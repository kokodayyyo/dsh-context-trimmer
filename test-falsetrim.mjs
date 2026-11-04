/**
 * Regression bench for the c430451e false-trim report.
 *
 * Both questions in that session belong to agent-loop turn 1 (the second was
 * typed while turn 1 was still running), so any per-turn tally reports 70 tool
 * calls for each of them and marks both as trimmed. The tallies must be scoped
 * by the question's own seq range.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const LOG = 'C:/Users/A/.dsh/sessions/--D-Work-~6570~667A~5316dev--/session-c430451e-9cdc-4952-ae77-9afd60e7d5f7/session.v4.jsonl.zstd';

function readLog() {
  const buf = fs.readFileSync(LOG);
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; i++) if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
  let text = '';
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    const e = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try { text += zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8'); } catch { /* torn */ }
  }
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result']);
const rows = readLog();
const events = rows.filter((r) => typeof r.seq === 'number');
const maxSeq = Math.max(...events.map((e) => e.seq));
const bySeq = new Map(events.map((e) => [e.seq, e]));

// Rebuild the model-visible surface exactly as the harness folds it.
const nodes = [];
for (const e of events) {
  const op = e.surfaceOp;
  if (op && op.op === 'replace') {
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (nodes[i] >= op.startSeq && nodes[i] <= op.endSeq) nodes.splice(i, 1);
    }
  }
  if (SURFACE_TYPES.has(e.type) && op !== undefined) nodes.push(e.seq);
}

const session = {
  get surface() { return { nodes: nodes.slice() }; },
  get seq() { return maxSeq; },
  eventAt: (s) => bySeq.get(s),
  ownEvents: () => events.slice(),
  snapshotEvents: (from = 0, to = maxSeq) => events.filter((e) => e.seq >= from && e.seq <= to),
  append(type, data, opts) {
    // Minimal but faithful: shadow the cited range, then land the replacement.
    const op = opts && opts.surfaceOp;
    if (op && op.op === 'replace') {
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (nodes[i] >= op.startSeq && nodes[i] <= op.endSeq) nodes.splice(i, 1);
      }
    }
    const ev = { type, seq: ++virtualSeq, time: Date.now(), data, surfaceOp: op, sourceEventSeqs: opts && opts.sourceEventSeqs };
    events.push(ev);
    bySeq.set(ev.seq, ev);
    if (SURFACE_TYPES.has(type)) nodes.push(ev.seq);
    return ev;
  },
};
let virtualSeq = maxSeq;

let handler = null;
const ctx = {
  commands: { register: (def) => { handler = def.handler; return () => {}; } },
  sessions: { get: () => session },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
};

const mod = await import('file:///D:/Work/配置更新/dsh-context-trimmer/index.js');
mod.apply(ctx);
const run = (payload) => handler({ agent: { id: 'session-x' }, rawInput: JSON.stringify(payload) });

const dump = JSON.parse(run({ action: 'list_json' }).text);
console.log('build:', dump.build);
console.log('turns:', dump.turns.length);
console.log('');
console.log('label  userSeq  surfaceTools  logTools  trimmed  removedChars  user');
for (const t of dump.turns) {
  console.log(
    String(t.label).padEnd(6),
    String(t.userSeq).padEnd(8),
    String(t.toolCalls).padEnd(13),
    String(t.logToolCalls).padEnd(9),
    String(t.trimmed).padEnd(8),
    String(t.removedChars).padEnd(13),
    (t.user || '').slice(0, 34),
  );
}

const falseTrim = dump.turns.filter((t) => t.trimmed || t.deleted || t.removedChars > 0);
const toolTotal = dump.turns.reduce((sum, t) => sum + t.logToolCalls, 0);
console.log('');
console.log(`questions: ${dump.turns.length}`);
console.log(`flagged as trimmed/removed: ${falseTrim.length} (must be 0)`);
console.log(`sum of per-question tool calls: ${toolTotal} (log holds ${events.filter((e) => e.type === 'tool/call').length})`);

const sharedTurn = new Set(events.filter((e) => e.type === 'tool/call').map((e) => e.data.turn));
console.log(`distinct turn numbers among tool/call: ${[...sharedTurn].join(',')} -> per-turn tally cannot split questions`);

if (dump.turns.length !== 2) { console.log('FAIL: expected 2 questions'); process.exit(1); }
if (falseTrim.length !== 0) { console.log('FAIL: false trim report'); process.exit(1); }
if (toolTotal !== 70) { console.log('FAIL: tool calls not attributed exactly once'); process.exit(1); }

// Now actually trim question 1 and prove the report flips for it ALONE.
console.log('\n=== trim_tools on question 1 ===');
const first = dump.turns[0];
const res = run({ action: 'trim_tools', userSeq: first.userSeq, startSeq: first.startSeq, endSeq: first.endSeq });
console.log(res.kind, '|', res.text);

const after = JSON.parse(run({ action: 'list_json' }).text).turns;
console.log('');
console.log('label  surfaceTools  logTools  trimmed  removedChars');
for (const t of after) {
  console.log(
    String(t.label).padEnd(6),
    String(t.toolCalls).padEnd(13),
    String(t.logToolCalls).padEnd(9),
    String(t.trimmed).padEnd(8),
    String(t.removedChars),
  );
}

const q1 = after.find((t) => t.userSeq === first.userSeq);
const q2 = after.find((t) => t.userSeq !== first.userSeq);
const okTrim = q1 && q1.trimmed === true && q1.toolCalls === 0 && q1.logToolCalls === 33;
const okOther = q2 && q2.trimmed === false && q2.toolCalls === 37;
console.log('');
console.log('question 1 flagged trimmed only:', okTrim);
console.log('question 2 left untouched:', okOther);
if (!okTrim || !okOther) { console.log('FAIL: trim report is not scoped to one question'); process.exit(1); }
console.log('\nPASS');
