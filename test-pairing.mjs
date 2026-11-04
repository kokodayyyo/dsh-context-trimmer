/**
 * Regression bench: a trim must never split a tool call from its result.
 *
 * The shape that broke a real session: an assistant message declaring two
 * tool calls is the last thing inside the chosen span, so the span ends on it
 * while its two tool results sit just after. The provider then sees `tool`
 * messages with no declaration and answers HTTP 400.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const REAL = process.env.PAIR_LOG
  || 'C:/Users/A/.dsh/sessions/--D-Work-~6570~667A~5316dev--/session-28322e96-b969-4200-9fd4-7104675b739b/session.v4.jsonl.zstd';

function readLog(file) {
  const buf = fs.readFileSync(file);
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
  }
  let text = '';
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    const e = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try { text += zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8'); } catch { /* torn */ }
  }
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const rows = readLog(REAL);
const events = rows.filter((r) => typeof r.seq === 'number');
const maxSeq = Math.max(...events.map((e) => e.seq));
const bySeq = new Map(events.map((e) => [e.seq, e]));

const SURFACE = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']);
const nodes = [];
for (const e of events) {
  const op = e.surfaceOp;
  if (op && op.op === 'replace') {
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (nodes[i] >= op.startSeq && nodes[i] <= op.endSeq) nodes.splice(i, 1);
    }
  }
  if (SURFACE.has(e.type) && op !== undefined) nodes.push(e.seq);
}

let virtualSeq = maxSeq;

/**
 * Mirrors the real `Session` CLASS, not a bag of closures.
 *
 * The harness exposes `eventAt`/`ownEvents`/`snapshotEvents` as prototype
 * methods, so `ownEvents()` internally reads `this.snapshotEvents`. An
 * arrow-function stub keeps working when the plugin detaches a reference, which
 * hides exactly the "reading 'snapshotEvents' of undefined" failure that broke a
 * live command. Declaring methods on a class keeps the `this` contract honest.
 */
class FakeSession {
  get surface() { return { nodes: nodes.slice() }; }
  get seq() { return virtualSeq; }
  eventAt(s) { return bySeq.get(s); }
  ownEvents() { return this.snapshotEvents(0); }
  snapshotEvents(from = 0, to = virtualSeq) {
    return events.filter((e) => e.seq >= from && e.seq <= to);
  }
  append(type, data, opts) {
    const op = opts && opts.surfaceOp;
    if (op && op.op === 'replace') {
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (nodes[i] >= op.startSeq && nodes[i] <= op.endSeq) nodes.splice(i, 1);
      }
    }
    virtualSeq += 1;
    const ev = { type, seq: virtualSeq, time: Date.now(), data, surfaceOp: op, sourceEventSeqs: opts && opts.sourceEventSeqs };
    events.push(ev);
    bySeq.set(ev.seq, ev);
    if (SURFACE.has(type)) nodes.push(ev.seq);
    return ev;
  }
}

const session = new FakeSession();

let handler = null;
const ctx = {
  commands: { register: (def) => { handler = def.handler; return () => {}; } },
  sessions: { get: () => session },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
};
const mod = await import('file:///D:/Work/配置更新/dsh-context-trimmer/index.js');
mod.apply(ctx);
const run = (p) => handler({ agent: { id: 'session-x' }, rawInput: JSON.stringify(p) });

/** Strict-provider check over the CURRENT surface. */
function pairingProblems() {
  const callAt = new Map();
  const resultAt = new Map();
  const problems = [];
  let open = [];
  for (const seq of nodes) {
    const ev = bySeq.get(seq);
    if (!ev) continue;
    if (ev.type === 'assistant/message') {
      if (open.length) problems.push(`seq ${seq}: ${open.length} unanswered call(s) before this assistant`);
      open = [];
      const content = (ev.data && ev.data.message && ev.data.message.content) || [];
      for (const b of Array.isArray(content) ? content : []) {
        if (b && b.type === 'tool-call' && b.id) { open.push(b.id); callAt.set(b.id, seq); }
      }
    } else if (ev.type === 'tool/result') {
      const id = ev.data && ev.data.message && ev.data.message.toolCallId;
      const at = open.indexOf(id);
      if (at === -1) problems.push(`seq ${seq}: tool/result ${id} has no declared call`);
      else open.splice(at, 1);
      resultAt.set(id, seq);
    } else if (ev.type === 'user/message' || ev.type === 'system/message' || ev.type === 'developer/message') {
      if (open.length) { problems.push(`seq ${seq}: ${open.length} call(s) left unanswered`); open = []; }
    }
  }
  if (open.length) problems.push(`tail: ${open.length} unanswered call(s)`);
  return problems;
}

console.log('=== baseline (before any trim) ===');
const base = pairingProblems();
console.log(base.length === 0 ? 'surface is pairable' : 'ALREADY BROKEN: ' + base.join('; '));
if (base.length !== 0) process.exit(1);

const dump = JSON.parse(run({ action: 'list_json' }).text);
console.log(`build=${dump.build} questions=${dump.turns.length}`);

console.log('\n=== trim every question that has tool calls ===');
for (const t of dump.turns) {
  const current = JSON.parse(run({ action: 'list_json' }).text).turns
    .find((x) => x.userSeq === t.userSeq);
  if (!current || current.trimmed || current.toolCalls === 0) continue;
  const res = run({ action: 'trim_tools', userSeq: current.userSeq, startSeq: current.startSeq, endSeq: current.endSeq });
  console.log(`  Q${current.label}: ${res.kind} | ${res.text}`);
}

const after = pairingProblems();
console.log('');
console.log('=== pairing after all trims ===');
console.log(after.length === 0 ? 'OK: every call still has its result' : 'BROKEN:\n  ' + after.join('\n  '));
if (after.length !== 0) process.exit(1);
console.log('\nPASS');
