/**
 * @local/dsh-context-trimmer — Host half.
 *
 * Rewrites the session's *surface* (what the model reads next) without touching
 * the append-only log.
 *
 * Turns are delimited by REAL user messages (`source.kind === 'user'`). The
 * session log also stores plenty of injected context as `user/message` events —
 * `runtime-context`, `time-context`, `skill-catalog`, `model-selection` — and
 * those are NOT questions. They are grouped into the turn they precede, so they
 * can be cleared separately.
 *
 * Everything below reasons in TWO coordinate systems, and keeping them apart is
 * the whole point of this file:
 *
 *   - the LOG is `seq`-ordered and append-only;
 *   - the SURFACE is position-ordered, and a replacement event carries a TAIL
 *     seq yet sits in the MIDDLE of `session.surface.nodes`.
 *
 * So a surface range must never be bounded by comparing `seq` values. Ranges are
 * computed as indices into `session.surface.nodes`, and only turned back into
 * seqs at the two edges (`surfaceOp.startSeq` / `endSeq`). `sourceEventSeqs` is
 * exactly the shadowed slice of that array — the harness's own contract, shared
 * with `@deepseek-ai/dsh-compaction-basic`.
 *
 * Actions:
 *   list            — human-readable report of the current surface.
 *   list_json       — the same data as JSON (the sidebar panel's source).
 *   trim_tools      — collapse a turn's assistant/tool span into one answer.
 *   delete_turn     — replace a whole turn with a removal marker.
 *   strip_injected  — drop a turn's injected context, keeping the question.
 */

export const name = 'dsh-context-trimmer-host';
export const inject = ['commands', 'sessions'];

/**
 * Bumped on every behavioural change. The panel displays this, so "is the Host
 * running the code I just wrote?" stops being a guess — replacing an installed
 * package needs a process restart, and an unchanged number proves it.
 */
const HOST_BUILD = 'b13-fork-history';

/** Text the model reads where a trimmed turn had no answer worth keeping. */
const TRIM_PLACEHOLDER = '（该轮的工具调用过程已由用户手动修剪，内容已从上下文中移除）';
/** `source.kind` of a message this plugin wrote to replace tool chatter. */
const TRIM_KIND = 'context-trimmer-summary';
/** `source.kind` of a message this plugin wrote to stand in for a whole turn. */
const DELETE_KIND = 'context-trimmer-removed';
/** `source.kind` of a message this plugin wrote to blank injected context. */
const INJECT_KIND = 'context-trimmer-stripped';

/**
 * The harness-injected `user/message` kinds this action may clear.
 *
 * Deliberately an allow-list. A `user/message` is not "a question" merely
 * because its `source.kind` is not `'user'`: the same slot carries
 * `compact-checkpoint` (the summary that replaced the whole earlier history),
 * `user-question-reply` (the user's own answer to a question the agent asked),
 * `goal`, `team-message`, `agent-message` and `agent-instructions`. Replacing
 * any of those would delete content the user never asked to lose, so an unknown
 * kind is left alone: invisible to this plugin is a safe default.
 *
 * Every entry below is something the harness `agent.inject()`ed as a notice —
 * a snapshot, a timestamp, a catalog, a cwd notice — never typed text.
 */
const INJECTED_KINDS = new Set([
  'runtime-context',
  'time-context',
  'skill-catalog',
  'skill-invocation',
  'model-selection',
  'working-directory',
  'user-approval',
  'tmux-context',
]);

function surfaceNodes(session) {
  const surface = session && session.surface;
  const nodes = surface && surface.nodes;
  return Array.isArray(nodes) ? nodes.slice() : [];
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
 * The complete event log, inherited prefix included.
 *
 * `ownEvents()` deliberately skips a fork's copied prefix, but that prefix IS
 * conversation the model still reads. A tally taken from `ownEvents()` reports
 * zero tool calls for every question a fork inherited — which reads as "this
 * turn has no tool calls" and hides the trim action entirely.
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

/** A message the human actually typed. */
function isRealUser(ev) {
  if (!ev || ev.type !== 'user/message') return false;
  const src = (ev.data || {}).source;
  if (!src) return true;
  // Our own replacements are not questions: they stand in for content a turn
  // already had, so a turn is never re-opened by them.
  if (src.kind === TRIM_KIND || src.kind === DELETE_KIND || src.kind === INJECT_KIND) {
    return false;
  }
  return src.kind === 'user';
}

/** A replacement this plugin wrote into the surface. */
function isOwnReplacement(ev) {
  if (!ev || ev.type !== 'user/message') return false;
  const src = (ev.data || {}).source;
  return Boolean(src) && (
    src.kind === TRIM_KIND || src.kind === DELETE_KIND || src.kind === INJECT_KIND
  );
}

/** The marker that stands where a removed turn used to be. */
function isRemovedMarker(ev) {
  if (!ev || ev.type !== 'user/message') return false;
  const src = (ev.data || {}).source;
  return Boolean(src) && src.kind === DELETE_KIND;
}

/** Context the harness injected, also stored as a user message. */
function isInjected(ev) {
  if (!ev || ev.type !== 'user/message') return false;
  if (isOwnReplacement(ev)) return false;
  const src = (ev.data || {}).source;
  return Boolean(src) && INJECTED_KINDS.has(src.kind);
}

function injectedKind(ev) {
  const src = (ev.data || {}).source;
  return (src && src.kind) || 'injected';
}

/**
 * The number of the turn that is still open, or null when none is.
 *
 * A turn is open between its `turn/start` and its `turn/end`. Deleting or
 * trimming an open turn would let the rest of that turn append *after* the
 * replacement, so the removed content would come straight back.
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
 * Boundaries are real user messages and this plugin's removal markers. The
 * marker is spliced where the question it replaced used to stand, so keeping it
 * as a row of its own preserves every later label — the panel keeps showing
 * "第 2 轮" for the row that was removed instead of renumbering the chat.
 */
function groupTurns(session, nodes, log) {
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

    if (isRemovedMarker(ev)) {
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

  const openTurn = openTurnNumber(log);
  const lastLabel = groups.length;

  return groups.map((g, index) => {
    const running = !g.removed
      && openTurn !== null
      && index + 1 === lastLabel
      && (g.assistantTurn === null || g.assistantTurn === openTurn);
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
 * questions can share `turn: 1`. Real user messages are the only stable
 * boundaries, and they survive a trim.
 *
 * @returns the half-open seq range, or null when it cannot be bounded.
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

function describeTurn(group, session, log) {
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
  // A marker this plugin wrote during a previous trim of this turn.
  let trimMarked = false;
  const kinds = [];

  for (const ev of group.events) {
    const data = ev.data || {};
    if (isOwnReplacement(ev)) {
      const src = data.source || {};
      if (src.kind === TRIM_KIND) {
        // The marker is spliced where the span it replaced started, so being in
        // this group already attributes it here; the replaced seqs only confirm.
        trimMarked = true;
        const t = previewOf(data.content, 160);
        if (t) assistantText = t;
      } else if (src.kind === INJECT_KIND) {
        injectedStripped = true;
      }
      continue;
    }
    if (isRealUser(ev)) {
      const t = previewOf(data.content, 160);
      if (t) userText = t;
    } else if (isInjected(ev)) {
      injectedChars += textOf(data.content).length;
      const k = injectedKind(ev);
      if (kinds.indexOf(k) === -1) kinds.push(k);
    } else if (ev.type === 'assistant/message') {
      const content = data.message && data.message.content;
      if (hasToolCallBlocks(content)) {
        surfaceToolCalls += content.filter((b) => b && b.type === 'tool-call').length;
      }
      const t = previewOf(content, 160);
      if (t) assistantText = t;
    }
  }

  // What the LOG still holds for this question, shadowed entries included: the
  // gap against the surface is exactly what a previous trim removed.
  //
  // Scoped by the question's own seq range, never by `turn`: a message typed
  // while a turn runs joins that turn, so several questions share one turn
  // number and a per-turn tally would count the same tool calls for each of
  // them (which reads as "everything is trimmed").
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
    // Characters the collapsed tool chatter still occupies in the log; the panel
    // reports it as "what a request no longer carries".
    removedChars: trimmed ? logChars : 0,
    // The marker is authoritative: after a trim the group's own seq range moves
    // to the replacement event, so the log-vs-surface gap alone cannot prove it.
    trimmed,
    injectedCount: group.injected.length,
    injectedKinds: kinds,
    injectedChars,
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
 * A provider rejects a request whose `assistant` message declares `tool_calls`
 * without the matching `tool` result, and equally rejects a `tool` result whose
 * declaration is gone ("对话里的工具调用记录对不上"). A span that ends on an
 * assistant message therefore cannot stop there while that assistant still has
 * results further down — and a span that starts on a result cannot leave its
 * declaration behind.
 *
 * The expansion is bidirectional and re-checked until stable, because pulling
 * in one edge can expose another pairing. Everything here is a POSITION in
 * `index.nodes`: a replacement event's seq says nothing about where it sits.
 *
 * @param floorSeq - first node this span may occupy (the turn's own first node);
 *          a pairing that would reach further back belongs to an earlier
 *          question and must be refused, not folded in.
 * @returns the closed span as `{ start, end }` indices, or null when closing it
 *          would swallow a neighbouring question (which must be trimmed
 *          differently, not corrupted).
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

  // Each pass either closes one more pair or stops; nodes.length is a safe cap.
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

  // The span runs to the group's LAST surface node, not to its last assistant:
  // an assistant that declares tool calls is followed by its results, and
  // stopping on it would orphan them. `group.endSeq` is the last node by
  // position, which is what the span needs; its seq value is irrelevant here.
  return { startSeq, endSeq: group.endSeq };
}

function ok(text) {
  return { kind: 'success', text };
}

function fail(text) {
  return { kind: 'error', text };
}

function findTurn(session, nodes, payload, log) {
  const groups = groupTurns(session, nodes, log).filter((g) => !g.removed);
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

/** Shared refusal for a turn the agent is still writing into. */
function refuseRunning(group, verb) {
  return fail(
    `第 ${group.label} 轮还在进行中（模型仍在生成），现在${verb}会让这一轮后续的内容` +
      '落在标记之后，等于没有修剪。请等该轮结束后再操作。',
  );
}

function trimTools(session, payload) {
  const index = surfaceIndex(session);
  const group = findTurn(session, index.nodes, payload, logEvents(session));
  if (!group) return fail('没有找到要修剪的轮次（请点「刷新」后重试）。');
  if (group.running) return refuseRunning(group, '修剪');

  const raw = toolSpanOf(group);
  if (!raw) return fail(`第 ${group.label} 轮没有可修剪的工具调用。`);

  const unsettled = hasUnsettledToolCall(group);
  if (unsettled) {
    return fail(
      `第 ${group.label} 轮还有工具调用未返回结果（${unsettled.name}），` +
        '现在修剪会让消息失去配对而无法发送。请等该轮结束（工具返回）后再修剪。',
    );
  }

  // Never cut a tool call away from its result: that is exactly the shape a
  // provider rejects with "对话里的工具调用记录对不上". The floor keeps the span
  // inside this question's own nodes, and the answer must stay after the
  // question it answers.
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

  // Every shadowed SURFACE node, in order — the harness validates exactly this
  // slice (`surface.js`: `state.nodes.slice(startIdx, endIdx + 1)`), and citing
  // log-only events instead both bloats the log and misses spliced markers.
  const shadowed = index.nodes.slice(span.start, span.end + 1);
  if (shadowed.length === 0) {
    return fail('要修剪的范围已不在当前表面上，请点「刷新」后重试。');
  }

  // The answer that survives is the LAST assistant message inside the closed
  // span, by position — not the last one in the group, which may now be
  // outside it, and not the one with the largest seq.
  let sourceMessage = null;
  for (let i = span.start; i <= span.end; i += 1) {
    const ev = session.eventAt(index.nodes[i]);
    if (!ev || ev.type !== 'assistant/message') continue;
    const message = ev.data && ev.data.message;
    if (message) sourceMessage = message;
  }
  if (!sourceMessage) return fail('没有找到该轮最终的助手消息，无法安全替换。');

  // The answer text survives; the tool chatter does not.
  const kept = answerBlocks(sourceMessage.content);
  const content = kept.length > 0 ? kept : [{ type: 'text', text: TRIM_PLACEHOLDER }];

  // A replace MUST cite every shadowed surface node, but `assistant/message` may
  // not carry `sourceEventSeqs` at all ("assistant/message embeds its source
  // stream"). The replacement is therefore a user/message with its own source
  // kind, exactly how DSH's own compaction writes its checkpoint.
  session.append(
    'user/message',
    // `id` is not optional: the harness treats a `user/message`'s `data` AS the
    // message and refuses any event without an id ("lacks an identified
    // message"), which makes the whole stored session unreadable on load.
    { id: globalThis.crypto.randomUUID(), role: 'user', content, source: { kind: TRIM_KIND } },
    {
      surfaceOp: { op: 'replace', startSeq: index.nodes[span.start], endSeq: index.nodes[span.end] },
      sourceEventSeqs: shadowed,
    },
  );

  return ok(
    `已修剪第 ${group.label} 轮的工具调用（${shadowed.length} 个表面节点折叠为问答）。`,
  );
}

function deleteTurn(session, payload) {
  const index = surfaceIndex(session);
  const group = findTurn(session, index.nodes, payload, logEvents(session));
  if (!group) return fail('没有找到要删除的轮次（请点「刷新」后重试）。');
  if (group.running) return refuseRunning(group, '删除');

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

  const shadowed = index.nodes.slice(span.start, span.end + 1);
  if (shadowed.length === 0) {
    return fail('要删除的范围已不在当前表面上，请点「刷新」后重试。');
  }

  session.append(
    'user/message',
    {
      id: globalThis.crypto.randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: `（原第 ${group.label} 轮问答已由用户手动移除，内容已从上下文中移除）` }],
      // The marker keeps the identity of the row it stands for, so the panel can
      // name it after the question itself is gone. It is never read as a
      // question: `source.kind` is not `'user'`.
      source: { kind: DELETE_KIND, userSeq: group.userSeq, label: group.label },
    },
    {
      surfaceOp: { op: 'replace', startSeq: index.nodes[span.start], endSeq: index.nodes[span.end] },
      sourceEventSeqs: shadowed,
    },
  );

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

function stripInjected(session, payload) {
  const index = surfaceIndex(session);
  const group = findTurn(session, index.nodes, payload, logEvents(session));
  if (!group) return fail('没有找到该轮次（请点「刷新」后重试）。');
  if (group.injected.length === 0) return fail(`第 ${group.label} 轮没有系统注入上下文。`);

  // Injected context can arrive in several separate bursts inside one turn (a
  // timestamp before the tools, a runtime snapshot after them). Each burst is
  // replaced on its own: one wide range would shadow the answers and tool
  // results between them, which the harness would then refuse.
  const runs = injectedRuns(index.nodes, group.injected);
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

    session.append(
      'user/message',
      {
        id: globalThis.crypto.randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: '（已清除的系统注入上下文）' }],
        source: { kind: INJECT_KIND },
      },
      {
        surfaceOp: { op: 'replace', startSeq: first.seq, endSeq: last.seq },
        sourceEventSeqs: shadowed,
      },
    );

    cleared += run.length;
    shadowedTotal += shadowed.length;
  }

  return ok(
    `已清除第 ${group.label} 轮的系统注入上下文（${cleared} 条，${shadowedTotal} 个节点）。`,
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
      tool =
        r.trimmed
          ? `原 ${r.logToolCalls} 次工具调用 · 现 ${r.toolCalls} 次`
          : `${r.toolCalls} 次工具调用`;
    }
    const inj =
      r.injectedCount > 0
        ? r.injectedStripped
          ? ' · 注入已清除'
          : ` · 注入 ${r.injectedCount} 条(${r.injectedKinds.join('/')}) ~${fmtChars(r.injectedChars)}`
        : '';
    lines.push(`第 ${r.label} 轮 · ${tool}${inj} ${mark}${running}`.trim());
    if (r.user) lines.push(`  问：${r.user}`);
    if (r.assistant) lines.push(`  答：${r.assistant}`);
    lines.push('');
  }
  lines.push('命令：');
  lines.push('  只留问答：/trim_context {"action":"trim_tools","turn":<轮次>}');
  lines.push('  删除整轮：/trim_context {"action":"delete_turn","turn":<轮次>}');
  lines.push('  清注入：  /trim_context {"action":"strip_injected","turn":<轮次>}');
  return lines.join('\n');
}

function listTurns(session) {
  const nodes = surfaceNodes(session);
  const log = logEvents(session);
  const rows = groupTurns(session, nodes, log).map((g) => describeTurn(g, session, log));
  if (rows.length === 0) return ok('当前会话还没有真实提问。');
  return ok(rowLines(rows, nodes));
}

function listTurnsJson(session) {
  const nodes = surfaceNodes(session);
  const log = logEvents(session);
  const rows = groupTurns(session, nodes, log).map((g) => describeTurn(g, session, log));
  // Returned as an object so the panel can show which Host build answered.
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
        if (action === 'trim_tools') return trimTools(session, payload);
        if (action === 'delete_turn') return deleteTurn(session, payload);
        if (action === 'strip_injected') return stripInjected(session, payload);
        if (action === 'build') return ok(`Host 构建版本：${HOST_BUILD}`);
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
