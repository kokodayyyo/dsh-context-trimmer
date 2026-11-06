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
  constructor(events, inherited = 0) {
    this.inherited = inherited;
    this.log = events.slice();
    this.rebuild();
    this.openTurn = null;
    this.compaction = null;
    for (const ev of this.log) this.track(ev);
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
  ownEvents() { return this.log.slice(this.inherited); }
  snapshotEvents(from = 0, toExclusive = this.seq) { return this.log.slice(from, toExclusive); }

  /** Track the turn / compaction cursors the real invariant derives from the log. */
  track(ev) {
    if (ev.type === 'turn/start') this.openTurn = ev.data.turn;
    else if (ev.type === 'turn/end') this.openTurn = null;
    else if (ev.type === 'compaction/start') {
      this.compaction = {
        id: ev.data.compactionId,
        sourceCommandId: ev.data.sourceCommandId,
        turn: ev.data.turn,
        summarized: false,
      };
    } else if (ev.type === 'compaction/summary' && this.compaction) {
      this.compaction.summarized = true;
    } else if (ev.type === 'compaction/end' || ev.type === 'session/end-seed') {
      this.compaction = null;
    }
  }

  /**
   * The compaction invariants `@deepseek-ai/dsh-compaction` enforces on every
   * append (`dsh-compaction/lib/types/invariant.js`): brackets, ownership, and
   * the exact shadowed surface span.
   */
  checkCompaction(type, data, opts) {
    if ((type === 'turn/start' || type === 'turn/end') && this.compaction) {
      throw new Error(`${type} crosses an open compaction`);
    }
    if (type === 'compaction/start') {
      if (this.compaction) throw new Error('compaction/start overlaps an open compaction');
      const turn = data.turn === undefined ? null : data.turn;
      if (turn === null) {
        if (this.openTurn !== null) throw new Error('standalone compaction with an open turn');
      } else if (turn !== this.openTurn) {
        throw new Error('compaction/start does not match the open turn');
      }
      return;
    }
    if (type === 'compaction/summary') {
      if (!this.compaction) throw new Error('compaction/summary has no matching compaction/start');
      if (data.compactionId !== this.compaction.id) throw new Error('compaction/summary id mismatch');
      if (data.sourceCommandId !== this.compaction.sourceCommandId) throw new Error('compaction/summary sourceCommandId mismatch');
      if (this.compaction.summarized) throw new Error('compaction/summary repeats');
      const range = data.shadowedRange || {};
      const start = this.nodes.indexOf(range.start);
      const end = this.nodes.indexOf(range.end);
      if (start < 0 || end < start) throw new Error('compaction/summary shadowedRange is not a current surface span');
      const slice = this.nodes.slice(start, end + 1);
      if (JSON.stringify(slice) !== JSON.stringify(data.shadowedSeqs)) {
        throw new Error('compaction/summary shadowedSeqs must list every node in the current span');
      }
      if (!Number.isSafeInteger(data.shadowedTokenCount) || data.shadowedTokenCount < 0) {
        throw new Error('compaction/summary shadowedTokenCount must be a non-negative integer');
      }
      return;
    }
    if (type === 'compaction/end') {
      if (!this.compaction) throw new Error('compaction/end has no matching compaction/start');
      if (data.compactionId !== this.compaction.id) throw new Error('compaction/end id mismatch');
      if (data.turn !== this.compaction.turn) throw new Error('compaction/end changes its owner turn');
      if (data.error === undefined && !this.compaction.summarized) {
        throw new Error('successful compaction/end requires one summary');
      }
      return;
    }
    const source = data && data.source;
    if (
      SURFACE_TYPES.has(type) &&
      source && source.kind === 'compact-checkpoint' &&
      opts && opts.surfaceOp !== 'append'
    ) {
      if (!this.compaction) throw new Error('compaction checkpoint has no matching compaction/start');
      if (source.compactionId !== this.compaction.id) throw new Error('compaction checkpoint id mismatch');
      if (source.sourceCommandId !== this.compaction.sourceCommandId) {
        throw new Error('compaction checkpoint sourceCommandId mismatch');
      }
    }
  }

  append(type, data, opts) {
    const op = opts && opts.surfaceOp;
    const raw = opts && opts.sourceEventSeqs;
    if (SURFACE_TYPES.has(type) && op === undefined) {
      throw new Error(`${type} is surface-eligible and requires a surfaceOp marker`);
    }
    const seq = this.log.length;

    this.checkCompaction(type, data, opts);

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
    this.track(ev);
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
  if (opts.injectedMidTurn) injected('mid-turn snapshot', 'time-context');
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

await test('trim_tools writes a complete compaction transaction over exactly the shadowed span', () => {
  const { session, act, dump } = bench();
  const before = session.surface.nodes.slice();
  const baseSeq = session.log.length;

  const res = act('trim_tools', 1);
  assert.equal(res.kind, 'success', res.text);

  const turns = dump();
  assert.equal(turns[0].trimmed, true);
  assert.equal(turns[0].toolCalls, 0);
  assert.equal(turns[1].trimmed, false, 'the next question must be untouched');
  assert.equal(turns[1].toolCalls, 1);

  // start → summary → checkpoint → end, one identity throughout.
  const written = session.log.slice(baseSeq);
  assert.deepEqual(written.map((e) => e.type), [
    'compaction/start', 'compaction/summary', 'user/message', 'compaction/end',
  ]);
  const [start, summary, checkpoint, end] = written;
  const id = start.data.compactionId;
  assert.equal(typeof id, 'string');
  assert.equal(summary.data.compactionId, id);
  assert.equal(checkpoint.data.source.compactionId, id);
  assert.equal(checkpoint.data.source.kind, 'compact-checkpoint');
  assert.equal(end.data.compactionId, id);
  assert.equal(end.data.error, undefined);
  assert.equal(start.data.turn, null, 'idle session → standalone bracket');

  // The summary must name the exact current surface span.
  const startIdx = before.indexOf(summary.data.shadowedRange.start);
  const endIdx = before.indexOf(summary.data.shadowedRange.end);
  assert.ok(startIdx >= 0 && endIdx >= startIdx, 'the span must name current surface nodes');
  const shadowed = before.slice(startIdx, endIdx + 1);
  assert.deepEqual(summary.data.shadowedSeqs, shadowed);
  assert.ok(Number.isSafeInteger(summary.data.shadowedTokenCount) && summary.data.shadowedTokenCount >= 0);
  assert.deepEqual(summary.data.trimmer.mode, 'trim');

  // The checkpoint cites the shadowed nodes plus its two lifecycle seqs.
  assert.deepEqual(checkpoint.sourceEventSeqs, [start.seq, summary.seq, ...shadowed]);

  assert.equal(checkpoint.data.role, 'user');
  assert.equal(typeof checkpoint.data.id, 'string');
  assert.ok(checkpoint.data.id.length > 0);
  assert.deepEqual(checkpoint.data.content, [{ type: 'text', text: 'A1 回答一' }]);

  for (const seq of shadowed) {
    assert.ok(SURFACE_TYPES.has(session.eventAt(seq).type), `shadowed seq ${seq} is not a surface node`);
  }
  assert.deepEqual(pairingProblems(session), []);
});

await test('a failed transaction closes its bracket with an error end-event', () => {
  const { session, act } = bench();
  // Make the checkpoint append itself fail: the bracket must not stay open.
  const original = session.append.bind(session);
  session.append = (type, data, opts) => {
    if (type === 'user/message' && data && data.source && data.source.kind === 'compact-checkpoint') {
      throw new Error('synthetic checkpoint failure');
    }
    return original(type, data, opts);
  };
  const res = act('trim_tools', 1);
  assert.equal(res.kind, 'error');
  assert.match(res.text, /synthetic checkpoint failure/);

  const tail = session.log.slice(-2).map((e) => e.type);
  assert.deepEqual(tail, ['compaction/summary', 'compaction/end']);
  const end = session.log.at(-1);
  assert.match(String(end.data.error), /synthetic checkpoint failure/);
  assert.equal(session.compaction, null, 'the bracket must be closed');
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

await test('strip_injected clears only the ephemeral burst by default', () => {
  const { session, act, dump } = bench({ injectedMidTurn: true });
  const before = dump()[0];
  assert.equal(before.injectedEphemeral, 1);
  assert.equal(before.injectedDurable, 1);

  const strip = act('strip_injected', 1);
  assert.equal(strip.kind, 'success', strip.text);
  const after = dump()[0];
  assert.equal(after.injectedEphemeral, 0, 'the time-context burst is gone');
  assert.equal(after.injectedDurable, 1, 'the durable runtime snapshot stays');
  assert.equal(after.injectedStripped, true);

  const res = act('trim_tools', 1);
  assert.equal(res.kind, 'success', res.text);
  assert.doesNotMatch(res.text, /missing/);
  assert.deepEqual(pairingProblems(session), []);
});

await test('durable carriers need an explicit second step', () => {
  const { run, act, dump } = bench();
  const row = dump()[0];
  assert.equal(row.injectedDurable, 1);

  const refused = run({
    action: 'strip_injected', userSeq: row.userSeq, startSeq: row.startSeq, endSeq: row.endSeq,
  });
  assert.equal(refused.kind, 'error');
  assert.match(refused.text, /持久注入/);

  const forced = run({
    action: 'strip_injected', userSeq: row.userSeq, startSeq: row.startSeq, endSeq: row.endSeq, includeDurable: true,
  });
  assert.equal(forced.kind, 'success', forced.text);
  assert.equal(dump()[0].injectedCount, 0);
});

await test('an open compaction bracket blocks every write', () => {
  const { session, act } = bench();
  session.append('compaction/start', { compactionId: 'other', turn: null });
  assert.equal(session.compaction.id, 'other');

  const res = act('trim_tools', 1);
  assert.equal(res.kind, 'error');
  assert.match(res.text, /压缩事务/);
  assert.equal(session.log.filter((e) => e.type === 'compaction/start').length, 1);
});

await test('a foreign compaction checkpoint is never shadowed', () => {
  const { session, act } = bench();
  // A real harness checkpoint (no `trimmer`) lands as its own transaction and
  // replaces the head node of turn 1.
  const start = session.append('compaction/start', { compactionId: 'real', turn: null });
  const summary = session.append('compaction/summary', {
    compactionId: 'real',
    summary: [{ type: 'text', text: 'real summary' }],
    shadowedRange: { start: 1, end: 1 },
    shadowedSeqs: [1],
    shadowedTokenCount: 1,
  });
  session.append('user/message', {
    id: 'real-cp', role: 'user', content: [{ type: 'text', text: 'real summary' }],
    source: { kind: 'compact-checkpoint', compactionId: 'real' },
  }, {
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
    sourceEventSeqs: [start.seq, summary.seq, 1],
  });
  session.append('compaction/end', { compactionId: 'real', turn: null });

  // The foreign checkpoint now stands at the head of turn 1; deleting that turn
  // would shadow it, so the action must refuse.
  const before = session.log.length;
  const res = act('delete_turn', 1);
  assert.equal(res.kind, 'error');
  assert.match(res.text, /压缩检查点/);
  assert.equal(session.log.length, before);
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

await test('a fork keeps the tool tallies of the history it inherited', () => {
  // A fork copies the parent prefix, marks the inherited cut, then owns whatever
  // follows. `ownEvents()` skips that prefix, but the model still reads it — so
  // the log tally must not report zero tool calls for inherited questions.
  const parent = buildConversation();
  const forked = new FakeSession([
    ...parent,
    { type: 'session/end-seed', seq: parent.length, data: { inherited: true } },
  ], parent.length + 1);
  forked.append('turn/start', { turn: 4 });
  forked.append('user/message', {
    id: 'fork-q', role: 'user', content: [{ type: 'text', text: 'Q4 新问题' }], source: { kind: 'user' },
  }, { surfaceOp: 'append' });
  forked.append('assistant/message', {
    turn: 4, step: 1, stream: [],
    message: { id: 'fork-a', role: 'assistant', content: [{ type: 'text', text: 'A4 新回答' }], source: { kind: 'model', provider: 'p', model: 'm' } },
  }, { surfaceOp: 'append' });
  forked.append('turn/end', { turn: 4, reason: { kind: 'stop' } });

  let handler = null;
  mod.apply({
    commands: { register: (def) => { handler = def.handler; return () => {}; } },
    sessions: { get: () => forked },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
  });
  const run = (payload) => handler({ agent: { id: 's' }, rawInput: JSON.stringify(payload) });
  const turns = JSON.parse(run({ action: 'list_json' }).text).turns;

  assert.equal(turns.length, 4);
  assert.deepEqual(turns.map((t) => t.toolCalls), [1, 1, 0, 0]);
  assert.deepEqual(turns.map((t) => t.logToolCalls), [1, 1, 0, 0], 'inherited questions keep their tally');
  assert.deepEqual(turns.map((t) => t.trimmed), [false, false, false, false]);

  // An inherited question is still trimmable: its nodes are current surface.
  const q1 = turns[0];
  const res = run({ action: 'trim_tools', userSeq: q1.userSeq, startSeq: q1.startSeq, endSeq: q1.endSeq });
  assert.equal(res.kind, 'success', res.text);
  assert.equal(JSON.parse(run({ action: 'list_json' }).text).turns[0].trimmed, true);
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
    injectedEphemeral: r.injectedEphemeral,
    injectedDurable: r.injectedDurable,
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
    beforeTrimmed: false, beforeInjected: 2, beforeTools: 0,
  };
  // Unchanged count → still pending; the durable second step lands as a drop.
  assert.equal(settledFeedback(pendingStrip, [{ userSeq: 7, injectedCount: 2, trimmed: false }]), null);
  // The ephemeral step: 2 → 1.
  assert.equal(settledFeedback(pendingStrip, [{ userSeq: 7, injectedCount: 1, trimmed: false }]).kind, 'ok');
  // The durable step: 1 → 0.
  assert.equal(settledFeedback(pendingStrip, [{ userSeq: 7, injectedCount: 0, trimmed: false }]).kind, 'ok');

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

await test('buttons disappear exactly when the action has nothing left to do', async () => {
  const plugin = await loadClientPlugin();
  const { rowActions } = plugin.__test;

  // The bug this locks: the log still holds 122 tool calls after a trim, so a
  // log-based gate kept offering "trim" on an already-trimmed row.
  const trimmed = rowActions({ trimmed: true, toolCalls: 0, logToolCalls: 122, injectedEphemeral: 0, injectedDurable: 0 });
  assert.equal(trimmed.canTrim, false);
  assert.equal(trimmed.canStrip, false);

  const fresh = rowActions({ trimmed: false, toolCalls: 3, logToolCalls: 3, injectedEphemeral: 2, injectedDurable: 1 });
  assert.equal(fresh.canTrim, true);
  assert.equal(fresh.canStrip, true);
  assert.equal(fresh.includeDurable, false, 'the ephemeral step comes first');

  const durableOnly = rowActions({ trimmed: true, toolCalls: 0, injectedEphemeral: 0, injectedDurable: 1 });
  assert.equal(durableOnly.canTrim, false);
  assert.equal(durableOnly.canStrip, true);
  assert.equal(durableOnly.includeDurable, true);

  const running = rowActions({ running: true, toolCalls: 3, injectedEphemeral: 1 });
  assert.equal(running.canTrim, false);
  assert.equal(running.canStrip, false);

  const removed = rowActions({ removed: true, toolCalls: 3, injectedEphemeral: 1 });
  assert.equal(removed.canTrim, false);
  assert.equal(removed.canStrip, false);
});

await test('two separate ephemeral bursts become two transactions, both valid', () => {
  const session = new FakeSession([
    { type: 'system/message', seq: 0, data: { message: { id: 's', role: 'system', content: [{ type: 'text', text: 'S' }], source: { kind: 'system-prompt' } } }, surfaceOp: 'append' },
    { type: 'user/message', seq: 1, data: { id: 'i1', role: 'user', content: [{ type: 'text', text: 't1' }], source: { kind: 'time-context' } }, surfaceOp: 'append' },
    { type: 'user/message', seq: 2, data: { id: 'u2', role: 'user', content: [{ type: 'text', text: 'Q' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 3, data: { turn: 1, step: 1, stream: [], message: { id: 'a3', role: 'assistant', content: [{ type: 'text', text: 'A' }], source: { kind: 'model', provider: 'p', model: 'm' } } }, surfaceOp: 'append' },
    { type: 'user/message', seq: 4, data: { id: 'i4', role: 'user', content: [{ type: 'text', text: 't2' }], source: { kind: 'time-context' } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 5, data: { turn: 1, step: 1, stream: [], message: { id: 'a5', role: 'assistant', content: [{ type: 'text', text: 'B' }], source: { kind: 'model', provider: 'p', model: 'm' } } }, surfaceOp: 'append' },
    { type: 'user/message', seq: 6, data: { id: 'u6', role: 'user', content: [{ type: 'text', text: 'Q2' }], source: { kind: 'user' } }, surfaceOp: 'append' },
  ]);
  let handler = null;
  mod.apply({
    commands: { register: (def) => { handler = def.handler; return () => {}; } },
    sessions: { get: () => session },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
  });
  const run = (payload) => handler({ agent: { id: 's' }, rawInput: JSON.stringify(payload) });
  const before = JSON.parse(run({ action: 'list_json' }).text).turns[0];
  assert.equal(before.injectedEphemeral, 2);

  const beforeSeq = session.log.length;
  const res = run({ action: 'strip_injected', userSeq: 2, startSeq: 1, endSeq: 5 });
  assert.equal(res.kind, 'success', res.text);
  const written = session.log.slice(beforeSeq).map((e) => e.type);
  assert.deepEqual(written, [
    'compaction/start', 'compaction/summary', 'user/message', 'compaction/end',
    'compaction/start', 'compaction/summary', 'user/message', 'compaction/end',
  ]);
  assert.equal(session.compaction, null);
  const after = JSON.parse(run({ action: 'list_json' }).text).turns[0];
  assert.equal(after.injectedCount, 0);
  assert.equal(after.injectedStripped, true);
});

await test('an assistant preview shows the answer, not the reasoning block', () => {
  // Real shape: one assistant/message carries [reasoning, text]. `textOf` joins
  // both, so a preview built from it would show the model's private reasoning.
  const session = new FakeSession([
    { type: 'system/message', seq: 0, data: { message: { id: 's', role: 'system', content: [{ type: 'text', text: 'S' }], source: { kind: 'system-prompt' } } }, surfaceOp: 'append' },
    { type: 'user/message', seq: 1, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Q' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    {
      type: 'assistant/message',
      seq: 2,
      data: {
        turn: 1, step: 1, stream: [],
        message: {
          id: 'a2', role: 'assistant',
          content: [
            { type: 'reasoning', text: 'THINKING INTERNALS' },
            { type: 'text', text: 'THE VISIBLE ANSWER' },
            { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
          ],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
      surfaceOp: 'append',
    },
    { type: 'tool/call', seq: 3, data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' } },
    { type: 'tool/result', seq: 4, data: { message: { id: 'r4', role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'R' }], source: { kind: 'tool', callId: 'c1' } } }, surfaceOp: 'append' },
  ]);
  let handler = null;
  mod.apply({
    commands: { register: (def) => { handler = def.handler; return () => {}; } },
    sessions: { get: () => session },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
  });
  const run = (payload) => handler({ agent: { id: 's' }, rawInput: JSON.stringify(payload) });
  const row = JSON.parse(run({ action: 'list_json' }).text).turns[0];
  assert.equal(row.assistant.includes('THINKING'), false, 'reasoning must not leak into the preview');
  assert.ok(row.assistant.startsWith('THE VISIBLE ANSWER'), row.assistant);

  // And the trim keeps exactly the text block.
  const res = run({ action: 'trim_tools', userSeq: 1, startSeq: 2, endSeq: 4 });
  assert.equal(res.kind, 'success', res.text);
  const checkpoint = session.log.find((e) => e.type === 'user/message' && e.data.source.kind === 'compact-checkpoint');
  assert.deepEqual(checkpoint.data.content, [{ type: 'text', text: 'THE VISIBLE ANSWER' }]);
});
/* ------------------------------------------------- real-session regression */
// Opt-in: TRIMMER_LOG=<path to session.v4.jsonl.zstd> replays one real session
// through the real Host half and performs a trim under the compaction
// invariant. Skipped in CI, where no such file exists.
const REAL_LOG = process.env.TRIMMER_LOG;
if (REAL_LOG) {
  await test('a real session survives a V2 trim under the compaction invariant', async () => {
    const fs = await import('node:fs');
    const zlib = await import('node:zlib');
    const buf = fs.readFileSync(REAL_LOG);
    const starts = [];
    for (let i = 0; i + 4 <= buf.length; i += 1) {
      if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
    }
    let text = '';
    for (let k = 0; k < starts.length; k += 1) {
      const s = starts[k];
      const e = k + 1 < starts.length ? starts[k + 1] : buf.length;
      try { text += zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8'); } catch { /* torn frame */ }
    }
    const events = text.split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((row) => row && typeof row.seq === 'number');
    const seed = events.find((e) => e.type === 'session/end-seed' && e.data && e.data.inherited === true);
    const session = new FakeSession(events, seed ? seed.seq : 0);

    let handler = null;
    mod.apply({
      commands: { register: (def) => { handler = def.handler; return () => {}; } },
      sessions: { get: () => session },
      effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    });
    const run = (payload) => handler({ agent: { id: 'real' }, rawInput: JSON.stringify(payload) });
    const rows = JSON.parse(run({ action: 'list_json' }).text).turns;
    assert.ok(rows.length > 0, 'the session must have at least one turn');

    const target = rows.find((row) => !row.removed && !row.running && !row.trimmed && row.toolCalls > 0);
    if (target === undefined) return;
    const before = session.log.length;
    const res = run({
      action: 'trim_tools',
      userSeq: target.userSeq,
      startSeq: target.startSeq,
      endSeq: target.endSeq,
    });
    assert.equal(res.kind, 'success', res.text);
    const written = session.log.slice(before).map((e) => e.type);
    assert.deepEqual(written, ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end']);
    assert.equal(session.compaction, null);
    const after = JSON.parse(run({ action: 'list_json' }).text).turns
      .find((row) => row.userSeq === target.userSeq);
    assert.equal(after.trimmed, true);
    assert.equal(after.toolCalls, 0);
  });
}

/* ---------------------------------------------------------------- summary */

const failed = results.filter((ok) => !ok).length;
process.stdout.write(`\n${results.length - failed}/${results.length} passed\n`);
if (failed > 0) process.exit(1);
