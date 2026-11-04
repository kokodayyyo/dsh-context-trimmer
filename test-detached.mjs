/**
 * Replay the exact failure: exercise `trim_tools` on the real session with a
 * CLASS-based Session stub, so a detached method reference fails the way the
 * live command did ("Cannot read properties of undefined (reading
 * 'snapshotEvents')").
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const LOG = process.argv[2]
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

const SURFACE = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']);
const rows = readLog(LOG);
const events = rows.filter((r) => typeof r.seq === 'number');
const maxSeq = Math.max(...events.map((e) => e.seq));
const bySeq = new Map(events.map((e) => [e.seq, e]));
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

class FakeSession {
  get surface() { return { nodes: nodes.slice() }; }
  get seq() { return virtualSeq; }
  eventAt(s) { return bySeq.get(s); }
  // Real Session.ownEvents delegates to this.snapshotEvents — the exact call
  // that threw when the plugin detached the method.
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

function pairing() {
  const bad = [];
  let open = [];
  for (const seq of nodes) {
    const ev = bySeq.get(seq);
    if (!ev) continue;
    if (ev.type === 'assistant/message') {
      if (open.length) bad.push(`seq ${seq}: ${open.length} unanswered`);
      open = [];
      const c = (ev.data && ev.data.message && ev.data.message.content) || [];
      for (const b of Array.isArray(c) ? c : []) if (b && b.type === 'tool-call' && b.id) open.push(b.id);
    } else if (ev.type === 'tool/result') {
      const id = ev.data && ev.data.message && ev.data.message.toolCallId;
      const at = open.indexOf(id);
      if (at === -1) bad.push(`seq ${seq}: orphan result ${id}`);
      else open.splice(at, 1);
    } else if (ev.type === 'user/message' || ev.type === 'system/message') {
      if (open.length) { bad.push(`seq ${seq}: ${open.length} unanswered`); open = []; }
    }
  }
  if (open.length) bad.push(`tail: ${open.length} unanswered`);
  return bad;
}

const before = pairing();
console.log(`baseline pairing: ${before.length === 0 ? 'OK' : 'BROKEN -> ' + before.join('; ')}`);

const dump = JSON.parse(run({ action: 'list_json' }).text);
console.log(`build=${dump.build} turns=${dump.turns.length}`);

const target = dump.turns.find((t) => t.toolCalls > 0 && !t.trimmed);
if (!target) { console.log('no trimmable turn'); process.exit(1); }
console.log(`\ntarget: turn ${target.label} userSeq=${target.userSeq} toolCalls=${target.toolCalls} span=${target.startSeq}-${target.endSeq}`);

const res = run({ action: 'trim_tools', userSeq: target.userSeq, startSeq: target.startSeq, endSeq: target.endSeq });
console.log(`result: ${res.kind} | ${res.text}`);

const after = pairing();
console.log(`\npairing after: ${after.length === 0 ? 'OK' : 'BROKEN -> ' + after.join('; ')}`);

if (res.kind !== 'success') {
  console.log('\nFAIL: command still rejected');
  process.exit(1);
}
if (after.length !== 0) {
  console.log('\nFAIL: trim broke pairing');
  process.exit(1);
}
console.log('\nPASS');
