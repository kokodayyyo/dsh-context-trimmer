/**
 * Local test bench for the Host half.
 *
 * Loads the real session log, builds a fake Session with the same shape the
 * harness exposes (surface, eventAt, ownEvents, snapshotEvents, append), and
 * replays the harness's own surface-replace validation so a bad append fails
 * here instead of in the user's panel.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const LOG = 'C:/Users/A/.dsh/sessions/--D-Work-~914D~7F6E~66F4~65B0--/session-422aa91d-5a35-458f-805e-ac9b77d831ed/session.v4.jsonl.zstd';

function readLog() {
  const buf = fs.readFileSync(LOG);
  const offs = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offs.push(i);
  }
  let all = '';
  for (let k = 0; k < offs.length; k++) {
    const s = offs[k];
    const e = k + 1 < offs.length ? offs[k + 1] : buf.length;
    try { all += zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8'); } catch { /* skip */ }
  }
  return all.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result']);

/** Mirror the harness: shadowed set = slice of the FULL event list. */
function makeSession(events) {
  const bySeq = new Map();
  for (const e of events) if (typeof e.seq === 'number') bySeq.set(e.seq, e);

  let nodes = [];
  let seq = 0;
  let nextSeq = Math.max(...events.filter((e) => typeof e.seq === 'number').map((e) => e.seq)) + 1;
  const log = [];

  function rebuild() {
    nodes = [];
    for (const e of log) {
      const op = e.surfaceOp;
      if (op && op.op === 'replace') {
        for (let i = nodes.length - 1; i >= 0; i--) {
          if (nodes[i] >= op.startSeq && nodes[i] <= op.endSeq) nodes.splice(i, 1);
        }
      }
      if (SURFACE_TYPES.has(e.type)) nodes.push(e.seq);
    }
  }

  for (const e of events) {
    if (typeof e.seq === 'number') { log.push(e); seq = Math.max(seq, e.seq); }
  }
  rebuild();

  return {
    get surface() { return { nodes: nodes.slice(), replaceGeneration: 0, contentGeneration: 0 }; },
    get seq() { return seq; },
    eventAt(s) { return bySeq.get(s); },
    ownEvents() { return log.slice(); },
    snapshotEvents(from = 0, to = seq) {
      const out = [];
      for (const e of log) if (typeof e.seq === 'number' && e.seq >= from && e.seq <= to) out.push(e);
      return out;
    },
    append(type, data, opts) {
      if (!SURFACE_TYPES.has(type)) throw new Error(`append: ${type} is not surface-eligible`);
      const op = opts && opts.surfaceOp;
      if (op === undefined) throw new Error(`${type} is surface-eligible and requires a surfaceOp marker`);
      const ev = { type, seq: nextSeq, time: Date.now(), data, surfaceOp: op };

      // Mirror the harness: a surface message must carry an identified message.
      // For `user/message` the event data IS the message; the others nest it.
      const msg = type === 'user/message' ? data : data && data.message;
      if (!msg || typeof msg.id !== 'string' || msg.id === '') {
        throw new Error(`${type} at seq ${ev.seq} lacks an identified message`);
      }
      const raw = opts && opts.sourceEventSeqs;

      if (op && op.op === 'replace') {
        if (op.startSeq >= ev.seq || op.endSeq >= ev.seq) {
          throw new Error(`surface replace at seq ${ev.seq}: startSeq and endSeq must reference earlier events`);
        }
        if (type === 'assistant/message' && raw !== undefined) {
          throw new Error('assistant/message embeds its source stream and cannot carry sourceEventSeqs');
        }
        const startIdx = nodes.indexOf(op.startSeq);
        const endIdx = nodes.indexOf(op.endSeq);
        if (startIdx === -1) throw new Error(`surface replace: start seq ${op.startSeq} not found in surface`);
        if (endIdx === -1) throw new Error(`surface replace: end seq ${op.endSeq} not found in surface`);
        if (startIdx > endIdx) throw new Error('surface replace: start seq after end seq');

        // The harness validates against the whole event range, not the surface.
        const fullRange = [];
        for (const e of log) {
          if (typeof e.seq === 'number' && e.seq >= op.startSeq && e.seq <= op.endSeq) fullRange.push(e.seq);
        }
        const sources = new Set(Array.isArray(raw) ? raw : []);
        if (Array.isArray(raw) && raw.length === 0) throw new Error('sourceEventSeqs must not be empty');
        const missing = fullRange.filter((s) => !sources.has(s));
        if (missing.length > 0) {
          throw new Error(`surface replace: sourceEventSeqs must include every shadowed surface node; missing ${missing.join(', ')}`);
        }
      }

      nextSeq += 1;
      seq = nextSeq - 1;
      ev.seq = seq;
      log.push(ev);
      bySeq.set(ev.seq, ev);
      rebuild();
      return ev;
    },
  };
}

const events = readLog();
const session = makeSession(events);

// Load the plugin's apply() and capture the registered handler.
let handler = null;
const ctx = {
  commands: { register: (def) => { handler = def.handler; return () => {}; } },
  sessions: { get: () => session },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
};

const mod = await import('file:///D:/Work/配置更新/dsh-context-trimmer/index.js');
mod.apply(ctx);

if (!handler) {
  console.log('FAIL: no command handler registered');
  process.exit(1);
}

function run(payload) {
  return handler({ agent: { id: 'session-x' }, rawInput: JSON.stringify(payload) });
}

console.log('=== build ===');
console.log(run({ action: 'build' }).text);

console.log('\n=== list ===');
const listed = run({ action: 'list' });
console.log(listed.text.split('\n').slice(0, 8).join('\n'));

console.log('\n=== list_json (shape) ===');
const j = JSON.parse(run({ action: 'list_json' }).text);
console.log('build:', j.build, '| turns:', Array.isArray(j.turns) ? j.turns.length : 'NOT AN ARRAY');

const turns = j.turns;
const firstToolTurn = turns.find((t) => t.toolCalls > 0);
console.log('\nfirst turn with tools:', firstToolTurn && {
  label: firstToolTurn.label, toolCalls: firstToolTurn.toolCalls,
  logToolCalls: firstToolTurn.logToolCalls,
  startSeq: firstToolTurn.startSeq, endSeq: firstToolTurn.endSeq,
});

if (firstToolTurn) {
  console.log('\n=== trim_tools turn ' + firstToolTurn.label + ' ===');
  const res = run({ action: 'trim_tools', turn: firstToolTurn.label, startSeq: firstToolTurn.startSeq, endSeq: firstToolTurn.endSeq });
  console.log(res.kind, '|', res.text);

  const after = JSON.parse(run({ action: 'list_json' }).text).turns;
  const t = after.find((x) => x.label === firstToolTurn.label);
  console.log('after -> toolCalls:', t && t.toolCalls, 'trimmed:', t && t.trimmed);
}

const injectedTurn = turns.find((t) => t.injectedCount > 0);
if (injectedTurn) {
  console.log('\n=== strip_injected turn ' + injectedTurn.label + ' ===');
  const res = run({ action: 'strip_injected', turn: injectedTurn.label, startSeq: injectedTurn.startSeq, endSeq: injectedTurn.endSeq });
  console.log(res.kind, '|', res.text);
}

console.log('\n=== delete_turn on last turn ===');
const last = turns[turns.length - 1];
const del = run({ action: 'delete_turn', turn: last.label, startSeq: last.startSeq, endSeq: last.endSeq });
console.log(del.kind, '|', del.text);

console.log('\n=== list_json row shape (client card fields) ===');
const dump = JSON.parse(run({ action: 'list_json' }).text);
const shapeOk = dump.turns.every(
  (t) =>
    t !== null &&
    typeof t.label === 'number' &&
    typeof t.startSeq === 'number' &&
    typeof t.endSeq === 'number' &&
    typeof t.removedChars === 'number' &&
    typeof t.toolCalls === 'number' &&
    'userSeq' in t,
);
console.log(`build=${dump.build} turns=${dump.turns.length} shapeOk=${shapeOk}`);
if (!shapeOk) process.exit(1);

console.log('\n=== userSeq-only addressing (no turn label) ===');
const candidate = dump.turns.find((t) => t.toolCalls > 0 && !t.trimmed && !t.deleted);
if (candidate === undefined) {
  console.log('no untrimmed turn with tool calls left; skipped');
} else {
  const res = run({
    action: 'trim_tools',
    userSeq: candidate.userSeq,
    startSeq: candidate.startSeq,
    endSeq: candidate.endSeq,
  });
  const addressed = res.kind === 'success' && res.text.includes(`第 ${candidate.label} 轮`);
  console.log(res.kind, '|', res.text, '| addressed right turn:', addressed);
  if (!addressed) process.exit(1);
}

console.log('\n=== written message ids ===');
const baseSeq = Math.max(...events.map((e) => (typeof e.seq === 'number' ? e.seq : -1)));
const written = session.ownEvents().filter((e) => typeof e.seq === 'number' && e.seq > baseSeq);
let bad = 0;
for (const e of written) {
  if (e.type !== 'user/message') continue;
  const ok = typeof e.data.id === 'string' && e.data.id !== '';
  if (!ok) bad += 1;
  console.log(`seq ${e.seq} ${e.data.source.kind} id=${ok ? e.data.id : 'MISSING'}`);
}
const ids = written.filter((e) => e.type === 'user/message').map((e) => e.data.id);
const unique = new Set(ids).size === ids.length;
console.log(`written user/message: ${ids.length} | unique ids: ${unique} | missing: ${bad}`);
if (bad > 0 || !unique) process.exit(1);
