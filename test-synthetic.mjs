/**
 * Self-contained test bench for both halves of the plugin.
 *
 * The older benches replay one machine's real session logs, so they only ran on
 * the author's box. This one builds its own session and validates every append
 * against a replica of `@deepseek-ai/dsh-session`'s surface fold, which is what
 * actually decides whether a trim is legal:
 *
 *   - a replacement's `startSeq`/`endSeq` must be CURRENT surface nodes,
 *   - in start-before-end POSITION order (their seq values need not be ordered),
 *   - `sourceEventSeqs` must cover every shadowed surface node, and citing a
 *     non-surface event is not enough to satisfy that,
 *   - a message event must carry `id`, `role`, `source.kind` and a content array.
 *
 * Run: node test-synthetic.mjs
 */
import assert from 'node:assert/strict';

const SURFACE_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
]);
const ROLE_BY_TYPE = {
  'system/message': 'system',
  'developer/message': 'developer',
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'tool',
};

/** A faithful stand-in for the harness Session surface. */
class FakeSession {
  constructor(events) {
    this.log = events.slice();
    this.rebuild();
  }

  /** Fold the log exactly like `surface.js`: a replace splices IN PLACE. */
  rebuild() {
    const nodes = [];
    for (const ev of this.log) {
      const op = ev.surfaceOp;
      if (op && typeof op === 'object' && op.op === 'replace') {
        const start = nodes.indexOf(op.startSeq);
        const end = nodes.indexOf(op.endSeq);
        if (start === -1) throw new Error(`surface replace: start seq ${op.startSeq} not found in surface`);
        if (end === -1) throw new Error(`surface replace: end seq ${op.endSeq} not found in surface`);
        if (start > end) throw new Error(`surface replace: start ${op.startSeq} is after end ${op.endSeq} on the surface`);
        nodes.splice(start, end - start + 1, ev.seq);
      } else if (op === 'append') {
        nodes.push(ev.seq);
      }
    }
    this.nodes = nodes;
  }

  get surface() { return { nodes: this.nodes.slice() }; }
  get seq() { return this.log.length; }
  eventAt(seq) { return this.log[seq]; }
  ownEvents() { return this.log.slice(); }
  snapshotEvents(from = 0, toExclusive = this.seq) { return this.log.slice(from, toExclusive); }

  append(type, data, opts) {
    const op = opts && opts.surfaceOp;
    const raw = opts && opts.sourceEventSeqs;
    if (SURFACE_TYPES.has(type) && op === undefined) {
      throw new Error(`${type} is surface-eligible and requires a surfaceOp marker`);
    }
    const seq = this.log.length;

    if (op !== undefined && op !== 'append') {
      if (op.startSeq >= seq || op.endSeq >= seq) {
        throw new Error(`surface replace at seq ${seq}: endpoints must reference earlier events`);
      }
      const start = this.nodes.indexOf(op.startSeq);
      const end = this.nodes.indexOf(op.endSeq);
      if (start === -1) throw new Error(`surface replace: start seq ${op.startSeq} not found in surface`);
      if (end === -1) throw new Error(`surface replace: end seq ${op.endSeq} not found in surface`);
      if (start > end) throw new Error(`surface replace: start seq ${op.startSeq} (index ${start}) is after end seq ${op.endSeq} (index ${end})`);
      if (raw === undefined) throw new Error('surface replace: sourceEventSeqs must include every shadowed surface node');
      if (!Array.isArray(raw) || raw.length === 0) throw new Error('sourceEventSeqs must not be empty');
      if (new Set(raw).size !== raw.length) throw new Error('sourceEventSeqs must not contain duplicates');
      for (const v of raw) {
        if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error('sourceEventSeqs must contain non-negative safe integers');
        if (v >= seq) throw new Error(`sourceEventSeqs must reference earlier events: ${v} >= ${seq}`);
      }
      // The real check: the SHADOWED SURFACE NODES, not the log range.
      const shadowed = this.nodes.slice(start, end + 1);
      const cited = new Set(raw);
      const missing = shadowed.filter((s) => !cited.has(s));
      if (missing.length > 0) {
        throw new Error(`surface replace: sourceEventSeqs must include every shadowed surface node; missing ${missing.join(', ')}`);
      }
    }

    if (SURFACE_TYPES.has(type)) {
      const message = type === 'user/message' ? data : data && data.message;
      if (!message || typeof message.id !== 'string' || message.id === '') {
        throw new Error(`${type} at seq ${seq} lacks an identified message`);
      }
      if (message.role !== ROLE_BY_TYPE[type]) {
        throw new Error(`${type} message must have role "${ROLE_BY_TYPE[type]}"`);
      }
      if (!message.source || typeof message.source.kind !== 'string' || message.source.kind === '') {
        throw new Error(`${type} message has invalid source`);
      }
      if (!Array.isArray(message.content)) throw new Error(`${type} message has invalid content`);
    }

    const ev = {
      type,
      seq,
      time: Date.now(),
      data,
      ...(op === undefined ? {} : { surfaceOp: op }),
      ...(raw === undefined ? {} : { sourceEventSeqs: raw }),
    };
    this.log.push(ev);
    this.rebuild();
    return ev;
  }
}

/**
 * A conversation with three questions, one tool call in each of the first two.
 * `opts.injectedMidTurn` adds a second injected burst AFTER the tool result —
 * the shape that used to make the next trim cite a range that missed the strip
 * marker. `opts.leaveLastTurnOpen` ends the log inside question three, with its
 * tool call still unanswered.
 */
function buildConversation(opts = {}) {
  const events = [];
  let seq = 0;
  let turn = 0;
  const push = (ev) => { ev.seq = seq++; events.push(ev); return ev; };

  const system = () => push({
    type: 'system/message',
    data: { message: { id: 's1', role: 'system', content: [{ type: 'text', text: 'SYSTEM' }], source: { kind: 'system-prompt' } } },
    surfaceOp: 'append',
  });
  const injected = (text, kind) => push({
    type: 'user/message',
    data: { id: `i${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind } },
    surfaceOp: 'append',
  });
  const user = (text) => push({
    type: 'user/message',
    data: { id: `u${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
    surfaceOp: 'append',
  });
  const assistantText = (text) => push({
    type: 'assistant/message',
    data: { turn, step: 1, stream: [], message: { id: `a${seq}`, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } } },
    surfaceOp: 'append',
  });
  const assistantCall = (text, callId) => push({
    type: 'assistant/message',
    data: {
      turn, step: 1, stream: [],
      message: {
        id: `a${seq}`,
        role: 'assistant',
        content: [{ type: 'text', text }, { type: 'tool-call', id: callId, name: 'read', arguments: '{"path":"x"}' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    },
    surfaceOp: 'append',
  });
  const toolCall = (callId) => push({
    type: 'tool/call',
    data: { turn, step: 1, callId, name: 'read', arguments: '{"path":"x"}' },
  });
  const toolResult = (callId, text) => push({
    type: 'tool/result',
    data: { message: { id: `r${seq}`, role: 'tool', toolCallId: callId, content: [{ type: 'text', text }], source: { kind: 'tool', callId } } },
    surfaceOp: 'append',
  });
  const turnStart = () => { turn += 1; push({ type: 'turn/start', data: { turn } }); };
  const turnEnd = () => push({ type: 'turn/end', data: { turn, reason: { kind: 'stop' } } });

  system();
  injected('runtime snapshot', 'runtime-context');

  turnStart();
  user('Q1 问题一');
  assistantCall('先看看文件', 'c1');
  toolCall('c1');
  toolResult('c1', 'FILE CONTENTS');
  if (opts.injectedMidTurn) injected('mid-turn snapshot', 'runtime-context');
  assistantText('A1 回答一');
  turnEnd();

  turnStart();
  user('Q2 问题二');
  assistantCall('再算一下', 'c2');
  toolCall('c2');
  toolResult('c2', 'MATH RESULT');
  assistantText('A2 回答二');
  turnEnd();

  turnStart();
  user('Q3 问题三');
  if (opts.leaveLastTurnOpen) {
    assistantCall('running a command', 'c3');
    toolCall('c3');
  } else {
    assistantText('A3 回答三');
    turnEnd();
  }

  return events;
}

/** Strict-provider check over the CURRENT surface. */
function pairingProblems(session) {
  const problems = [];
  let open = [];
  for (const seq of session.surface.nodes) {
    const ev = session.eventAt(seq);
    if (!ev) continue;
    if (ev.type === 'assistant/message') {
      if (open.length) {
        problems.push(`seq ${seq}: ${open.length} unanswered call(s) before this assistant`);
        open = [];
      }
      for (const b of ev.data.message.content) {
        if (b && b.type === 'tool-call' && b.id) open.push(b.id);
      }
    } else if (ev.type === 'tool/result') {
      const id = ev.data.message.toolCallId;
      const at = open.indexOf(id);
      if (at === -1) problems.push(`seq ${seq}: tool/result ${id} has no declared call`);
      else open.splice(at, 1);
    } else if (ev.type === 'user/message' || ev.type === 'system/message') {
      if (open.length) {
        problems.push(`seq ${seq}: ${open.length} unanswered call(s) dropped`);
        open = [];
      }
    }
  }
  if (open.length) problems.push(`tail: ${open.length} unanswered call(s)`);
  return problems;
}

const HOST = new URL('./index.js', import.meta.url).href;
const CLIENT = new URL('./client.js', import.meta.url).href;
const mod = await import(HOST);

function bench(opts = {}) {
  const session = new FakeSession(buildConversation(opts));
  let handler = null;
  const ctx = {
    commands: { register: (def) => { handler = def.handler; return () => {}; } },
    sessions: { get: () => session },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
  };
  mod.apply(ctx);
  const run = (payload) => handler({ agent: { id: 'session-test' }, rawInput: JSON.stringify(payload) });
  const dump = () => JSON.parse(run({ action: 'list_json' }).text).turns;
  const row = (label) => dump().find((t) => t.label === label);
  const act = (action, label) => {
    const t = row(label);
    assert.ok(t, `no row for label ${label}`);
    return run({ action, userSeq: t.userSeq, startSeq: t.startSeq, endSeq: t.endSeq });
  };
  return { session, run, dump, row, act };
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(true);
    process.stdout.write(`ok   ${name}\n`);
  } catch (err) {
    results.push(false);
    process.stdout.write(`FAIL ${name}\n     ${err && err.message ? err.message.split('\n').join('\n     ') : err}\n`);
  }
}

/* ------------------------------------------------------------------ tests */

await test('list_json reports every question with its own tool calls', () => {
  const { run, dump } = bench();
  const payload = JSON.parse(run({ action: 'list_json' }).text);
  assert.equal(typeof payload.build, 'string');
  const turns = dump();
  assert.equal(turns.length, 3);
  assert.deepEqual(turns.map((t) => t.toolCalls), [1, 1, 0]);
  assert.deepEqual(turns.map((t) => t.removed), [false, false, false]);
  assert.equal(turns[0].injectedCount, 1);
  assert.deepEqual(turns[0].injectedKinds, ['runtime-context']);
});

await test('trim_tools keeps the answer and cites exactly the shadowed surface nodes', () => {
  const { session, act, dump } = bench();
  const before = session.surface.nodes.slice();

  const res = act('trim_tools', 1);
  assert.equal(res.kind, 'success', res.text);

  const turns = dump();
  assert.equal(turns[0].trimmed, true);
  assert.equal(turns[0].toolCalls, 0);
  assert.equal(turns[1].trimmed, false, 'the next question must be untouched');
  assert.equal(turns[1].toolCalls, 1);

  const written = session.log.find((e) => e.data && e.data.source && e.data.source.kind === 'context-trimmer-summary');
  assert.ok(written, 'a replacement must be written');
  assert.equal(written.data.role, 'user');
  assert.equal(typeof written.data.id, 'string');
  assert.ok(written.data.id.length > 0);
  assert.deepEqual(written.data.content, [{ type: 'text', text: 'A1 回答一' }]);

  // The cited list must be the shadowed slice of the PRE-ACTION surface, and
  // must not include log-only events such as `tool/call`.
  const startIdx = before.indexOf(written.surfaceOp.startSeq);
  const endIdx = before.indexOf(written.surfaceOp.endSeq);
  assert.ok(startIdx >= 0 && endIdx >= startIdx, 'the span must name current surface nodes');
  assert.deepEqual(written.sourceEventSeqs, before.slice(startIdx, endIdx + 1));
  for (const seq of written.sourceEventSeqs) {
    assert.ok(SURFACE_TYPES.has(session.eventAt(seq).type), `cited seq ${seq} is not a surface node`);
  }
  assert.deepEqual(pairingProblems(session), []);
});

await test('a trimmed turn can still be deleted (never refused because of a tail seq)', () => {
  const { session, act, dump, row } = bench();
  const q2 = row(2);
  assert.equal(act('trim_tools', 1).kind, 'success');
  const res = act('delete_turn', 1);
  assert.equal(res.kind, 'success', res.text);

  const turns = dump();
  assert.equal(turns.length, 3);
  assert.equal(turns[0].removed, true);
  assert.equal(turns[1].userSeq, q2.userSeq, 'the next question keeps its own row');
  assert.deepEqual(pairingProblems(session), []);
});

await test('deleting a turn marks THAT turn, never its neighbours', () => {
  const { session, act, dump, row } = bench();
  const q1 = row(1);
  const q3 = row(3);
  const res = act('delete_turn', 2);
  assert.equal(res.kind, 'success', res.text);

  const turns = dump();
  assert.equal(turns.length, 3);
  assert.deepEqual(turns.map((t) => t.removed), [false, true, false]);
  assert.equal(turns[0].userSeq, q1.userSeq, 'the preceding question is untouched');
  assert.equal(turns[2].userSeq, q3.userSeq, 'the following question keeps its number');
  assert.deepEqual(pairingProblems(session), []);
});

await test('deleting the first turn keeps the second turn intact and numbered 2', () => {
  const { act, dump, row } = bench();
  const q2 = row(2);
  const q3 = row(3);
  const res = act('delete_turn', 1);
  assert.equal(res.kind, 'success', res.text);

  const turns = dump();
  assert.deepEqual(turns.map((t) => t.label), [1, 2, 3]);
  assert.deepEqual(turns.map((t) => t.removed), [true, false, false]);
  assert.equal(turns[1].userSeq, q2.userSeq);
  assert.equal(turns[2].userSeq, q3.userSeq);
});

await test('a deletion does not poison the neighbouring turn', () => {
  const { session, act } = bench();
  assert.equal(act('delete_turn', 2).kind, 'success');
  const res = act('trim_tools', 1);
  assert.equal(res.kind, 'success', res.text);
  assert.deepEqual(pairingProblems(session), []);
});

await test('strip_injected leaves a marker that the next trim still cites', () => {
  const { session, act, dump } = bench({ injectedMidTurn: true });
  const strip = act('strip_injected', 1);
  assert.equal(strip.kind, 'success', strip.text);
  assert.equal(dump()[0].injectedStripped, true);

  const res = act('trim_tools', 1);
  assert.equal(res.kind, 'success', res.text);
  assert.doesNotMatch(res.text, /missing/);
  assert.deepEqual(pairingProblems(session), []);
});

await test('a running turn refuses trim and delete, and the late result stays paired', () => {
  const { session, act } = bench({ leaveLastTurnOpen: true });
  assert.equal(act('trim_tools', 3).kind, 'error');
  assert.equal(act('delete_turn', 3).kind, 'error');

  // The harness finishes the tool call: its result must never land orphaned.
  session.append('tool/result', {
    turn: 3,
    step: 1,
    message: {
      id: 'r-late',
      role: 'tool',
      toolCallId: 'c3',
      content: [{ type: 'text', text: 'LATE OUTPUT' }],
      source: { kind: 'tool', callId: 'c3' },
    },
  }, { surfaceOp: 'append' });
  assert.deepEqual(pairingProblems(session), []);
});

await test('a finished turn with no unanswered call becomes actionable again', () => {
  const { session, act } = bench({ leaveLastTurnOpen: true });
  session.append('tool/result', {
    turn: 3,
    step: 1,
    message: { id: 'r-late', role: 'tool', toolCallId: 'c3', content: [{ type: 'text', text: 'LATE OUTPUT' }], source: { kind: 'tool', callId: 'c3' } },
  }, { surfaceOp: 'append' });
  session.append('turn/end', { turn: 3, reason: { kind: 'stop' } });

  const res = act('trim_tools', 3);
  assert.equal(res.kind, 'success', res.text);
  assert.deepEqual(pairingProblems(session), []);
});

await test('injected kinds that are not harness snapshots are never "strippable"', () => {
  // A compaction checkpoint / user answer / goal travels as user/message but is
  // not context this action may clear. A skill invocation notice IS.
  const session = new FakeSession([
    { type: 'system/message', seq: 0, data: { message: { id: 's', role: 'system', content: [{ type: 'text', text: 'S' }], source: { kind: 'system-prompt' } } }, surfaceOp: 'append' },
    { type: 'user/message', seq: 1, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Q' }], source: { kind: 'compact-checkpoint' } }, surfaceOp: 'append' },
    { type: 'user/message', seq: 2, data: { id: 'u2', role: 'user', content: [{ type: 'text', text: 'reply' }], source: { kind: 'user-question-reply' } }, surfaceOp: 'append' },
    { type: 'user/message', seq: 3, data: { id: 'u3', role: 'user', content: [{ type: 'text', text: 'skill body' }], source: { kind: 'skill-invocation' } }, surfaceOp: 'append' },
    { type: 'user/message', seq: 4, data: { id: 'u4', role: 'user', content: [{ type: 'text', text: 'the real one' }], source: { kind: 'user' } }, surfaceOp: 'append' },
  ]);
  let handler = null;
  mod.apply({
    commands: { register: (def) => { handler = def.handler; return () => {}; } },
    sessions: { get: () => session },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
  });
  const turns = JSON.parse(handler({ agent: { id: 's' }, rawInput: JSON.stringify({ action: 'list_json' }) }).text).turns;
  assert.equal(turns.length, 1);
  assert.equal(turns[0].injectedCount, 1, 'only the injected notice counts');
  assert.deepEqual(turns[0].injectedKinds, ['skill-invocation']);
  assert.equal(turns[0].userSeq, 4);
});

await test('a garbage payload is rejected without writing anything', () => {
  const { session, run } = bench();
  const before = session.log.length;
  assert.equal(run({ action: 'trim_tools', userSeq: 9999 }).kind, 'error');
  assert.equal(run({ action: 'nope' }).kind, 'error');
  assert.equal(session.log.length, before);
});

await test('a question typed mid-run never drags the previous call into its span', () => {
  // Q1's tool call is still in flight when Q2 is typed, so Q1's result lands
  // INSIDE Q2's turn. Folding that result would erase Q1's declaration, so the
  // action must refuse instead of corrupting the pairing.
  const session = new FakeSession([
    { type: 'system/message', seq: 0, data: { message: { id: 's', role: 'system', content: [{ type: 'text', text: 'S' }], source: { kind: 'system-prompt' } } }, surfaceOp: 'append' },
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { id: 'u2', role: 'user', content: [{ type: 'text', text: 'Q1' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 3, data: { turn: 1, step: 1, stream: [], message: { id: 'a3', role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }], source: { kind: 'model', provider: 'p', model: 'm' } } }, surfaceOp: 'append' },
    { type: 'tool/call', seq: 4, data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' } },
    { type: 'user/message', seq: 5, data: { id: 'u5', role: 'user', content: [{ type: 'text', text: 'Q2 typed while running' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'tool/result', seq: 6, data: { message: { id: 'r6', role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'R1' }], source: { kind: 'tool', callId: 'c1' } } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 7, data: { turn: 1, step: 2, stream: [], message: { id: 'a7', role: 'assistant', content: [{ type: 'tool-call', id: 'c2', name: 'read', arguments: '{}' }], source: { kind: 'model', provider: 'p', model: 'm' } } }, surfaceOp: 'append' },
    { type: 'tool/call', seq: 8, data: { turn: 1, step: 2, callId: 'c2', name: 'read', arguments: '{}' } },
    { type: 'tool/result', seq: 9, data: { message: { id: 'r9', role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'R2' }], source: { kind: 'tool', callId: 'c2' } } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 10, data: { turn: 1, step: 2, stream: [], message: { id: 'a10', role: 'assistant', content: [{ type: 'text', text: 'A2' }], source: { kind: 'model', provider: 'p', model: 'm' } } }, surfaceOp: 'append' },
    { type: 'turn/end', seq: 11, data: { turn: 1, reason: { kind: 'stop' } } },
  ]);
  let handler = null;
  mod.apply({
    commands: { register: (def) => { handler = def.handler; return () => {}; } },
    sessions: { get: () => session },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
  });
  const run = (payload) => handler({ agent: { id: 's' }, rawInput: JSON.stringify(payload) });
  const turns = JSON.parse(run({ action: 'list_json' }).text).turns;
  assert.equal(turns.length, 2);
  const q2 = turns[1];

  const before = session.surface.nodes.slice();
  const del = run({ action: 'delete_turn', userSeq: q2.userSeq, startSeq: q2.startSeq, endSeq: q2.endSeq });
  assert.equal(del.kind, 'error', 'deleting Q2 would swallow Q1\'s call declaration');
  assert.deepEqual(session.surface.nodes, before, 'a refused action must not touch the surface');

  const trim = run({ action: 'trim_tools', userSeq: q2.userSeq, startSeq: q2.startSeq, endSeq: q2.endSeq });
  assert.equal(trim.kind, 'success', trim.text);

  // No result may survive without its declaration: that is the shape a provider
  // rejects, and it is what a span reaching backwards would create.
  const declared = new Set();
  for (const seq of session.surface.nodes) {
    const ev = session.eventAt(seq);
    if (ev.type === 'assistant/message') {
      for (const b of ev.data.message.content) if (b && b.type === 'tool-call') declared.add(b.id);
    }
  }
  for (const seq of session.surface.nodes) {
    const ev = session.eventAt(seq);
    if (ev.type !== 'tool/result') continue;
    assert.ok(declared.has(ev.data.message.toolCallId), `seq ${seq}: orphan tool result`);
  }
});

/* --------------------------------------------------- client half smoke test */

let clientPlugin = null;

/** Load the panel bundle once and build its plugin object. */
async function loadClientPlugin() {
  if (clientPlugin) return clientPlugin;
  let captured = null;
  globalThis.window = {
    __CONTEXT_TRIMMER_TEST__: true,
    __ModuleLoader__: { load(def) { captured = def; } },
  };
  await import(CLIENT);
  assert.ok(captured, 'client.js must register itself with the module loader');
  assert.equal(captured.id, '@local/dsh-context-trimmer');
  const React = {
    createElement: (...args) => ({ args }),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };
  clientPlugin = captured.factory((name) => {
    if (name === 'react') return React;
    throw new Error('unexpected require: ' + name);
  });
  return clientPlugin;
}

await test('the client half loads, declares its services and registers its slots', async () => {
  const plugin = await loadClientPlugin();
  assert.deepEqual(plugin.inject, ['slots', 'remote']);
  assert.ok(plugin.__test, 'the test hook must be exposed when explicitly enabled');

  const registered = [];
  const ctx = {
    inject: (_deps, callback) => { callback({}); return () => {}; },
    slots: {
      inject: (name, register) => { registered.push(name); register(); return () => {}; },
      register: (options) => { registered.push(options.name); return () => {}; },
    },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    get: () => undefined,
  };
  const cleanup = plugin.apply(ctx);
  assert.equal(typeof cleanup, 'function');
  assert.ok(registered.includes('conversation.input.right'));
  assert.ok(registered.includes('conversation.composer.dock'));
  cleanup();
});

await test('the panel folds the same surface as the Host, row for row', async () => {
  const plugin = await loadClientPlugin();
  const shape = (r) => ({
    label: r.label,
    userSeq: r.userSeq,
    startSeq: r.startSeq,
    endSeq: r.endSeq,
    nodeCount: r.nodeCount,
    removed: r.removed,
    running: r.running,
    trimmed: r.trimmed,
    toolCalls: r.toolCalls,
    logToolCalls: r.logToolCalls,
    removedChars: r.removedChars,
    injectedCount: r.injectedCount,
    injectedStripped: r.injectedStripped,
    user: r.user,
    assistant: r.assistant,
  });

  for (const scenario of ['fresh', 'trim', 'delete', 'strip']) {
    const { session, run, act } = bench({ injectedMidTurn: scenario === 'strip' });
    if (scenario === 'trim') assert.equal(act('trim_tools', 1).kind, 'success');
    if (scenario === 'delete') assert.equal(act('delete_turn', 2).kind, 'success');
    if (scenario === 'strip') assert.equal(act('strip_injected', 1).kind, 'success');

    const hostRows = JSON.parse(run({ action: 'list_json' }).text).turns;
    const entries = session.log.map((event) => ({ type: 'event', event }));
    const clientRows = plugin.__test.buildTurns(entries).turns;
    assert.deepEqual(clientRows.map(shape), hostRows.map(shape), `rows diverged in the ${scenario} case`);
  }
});

await test('the settle rule recognises a landed action and ignores an unchanged surface', async () => {
  const plugin = await loadClientPlugin();
  const { settledFeedback } = plugin.__test;

  const pendingStrip = {
    id: 1, label: 2, userSeq: 7, action: 'strip_injected',
    beforeTrimmed: false, beforeStripped: false, beforeInjected: 1, beforeTools: 0,
  };
  assert.equal(settledFeedback(pendingStrip, [{ userSeq: 7, trimmed: false, injectedStripped: false }]), null);
  assert.equal(settledFeedback(pendingStrip, [{ userSeq: 7, trimmed: false, injectedStripped: true }]).kind, 'ok');

  const pendingDelete = {
    id: 2, label: 2, userSeq: 7, action: 'delete_turn',
    beforeTrimmed: false, beforeStripped: false, beforeInjected: 0, beforeTools: 1,
  };
  assert.equal(settledFeedback(pendingDelete, [{ label: 1, userSeq: 2 }, { label: 2, userSeq: 7 }]), null);
  assert.equal(
    settledFeedback(pendingDelete, [{ label: 1, userSeq: 2 }, { label: 2, userSeq: null, removed: true }]).kind,
    'ok',
  );
  assert.equal(settledFeedback(pendingDelete, [{ label: 1, userSeq: 2 }]).kind, 'ok');
});

/* ---------------------------------------------------------------- summary */

const failed = results.filter((ok) => !ok).length;
process.stdout.write(`\n${results.length - failed}/${results.length} passed\n`);
if (failed > 0) process.exit(1);
