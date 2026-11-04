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
          for (let i = visible.length - 1; i >= 0; i--) {
            const s = visible[i];
            if (Number.isFinite(start) && Number.isFinite(end) && s >= start && s <= end) {
              visible.splice(i, 1);
            }
          }
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

    function isOwnReplacement(ev) {
      if (!ev || ev.type !== 'user/message') return false;
      const src = (ev.data || {}).source;
      return Boolean(src) && (
        src.kind === TRIM_KIND || src.kind === DELETE_KIND || src.kind === INJECT_KIND
      );
    }

    /** A message the human typed; anything else stored as user/message is
     * harness-injected context (runtime-context, time-context, skill-catalog…). */
    function isRealUserEvent(ev) {
      if (!ev || ev.type !== 'user/message') return false;
      if (isOwnReplacement(ev)) return false;
      const src = (ev.data || {}).source;
      return !src || src.kind === 'user';
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
          user: '',
          userSeq: null,
          assistant: '',
          toolCalls: 0,
          injected: [],
          injectedChars: 0,
          injectedStripped: false,
        };
      }

      for (const ev of surface) {
        const type = ev.type;
        if (type !== 'user/message' && type !== 'assistant/message' && type !== 'tool/result') continue;

        if (isRealUserEvent(ev)) {
          current = blank(ev.seq);
          for (const p of pending) {
            current.firstSeq = Math.min(current.firstSeq, p.seq);
            current.injected.push(injectedKindOf(p));
            current.injectedChars += textOf((p.data || {}).content).length;
          }
          pending = [];
          current.userSeq = ev.seq;
          groups.push(current);
        } else if (type === 'user/message') {
          const text = textOf((ev.data || {}).content);
          if (current === null) {
            pending.push(ev);
            continue;
          }
          current.firstSeq = Math.min(current.firstSeq, ev.seq);
          current.lastSeq = Math.max(current.lastSeq, ev.seq);

          // Our own replacements carry the outcome, keyed by source kind.
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
          if (src.kind === DELETE_KIND) {
            current.deletedMarker = true;
            continue;
          }
          if (text.indexOf('已清除的系统注入上下文') >= 0) {
            current.injectedStripped = true;
          } else {
            current.injected.push(injectedKindOf(ev));
            current.injectedChars += text.length;
          }
          continue;
        } else {
          if (current === null) {
            current = blank(ev.seq);
            groups.push(current);
          }
          current.firstSeq = Math.min(current.firstSeq, ev.seq);
          current.lastSeq = Math.max(current.lastSeq, ev.seq);
        }

        const data = ev.data || {};
        if (type === 'user/message') {
          const t = previewText(data.content, 160);
          if (t) current.user = t;
        } else if (type === 'assistant/message') {
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
      let surfaceChars = 0;

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

      for (const ev of surface) {
        if (ev.type !== 'tool/result') continue;
        surfaceChars += textOf((ev.data || {}).message && ev.data.message.content).length;
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

      return { turns: groups.map((g, i) => {
        const range = rangeFor(g.userSeq);
        const bucket = range === null ? undefined : logByUser.get(range.from);
        const logToolCalls = bucket ? bucket.calls : g.toolCalls;
        const turnChars = bucket ? bucket.chars : 0;
        // The replacement marker is authoritative; the count gap is a fallback
        // for surfaces written before this plugin recorded its own kind.
        const trimmed = Boolean(g.trimmedMarker) || logToolCalls > g.toolCalls;
        const deleted = Boolean(g.deletedMarker);
        return {
          turn: i + 1,
          label: i + 1,
          startSeq: g.firstSeq,
          endSeq: g.lastSeq,
          userSeq: g.userSeq,
          toolCalls: g.toolCalls,
          logToolCalls,
          removedChars: trimmed ? turnChars : 0,
          trimmed,
          deleted,
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
            owned = sessions.retain({ id: sessionId }, { source: 'gateway' });
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
            return (line) =>
              commands.execute({ id: sessionId }, line, [], new AbortController().signal);
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
          const result = res && res.result;
          if (result && result.kind === 'error') throw new Error(result.text || '执行失败');
          return { matched: true, via: 'remote' };
        }
        throw new Error(
          '会话命令通道不可用：binding.session.command 取不到。' +
            '请刷新页面后重试；若仍不行，请在输入框直接发送上面给出的命令。',
        );
      };
    }

    /**
     * Read the newest Host turn dump out of the client window.
     *
     * The panel can only *send* commands — `session.command()` reports nothing
     * but `matched` — so a command's text comes back as the durable
     * `command/done` row. That row is the return channel; only a payload that
     * parses to `{ build, turns }` counts, so trim outcomes are skipped.
     */
    function readHostDump(snapshot) {
      const entries = snapshot && Array.isArray(snapshot.entries) ? snapshot.entries : [];
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        if (!entry || entry.type !== 'event' || !entry.event) continue;
        const ev = entry.event;
        if (ev.type !== 'command/done') continue;
        const data = ev.data || {};
        if (data.kind !== 'success' || typeof data.text !== 'string') continue;
        const text = data.text.trim();
        if (text.charAt(0) !== '{') continue;
        try {
          const parsed = JSON.parse(text);
          if (parsed && Array.isArray(parsed.turns)) return parsed;
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
    /** Window tail seq per session: the cache key for the last Host dump. */
    function windowHeadSeq(snapshot) {
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

      const load = React.useCallback(async () => {
        if (busy.current) return;
        busy.current = true;
        const mine = generation.current;
        const live = () => alive.current && generation.current === mine;
        const sessionKey = sessionIdRef.current;
        setState((prev) => (live() ? { ...prev, status: prev.turns ? 'refreshing' : 'loading', error: '' } : prev));
        try {
          const before = getWindowRef.current ? getWindowRef.current() : null;
          const beforeHead = windowHeadSeq(before);
          const cached = sessionKey ? hostTurnCache.get(sessionKey) : undefined;
          if (cached && beforeHead !== null && cached.head === beforeHead) {
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
          let dump = null;
          // The dump travels through the follow stream: it can land one frame
          // after the RPC resolves, so poll the live window briefly.
          for (let attempt = 0; attempt < 12 && dump === null; attempt += 1) {
            dump = readHostDump(getWindowRef.current ? getWindowRef.current() : null);
            if (dump === null) await new Promise((resolve) => setTimeout(resolve, 60));
          }
          if (!live()) return;
          if (dump === null) {
            setState((prev) => ({ ...prev, status: 'error', error: '没读到 Host 返回的轮次数据' }));
            return;
          }
          const build = typeof dump.build === 'string' ? dump.build : null;
          if (sessionKey) {
            const head = windowHeadSeq(getWindowRef.current ? getWindowRef.current() : null);
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
        }
      }, []);

      React.useEffect(() => {
        if (!enabled) return;
        void load();
      }, [enabled, refreshKey, load]);

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

      // The window is turn-aligned but starts at the tail: as long as it has
      // more pages, its turn numbering is a suffix of the real conversation.
      // Ask the Host (which holds the whole log) instead of guessing.
      const windowHasMore = Boolean(winState.window && winState.window.hasMore);
      const host = useHostTurns({
        sessionId,
        enabled: winState.status === 'ready' && windowHasMore,
        refreshKey: tick,
        getWindow: winState.getWindow,
        run,
      });
      const usingHost = Array.isArray(host.state.turns);
      const turns = usingHost ? host.state.turns : built.turns;

      // A command reports only "matched", never its own outcome, so success is
      // decided by observing the surface actually change. Turns are matched by
      // the user message they start at, which survives both numbering schemes.
      const pendingRef = React.useRef(null);

      React.useEffect(() => {
        const p = pendingRef.current;
        if (!p) return;
        const now = turns.find((x) =>
          p.userSeq !== null && x.userSeq !== null && x.userSeq !== undefined
            ? x.userSeq === p.userSeq
            : x.label === p.label,
        );
        if (!now) return;
        const changed =
          now.trimmed !== p.beforeTrimmed ||
          now.deleted !== p.beforeDeleted ||
          now.injectedStripped !== p.beforeStripped;
        if (!changed) return;
        pendingRef.current = null;

        if (p.action === 'strip_injected') {
          setFeedback({
            kind: 'ok',
            text: `已清除第 ${p.label} 轮的系统注入上下文（${p.beforeInjected} 条）`,
          });
          return;
        }
        setFeedback({
          kind: 'ok',
          text:
            (p.action === 'delete_turn' ? '已移除第 ' : '已修剪第 ') +
            p.label +
            ' 轮：工具调用 ' +
            p.beforeTools +
            ' → ' +
            now.toolCalls +
            (now.removedChars > 0 ? '，约移除 ' + fmtChars(now.removedChars) : ''),
        });
      }, [turns]);

      async function act(action, t) {
        const isDelete = action === 'delete_turn';
        const isStrip = action === 'strip_injected';
        const tools = t.logToolCalls || t.toolCalls;

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
        pendingRef.current = {
          label: t.label,
          userSeq: typeof t.userSeq === 'number' ? t.userSeq : null,
          action,
          beforeTrimmed: Boolean(t.trimmed),
          beforeDeleted: Boolean(t.deleted),
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
            if (!p || p.label !== t.label) return;
            pendingRef.current = null;
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
          const done = Boolean(t.trimmed || t.deleted);
          const shown = t.logToolCalls == null ? t.toolCalls : t.logToolCalls;
          const hasTools = shown > 0;
          const toolLabel = hasTools ? `${shown} 次工具调用` : '无工具调用';
          const saved = t.removedChars > 0 ? ` · 已移除 ~${fmtChars(t.removedChars)}` : '';
          const hasInjected = (t.injectedCount || 0) > 0;
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
              t.deleted ? h('span', { style: S.badgeDone }, '【已移除】') : null,
              h('span', { style: { marginLeft: 'auto', ...S.note } }, `seq ${t.startSeq}–${t.endSeq}`)
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
                    disabled: busy,
                    title: '把本轮中间的工具调用与结果从模型上下文中移除，只保留提问与最终回答',
                    onClick: () => act('trim_tools', t),
                  }, '✂️ 只留问答')
                : null,
              hasInjected
                ? h('button', {
                    key: 'strip',
                    type: 'button',
                    style: S.btn,
                    disabled: busy,
                    title: '清除本轮的系统注入上下文（运行时快照、时间戳、技能清单等），保留你的提问',
                    onClick: () => act('strip_injected', t),
                  }, '🧽 清注入')
                : null,
              h('button', {
                key: 'del',
                type: 'button',
                style: S.btnDanger,
                disabled: busy,
                title: '把本轮问答从模型上下文中移除',
                onClick: () => act('delete_turn', t),
              }, '🗑 删除本轮')
            )
          );
        });
      }

      const doneCount = turns.filter((t) => t.trimmed || t.deleted).length;
      const savedChars = turns.reduce((sum, t) => sum + (t.removedChars || 0), 0);

      return h('div', { style: S.root },
        h('div', { style: S.head },
          h('span', { 'aria-hidden': 'true' }, '✂️'),
          h('strong', null, '上下文修剪器'),
          h('span', { style: S.badge }, `${turns.length} 轮`),
          usingHost
            ? h('span', {
                style: S.badgeDone,
                title:
                  '来自 Host 的完整日志；与聊天区滚到哪无关（Host ' +
                  (host.state.build || '?') +
                  '）',
              }, '全量')
            : windowHasMore
              ? h('span', { style: S.badgeWarn, title: '只统计聊天区已加载的窗口，轮次编号是窗口内的' }, '窗口内')
              : null,
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
          : windowHasMore
            ? h('div', { style: S.note },
                host.state.status === 'loading' || host.state.status === 'refreshing'
                  ? '正在向 Host 读取完整轮次…'
                  : '未能读到 Host 的完整轮次（' +
                    (host.state.error || '尚未返回') +
                    '），下面只列出聊天区已加载窗口内的轮次，编号从 1 起算。')
            : null,
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

    return {
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
  },
});
