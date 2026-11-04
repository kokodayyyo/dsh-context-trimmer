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
 * Actions:
 *   list            — human-readable report of the current surface.
 *   list_json       — the same data as JSON (the sidebar panel's source).
 *   trim_tools      — collapse a turn's assistant/tool span into one answer.
 *   delete_turn     — collapse a whole turn into a short placeholder.
 *   strip_injected  — drop a turn's injected context, keeping the question.
 */

export const name = 'dsh-context-trimmer-host';
export const inject = ['commands', 'sessions'];

/**
 * Bumped on every behavioural change. The panel displays this, so "is the Host
 * running the code I just wrote?" stops being a guess — replacing an installed
 * package needs a process restart, and an unchanged number proves it.
 */
const HOST_BUILD = 'b10-question-scope';

const PLACEHOLDER = '（该轮对话已由用户手动修剪，内容已从上下文中移除）';
const PLACEHOLDER_MARK = '已由用户手动修剪';
const INJECTED_MARK = '已清除的系统注入上下文';
/** `source.kind` of a message this plugin wrote to replace tool chatter. */
const TRIM_KIND = 'context-trimmer-summary';
/** `source.kind` of a message this plugin wrote to blank a whole turn. */
const DELETE_KIND = 'context-trimmer-removed';
/** `source.kind` of a message this plugin wrote to blank injected context. */
const INJECT_KIND = 'context-trimmer-stripped';

function surfaceNodes(session) {
  const surface = session && session.surface;
  const nodes = surface && surface.nodes;
  return Array.isArray(nodes) ? nodes.slice() : [];
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

function textBlocks(content) {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (b) => b && (b.type === 'text' || b.type === 'reasoning') && typeof b.text === 'string',
  );
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

/** Context the harness injected, also stored as a user message. */
function isInjected(ev) {
  if (!ev || ev.type !== 'user/message') return false;
  if (isOwnReplacement(ev)) return false;
  const src = (ev.data || {}).source;
  return Boolean(src) && src.kind !== 'user';
}

function injectedKind(ev) {
  const src = (ev.data || {}).source;
  return (src && src.kind) || 'injected';
}

/**
 * Group surface nodes into turns, split on REAL user messages.
 *
 * Keying on an event's `turn` field cannot work: `user/message` carries no turn,
 * and every injected pseudo-message would become a turn of its own.
 */
function groupTurns(session, nodes) {
  const groups = [];
  let current = null;
  let pending = [];

  for (const seq of nodes) {
    const ev = session.eventAt(seq);
    if (!ev) continue;
    const type = ev.type;
    if (type !== 'user/message' && type !== 'assistant/message' && type !== 'tool/result') {
      continue;
    }

    if (isRealUser(ev)) {
      current = { assistantTurn: null, userSeq: seq, seqs: [], events: [], injected: [] };
      for (const p of pending) {
        current.seqs.push(p.seq);
        current.events.push(p);
        if (isInjected(p)) current.injected.push(p);
      }
      pending = [];
      current.seqs.push(seq);
      current.events.push(ev);
      groups.push(current);
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

  return groups.map((g, index) => ({
    label: index + 1,
    assistantTurn: g.assistantTurn,
    userSeq: g.userSeq,
    startSeq: g.seqs[0],
    endSeq: g.seqs[g.seqs.length - 1],
    seqs: g.seqs,
    events: g.events,
    injected: g.injected,
  }));
}

/**
 * The log range one question owns: `[this user message, the next one)`.
 *
 * The `turn` number cannot identify a question. It is the agent-loop turn, and
 * a message typed while a turn is still running joins THAT turn, so two
 * questions can share `turn: 1` and every per-turn tally then double-counts.
 * Real user messages are the only stable boundaries, and they survive a trim.
 *
 * @returns the half-open seq range, or null when it cannot be bounded.
 */
function logRangeForUser(session, userSeq) {
  if (typeof userSeq !== 'number') return null;
  if (!session || typeof session.ownEvents !== 'function') return null;
  let next = null;
  let seen = false;
  for (const ev of session.ownEvents()) {
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

/**
 * Whether a replacement this plugin wrote belongs to `group`.
 *
 * A `replace` shadows a range that starts inside the question it edits, but the
 * replacement event itself is appended at the log tail — so on the surface it
 * sits at the end of whichever group happens to be last. Attributing it by
 * position attributes every earlier question's trim to the newest one; the
 * replaced `startSeq` is the question's own identity.
 */
function ownsReplacement(group, ev) {
  const op = ev && ev.surfaceOp;
  if (!op || typeof op !== 'object' || op.op !== 'replace') return false;
  const start = Number(op.startSeq);
  if (!Number.isFinite(start)) return false;
  if (typeof group.userSeq === 'number' && start < group.userSeq) return false;
  return start >= group.startSeq && start <= group.endSeq;
}

function describeTurn(group, session) {
  let userText = '';
  let assistantText = '';
  let surfaceToolCalls = 0;
  let deleted = false;
  let injectedChars = 0;
  let injectedStripped = false;
  // Markers this plugin wrote during a previous trim/strip of this turn.
  let trimMarked = false;
  let deleteMarked = false;
  const kinds = [];

  for (const ev of group.events) {
    const data = ev.data || {};
    if (isOwnReplacement(ev)) {
      const src = data.source || {};
      if (src.kind === TRIM_KIND) {
        // A global replace lands at the log tail, so this group may hold the
        // marker of a LATER question. Only the marker whose replaced range
        // starts inside this group belongs here.
        if (!ownsReplacement(group, ev)) continue;
        trimMarked = true;
        const t = previewOf(data.content, 160);
        if (t) assistantText = t;
      } else if (src.kind === DELETE_KIND) {
        deleteMarked = true;
      } else if (src.kind === INJECT_KIND) {
        injectedStripped = true;
      }
      continue;
    }
    if (isRealUser(ev)) {
      const t = previewOf(data.content, 160);
      if (t) userText = t;
      if (textOf(data.content).indexOf(PLACEHOLDER_MARK) >= 0) deleted = true;
    } else if (isInjected(ev)) {
      const text = textOf(data.content);
      if (text.indexOf(INJECTED_MARK) >= 0) {
        injectedStripped = true;
      } else {
        injectedChars += text.length;
      }
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
  const range = logRangeForUser(session, group.userSeq);
  if (range && session && typeof session.ownEvents === 'function') {
    for (const ev of session.ownEvents()) {
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
    startSeq: group.startSeq,
    endSeq: group.endSeq,
    userSeq: group.userSeq,
    toolCalls: surfaceToolCalls,
    logToolCalls,
    // Characters the collapsed tool chatter still occupies in the log; the panel
    // reports it as "what a request no longer carries".
    removedChars: trimmed ? logChars : 0,
    // The marker is authoritative: after a trim the group's own seq range moves
    // to the replacement event, so the log-vs-surface gap alone cannot prove it.
    trimmed,
    deleted: deleteMarked || deleted,
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
 * Grow a span until it never splits a tool call from its result.
 *
 * A provider rejects a request whose `assistant` message declares `tool_calls`
 * without the matching `tool` result, and equally rejects a `tool` result whose
 * declaration is gone ("对话里的工具调用记录对不上"). A span that ends on an
 * assistant message therefore cannot stop there while that assistant still has
 * results further down — and a span that starts on a result cannot leave its
 * declaration behind.
 *
 * The expansion is bidirectional and re-checked until stable, because pulling
 * in one edge can expose another pairing.
 *
 * @returns the closed span, or null when closing it would swallow a later
 *          question (that turn has to be trimmed differently, not corrupted).
 */
function closeOverToolPairs(session, nodes, startSeq, endSeq, userSeq) {
  if (!session || typeof session.eventAt !== 'function') return { startSeq, endSeq };
  const onSurface = new Map();
  for (const seq of nodes) {
    const ev = session.eventAt(seq);
    if (ev) onSurface.set(seq, ev);
  }

  const callAt = new Map(); // callId -> seq of the declaring assistant/message
  const resultAt = new Map(); // callId -> seq of the answering tool/result
  for (const [seq, ev] of onSurface) {
    if (ev.type === 'assistant/message') {
      for (const id of declaredCallIds(ev)) callAt.set(id, seq);
    } else if (ev.type === 'tool/result') {
      const id = answeredCallId(ev);
      if (id !== null) resultAt.set(id, seq);
    }
  }

  // The next real question bounds the span: crossing it would fold two
  // questions into one replacement and erase a message the user typed.
  //
  // Called through `session.` deliberately: these readers are class methods, and
  // a detached reference loses `this` — `ownEvents()` would then read
  // `this.snapshotEvents` off undefined and throw mid-command.
  let limit = Number.POSITIVE_INFINITY;
  if (typeof session.ownEvents === 'function' && typeof userSeq === 'number') {
    for (const ev of session.ownEvents()) {
      if (ev.type !== 'user/message' || typeof ev.seq !== 'number') continue;
      if (!isRealUser(ev)) continue;
      if (ev.seq > userSeq && ev.seq < limit) limit = ev.seq;
    }
  }

  let start = startSeq;
  let end = endSeq;
  for (let guard = 0; guard < 1000; guard += 1) {
    let changed = false;
    for (const [id, callSeq] of callAt) {
      const resultSeq = resultAt.get(id);
      if (resultSeq === undefined) continue;
      if (callSeq >= start && callSeq <= end) {
        if (resultSeq > end) {
          end = resultSeq;
          changed = true;
        }
        if (resultSeq < start) {
          start = resultSeq;
          changed = true;
        }
      }
    }
    for (const [id, resultSeq] of resultAt) {
      const callSeq = callAt.get(id);
      if (callSeq === undefined) continue;
      if (resultSeq >= start && resultSeq <= end) {
        if (callSeq < start) {
          start = callSeq;
          changed = true;
        }
        if (callSeq > end) {
          end = callSeq;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  if (end >= limit) return null;
  return { startSeq: start, endSeq: end };
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

  let endSeq = null;
  for (const ev of group.events) {
    if (ev.type === 'assistant/message') {
      endSeq = ev.seq;
    }
  }
  if (endSeq === null) endSeq = group.endSeq;
  if (endSeq < startSeq) return null;
  // The LAST surface node, not the last assistant: an assistant that declares
  // tool calls is followed by its results, and stopping on it would orphan them.
  if (group.endSeq > endSeq) endSeq = Math.max(endSeq, group.endSeq);
  return { startSeq, endSeq };
}

function ok(text) {
  return { kind: 'success', text };
}

function fail(text) {
  return { kind: 'error', text };
}

function findTurn(session, nodes, payload) {
  const groups = groupTurns(session, nodes);
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
 * Every event seq a replacement will shadow.
 *
 * The harness computes the shadowed set as a SLICE OF THE FULL EVENT RANGE
 * (`state.nodes.slice(startIdx, endIdx + 1)`), not of the surface message list.
 * That slice also contains `tool/call`, `step/*`, `job/*` and every other event
 * logged between the two edges; naming only the surface messages is rejected
 * with "sourceEventSeqs must include every shadowed surface node".
 *
 * So the cited list must be every event seq in [startSeq, endSeq], in order.
 */
function shadowedSeqsOf(session, startSeq, endSeq) {
  const list = [];
  if (session && typeof session.snapshotEvents === 'function') {
    const from = Number(startSeq);
    const to = Number(endSeq);
    // snapshotEvents(from, toExclusive) — walk the whole log once.
    const events = session.snapshotEvents(0, session.seq);
    for (const ev of events) {
      if (typeof ev.seq !== 'number') continue;
      if (ev.seq >= from && ev.seq <= to) list.push(ev.seq);
    }
  }
  if (list.length === 0) {
    // Fall back to the surface nodes of the same span.
    const nodes = surfaceNodes(session);
    const startIdx = nodes.indexOf(startSeq);
    const endIdx = nodes.indexOf(endSeq);
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) return null;
    return nodes.slice(startIdx, endIdx + 1);
  }
  return list;
}

/**
 * Whether a turn still has a tool call whose result never arrived.
 *
 * Trimming such a turn would leave an `assistant` message that declares
 * `tool_calls` with no matching `tool` message, which strict provider APIs
 * reject with 400. The turn is still running, so it is simply not trimmable yet.
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

function trimTools(session, payload) {
  const nodes = surfaceNodes(session);
  const group = findTurn(session, nodes, payload);
  if (!group) return fail('没有找到要修剪的轮次（请点「刷新」后重试）。');

  const unsettled = hasUnsettledToolCall(group);
  if (unsettled) {
    return fail(
      `第 ${group.label} 轮还有工具调用未返回结果（${unsettled.name}），` +
        '现在修剪会让消息失去配对而无法发送。请等该轮结束（工具返回）后再修剪。',
    );
  }

  const raw = toolSpanOf(group);
  if (!raw) return fail(`第 ${group.label} 轮没有可修剪的工具调用。`);

  // Never cut a tool call away from its result: that is exactly the shape a
  // provider rejects with "对话里的工具调用记录对不上".
  const span = closeOverToolPairs(session, nodes, raw.startSeq, raw.endSeq, group.userSeq);
  if (!span) {
    return fail(
      `第 ${group.label} 轮的工具调用跨越到下一个提问之后，单独修剪会让消息失去配对。` +
        '请改用「删除本轮」，或等该轮结束再修剪。',
    );
  }

  const shadowed = shadowedSeqsOf(session, span.startSeq, span.endSeq);
  if (!shadowed) return fail('要修剪的范围已不在当前表面上，请点「刷新」后重试。');

  // The answer that survives is the LAST assistant message inside the closed
  // span — not the last one in the group, which may now be outside it.
  let sourceMessage = null;
  for (const seq of nodes) {
    if (typeof seq !== 'number' || seq < span.startSeq || seq > span.endSeq) continue;
    const ev = session.eventAt(seq);
    if (!ev || ev.type !== 'assistant/message') continue;
    const message = ev.data && ev.data.message;
    if (message) sourceMessage = message;
  }
  if (!sourceMessage) return fail('没有找到该轮最终的助手消息，无法安全替换。');

  // The answer text survives; the tool chatter does not.
  const kept = textBlocks(sourceMessage.content);
  const content = kept.length > 0 ? kept : [{ type: 'text', text: PLACEHOLDER }];

  // A replace MUST cite every shadowed node, but `assistant/message` may not
  // carry `sourceEventSeqs` at all ("assistant/message embeds its source
  // stream"). The replacement is therefore a user/message with its own
  // source kind, exactly how DSH's own compaction writes its checkpoint.
  session.append(
    'user/message',
    // `id` is not optional: the harness treats a `user/message`'s `data` AS the
    // message and refuses any event without an id ("lacks an identified
    // message"), which makes the whole stored session unreadable on load.
    { id: globalThis.crypto.randomUUID(), role: 'user', content, source: { kind: TRIM_KIND } },
    {
      surfaceOp: { op: 'replace', startSeq: span.startSeq, endSeq: span.endSeq },
      sourceEventSeqs: shadowed,
    },
  );

  return ok(
    `已修剪第 ${group.label} 轮的工具调用（${shadowed.length} 个表面节点折叠为问答）。`,
  );
}

function deleteTurn(session, payload) {
  const nodes = surfaceNodes(session);
  const group = findTurn(session, nodes, payload);
  if (!group) return fail('没有找到要删除的轮次（请点「刷新」后重试）。');

  // A whole-turn removal also has to keep tool calls with their results; the
  // group's own span can end on an assistant whose results sit just after it.
  const span = closeOverToolPairs(session, nodes, group.startSeq, group.endSeq, group.userSeq);
  if (!span) return fail('这一轮的工具调用与结果跨越了边界，删除会让配对断开，已拒绝。');

  const shadowed = shadowedSeqsOf(session, span.startSeq, span.endSeq);
  if (!shadowed) return fail('要删除的范围已不在当前表面上，请点「刷新」后重试。');

  const content = [{ type: 'text', text: `${PLACEHOLDER}（第 ${group.label} 轮）` }];
  session.append(
    'user/message',
    { id: globalThis.crypto.randomUUID(), role: 'user', content, source: { kind: DELETE_KIND } },
    {
      surfaceOp: { op: 'replace', startSeq: span.startSeq, endSeq: span.endSeq },
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
  const nodes = surfaceNodes(session);
  const group = findTurn(session, nodes, payload);
  if (!group) return fail('没有找到该轮次（请点「刷新」后重试）。');
  if (group.injected.length === 0) return fail(`第 ${group.label} 轮没有系统注入上下文。`);

  // Injected context can arrive in several separate bursts inside one turn (a
  // timestamp before the tools, a runtime snapshot after them). Each burst is
  // replaced on its own: one wide range would shadow the answers and tool
  // results between them, which the harness would then refuse.
  const runs = injectedRuns(nodes, group.injected);
  if (runs.length === 0) return fail('注入节点已不在当前表面上，请刷新后重试。');

  let cleared = 0;
  let shadowedTotal = 0;

  for (const run of runs) {
    const first = run[0];
    const last = run[run.length - 1];
    const shadowed = shadowedSeqsOf(session, first.seq, last.seq);
    if (!shadowed) return fail('注入范围已不在日志中，请刷新后重试。');

    session.append(
      'user/message',
      {
        id: globalThis.crypto.randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: `（${INJECTED_MARK}）` }],
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
  const lines = [`共 ${rows.length} 轮真实提问（表面节点 ${nodes.length} 个）`, ''];
  for (const r of rows) {
    const mark = r.deleted ? '【已移除】' : r.trimmed ? '【已修剪】' : '';
    let tool = '无工具调用';
    if (r.logToolCalls > 0) {
      tool =
        r.trimmed || r.deleted
          ? `原 ${r.logToolCalls} 次工具调用 · 现 ${r.toolCalls} 次`
          : `${r.toolCalls} 次工具调用`;
    }
    const inj =
      r.injectedCount > 0
        ? r.injectedStripped
          ? ' · 注入已清除'
          : ` · 注入 ${r.injectedCount} 条(${r.injectedKinds.join('/')}) ~${fmtChars(r.injectedChars)}`
        : '';
    lines.push(`第 ${r.label} 轮 · ${tool}${inj} ${mark}`.trim());
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
  const rows = groupTurns(session, nodes).map((g) => describeTurn(g, session));
  if (rows.length === 0) return ok('当前会话还没有真实提问。');
  return ok(rowLines(rows, nodes));
}

function listTurnsJson(session) {
  const nodes = surfaceNodes(session);
  const rows = groupTurns(session, nodes).map((g) => describeTurn(g, session));
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
