window.__ModuleLoader__.load({
  id: '@local/dsh-context-trimmer',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const TAB_ID = '@local/dsh-context-trimmer';
    const TAB_KIND = TAB_ID;
    const TAB_TITLE = '上下文修剪';

    const ui = { mode: 'right' };
    const listeners = new Set();
    function getMode() {
      return ui.mode;
    }
    function setMode(next) {
      if (ui.mode === next) return;
      ui.mode = next;
      for (const l of listeners) {
        try { l(); } catch { /* ignore */ }
      }
    }
    function subscribeMode(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }

    let pluginCtx = null;
    let lastOpenError = '';
    let openPanel = () => {
      lastOpenError = '右侧栏服务尚未就绪（sidebarRight 未注入）';
      setMode('fallback');
    };

    function sget(ctx, name) {
      try {
        return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined;
      } catch {
        return undefined;
      }
    }
    function errText(err) {
      return String((err && err.message) || err);
    }

    function fmtChars(n) {
      if (!n || n <= 0) return '0';
      if (n >= 10000) return (n / 1000).toFixed(1) + 'k 字符';
      return n + ' 字符';
    }

    /**
     * The success box an action deserves, or null while the surface still shows
     * the pre-action state.
     *
     * Shared by the render-time watcher and its fallback timer so both judge by
     * the same rule: the timer must never report "nothing changed" for an action
     * the list has already proven.
     */
    function settledFeedback(pending, turns) {
      if (pending.action === 'delete_turn') {
        // A removed turn stops being a question row: the Host splices a removal
        // marker into its place, so the mark keeps the SAME label.
        const tombstoned = turns.some((x) => x.label === pending.label && x.removed);
        const vanished = pending.userSeq !== null
          && !turns.some((x) => x.userSeq === pending.userSeq);
        if (!tombstoned && !vanished) return null;
        return {
          kind: 'ok',
          text: `已移除第 ${pending.label} 轮：原 ${pending.beforeTools} 次工具调用与问答不再进入请求`,
        };
      }

      // Trim and strip keep the question, so the row is still addressed by the
      // user message it starts at.
      if (pending.userSeq === null) return null;
      const now = turns.find((x) => x.userSeq === pending.userSeq);
      if (!now) return null;
      if (
        now.trimmed === pending.beforeTrimmed &&
        now.injectedStripped === pending.beforeStripped
      ) {
        return null;
      }
      if (pending.action === 'strip_injected') {
        return {
          kind: 'ok',
          text: `已清除第 ${pending.label} 轮的系统注入上下文（${pending.beforeInjected} 条）`,
        };
      }
      return {
        kind: 'ok',
        text:
          '已修剪第 ' +
          pending.label +
          ' 轮：工具调用 ' +
          pending.beforeTools +
          ' → ' +
          now.toolCalls +
          (now.removedChars > 0 ? '，约移除 ' + fmtChars(now.removedChars) : ''),
      };
    }

    function previewText(content, maxLen) {
      const limit = typeof maxLen === 'number' ? maxLen : 90;
      if (content == null) return '';
      let str = '';
      if (typeof content === 'string') str = content;
      else if (Array.isArray(content)) {
        str = content.map(b => (b && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join(' ');
      } else if (content && typeof content === 'object' && typeof content.text === 'string') {
        str = content.text;
      }
      str = String(str).replace(/\s+/g, ' ').trim();
      return str.length > limit ? str.slice(0, limit) + '…' : str;
    }

    function textOf(content) {
      if (content == null) return '';
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content.map(b => (b && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join(' ');
      }
      if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
      return '';
    }

    function hasToolCallBlocks(content) {
      return Array.isArray(content) && content.some(b => b && b.type === 'tool-call');
    }

    /**
     * Rebuild the session's SURFACE from the client's event window.
     *
     * The window contains every stored event, shadowed ones included, but each
     * surface event carries the `surfaceOp` that placed it. Honouring those ops
     * locally reproduces what the model will actually read — so a trim shows up
     * here immediately, without asking the Host.
     *
     * A replacement SPLICES IN PLACE (`surface.js`: `nodes.splice(startIdx, …)`),
     * it does not append at the tail: the marker stands where the shadowed range
     * began. Appending it would move every later turn's boundary — which reads
     * as "the trim landed on the wrong turn" for anything but the newest one.
     */
    function surfaceEvents(entries) {
      const visible = [];
      const bySeq = new Map();

      for (const entry of Array.isArray(entries) ? entries : []) {
        if (!entry || entry.type !== 'event' || !entry.event) continue;
        const ev = entry.event;
        if (typeof ev.seq !== 'number') continue;
        bySeq.set(ev.seq, ev);

        const op = ev.surfaceOp;
        if (op && typeof op === 'object' && op.op === 'replace') {
          const start = Number(op.startSeq);
          const end = Number(op.endSeq);
          const startIdx = visible.indexOf(start);
          const endIdx = visible.indexOf(end);
          if (startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx) {
            visible.splice(startIdx, endIdx - startIdx + 1, ev.seq);
            continue;
          }
          // One edge is outside this window: drop the part of the range that is
          // visible and put the marker where that part began. Nothing visible
          // matched, so the range lies before the window — the marker leads it.
          let at = -1;
          for (let i = visible.length - 1; i >= 0; i -= 1) {
            const s = visible[i];
            if (Number.isFinite(start) && Number.isFinite(end) && s >= start && s <= end) {
              at = i;
              visible.splice(i, 1);
            }
          }
          visible.splice(at === -1 ? 0 : at, 0, ev.seq);
          continue;
        }
        visible.push(ev.seq);
      }

      const out = [];
      for (const seq of visible) {
        const ev = bySeq.get(seq);
        if (ev) out.push(ev);
      }
      return out;
    }

    // The three `source.kind` values this plugin writes when it replaces content.
    const TRIM_KIND = 'context-trimmer-summary';
    const DELETE_KIND = 'context-trimmer-removed';
    const INJECT_KIND = 'context-trimmer-stripped';

    /**
     * The harness-injected kinds this panel may offer to clear.
     *
     * An allow-list on purpose: a `user/message` is not "injected context" just
     * because its kind is not `'user'`. The same slot carries
     * `compact-checkpoint` (the summary that replaced the earlier history),
     * `user-question-reply` (the user's own answer), `goal`, `team-message`,
     * `agent-message` and `agent-instructions`; offering to clear those would
     * delete content the user never asked to lose. Every entry here is an
     * `agent.inject()` notice, never typed text.
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

    /** A message the human typed; a user/message of any other kind is not one. */
    function isRealUserEvent(ev) {
      if (!ev || ev.type !== 'user/message') return false;
      if (isOwnReplacement(ev)) return false;
      const src = (ev.data || {}).source;
      return !src || src.kind === 'user';
    }

    /** Harness injection this panel may show (and offer to clear). */
    function isInjectedEvent(ev) {
      if (!ev || ev.type !== 'user/message') return false;
      if (isOwnReplacement(ev)) return false;
      const src = (ev.data || {}).source;
      return Boolean(src) && INJECTED_KINDS.has(src.kind);
    }

    function injectedKindOf(ev) {
      const src = (ev.data || {}).source;
      return (src && src.kind) || 'injected';
    }

    /**
     * Group surface events into turns, split on REAL user messages.
     *
     * Injected context is attached to the turn that follows it rather than
     * becoming a "question" of its own — the log stores runtime snapshots, time
     * stamps and the skill catalog as `user/message` events too.
     */
    function buildTurns(entries) {
      const surface = surfaceEvents(entries);
      const groups = [];
      let current = null;
      let pending = [];

      function blank(seq) {
        return {
          assistantTurn: null,
          firstSeq: seq,
          lastSeq: seq,
          nodes: 1,
          user: '',
          userSeq: null,
          assistant: '',
          removed: false,
          toolCalls: 0,
          injected: [],
          injectedChars: 0,
          injectedStripped: false,
        };
      }

      /**
       * Start a row and adopt any context that preceded its boundary.
       *
       * `firstSeq`/`lastSeq` are POSITIONS in surface order, never min/max: a
       * replacement event carries a tail seq yet sits mid-surface, so "smallest
       * seq" is not "first node".
       */
      function open(seq, userSeq, removed) {
        const row = blank(seq);
        row.userSeq = userSeq;
        row.removed = removed;
        for (const p of pending) {
          if (row.firstSeq === seq) row.firstSeq = p.seq;
          row.lastSeq = p.seq;
          row.nodes += 1;
          if (isInjectedEvent(p)) {
            row.injected.push(injectedKindOf(p));
            row.injectedChars += textOf((p.data || {}).content).length;
          }
        }
        pending = [];
        return row;
      }

      for (const ev of surface) {
        const type = ev.type;
        if (type !== 'user/message' && type !== 'assistant/message' && type !== 'tool/result') continue;

        // A removal marker is a row of its own: it stands where the removed
        // question used to be, so every later label keeps its number.
        if (isRemovedMarker(ev)) {
          const row = open(ev.seq, null, true);
          row.lastSeq = ev.seq;
          groups.push(row);
          current = null;
          continue;
        }

        if (isRealUserEvent(ev)) {
          const row = open(ev.seq, ev.seq, false);
          row.lastSeq = ev.seq;
          const t = previewText((ev.data || {}).content, 160);
          if (t) row.user = t;
          groups.push(row);
          current = row;
          continue;
        }

        if (type === 'user/message') {
          if (current === null) {
            pending.push(ev);
            continue;
          }
          current.lastSeq = ev.seq;
          current.nodes += 1;

          // Our own trim/strip markers carry the outcome, keyed by source kind.
          const src = (ev.data || {}).source || {};
          if (src.kind === INJECT_KIND) {
            current.injectedStripped = true;
            continue;
          }
          if (src.kind === TRIM_KIND) {
            current.trimmedMarker = true;
            const t = previewText((ev.data || {}).content, 160);
            if (t) current.assistant = t;
            continue;
          }
          if (isInjectedEvent(ev)) {
            current.injected.push(injectedKindOf(ev));
            current.injectedChars += textOf((ev.data || {}).content).length;
          }
          continue;
        }

        if (current === null) {
          pending.push(ev);
          continue;
        }
        current.lastSeq = ev.seq;
        current.nodes += 1;

        if (type === 'assistant/message') {
          const data = ev.data || {};
          const content = data.message && data.message.content;
          if (hasToolCallBlocks(content)) {
            current.toolCalls += content.filter(b => b && b.type === 'tool-call').length;
          }
          if (current.assistantTurn === null && typeof data.turn === 'number') {
            current.assistantTurn = data.turn;
          }
          const t = previewText(content, 160);
          if (t) current.assistant = t;
        }
      }

      // Tool calls and characters the LOG still holds for each question
      // (shadowed ones included): the difference against the surface is what a
      // trim removed.
      //
      // Scoped by the question's own seq range, never by `turn`: a message typed
      // while a turn is still running joins that turn, so two questions can share
      // `turn: 1` and a per-turn tally would report the same tool calls for each
      // of them — which renders as "everything has been trimmed".
      const allEvents = [];
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (!entry || entry.type !== 'event' || !entry.event) continue;
        const ev = entry.event;
        if (typeof ev.seq !== 'number') continue;
        allEvents.push(ev);
      }

      // Real user messages are the only stable boundaries, and they survive a trim.
      const userSeqs = allEvents
        .filter((ev) => isRealUserEvent(ev))
        .map((ev) => ev.seq)
        .sort((a, b) => a - b);

      function rangeFor(userSeq) {
        if (typeof userSeq !== 'number') return null;
        const index = userSeqs.indexOf(userSeq);
        if (index === -1) return null;
        return { from: userSeq, to: index + 1 < userSeqs.length ? userSeqs[index + 1] : Infinity };
      }

      // Per-question tallies, keyed by the user message that opened the question.
      const logByUser = new Map();
      for (const ev of allEvents) {
        const data = ev.data || {};
        if (ev.type !== 'tool/call' && ev.type !== 'tool/result') continue;
        for (let i = userSeqs.length - 1; i >= 0; i -= 1) {
          if (userSeqs[i] > ev.seq) continue;
          // The owner is the last user message at or before this event.
          const owner = userSeqs[i];
          const bucket = logByUser.get(owner) || { calls: 0, chars: 0 };
          if (ev.type === 'tool/call') {
            bucket.calls += 1;
            bucket.chars += typeof data.arguments === 'string' ? data.arguments.length : 0;
          } else {
            bucket.chars += textOf(data.message && data.message.content).length;
          }
          logByUser.set(owner, bucket);
          break;
        }
      }

      // The Host logs every command outcome as `command/done`; the client's
      // session.command() only reports "matched", so this is the only place a
      // rejection becomes readable. Only the NEWEST one is offered, and the
      // caller decides whether it postdates its own click — replaying an old
      // failure on every refresh would look like a fresh one.
      let lastCommand = null;
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (!entry || entry.type !== 'event' || !entry.event) continue;
        const ev = entry.event;
        if (ev.type !== 'command/done') continue;
        const data = ev.data || {};
        lastCommand = {
          commandId: data.commandId,
          kind: data.kind,
          text: data.text || '',
          seq: ev.seq,
          time: ev.time,
        };
      }

      // The window is the only view this half has. A `turn/start` with no
      // `turn/end` after it means the last question is still being answered; the
      // Host re-checks the same condition against the whole log before writing.
      let openTurn = null;
      for (const ev of allEvents) {
        if (ev.type === 'turn/start') {
          openTurn = typeof (ev.data || {}).turn === 'number' ? ev.data.turn : null;
        } else if (ev.type === 'turn/end') {
          openTurn = null;
        }
      }
      const lastIndex = groups.length - 1;

      return { turns: groups.map((g, i) => {
        if (g.removed) {
          return {
            turn: i + 1,
            label: i + 1,
            startSeq: g.firstSeq,
            endSeq: g.lastSeq,
            nodeCount: g.nodes,
            userSeq: null,
            toolCalls: 0,
            logToolCalls: 0,
            removedChars: 0,
            trimmed: false,
            removed: true,
            running: false,
            injectedCount: 0,
            injectedKinds: [],
            injectedChars: 0,
            injectedStripped: false,
            user: '',
            assistant: '',
          };
        }
        const range = rangeFor(g.userSeq);
        const bucket = range === null ? undefined : logByUser.get(range.from);
        const logToolCalls = bucket ? bucket.calls : g.toolCalls;
        const turnChars = bucket ? bucket.chars : 0;
        // The replacement marker is authoritative; the count gap is a fallback
        // for surfaces written before this plugin recorded its own kind.
        const trimmed = Boolean(g.trimmedMarker) || logToolCalls > g.toolCalls;
        const running = i === lastIndex
          && openTurn !== null
          && (g.assistantTurn === null || g.assistantTurn === openTurn);
        return {
          turn: i + 1,
          label: i + 1,
          startSeq: g.firstSeq,
          endSeq: g.lastSeq,
          nodeCount: g.nodes,
          userSeq: g.userSeq,
          toolCalls: g.toolCalls,
          logToolCalls,
          removedChars: trimmed ? turnChars : 0,
          trimmed,
          removed: false,
          running,
          injectedCount: g.injected.length,
          injectedKinds: g.injected,
          injectedChars: g.injectedChars,
          injectedStripped: g.injectedStripped,
          user: g.user,
          assistant: g.assistant,
        };
      }), lastCommand };
    }

    function useSessionWindow(ctx, sessionId) {
      const [state, setState] = React.useState({ status: 'idle', window: null, reason: '' });
      const sourceRef = React.useRef(null);
      /**
       * Read the live window without waiting for a re-render. The panel needs
       * this right after it runs a command: the command's own `command/done` row
       * travels through the follow stream, one frame behind the RPC result.
       */
      const getWindow = React.useCallback(() => {
        const source = sourceRef.current;
        try {
          return source && typeof source.getSnapshot === 'function' ? source.getSnapshot() : null;
        } catch {
          return null;
        }
      }, []);
      React.useEffect(() => {
        sourceRef.current = null;
        if (!sessionId) {
          setState({ status: 'error', window: null, reason: '当前没有绑定的会话' });
          return undefined;
        }
        const sessions = sget(ctx, 'sessions');
        if (!sessions || typeof sessions.binding !== 'function') {
          setState({ status: 'error', window: null, reason: '会话服务不可用' });
          return undefined;
        }
        let owned = null;
        let binding;
        try {
          binding = sessions.binding(sessionId);
        } catch {
          binding = undefined;
        }
        if (!binding && typeof sessions.retain === 'function') {
          try {
            // `retain` resolves a session-id STRING (or a `{childSessionId}`
            // subagent address); `{ id }` resolves to nothing.
            owned = sessions.retain(sessionId, { source: 'context-trimmer' });
            binding = owned && owned.binding;
          } catch (err) {
            setState({ status: 'error', window: null, reason: '无法保留会话：' + errText(err) });
            return undefined;
          }
        }
        const release = () => {
          if (owned && typeof owned.release === 'function') {
            try { owned.release(); } catch { /* ignore */ }
          }
          owned = null;
        };
        const source = binding && binding.eventSource;
        if (!source || typeof source.getSnapshot !== 'function') {
          setState({ status: 'error', window: null, reason: '会话事件源尚未就绪' });
          release();
          return undefined;
        }
        sourceRef.current = source;
        const read = () => {
          try {
            setState({ status: 'ready', window: source.getSnapshot(), reason: '' });
          } catch (err) {
            setState({ status: 'error', window: null, reason: errText(err) });
          }
        };
        read();
        const off = typeof source.subscribe === 'function' ? source.subscribe(read) : () => {};
        return () => {
          try { off(); } catch { /* ignore */ }
          sourceRef.current = null;
          release();
        };
      }, [ctx, sessionId]);
      return { ...state, getWindow };
    }

    /**
     * Run a `/trim_context` line through the Session's own command channel.
     *
     * `binding.session.command()` is the entry point the composer itself uses,
     * so it needs no extra remote namespace (this client has no
     * `remote.commands`). The channel is resolved on every call: the binding may
     * only exist after the tab has retained its session.
     */
    function makeRunner(ctx, sessionId) {
      function sessionChannel() {
        try {
          const sessions = sget(ctx, 'sessions');
          if (!sessions || typeof sessions.binding !== 'function') return null;
          const binding = sessions.binding(sessionId);
          const session = binding && binding.session;
          if (session && typeof session.command === 'function') {
            return (line) => session.command(line);
          }
        } catch { /* ignore */ }
        return null;
      }

      function remoteChannel() {
        try {
          const remote = ctx && ctx.remote;
          const commands = remote && remote.commands;
          if (commands && typeof commands.execute === 'function') {
            // The remote takes a session id, the line, and the submitted
            // attachments — the same shape `binding.session.command` sends.
            return (line) => commands.execute(sessionId, line, []);
          }
        } catch { /* ignore */ }
        return null;
      }

      return async function run(line) {
        const channel = sessionChannel();
        if (channel) {
          const res = await channel(line);
          if (res && res.ok === false) {
            throw new Error((res.error && res.error.message) || '命令执行失败');
          }
          const value = res && res.ok === true ? res.value : res;
          // `matched: false` means the Host has no such command registered —
          // the plugin's Host half is not loaded.
          return { matched: !(value && value.matched === false), via: 'session' };
        }
        const fallback = remoteChannel();
        if (fallback) {
          const res = await fallback(line);
          if (res && res.ok === false) {
            throw new Error((res.error && res.error.message) || '命令执行失败');
          }
          const value = res && res.ok === true ? res.value : res;
          const result = value && value.result;
          if (result && result.kind === 'error') throw new Error(result.text || '执行失败');
          return { matched: Boolean(value), via: 'remote' };
        }
        throw new Error(
          '会话命令通道不可用：binding.session.command 取不到。' +
            '请刷新页面后重试；若仍不行，请在输入框直接发送上面给出的命令。',
        );
      };
    }

    /**
     * Read the Host turn dump written AFTER one request.
     *
     * The panel can only *send* commands — `session.command()` reports nothing
     * but `matched` — so a command's text comes back as the durable
     * `command/done` row. That row is the return channel; only a payload that
     * parses to `{ build, turns }` counts, so trim outcomes are skipped.
     *
     * `afterSeq` is the window tail captured BEFORE the request was sent. The
     * window still holds the previous dump, so without that bound this function
     * would answer every refresh with the pre-action answer.
     *
     * @returns `{ dump, seq }` for the newest qualifying row, or null.
     */
    function readHostDump(snapshot, afterSeq) {
      const entries = snapshot && Array.isArray(snapshot.entries) ? snapshot.entries : [];
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        if (!entry || entry.type !== 'event' || !entry.event) continue;
        const ev = entry.event;
        if (ev.type !== 'command/done') continue;
        if (typeof ev.seq !== 'number') continue;
        if (afterSeq !== null && ev.seq <= afterSeq) continue;
        const data = ev.data || {};
        if (data.kind !== 'success' || typeof data.text !== 'string') continue;
        const text = data.text.trim();
        if (text.charAt(0) !== '{') continue;
        try {
          const parsed = JSON.parse(text);
          if (parsed && Array.isArray(parsed.turns)) return { dump: parsed, seq: ev.seq };
        } catch { /* not the Host dump */ }
      }
      return null;
    }

    /**
     * Ask the Host for its own turn list.
     *
     * The client window starts at the conversation tail (pages of ≥50 messages
     * and 2 turns), so a long session would render two or three cards labelled
     * "第 1 轮…" and every action would address the wrong turn. `list_json` runs
     * against the Host's complete log, so one call lists every turn under its
     * real number, no matter how far the chat has been scrolled.
     */
    /** Last event seq in the window; the cache key for the last Host dump. */
    function windowTailSeq(snapshot) {
      const entries = snapshot && Array.isArray(snapshot.entries) ? snapshot.entries : [];
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        if (entry && entry.type === 'event' && entry.event && typeof entry.event.seq === 'number') {
          return entry.event.seq;
        }
      }
      return null;
    }

    /**
     * The command channel appends `command/run` + `command/done` to the log, so
     * asking costs two events. Reuse the answer while the window tail is
     * unchanged: re-opening the panel must not litter the transcript.
     */
    const hostTurnCache = new Map();

    function useHostTurns(params) {
      const { sessionId, enabled, refreshKey, getWindow, run } = params;
      const [state, setState] = React.useState({ status: 'idle', turns: null, build: null, error: '' });
      const busy = React.useRef(false);
      /** Whether a forced refresh arrived while a load was in flight. */
      const queued = React.useRef(false);
      /** Stable handle on `load`, so its own tail can re-run it. */
      const loadRef = React.useRef(null);
      const alive = React.useRef(true);
      const generation = React.useRef(0);
      // Held in refs so `load` stays identity-stable: the effect must fire on
      // "a session opened / the user asked to refresh", never once per render.
      const runRef = React.useRef(run);
      const getWindowRef = React.useRef(getWindow);
      const sessionIdRef = React.useRef(sessionId);
      runRef.current = run;
      getWindowRef.current = getWindow;
      sessionIdRef.current = sessionId;

      React.useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      React.useEffect(() => {
        // A different session invalidates whatever the previous fetch returns.
        generation.current += 1;
        setState({ status: 'idle', turns: null, build: null, error: '' });
      }, [sessionId]);

      const load = React.useCallback(async (force) => {
        if (busy.current) {
          // A forced refresh that arrives mid-flight (an action finishing while
          // the first load runs) must not be dropped, or the panel settles on
          // pre-action data.
          if (force) queued.current = true;
          return;
        }
        busy.current = true;
        const mine = generation.current;
        const live = () => alive.current && generation.current === mine;
        const sessionKey = sessionIdRef.current;
        setState((prev) => (live() ? { ...prev, status: prev.turns ? 'refreshing' : 'loading', error: '' } : prev));
        try {
          const before = getWindowRef.current ? getWindowRef.current() : null;
          const beforeTail = windowTailSeq(before);
          const cached = sessionKey && !force ? hostTurnCache.get(sessionKey) : undefined;
          if (cached && beforeTail !== null && cached.head === beforeTail) {
            if (live()) {
              setState({ status: 'ready', turns: cached.turns, build: cached.build, error: '' });
            }
            return;
          }
          const res = await runRef.current('/trim_context ' + JSON.stringify({ action: 'list_json' }));
          if (!live()) return;
          if (res && res.matched === false) {
            setState((prev) => ({
              ...prev,
              status: 'error',
              error: 'Host 没有注册 /trim_context 命令（插件是否已加载？）',
            }));
            return;
          }
          let found = null;
          // The dump travels through the follow stream: it can land one frame
          // after the RPC resolves, so poll the live window briefly. Only a row
          // written after `beforeTail` can answer THIS request.
          for (let attempt = 0; attempt < 12 && found === null; attempt += 1) {
            found = readHostDump(getWindowRef.current ? getWindowRef.current() : null, beforeTail);
            if (found === null) await new Promise((resolve) => setTimeout(resolve, 60));
          }
          if (!live()) return;
          if (found === null) {
            setState((prev) => ({
              ...prev,
              status: 'error',
              error: '没读到 Host 本次返回的轮次数据',
            }));
            return;
          }
          const dump = found.dump;
          const build = typeof dump.build === 'string' ? dump.build : null;
          if (sessionKey) {
            const head = windowTailSeq(getWindowRef.current ? getWindowRef.current() : null);
            hostTurnCache.set(sessionKey, { head, turns: dump.turns, build });
            if (hostTurnCache.size > 32) {
              hostTurnCache.delete(hostTurnCache.keys().next().value);
            }
          }
          setState({ status: 'ready', turns: dump.turns, build, error: '' });
        } catch (err) {
          if (live()) setState((prev) => ({ ...prev, status: 'error', error: errText(err) }));
        } finally {
          busy.current = false;
          if (queued.current) {
            queued.current = false;
            if (loadRef.current) void loadRef.current(true);
          }
        }
      }, []);
      loadRef.current = load;

      const loadedKey = React.useRef(null);
      React.useEffect(() => {
        // A different session is a different question — never let the previous
        // session's `refreshKey` suppress its first fetch.
        loadedKey.current = null;
      }, [sessionId]);

      React.useEffect(() => {
        if (!enabled) return;
        // Re-opening the panel reuses the cache; an explicit refresh (the 刷新
        // button, or an action that just landed) always re-reads the Host.
        const force = loadedKey.current !== null && loadedKey.current !== refreshKey;
        loadedKey.current = refreshKey;
        void load(force);
      }, [enabled, refreshKey, sessionId, load]);

      return { state, reload: load };
    }

    const S = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        height: '100%',
        boxSizing: 'border-box',
        padding: '10px 12px',
        gap: '8px',
        fontSize: '12px',
        color: 'var(--dsw-alias-text-primary, #1e293b)',
      },
      head: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flexWrap: 'wrap',
        paddingBottom: '8px',
        borderBottom: '1px solid var(--dsw-alias-border-subtle, rgba(0,0,0,0.08))',
      },
      list: {
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      },
      card: {
        border: '1px solid var(--dsw-alias-border-subtle, rgba(0,0,0,0.1))',
        borderRadius: '8px',
        padding: '8px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: '5px',
      },
      cardDone: {
        border: '1px solid rgba(16,185,129,0.35)',
        background: 'rgba(16,185,129,0.04)',
      },
      badge: {
        display: 'inline-block',
        padding: '1px 6px',
        borderRadius: '999px',
        fontSize: '11px',
        background: 'rgba(59,130,246,0.12)',
        color: '#2563eb',
      },
      badgeWarn: {
        display: 'inline-block',
        padding: '1px 6px',
        borderRadius: '999px',
        fontSize: '11px',
        background: 'rgba(245,158,11,0.14)',
        color: '#b45309',
      },
      badgeDone: {
        display: 'inline-block',
        padding: '1px 6px',
        borderRadius: '999px',
        fontSize: '11px',
        background: 'rgba(16,185,129,0.15)',
        color: '#047857',
        fontWeight: 600,
      },
      badgeInj: {
        display: 'inline-block',
        padding: '1px 6px',
        borderRadius: '999px',
        fontSize: '11px',
        background: 'rgba(139,92,246,0.14)',
        color: '#6d28d9',
      },
      strike: { textDecoration: 'line-through', opacity: 0.6 },
      btn: {
        padding: '2px 8px',
        borderRadius: '6px',
        fontSize: '11px',
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-subtle, #cbd5e1)',
        background: 'transparent',
        color: 'inherit',
      },
      btnDanger: {
        padding: '2px 8px',
        borderRadius: '6px',
        fontSize: '11px',
        cursor: 'pointer',
        border: '1px solid rgba(239,68,68,0.35)',
        background: 'transparent',
        color: '#dc2626',
      },
      note: { fontSize: '11px', color: 'var(--dsw-alias-text-muted, #94a3b8)' },
      err: {
        padding: '6px 8px',
        borderRadius: '6px',
        fontSize: '11px',
        background: 'rgba(239,68,68,0.08)',
        color: '#dc2626',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
      },
      okBox: {
        padding: '6px 8px',
        borderRadius: '6px',
        fontSize: '11px',
        background: 'rgba(16,185,129,0.12)',
        color: '#047857',
        whiteSpace: 'pre-wrap',
        fontWeight: 600,
      },
      warnBox: {
        padding: '6px 8px',
        borderRadius: '6px',
        fontSize: '11px',
        background: 'rgba(245,158,11,0.12)',
        color: '#b45309',
        whiteSpace: 'pre-wrap',
        fontWeight: 600,
      },
      code: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '11px',
        background: 'rgba(0,0,0,0.06)',
        padding: '6px 8px',
        borderRadius: '6px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        userSelect: 'all',
      },
    };

    function TrimmerView(props) {
      const ctx = props.ctx || pluginCtx;
      const sessionId = props.sessionId;
      const winState = useSessionWindow(ctx, sessionId);

      const [busy, setBusy] = React.useState(false);
      const [feedback, setFeedback] = React.useState(null);
      const [manual, setManual] = React.useState(null);
      const [tick, setTick] = React.useState(0);
      // Only failures logged after this instant belong to the user's own click;
      // older rejections stay in the log and must not resurface as "just now".
      const [commandCutoff, setCommandCutoff] = React.useState(0);

      const built = React.useMemo(
        () => buildTurns(winState.window && winState.window.entries),
        [winState.window, tick],
      );
      const lastCommand = built.lastCommand;

      const run = React.useMemo(() => makeRunner(ctx, sessionId), [ctx, sessionId]);

      // The window is turn-aligned but starts at the tail. Always ask the Host
      // (which holds the whole log) instead of guessing: it is the single source
      // of turn numbering, and its build string is the only way to tell which
      // Host half is actually loaded.
      const windowHasMore = Boolean(winState.window && winState.window.hasMore);
      const host = useHostTurns({
        sessionId,
        enabled: winState.status === 'ready',
        refreshKey: tick,
        getWindow: winState.getWindow,
        run,
      });
      const usingHost = Array.isArray(host.state.turns);
      const turns = usingHost ? host.state.turns : built.turns;

      // A command reports only "matched", never its own outcome, so success is
      // decided by observing the surface actually change.
      const pendingRef = React.useRef(null);
      /** Per-action token: a stale fallback timer must never settle a newer click. */
      const actionSeq = React.useRef(0);
      /** Newest rows for the timer, which closes over a stale render. */
      const turnsRef = React.useRef(turns);
      turnsRef.current = turns;

      React.useEffect(() => {
        const p = pendingRef.current;
        if (!p) return;
        const settled = settledFeedback(p, turns);
        if (!settled) return;
        pendingRef.current = null;
        setFeedback(settled);
      }, [turns]);

      async function act(action, t) {
        if (t.removed) return;
        const isDelete = action === 'delete_turn';
        const isStrip = action === 'strip_injected';
        const tools = Math.max(t.logToolCalls || 0, t.toolCalls || 0);

        if (t.running) {
          setFeedback({
            kind: 'warn',
            text: `第 ${t.label} 轮还在进行中（模型仍在生成）。等这一轮结束后再操作，否则本轮后续内容会落在标记之后。`,
          });
          return;
        }
        if (!isDelete && !isStrip && tools === 0) {
          setFeedback({ kind: 'warn', text: `第 ${t.label} 轮没有工具调用，无需修剪。` });
          return;
        }
        if (isStrip && !(t.injectedCount > 0)) {
          setFeedback({ kind: 'warn', text: `第 ${t.label} 轮没有系统注入上下文。` });
          return;
        }

        let question;
        if (isDelete) question = `把第 ${t.label} 轮问答整轮从上下文移除？`;
        else if (isStrip) question = `清除第 ${t.label} 轮的 ${t.injectedCount} 条系统注入上下文（运行时快照/时间戳/技能清单等），保留你的提问？`;
        else question = `把第 ${t.label} 轮中间的 ${tools} 次工具调用与结果从上下文移除，只保留提问与最终回答？`;

        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          const yes = window.confirm(question + '\n\n（只改变模型后续看到的内容；原始日志仍完整保留，可回看）');
          if (!yes) return;
        }

        // Address the turn by the user message it starts at. The Host numbers
        // turns 1..N over the whole log, so a window-relative label would hit a
        // different turn as soon as the window starts anywhere but the head.
        const payload = {
          action,
          userSeq: typeof t.userSeq === 'number' ? t.userSeq : undefined,
          startSeq: t.startSeq,
          endSeq: t.endSeq,
        };
        const line = '/trim_context ' + JSON.stringify(payload);
        setFeedback(null);
        setManual(null);
        setBusy(true);
        const actionId = actionSeq.current + 1;
        actionSeq.current = actionId;
        pendingRef.current = {
          id: actionId,
          label: t.label,
          userSeq: typeof t.userSeq === 'number' ? t.userSeq : null,
          action,
          beforeTrimmed: Boolean(t.trimmed),
          beforeStripped: Boolean(t.injectedStripped),
          beforeInjected: t.injectedCount || 0,
          beforeTools: tools,
        };
        // Only a command failure logged AFTER this click may be shown as the
        // cause; the log also holds older rejections.
        setCommandCutoff(Date.now());
        try {
          const res = await run(line);
          if (res && res.matched === false) {
            pendingRef.current = null;
            setFeedback({
              kind: 'err',
              text: `Host 没有注册 /trim_context 命令（matched: false）。插件是否已加载？`,
            });
            return;
          }
          setTick((x) => x + 1);
        } catch (err) {
          pendingRef.current = null;
          setManual({ line, reason: '执行失败：' + errText(err) + '\n可在输入框直接发送下面这行命令：' });
        } finally {
          setBusy(false);
        }

        if (typeof setTimeout === 'function') {
          setTimeout(() => {
            const p = pendingRef.current;
            // A newer click owns the slot; a stale timer must not settle it.
            if (!p || p.id !== actionId) return;
            // Judge once more against the newest rows: the watcher may have
            // missed a frame that arrived after its last render.
            const settled = settledFeedback(p, turnsRef.current);
            pendingRef.current = null;
            if (settled) {
              setFeedback(settled);
              return;
            }
            setFeedback({
              kind: 'warn',
              text:
                `命令已发送，但第 ${p.label} 轮的上下文表面没有变化。` +
                '如果下方出现了 Host 的拒绝原因，那是本次操作的失败说明。',
            });
          }, 1800);
        }
      }

      function body() {
        if (winState.status === 'error') {
          return h('div', { style: S.err }, winState.reason || '无法读取会话事件');
        }
        if (winState.status !== 'ready') {
          return h('div', { style: S.note }, '正在读取会话上下文…');
        }
        if (turns.length === 0) {
          return h('div', { style: S.note }, '当前还没有可修剪的问答轮次。');
        }

        return turns.map((t) => {
          if (t.removed) {
            // A removal marker: the row keeps its number so the turns after it
            // never appear to shift, but there is nothing left to act on.
            return h('div', {
              key: 'turn-' + t.label + '-' + t.startSeq,
              style: { ...S.card, ...S.cardDone },
            },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
                h('strong', null, `第 ${t.label} 轮`),
                h('span', { style: S.badgeDone }, '【已移除】'),
                h('span', { style: { marginLeft: 'auto', ...S.note } }, `${t.nodeCount} 个节点`)
              ),
              h('div', { style: S.note }, '这一轮问答已从模型上下文中移除；原始日志仍完整保留。')
            );
          }

          const done = Boolean(t.trimmed);
          const shown = Math.max(t.logToolCalls || 0, t.toolCalls || 0);
          const hasTools = shown > 0;
          const toolLabel = hasTools ? `${shown} 次工具调用` : '无工具调用';
          const saved = t.removedChars > 0 ? ` · 已移除 ~${fmtChars(t.removedChars)}` : '';
          const hasInjected = (t.injectedCount || 0) > 0;
          const blocked = busy || Boolean(t.running);
          return h('div', {
            key: 'turn-' + t.label + '-' + t.startSeq,
            style: done ? { ...S.card, ...S.cardDone } : S.card,
          },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
              h('strong', null, `第 ${t.label} 轮`),
              h('span', { style: done ? { ...S.badgeWarn, ...S.strike } : S.badgeWarn }, toolLabel),
              hasInjected
                ? h('span', { style: S.badgeInj },
                    `系统注入 ${t.injectedCount} 条 · ~${fmtChars(t.injectedChars)}`)
                : null,
              t.injectedStripped ? h('span', { style: S.badgeDone }, '【注入已清】') : null,
              t.trimmed ? h('span', { style: S.badgeDone }, '【已修剪】' + saved) : null,
              t.running ? h('span', { style: S.badge }, '【进行中】') : null,
              h('span', { style: { marginLeft: 'auto', ...S.note } }, `${t.nodeCount} 个节点`)
            ),
            t.user ? h('div', null, h('strong', null, '提问：'), previewText(t.user, 100)) : null,
            hasInjected
              ? h('div', { style: S.note },
                  '注入项：' + (t.injectedKinds || []).join('、') + '（非你的提问）')
              : null,
            t.assistant ? h('div', null, h('strong', null, '回复：'), previewText(t.assistant, 100)) : null,
            h('div', { style: { display: 'flex', gap: '6px', justifyContent: 'flex-end', flexWrap: 'wrap' } },
              hasTools
                ? h('button', {
                    key: 'trim',
                    type: 'button',
                    style: S.btn,
                    disabled: blocked,
                    title: t.running
                      ? '这一轮还在进行中，结束后才能修剪'
                      : '把本轮中间的工具调用与结果从模型上下文中移除，只保留提问与最终回答',
                    onClick: () => act('trim_tools', t),
                  }, '✂️ 只留问答')
                : null,
              hasInjected
                ? h('button', {
                    key: 'strip',
                    type: 'button',
                    style: S.btn,
                    disabled: blocked,
                    title: '清除本轮的系统注入上下文（运行时快照、时间戳、技能清单等），保留你的提问',
                    onClick: () => act('strip_injected', t),
                  }, '🧽 清注入')
                : null,
              h('button', {
                key: 'del',
                type: 'button',
                style: S.btnDanger,
                disabled: blocked,
                title: t.running
                  ? '这一轮还在进行中，结束后才能删除'
                  : '把本轮问答从模型上下文中移除',
                onClick: () => act('delete_turn', t),
              }, '🗑 删除本轮')
            )
          );
        });
      }

      const doneCount = turns.filter((t) => t.trimmed || t.removed).length;
      const savedChars = turns.reduce((sum, t) => sum + (t.removedChars || 0), 0);

      return h('div', { style: S.root },
        h('div', { style: S.head },
          h('span', { 'aria-hidden': 'true' }, '✂️'),
          h('strong', null, '上下文修剪器'),
          h('span', { style: S.badge }, `${turns.length} 轮`),
          usingHost
            ? h('span', {
                style: S.badgeDone,
                title: '来自 Host 的完整日志；与聊天区滚到哪无关',
              }, '全量 · ' + (host.state.build || '?'))
            : windowHasMore
              ? h('span', { style: S.badgeWarn, title: '只统计聊天区已加载的窗口，轮次编号是窗口内的' }, '窗口内')
              : h('span', { style: S.badgeWarn, title: 'Host 轮次尚未返回，先显示本地窗口数据' }, '本地'),
          h('button', {
            type: 'button',
            style: { ...S.btn, marginLeft: 'auto' },
            disabled: busy,
            title: '重新读取会话表面',
            onClick: () => setTick((x) => x + 1),
          }, '刷新')
        ),
        usingHost
          ? null
          : h('div', { style: S.note },
              host.state.status === 'error'
                ? '未能读到 Host 的完整轮次（' +
                  (host.state.error || '未返回') +
                  '），下面只列出聊天区已加载窗口内的轮次。'
                : '正在向 Host 读取完整轮次…'),
        doneCount > 0 || savedChars > 0
          ? h('div', { style: S.note },
              `已修剪 ${doneCount} 轮` +
                (savedChars > 0 ? ` · 之后每次请求少带 ~${fmtChars(savedChars)}` : '') +
                '（右上角的占用圈在下次发送消息后才会更新）')
          : null,
        lastOpenError ? h('div', { style: S.err }, lastOpenError) : null,
        lastCommand &&
        lastCommand.kind === 'error' &&
        commandCutoff > 0 &&
        typeof lastCommand.time === 'number' &&
        lastCommand.time >= commandCutoff
          ? h('div', { style: S.err },
              'Host 拒绝了本次操作：' + lastCommand.text)
          : null,
        lastCommand && lastCommand.kind === 'error' && commandCutoff === 0
          ? h('div', { style: S.note },
              '（日志里有一条更早的命令失败记录，不是本次操作；执行一次操作后才会计入。）')
          : null,
        feedback
          ? h('div', { style: feedback.kind === 'ok' ? S.okBox : S.warnBox },
              (feedback.kind === 'ok' ? '✅ ' : '⚠️ ') + feedback.text)
          : null,
        manual
          ? h('div', null,
              h('div', { style: S.err }, manual.reason),
              h('div', { style: S.code }, manual.line))
          : null,
        h('div', { style: S.list }, body())
      );
    }

    function RightTab(props) {
      return h(TrimmerView, { ctx: props.ctx, sessionId: props.sessionId });
    }

    function DockFallback(props) {
      const mode = React.useSyncExternalStore(subscribeMode, getMode, getMode);
      if (mode !== 'fallback') return null;
      return h('div', {
        style: {
          borderTop: '1px solid var(--dsw-alias-border-subtle, rgba(0,0,0,0.08))',
          maxHeight: '45vh',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        },
      },
        h('div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '4px 10px',
            fontSize: '12px',
            color: 'var(--dsw-alias-text-secondary, #64748b)',
            background: 'rgba(245,158,11,0.08)',
          },
        },
          h('span', null, '↩️ 右侧栏无法承载，已降级到底部'),
          h('button', {
            type: 'button',
            style: { ...S.btn, marginLeft: 'auto' },
            onClick: () => {
              lastOpenError = '';
              setMode('right');
              try { openPanel(); } catch { /* ignore */ }
            },
          }, '重试右侧栏')
        ),
        h(TrimmerView, { ctx: props.ctx, sessionId: props.sessionId })
      );
    }

    function ToggleButton() {
      return h('button', {
        type: 'button',
        title: lastOpenError ? '上下文修剪器：' + lastOpenError : '打开右侧栏的上下文修剪器',
        'aria-label': '上下文修剪器',
        onClick: () => {
          lastOpenError = '';
          try {
            openPanel();
          } catch (err) {
            lastOpenError = errText(err);
            setMode('fallback');
          }
        },
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2px 6px',
          borderRadius: '6px',
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          color: 'inherit',
          fontSize: '12px',
        },
      }, h('span', { 'aria-hidden': 'true' }, '✂️'));
    }

    const plugin = {
      inject: ['slots', 'remote'],
      apply(ctx) {
        pluginCtx = ctx;
        const disposers = [];

        disposers.push(
          ctx.inject(['sidebarRight', 'sidebarRightTabs'], (sub) => {
            const registry = sub.sidebarRightTabs;
            const svc = sub.sidebarRight;

            let disposeType = null;
            if (registry && typeof registry.register === 'function') {
              try {
                disposeType = registry.register({
                  id: TAB_ID,
                  kind: TAB_KIND,
                  keepMounted: true,
                  priority: 'extension',
                  title: () => TAB_TITLE,
                  guide: [
                    {
                      id: 'context-trimmer-guide',
                      order: 90,
                      title: () => '上下文修剪器',
                      description: () => '查看本会话的问答轮次，移除工具调用过程或整轮问答',
                    },
                  ],
                });
              } catch (err) {
                lastOpenError = '注册标签类型失败：' + errText(err);
                if (typeof console !== 'undefined') console.error('[context-trimmer]', err);
                setMode('fallback');
              }
            } else {
              lastOpenError = '右侧栏标签注册表不可用';
              setMode('fallback');
            }

            const RETRY = 60;
            const later = (fn, ms) => (typeof setTimeout === 'function' ? setTimeout(fn, ms) : fn());

            const fail = (reason) => {
              lastOpenError = reason;
              setMode('fallback');
              if (typeof console !== 'undefined') console.error('[context-trimmer] open failed:', reason);
            };

            const focusWhenReady = (attempt) => {
              let row = null;
              try {
                const rows = svc.openTabs && svc.openTabs.getSnapshot ? svc.openTabs.getSnapshot() : [];
                row = (rows || []).find((r) => r && r.kind === TAB_KIND);
              } catch { /* ignore */ }
              if (row) {
                try {
                  if (typeof svc.focus === 'function') svc.focus(row.tabId);
                  if (typeof svc.isExpanded === 'function' && !svc.isExpanded() && typeof svc.toggleExpanded === 'function') {
                    svc.toggleExpanded();
                  }
                } catch { /* ignore */ }
                setMode('right');
                return;
              }
              if (attempt < RETRY) later(() => focusWhenReady(attempt + 1), 50);
              else fail('标签已请求但未出现在右侧栏');
            };

            const tryOpen = (attempt) => {
              if (!svc || typeof svc.openTab !== 'function') {
                fail('右侧栏服务不可用');
                return;
              }
              try {
                svc.openTab(TAB_KIND);
              } catch (err) {
                const msg = errText(err);
                if (/no session surface is mounted|not mounted/i.test(msg) && attempt < RETRY) {
                  later(() => tryOpen(attempt + 1), 50);
                  return;
                }
                fail(msg);
                return;
              }
              focusWhenReady(0);
            };

            openPanel = () => {
              const layout = sget(pluginCtx, 'layout');
              if (layout && typeof layout.openRightbar === 'function') {
                try { layout.openRightbar(true, false); } catch { /* ignore */ }
              }
              tryOpen(0);
            };

            return () => {
              openPanel = () => fail('右侧栏服务已卸载');
              if (disposeType) {
                try { disposeType(); } catch { /* ignore */ }
              }
            };
          })
        );

        disposers.push(
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register({
              name: 'sidebar.right.pane.tab',
              key: TAB_ID,
              inject: (sessionId) => ({ sessionId, ctx }),
            }, RightTab)
          )
        );
        disposers.push(
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, () =>
              h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } },
                h('span', { 'aria-hidden': 'true' }, '✂️'),
                h('span', null, TAB_TITLE)))
          )
        );
        disposers.push(
          ctx.slots.inject('conversation.input.right', () =>
            ctx.slots.register({
              name: 'conversation.input.right',
              id: 'context-trimmer-toggle',
              order: 35,
              label: () => '上下文修剪器',
            }, ToggleButton)
          )
        );
        disposers.push(
          ctx.slots.inject('conversation.composer.dock', () =>
            ctx.slots.register({
              name: 'conversation.composer.dock',
              id: 'context-trimmer-fallback',
              order: 45,
              label: () => '上下文修剪器（降级）',
              inject: (sessionId) => ({ sessionId, ctx }),
            }, DockFallback)
          )
        );

        return () => {
          for (const d of disposers) {
            try { d && d(); } catch { /* ignore */ }
          }
        };
      },
    };

    // Test-only hook (see test-synthetic.mjs): the bench compares the panel's
    // own surface fold and its action-settling rule against the Host's answers.
    // Never enabled by the runtime.
    if (typeof window !== 'undefined' && window.__CONTEXT_TRIMMER_TEST__ === true) {
      plugin.__test = { buildTurns, settledFeedback };
    }
    return plugin;
  },
});
