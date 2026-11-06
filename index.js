/**
 * @local/dsh-context-trimmer — Host half.
 *
 * Rewrites the session's *surface* (what the model reads next) without touching
 * the append-only log, using DeepSeek Harness's own compaction contract:
 *
 *   compaction/start → compaction/summary → `compact-checkpoint` user/message → compaction/end
 *
 * That transaction is the only sanctioned shape for "replace a span of the
 * surface with one node". Because we speak it verbatim:
 *
 *   - `@deepseek-ai/dsh-compaction`'s live invariant validates every append, so a
 *     malformed transaction fails at the write site instead of corrupting a
 *     restored session;
 *   - the token meter prices `shadowedTokenCount`, the chat renders the
 *     checkpoint as a compaction node, and other compaction-aware plugins
 *     recognize (or at least do not choke on) the result;
 *   - a concurrent real compaction is mutually exclusive with ours through the
 *     same open-bracket rule.
 *
 * Everything below reasons in TWO coordinate systems, and keeping them apart is
 * the whole point of this file:
 *
 *   - the LOG is `seq`-ordered and append-only;
 *   - the SURFACE is position-ordered, and a replacement event carries a TAIL
 *     seq yet sits in the MIDDLE of `session.surface.nodes`.
 *
 * So surface ranges are computed as indices into `session.surface.nodes`, and
 * only turned back into seqs at the two edges. `shadowedSeqs` is exactly the
 * shadowed slice of that array.
 *
 * Actions:
 *   list            — human-readable report of the current surface.
 *   list_json       — the same data as JSON (the sidebar panel's source).
 *   trim_tools      — collapse a turn's assistant/tool span into one answer.
 *   delete_turn     — replace a whole turn with a removal checkpoint.
 *   strip_injected  — drop a turn's injected context, keeping the question.
 */

export const name = 'dsh-context-trimmer-host';
export const inject = ['commands', 'sessions'];

/**
 * Bumped on every behavioural change. The panel displays this, so "is the Host
 * running the code I just wrote?" stops being a guess — replacing an installed
 * package needs a process restart, and an unchanged number proves it.
 */
const HOST_BUILD = 'b15-answer-preview';

/** `source.kind` of the replacement node inside a compaction transaction. */
const COMPACT_KIND = 'compact-checkpoint';
/** Our identity tag inside `compaction/summary.trimmer.mode`. */
const TRIM_MODE = 'trim';
const REMOVE_MODE = 'remove';
const STRIP_MODE = 'strip';

/**
 * Markers written by the pre-checkpoint build. They are still recognized so a
 * session trimmed by an older install keeps reporting its state correctly; the
 * plugin never writes them again.
 */
const LEGACY_TRIM_KIND = 'context-trimmer-summary';
const LEGACY_DELETE_KIND = 'context-trimmer-removed';
const LEGACY_INJECT_KIND = 'context-trimmer-stripped';

/** Text the model reads where a trimmed turn had no answer worth keeping. */
const TRIM_PLACEHOLDER = '（该轮的工具调用过程已由用户手动修剪，内容已从上下文中移除）';

/**
 * Injected `user/message` kinds this plugin may clear.
 *
 * Deliberately an allow-list. A `user/message` is not "a question" merely
 * because its `source.kind` is not `'user'`: the same slot carries
 * `compact-checkpoint` (a compaction summary), `user-question-reply` (the user's
 * own answer), `goal`, `team-message`, `agent-message` and `agent-instructions`.
 * Replacing any of those would delete content the user never asked to lose.
 *
 * The split below is the important part: the host only re-injects a DURABLE
 * carrier when its content or the underlying state CHANGES, so clearing one can
 * remove that guidance for the rest of the session. Only `time-context` is
 * re-emitted every turn.
 */
const EPHEMERAL_INJECTED = new Set(['time-context']);
const DURABLE_INJECTED = new Set([
  'runtime-context',
  'skill-catalog',
  'skill-invocation',
  'model-selection',
  'working-directory',
  'user-approval',
  'tmux-context',
]);

function isInjectedKind(kind) {
  return EPHEMERAL_INJECTED.has(kind) || DURABLE_INJECTED.has(kind);
}

function surfaceNodes(session) {
  const surface = session && session.surface;
  const nodes = surface && surface.nodes;
  return Array.isArray(nodes) ? nodes.slice() : [];
}

/**
 * The complete event log, inherited prefix included.
 *
 * `ownEvents()` deliberately skips a fork's copied prefix, but that prefix IS
 * conversation the model still reads. A tally taken from `ownEvents()` reports
 * zero tool calls for every question a fork inherited.
 */
function logEvents(session) {
  if (!session) return [];
  if (typeof session.snapshotEvents === 'function') {
    try {
      return session.snapshotEvents();
    } catch {
      /* fall through to the child-owned view */
    }
  }
  if (typeof session.ownEvents === 'function') return session.ownEvents();
  return [];
}

/**
 * The surface as positions plus a seq → position map.
 *
 * `nodes` is the single source of ordering for every range computed below.
 */
function surfaceIndex(session) {
  const nodes = surfaceNodes(session);
  const pos = new Map();
  for (let i = 0; i < nodes.length; i += 1) {
    if (!pos.has(nodes[i])) pos.set(nodes[i], i);
  }
  return { nodes, pos };
}

/**
 * Our own trimmer metadata, keyed by `compactionId`.
 *
 * `compaction/summary` carries a `trimmer` object on the transactions this
 * plugin wrote; a real compaction checkpoint has none, which is exactly how the
 * panel tells "the user trimmed this" from "the harness compacted this".
 */
function trimmerIndex(log) {
  const byId = new Map();
  for (const ev of log) {
    if (ev.type !== 'compaction/summary') continue;
    const data = ev.data || {};
    if (data.trimmer === undefined || typeof data.compactionId !== 'string') continue;
    byId.set(data.compactionId, data.trimmer);
  }
  return byId;
}

/** Our metadata for one checkpoint node, when this plugin wrote it. */
function checkpointMeta(ev, trims) {
  if (!ev || ev.type !== 'user/message') return undefined;
  const src = (ev.data || {}).source;
  if (!src || src.kind !== COMPACT_KIND || typeof src.compactionId !== 'string') return undefined;
  const meta = trims && trims.get(src.compactionId);
  return meta && typeof meta === 'object' ? meta : undefined;
}

/** A replacement written by the pre-checkpoint build. */
function isLegacyReplacement(ev) {
  if (!ev || ev.type !== 'user/message') return false;
  const src = (ev.data || {}).source;
  return Boolean(src) && (
    src.kind === LEGACY_TRIM_KIND ||
    src.kind === LEGACY_DELETE_KIND ||
    src.kind === LEGACY_INJECT_KIND
  );
}

/** The node that stands where a removed turn used to be. */
function isRemovedMarker(ev, trims) {
  if (!ev || ev.type !== 'user/message') return false;
  const src = (ev.data || {}).source;
  if (src && src.kind === LEGACY_DELETE_KIND) return true;
  const meta = checkpointMeta(ev, trims);
  return Boolean(meta) && meta.mode === REMOVE_MODE;
}

/** A message the human actually typed. */
function isRealUser(ev) {
  if (!ev || ev.type !== 'user/message') return false;
  const src = (ev.data || {}).source;
  if (!src) return true;
  // Every replacement kind (legacy or checkpoint) is not a question: it stands
  // in for content a turn already had, so a turn is never re-opened by it.
  if (
    src.kind === LEGACY_TRIM_KIND ||
    src.kind === LEGACY_DELETE_KIND ||
    src.kind === LEGACY_INJECT_KIND ||
    src.kind === COMPACT_KIND
  ) {
    return false;
  }
  return src.kind === 'user';
}

/** Context the harness injected, also stored as a user message. */
function isInjected(ev) {
  if (!ev || ev.type !== 'user/message') return false;
  const src = (ev.data || {}).source;
  if (!src || !isInjectedKind(src.kind)) return false;
  return true;
}

function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join(' ');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return '';
}

/**
 * The visible answer blocks of one assistant message, ready to reuse.
 *
 * Only `text` blocks survive. The replacement is a `user/message`, and every
 * adapter drops `reasoning` from user content — keeping it here would produce an
 * empty message that the provider then skips, silently losing the answer.
 */
function answerBlocks(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '')
    .map((b) => ({ type: 'text', text: b.text }));
}

function hasToolCallBlocks(content) {
  return Array.isArray(content) && content.some((b) => b && b.type === 'tool-call');
}

function previewOf(content, limit) {
  const max = typeof limit === 'number' ? limit : 120;
  const text = textOf(content).replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/**
 * The visible answer text of one assistant message.
 *
 * An assistant message interleaves `reasoning` and `text` blocks, and `textOf`
 * joins every block's `text` — so it returns the model's private reasoning
 * first. A preview must show the answer instead, and a message with no text
 * blocks has no answer to preview.
 */
function answerPreview(content, limit) {
  const max = typeof limit === 'number' ? limit : 120;
  if (!Array.isArray(content)) return '';
  const text = content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/**
 * The compaction transaction currently open in this log, or null.
 *
 * `compaction/start` has no owner once `session/end-seed` marks an inherited
 * cut, mirroring the harness invariant's stale-orphan rule.
 */
function openCompaction(log) {
  let open = null;
  for (const ev of log) {
    if (ev.type === 'compaction/start') {
      open = typeof (ev.data || {}).compactionId === 'string' ? ev.data.compactionId : 'unknown';
    } else if (ev.type === 'compaction/end' || ev.type === 'session/end-seed') {
      open = null;
    }
  }
  return open;
}

/**
 * The number of the turn that is still open, or null when none is.
 *
 * A standalone (`turn: null`) compaction bracket may only be written between
 * turns; inside a turn the bracket must name that turn. So this value is both
 * the "is the session busy" answer and the transaction's `turn` field.
 */
function openTurnNumber(log) {
  let open = null;
  for (const ev of log) {
    if (ev.type === 'turn/start') {
      open = typeof (ev.data || {}).turn === 'number' ? ev.data.turn : null;
    } else if (ev.type === 'turn/end') {
      open = null;
    }
  }
  return open;
}

/**
 * Group surface nodes into turns.
 *
 * Boundaries are real user messages and this plugin's removal checkpoints. The
 * checkpoint is spliced where the question it replaced used to stand, so keeping
 * it as a row of its own preserves every later label.
 */
function groupTurns(session, nodes, log, trims) {
  const groups = [];
  let current = null;
  let pending = [];

  /** Start a row and adopt any context that preceded its boundary. */
  function open(userSeq, removed) {
    const group = {
      assistantTurn: null,
      userSeq,
      removed,
      seqs: [],
      events: [],
      injected: [],
    };
    for (const p of pending) {
      group.seqs.push(p.seq);
      group.events.push(p);
      if (isInjected(p)) group.injected.push(p);
    }
    pending = [];
    return group;
  }

  for (const seq of nodes) {
    const ev = session.eventAt(seq);
    if (!ev) continue;
    const type = ev.type;
    if (type !== 'user/message' && type !== 'assistant/message' && type !== 'tool/result') {
      continue;
    }

    if (isRemovedMarker(ev, trims)) {
      const group = open(null, true);
      group.seqs.push(seq);
      group.events.push(ev);
      groups.push(group);
      current = null;
      continue;
    }

    if (isRealUser(ev)) {
      const group = open(seq, false);
      group.seqs.push(seq);
      group.events.push(ev);
      groups.push(group);
      current = group;
      continue;
    }

    if (current === null) {
      pending.push(ev);
      continue;
    }

    current.seqs.push(seq);
    current.events.push(ev);
    if (isInjected(ev)) {
      current.injected.push(ev);
    } else if (type === 'assistant/message' && current.assistantTurn === null) {
      const evTurn = (ev.data || {}).turn;
      if (typeof evTurn === 'number') current.assistantTurn = evTurn;
    }
  }

  const turn = openTurnNumber(log);
  const lastLabel = groups.length;

  return groups.map((g, index) => {
    const running = !g.removed
      && turn !== null
      && index + 1 === lastLabel
      && (g.assistantTurn === null || g.assistantTurn === turn);
    return {
      label: index + 1,
      removed: g.removed,
      running,
      assistantTurn: g.assistantTurn,
      userSeq: g.userSeq,
      startSeq: g.seqs[0],
      endSeq: g.seqs[g.seqs.length - 1],
      seqs: g.seqs,
      events: g.events,
      injected: g.injected,
    };
  });
}

/**
 * The log range one question owns: `[this user message, the next one)`.
 *
 * The log is seq-ordered, so numeric bounds are correct HERE and only here.
 * The `turn` number cannot identify a question: it is the agent-loop turn, and a
 * message typed while a turn is still running joins THAT turn, so several
 * questions can share `turn: 1`.
 */
function logRangeForUser(log, userSeq) {
  if (typeof userSeq !== 'number') return null;
  let next = null;
  let seen = false;
  for (const ev of log) {
    if (ev.type !== 'user/message' || typeof ev.seq !== 'number') continue;
    if (!isRealUser(ev)) continue;
    if (ev.seq === userSeq) {
      seen = true;
      continue;
    }
    if (seen && ev.seq > userSeq && (next === null || ev.seq < next)) next = ev.seq;
  }
  if (!seen) return null;
  return { from: userSeq, to: next === null ? Number.POSITIVE_INFINITY : next };
}

function describeTurn(group, session, log, trims) {
  if (group.removed) {
    return {
      turn: group.label,
      label: group.label,
      removed: true,
      running: false,
      trimmed: false,
      startSeq: group.startSeq,
      endSeq: group.endSeq,
      nodeCount: group.seqs.length,
      userSeq: null,
      toolCalls: 0,
      logToolCalls: 0,
      removedChars: 0,
      injectedCount: 0,
      injectedKinds: [],
      injectedChars: 0,
      injectedEphemeral: 0,
      injectedDurable: 0,
      injectedStripped: false,
      user: '',
      assistant: '',
    };
  }

  let userText = '';
  let assistantText = '';
  let surfaceToolCalls = 0;
  let injectedChars = 0;
  let injectedStripped = false;
  // A replacement this plugin wrote during a previous trim of this turn.
  let trimMarked = false;
  const kinds = [];
  let injectedEphemeral = 0;
  let injectedDurable = 0;

  for (const ev of group.events) {
    const data = ev.data || {};

    const meta = checkpointMeta(ev, trims);
    if (meta) {
      if (meta.mode === TRIM_MODE) {
        trimMarked = true;
        const t = previewOf(data.content, 160);
        if (t) assistantText = t;
      } else if (meta.mode === STRIP_MODE) {
        injectedStripped = true;
      }
      continue;
    }

    if (isLegacyReplacement(ev)) {
      const src = data.source || {};
      if (src.kind === LEGACY_TRIM_KIND) {
        trimMarked = true;
        const t = previewOf(data.content, 160);
        if (t) assistantText = t;
      } else if (src.kind === LEGACY_INJECT_KIND) {
        injectedStripped = true;
      }
      continue;
    }

    if (isRealUser(ev)) {
      const t = previewOf(data.content, 160);
      if (t) userText = t;
    } else if (isInjected(ev)) {
      const kind = (data.source && data.source.kind) || 'injected';
      injectedChars += textOf(data.content).length;
      if (kinds.indexOf(kind) === -1) kinds.push(kind);
      if (EPHEMERAL_INJECTED.has(kind)) injectedEphemeral += 1;
      else injectedDurable += 1;
    } else if (ev.type === 'assistant/message') {
      const content = data.message && data.message.content;
      if (hasToolCallBlocks(content)) {
        surfaceToolCalls += content.filter((b) => b && b.type === 'tool-call').length;
      }
      const t = answerPreview(content, 160);
      if (t) assistantText = t;
    }
  }

  // What the LOG still holds for this question, shadowed entries included: the
  // gap against the surface is exactly what a previous trim removed.
  let logToolCalls = 0;
  let logChars = 0;
  const range = logRangeForUser(log, group.userSeq);
  if (range) {
    for (const ev of log) {
      if (typeof ev.seq !== 'number' || ev.seq < range.from || ev.seq >= range.to) continue;
      const data = ev.data || {};
      if (ev.type === 'tool/call') {
        logToolCalls += 1;
        logChars += typeof data.arguments === 'string' ? data.arguments.length : 0;
      } else if (ev.type === 'tool/result') {
        logChars += textOf(data.message && data.message.content).length;
      }
    }
  } else {
    // No boundable question (a surface without its user message): fall back to
    // the span this group currently occupies on the surface.
    for (const ev of group.events) {
      if (ev.type === 'tool/call') {
        logToolCalls += 1;
        logChars += typeof (ev.data || {}).arguments === 'string' ? ev.data.arguments.length : 0;
      }
    }
  }
  const trimmed = trimMarked || logToolCalls > surfaceToolCalls;

  return {
    turn: group.label,
    label: group.label,
    removed: false,
    running: group.running,
    startSeq: group.startSeq,
    endSeq: group.endSeq,
    nodeCount: group.seqs.length,
    userSeq: group.userSeq,
    toolCalls: surfaceToolCalls,
    logToolCalls,
    // Characters the collapsed tool chatter still occupies in the log.
    removedChars: trimmed ? logChars : 0,
    trimmed,
    injectedCount: group.injected.length,
    injectedKinds: kinds,
    injectedChars,
    injectedEphemeral,
    injectedDurable,
    injectedStripped,
    user: userText,
    assistant: assistantText,
  };
}

/** Tool-call ids an assistant event declares, in order. */
function declaredCallIds(ev) {
  const content = ev && ev.data && ev.data.message && ev.data.message.content;
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b && b.type === 'tool-call' && b.id).map((b) => b.id);
}

/** The tool-call id a tool/result answers, or null. */
function answeredCallId(ev) {
  const msg = ev && ev.data && ev.data.message;
  const id = msg && msg.toolCallId;
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * Grow a surface span until it never splits a tool call from its result.
 *
 * The expansion is bidirectional and re-checked until stable. Everything here is
 * a POSITION in `index.nodes`: a replacement event's seq says nothing about
 * where it sits.
 *
 * @param floorSeq - first node this span may occupy (the turn's own first node).
 * @returns the closed span as `{ start, end }` indices, or null when closing it
 *          would swallow a neighbouring question.
 */
function closeOverToolPairs(session, index, startSeq, endSeq, userSeq, floorSeq) {
  const { nodes, pos } = index;
  let start = pos.get(startSeq);
  let end = pos.get(endSeq);
  if (start === undefined || end === undefined || start > end) return null;

  const floor = pos.get(floorSeq);
  if (floor === undefined) return null;

  // The next real question bounds the span: crossing it would fold two
  // questions into one replacement and erase a message the user typed.
  const userIdx = typeof userSeq === 'number' ? pos.get(userSeq) : undefined;
  let limit = nodes.length;
  if (userIdx !== undefined) {
    for (let i = userIdx + 1; i < nodes.length; i += 1) {
      if (isRealUser(session.eventAt(nodes[i]))) {
        limit = i;
        break;
      }
    }
  }

  const callAt = new Map(); // callId -> position of the declaring assistant/message
  const resultAt = new Map(); // callId -> position of the answering tool/result
  for (let i = 0; i < nodes.length; i += 1) {
    const ev = session.eventAt(nodes[i]);
    if (!ev) continue;
    if (ev.type === 'assistant/message') {
      for (const id of declaredCallIds(ev)) callAt.set(id, i);
    } else if (ev.type === 'tool/result') {
      const id = answeredCallId(ev);
      if (id !== null) resultAt.set(id, i);
    }
  }

  for (let guard = 0; guard <= nodes.length; guard += 1) {
    let changed = false;
    for (const [id, callIdx] of callAt) {
      const resultIdx = resultAt.get(id);
      if (resultIdx === undefined) continue;
      if (callIdx >= start && callIdx <= end) {
        if (resultIdx > end) {
          end = resultIdx;
          changed = true;
        }
        if (resultIdx < start) {
          start = resultIdx;
          changed = true;
        }
      }
    }
    for (const [id, resultIdx] of resultAt) {
      const callIdx = callAt.get(id);
      if (callIdx === undefined) continue;
      if (resultIdx >= start && resultIdx <= end) {
        if (callIdx < start) {
          start = callIdx;
          changed = true;
        }
        if (callIdx > end) {
          end = callIdx;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  if (end >= limit) return null;
  if (start < floor) return null;
  return { start, end };
}

/** Pick the span that represents this turn's tool chatter. */
function toolSpanOf(group) {
  let startSeq = null;
  for (const ev of group.events) {
    if (
      ev.type === 'assistant/message' &&
      hasToolCallBlocks(ev.data && ev.data.message && ev.data.message.content)
    ) {
      startSeq = ev.seq;
      break;
    }
  }
  if (startSeq === null) return null;
  return { startSeq, endSeq: group.endSeq };
}

function ok(text) {
  return { kind: 'success', text };
}

function fail(text) {
  return { kind: 'error', text };
}

function findTurn(session, nodes, payload, log, trims) {
  const groups = groupTurns(session, nodes, log, trims).filter((g) => !g.removed);
  if (groups.length === 0) return null;

  const raw = payload && payload.label !== undefined ? payload.label : payload && payload.turn;
  const wanted = Number(raw);
  if (Number.isFinite(wanted)) {
    const byLabel = groups.find((g) => g.label === wanted);
    if (byLabel) return byLabel;
  }
  const userSeq = Number(payload && payload.userSeq);
  if (Number.isFinite(userSeq)) {
    const byUser = groups.find((g) => g.userSeq === userSeq);
    if (byUser) return byUser;
  }
  const startSeq = Number(payload && payload.startSeq);
  if (Number.isFinite(startSeq)) {
    const bySeq = groups.find((g) => g.startSeq === startSeq || g.seqs.indexOf(startSeq) !== -1);
    if (bySeq) return bySeq;
  }
  return null;
}

/**
 * Whether a turn still has a tool call whose result never arrived.
 *
 * Trimming such a turn would leave an `assistant` message that declares
 * `tool_calls` with no matching `tool` message, which strict provider APIs
 * reject with 400.
 */
function hasUnsettledToolCall(group) {
  const calls = new Map();
  const results = new Set();
  for (const ev of group.events) {
    const data = ev.data || {};
    if (ev.type === 'assistant/message') {
      const content = data.message && data.message.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b && b.type === 'tool-call' && b.id) calls.set(b.id, b.name || 'tool');
        }
      }
    } else if (ev.type === 'tool/result') {
      const id = data.message && data.message.toolCallId;
      if (id) results.add(id);
    }
  }
  for (const [id, name] of calls) {
    if (!results.has(id)) return { id, name };
  }
  return null;
}

/** Rough token count for a shadowed span, preferring the harness meter. */
function shadowedTokens(ctx, session, seqs) {
  const log = logEvents(session);
  const meter = ctx && typeof ctx.get === 'function' ? ctx.get('tokenMeter') : undefined;
  if (meter && typeof meter.measure === 'function') {
    try {
      const measurement = meter.measure(session);
      if (measurement && Array.isArray(measurement.nodes)) {
        const wanted = new Set(seqs);
        let total = 0;
        for (const node of measurement.nodes) {
          if (!wanted.has(node.seq)) continue;
          const tokens = Number(node.heuristicTokens);
          if (Number.isFinite(tokens) && tokens > 0) total += Math.floor(tokens);
        }
        if (total > 0) return total;
      }
    } catch {
      /* fall through to the character estimate */
    }
  }
  let chars = 0;
  const bySeq = new Map();
  for (const ev of log) {
    if (typeof ev.seq === 'number') bySeq.set(ev.seq, ev);
  }
  for (const seq of seqs) {
    const ev = bySeq.get(seq);
    if (!ev) continue;
    chars += JSON.stringify(ev.data || {}).length;
  }
  return Math.max(0, Math.ceil(chars / 4));
}

/** Provider/model of the session's current request header, when known. */
function headerRoute(session) {
  try {
    if (typeof session.requestHeader !== 'function') return {};
    const header = session.requestHeader();
    const config = header && header.config;
    if (!config) return {};
    if (typeof config.provider !== 'string' || typeof config.model !== 'string') return {};
    return { provider: config.provider, model: config.model };
  } catch {
    return {};
  }
}

/**
 * Append one complete compaction transaction that replaces a surface span.
 *
 * Shape (and field names) are the harness's own — see
 * `@deepseek-ai/dsh-compaction-basic`'s `commitCompactionBody`:
 *
 *   compaction/start   { compactionId, sourceCommandId?, turn }
 *   compaction/summary { compactionId, summary, shadowedRange, shadowedSeqs,
 *                        shadowedTokenCount, trimmer }
 *   user/message       source: { kind: 'compact-checkpoint', compactionId, … }
 *                      surfaceOp: replace(start, end)
 *   compaction/end     { compactionId, turn }
 *
 * If the checkpoint cannot be written the bracket is closed with an `error`
 * end-event, which is what the invariant expects of a failed transaction.
 */
function writeCheckpoint(ctx, session, opts) {
  // The restore path refuses a checkpoint that shadows the protected system
  // head (`compaction cannot shadow the protected system head`), so never open a
  // bracket over it. Checked before `compaction/start` so no bracket is left
  // dangling by the refusal.
  const surface = surfaceNodes(session);
  if (surface.length > 0 && surface[0] === opts.startSeq) {
    const head = session.eventAt(opts.startSeq);
    if (head && head.type === 'system/message') {
      throw new Error('the first surface node is the system prompt and cannot be shadowed');
    }
  }

  const compactionId = globalThis.crypto.randomUUID();
  const sourceCommandId = opts.sourceCommandId;
  const common = {
    compactionId,
    ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
  };
  const route = headerRoute(session);
  const startEvent = session.append('compaction/start', { ...common, turn: opts.turn });
  try {
    const summaryEvent = session.append('compaction/summary', {
      ...common,
      summary: [{ type: 'text', text: opts.summary }],
      shadowedRange: { start: opts.startSeq, end: opts.endSeq },
      shadowedSeqs: opts.shadowed,
      shadowedTokenCount: shadowedTokens(ctx, session, opts.shadowed),
      ...route,
      trimmer: {
        mode: opts.mode,
        label: opts.label,
        userSeq: opts.userSeq === undefined ? null : opts.userSeq,
      },
    });
    session.append(
      'user/message',
      {
        id: globalThis.crypto.randomUUID(),
        role: 'user',
        content: opts.content,
        source: { kind: COMPACT_KIND, ...common },
      },
      {
        surfaceOp: { op: 'replace', startSeq: opts.startSeq, endSeq: opts.endSeq },
        // The harness requires every shadowed surface node; the two lifecycle
        // seqs are cited for provenance, exactly like the stock compaction.
        sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...opts.shadowed],
      },
    );
  } catch (error) {
    try {
      session.append('compaction/end', {
        ...common,
        turn: opts.turn,
        error: error && error.message ? String(error.message) : String(error),
      });
    } catch {
      /* the bracket is already unusable; surface the original failure */
    }
    throw error;
  }
  session.append('compaction/end', { ...common, turn: opts.turn });
}

/** Shared preconditions for every transaction. */
function transactionBlocker(log) {
  const open = openCompaction(log);
  if (open !== null) {
    return '另一个压缩事务尚未结束（compaction/start 没有对应的 end），现在写入会让日志进入非法状态。请稍后重试。';
  }
  return null;
}

/** Shared refusal for a turn the agent is still writing into. */
function refuseRunning(group, verb) {
  return fail(
    `第 ${group.label} 轮还在进行中（模型仍在生成），现在${verb}会让这一轮后续的内容` +
      '落在标记之后，等于没有修剪。请等该轮结束后再操作。',
  );
}

/** Reject a span that would shadow a checkpoint this plugin did not write. */
function foreignCheckpointInside(session, index, span, trims) {
  for (let i = span.start; i <= span.end; i += 1) {
    const ev = session.eventAt(index.nodes[i]);
    if (!ev || ev.type !== 'user/message') continue;
    const src = (ev.data || {}).source;
    if (!src || src.kind !== COMPACT_KIND) continue;
    if (checkpointMeta(ev, trims)) continue;
    return true;
  }
  return false;
}

function trimTools(session, payload, env) {
  const log = logEvents(session);
  const trims = trimmerIndex(log);
  const index = surfaceIndex(session);
  const group = findTurn(session, index.nodes, payload, log, trims);
  if (!group) return fail('没有找到要修剪的轮次（请点「刷新」后重试）。');
  if (group.running) return refuseRunning(group, '修剪');

  const blocked = transactionBlocker(log);
  if (blocked) return fail(blocked);

  const raw = toolSpanOf(group);
  if (!raw) return fail(`第 ${group.label} 轮没有可修剪的工具调用。`);

  const unsettled = hasUnsettledToolCall(group);
  if (unsettled) {
    return fail(
      `第 ${group.label} 轮还有工具调用未返回结果（${unsettled.name}），` +
        '现在修剪会让消息失去配对而无法发送。请等该轮结束（工具返回）后再修剪。',
    );
  }

  const span = closeOverToolPairs(
    session, index, raw.startSeq, raw.endSeq, group.userSeq, group.startSeq,
  );
  if (!span) {
    return fail(
      `第 ${group.label} 轮的工具调用跨越到相邻提问之外，单独修剪会让消息失去配对。` +
        '请改用「删除本轮」，或等该轮结束再修剪。',
    );
  }

  const userIdx = index.pos.get(group.userSeq);
  if (userIdx !== undefined && span.start <= userIdx) {
    return fail(
      `第 ${group.label} 轮里有工具结果属于更早的提问（提问发出时上一轮还在运行），` +
        '折叠它会把上一轮的调用声明一起卷进来。请等该轮结束后重试。',
    );
  }

  if (foreignCheckpointInside(session, index, span, trims)) {
    return fail(
      `第 ${group.label} 轮的范围内包含一条系统压缩检查点，修剪它会让整段摘要消失。已拒绝。`,
    );
  }

  const shadowed = index.nodes.slice(span.start, span.end + 1);
  if (shadowed.length === 0) {
    return fail('要修剪的范围已不在当前表面上，请点「刷新」后重试。');
  }

  // The answer that survives is the LAST assistant message inside the closed
  // span, by position.
  let sourceMessage = null;
  for (let i = span.start; i <= span.end; i += 1) {
    const ev = session.eventAt(index.nodes[i]);
    if (!ev || ev.type !== 'assistant/message') continue;
    const message = ev.data && ev.data.message;
    if (message) sourceMessage = message;
  }
  if (!sourceMessage) return fail('没有找到该轮最终的助手消息，无法安全替换。');

  const kept = answerBlocks(sourceMessage.content);
  const content = kept.length > 0 ? kept : [{ type: 'text', text: TRIM_PLACEHOLDER }];

  writeCheckpoint(env.ctx, session, {
    sourceCommandId: env.commandId,
    turn: env.turn,
    startSeq: index.nodes[span.start],
    endSeq: index.nodes[span.end],
    shadowed,
    content,
    summary: `用户手动修剪第 ${group.label} 轮的工具调用（保留最终回答，折叠 ${shadowed.length} 个表面节点）`,
    mode: TRIM_MODE,
    label: group.label,
    userSeq: group.userSeq,
  });

  return ok(
    `已修剪第 ${group.label} 轮的工具调用（${shadowed.length} 个表面节点折叠为问答）。`,
  );
}

function deleteTurn(session, payload, env) {
  const log = logEvents(session);
  const trims = trimmerIndex(log);
  const index = surfaceIndex(session);
  const group = findTurn(session, index.nodes, payload, log, trims);
  if (!group) return fail('没有找到要删除的轮次（请点「刷新」后重试）。');
  if (group.running) return refuseRunning(group, '删除');

  const blocked = transactionBlocker(log);
  if (blocked) return fail(blocked);

  // A removal has to keep every tool call with its results too. The guard below
  // runs before `closeOverToolPairs` so a half-open turn reports the real reason
  // instead of "crosses the boundary".
  const unsettled = hasUnsettledToolCall(group);
  if (unsettled) {
    return fail(
      `第 ${group.label} 轮还有工具调用未返回结果（${unsettled.name}），现在删除会让` +
        '随后返回的工具结果失去配对、无法发送。请等该轮结束后再删除。',
    );
  }

  const span = closeOverToolPairs(
    session, index, group.startSeq, group.endSeq, group.userSeq, group.startSeq,
  );
  if (!span) {
    return fail(
      '这一轮的工具调用与相邻轮次交错，删除会让配对断开或卷进上一个提问，已拒绝。' +
        '请先修剪相邻轮次再试。',
    );
  }

  if (foreignCheckpointInside(session, index, span, trims)) {
    return fail(
      `第 ${group.label} 轮的范围内包含一条系统压缩检查点，删除它会让整段摘要消失。已拒绝。`,
    );
  }

  const shadowed = index.nodes.slice(span.start, span.end + 1);
  if (shadowed.length === 0) {
    return fail('要删除的范围已不在当前表面上，请点「刷新」后重试。');
  }

  writeCheckpoint(env.ctx, session, {
    sourceCommandId: env.commandId,
    turn: env.turn,
    startSeq: index.nodes[span.start],
    endSeq: index.nodes[span.end],
    shadowed,
    content: [{ type: 'text', text: `（原第 ${group.label} 轮问答已由用户手动移除，内容已从上下文中移除）` }],
    summary: `用户手动移除第 ${group.label} 轮问答（折叠 ${shadowed.length} 个表面节点）`,
    mode: REMOVE_MODE,
    label: group.label,
    userSeq: group.userSeq,
  });

  return ok(
    `已从上下文表面移除第 ${group.label} 轮问答（${shadowed.length} 个表面节点）。`,
  );
}

/** Split injected messages into runs that are contiguous on the surface. */
function injectedRuns(nodes, injected) {
  const runs = [];
  let run = [];
  let expected = null;
  for (const ev of injected) {
    const idx = nodes.indexOf(ev.seq);
    if (idx === -1) continue;
    if (expected !== null && idx !== expected) {
      runs.push(run);
      run = [];
    }
    run.push(ev);
    expected = idx + 1;
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

/** Distinct `source.kind` values among a set of user messages. */
function kindsOf(events) {
  const kinds = [];
  for (const ev of events) {
    const kind = ((ev.data || {}).source || {}).kind;
    if (kind && kinds.indexOf(kind) === -1) kinds.push(kind);
  }
  return kinds;
}

function stripInjected(session, payload, env) {
  const log = logEvents(session);
  const trims = trimmerIndex(log);
  const index = surfaceIndex(session);
  const group = findTurn(session, index.nodes, payload, log, trims);
  if (!group) return fail('没有找到该轮次（请点「刷新」后重试）。');
  if (group.injected.length === 0) return fail(`第 ${group.label} 轮没有系统注入上下文。`);

  const blocked = transactionBlocker(log);
  if (blocked) return fail(blocked);

  // Durable carriers are only re-injected when their content CHANGES, so
  // clearing one can remove that guidance for the rest of the session. Only do
  // it when the caller explicitly asks.
  const includeDurable = payload && payload.includeDurable === true;
  const selected = group.injected.filter((ev) => {
    const kind = ((ev.data || {}).source || {}).kind;
    return includeDurable ? DURABLE_INJECTED.has(kind) : EPHEMERAL_INJECTED.has(kind);
  });
  if (selected.length === 0) {
    if (!includeDurable) {
      const durable = group.injected.filter((ev) => DURABLE_INJECTED.has(((ev.data || {}).source || {}).kind));
      return fail(
        `第 ${group.label} 轮没有可安全清除的瞬时注入（time-context）。` +
          (durable.length > 0
            ? `本轮还有 ${durable.length} 条持久注入（${kindsOf(durable).join(' / ')}）：` +
              '宿主只在其内容变化时重发，清除后本轮之后的会话会失去这段说明。确认后请用 includeDurable 再执行一次。'
            : ''),
      );
    }
    return fail(`第 ${group.label} 轮没有持久注入上下文。`);
  }

  // Separate bursts are replaced one transaction at a time: one wide range would
  // shadow the answers and tool results between them.
  const runs = injectedRuns(index.nodes, selected);
  if (runs.length === 0) return fail('注入节点已不在当前表面上，请刷新后重试。');

  let cleared = 0;
  let shadowedTotal = 0;

  for (const run of runs) {
    const first = run[0];
    const last = run[run.length - 1];
    const start = index.pos.get(first.seq);
    const end = index.pos.get(last.seq);
    if (start === undefined || end === undefined || start > end) {
      return fail('注入范围已不在当前表面上，请刷新后重试。');
    }
    const shadowed = index.nodes.slice(start, end + 1);

    writeCheckpoint(env.ctx, session, {
      sourceCommandId: env.commandId,
      turn: env.turn,
      startSeq: index.nodes[start],
      endSeq: index.nodes[end],
      shadowed,
      content: [{ type: 'text', text: '（已清除的系统注入上下文）' }],
      summary: `用户手动清除第 ${group.label} 轮的系统注入上下文（${run.length} 条）`,
      mode: STRIP_MODE,
      label: group.label,
      userSeq: group.userSeq,
    });

    cleared += run.length;
    shadowedTotal += shadowed.length;
  }

  const scope = includeDurable ? '持久' : '瞬时';
  return ok(
    `已清除第 ${group.label} 轮的${scope}注入（${cleared} 条，${shadowedTotal} 个节点）。`,
  );
}

function fmtChars(n) {
  if (!n || n <= 0) return '0';
  if (n >= 10000) return (n / 1000).toFixed(1) + 'k 字符';
  return n + ' 字符';
}

function rowLines(rows, nodes) {
  const live = rows.filter((r) => !r.removed).length;
  const gone = rows.length - live;
  const lines = [
    `共 ${live} 轮真实提问${gone > 0 ? `（另有 ${gone} 轮已移除）` : ''}（表面节点 ${nodes.length} 个）`,
    '',
  ];
  for (const r of rows) {
    if (r.removed) {
      lines.push(`第 ${r.label} 轮 · 【已移除】`);
      lines.push('');
      continue;
    }
    const mark = r.trimmed ? '【已修剪】' : '';
    const running = r.running ? '【进行中】' : '';
    let tool = '无工具调用';
    if (r.logToolCalls > 0) {
      tool = r.trimmed
        ? `原 ${r.logToolCalls} 次工具调用 · 现 ${r.toolCalls} 次`
        : `${r.toolCalls} 次工具调用`;
    }
    const inj =
      r.injectedCount > 0
        ? r.injectedStripped
          ? ' · 注入已清除'
          : ` · 注入 ${r.injectedCount} 条(${r.injectedKinds.join('/')})${
              r.injectedDurable > 0 ? ` 含持久 ${r.injectedDurable} 条` : ''
            } ~${fmtChars(r.injectedChars)}`
        : '';
    lines.push(`第 ${r.label} 轮 · ${tool}${inj} ${mark}${running}`.trim());
    if (r.user) lines.push(`  问：${r.user}`);
    if (r.assistant) lines.push(`  答：${r.assistant}`);
    lines.push('');
  }
  lines.push('命令：');
  lines.push('  只留问答：/trim_context {"action":"trim_tools","turn":<轮次>}');
  lines.push('  删除整轮：/trim_context {"action":"delete_turn","turn":<轮次>}');
  lines.push('  清瞬时注入：/trim_context {"action":"strip_injected","turn":<轮次>}');
  lines.push('  清持久注入：/trim_context {"action":"strip_injected","turn":<轮次>,"includeDurable":true}');
  return lines.join('\n');
}

function listTurns(session) {
  const nodes = surfaceNodes(session);
  const log = logEvents(session);
  const trims = trimmerIndex(log);
  const rows = groupTurns(session, nodes, log, trims).map((g) => describeTurn(g, session, log, trims));
  if (rows.length === 0) return ok('当前会话还没有真实提问。');
  return ok(rowLines(rows, nodes));
}

function listTurnsJson(session) {
  const nodes = surfaceNodes(session);
  const log = logEvents(session);
  const trims = trimmerIndex(log);
  const rows = groupTurns(session, nodes, log, trims).map((g) => describeTurn(g, session, log, trims));
  return ok(JSON.stringify({ build: HOST_BUILD, turns: rows }));
}

export function apply(ctx) {
  const dispose = ctx.commands.register({
    name: 'trim_context',
    description: '查看并修剪当前会话的上下文（list / trim_tools / delete_turn / strip_injected）',
    handler(invocation) {
      const agent = invocation && invocation.agent;
      const sessionId = agent && agent.id;
      if (!sessionId) return fail('没有拿到会话标识。');

      const session = ctx.sessions.get(sessionId);
      if (!session) return fail(`会话 ${sessionId} 不在内存中（可能已闲置）。`);

      const raw = String(invocation.rawInput || '').trim();
      if (!raw) return fail('缺少参数。用法：/trim_context {"action":"list"}');

      let payload;
      try {
        payload = JSON.parse(raw);
      } catch (err) {
        return fail(`参数不是合法 JSON：${err && err.message ? err.message : err}`);
      }

      const action = payload && payload.action;
      try {
        if (action === 'list') return listTurns(session);
        if (action === 'list_json') return listTurnsJson(session);
        if (action === 'build') return ok(`Host 构建版本：${HOST_BUILD}`);

        const log = logEvents(session);
        const env = {
          ctx,
          commandId: invocation && typeof invocation.commandId === 'string' ? invocation.commandId : undefined,
          turn: openTurnNumber(log),
        };
        if (action === 'trim_tools') return trimTools(session, payload, env);
        if (action === 'delete_turn') return deleteTurn(session, payload, env);
        if (action === 'strip_injected') return stripInjected(session, payload, env);
        return fail(`未知操作：${String(action)}`);
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        return fail(`执行失败：${message}`);
      }
    },
  });

  ctx.effect(() => () => {
    try {
      dispose();
    } catch {
      /* ignore */
    }
  });
}
