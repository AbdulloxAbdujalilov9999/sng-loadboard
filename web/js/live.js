// Live updates over Server-Sent Events, implemented with fetch streaming so we can send the Authorization
// header (EventSource cannot). Events are tiny "something changed" hints; modules re-fetch through the API.
const Live = (() => {
  const listeners = new Set();
  let running = false;
  let abort = null;
  let watchdog = null;
  let lastActivity = 0;
  let everConnected = false;
  let hiddenAt = 0;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const on = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const emit = (evt) => listeners.forEach((fn) => { try { fn(evt); } catch (e) { console.error('live listener failed', e); } });

  function setState(state) {
    const dot = U.$('live-dot');
    const text = U.$('live-text');
    if (!dot) return;
    const palette = { live: 'bg-emerald-500', connecting: 'bg-amber-400', offline: 'bg-rose-400', off: 'bg-slate-300' };
    dot.className = `w-2 h-2 rounded-full ${palette[state] || palette.off}`;
    text.textContent = t({ live: 'live_on', connecting: 'live_connecting', offline: 'live_offline', off: 'live_connecting' }[state]);
  }

  function parseFrames(buffer) {
    const frames = [];
    let idx;
    let rest = buffer;
    while ((idx = rest.indexOf('\n\n')) >= 0) { frames.push(rest.slice(0, idx)); rest = rest.slice(idx + 2); }
    return { frames, rest };
  }

  async function connectOnce() {
    const token = await Session.getToken();
    if (!token) throw new Error('no token');
    abort = new AbortController();
    setState('connecting');
    const res = await fetch(`${window.APP_CONFIG.apiBase || ''}/api/events`, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }, signal: abort.signal });
    if (res.status === 401) await Session.getToken(true);
    if (!res.ok) throw new Error(`events ${res.status}`);

    if (everConnected) emit({ entity: 'resync' }); // we may have missed events while disconnected
    everConnected = true;
    lastActivity = Date.now();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      lastActivity = Date.now();
      const parsed = parseFrames(buffer + decoder.decode(value, { stream: true }));
      buffer = parsed.rest;
      for (const frame of parsed.frames) {
        const name = /^event: (.*)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (name === 'hello') setState('live');
        else if (name === 'change' && data) { try { handleEvent(JSON.parse(data)); } catch { /* ignore malformed */ } }
      }
    }
  }

  function handleEvent(evt) {
    if (evt.entity === 'me') Session.refresh();
    emit(evt);
  }

  async function loop() {
    let delay = 1000;
    while (running) {
      try { await connectOnce(); delay = 1000; } catch (err) { if (!running) return; }
      if (!running) return;
      setState('offline');
      await sleep(delay * (0.5 + Math.random())); // jitter: after a server restart every browser reconnects at once otherwise
      delay = Math.min(delay * 2, 15000);
    }
  }

  function start() {
    if (running) return;
    running = true;
    everConnected = false;
    // The server pings every 20s; silence for 60s means a dead connection (e.g. wifi switch) - reconnect.
    watchdog = setInterval(() => { if (running && lastActivity && Date.now() - lastActivity > 60000) abort?.abort(); }, 10000);
    loop();
  }

  function stop() {
    running = false;
    clearInterval(watchdog);
    abort?.abort();
    setState('off');
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (running && hiddenAt && Date.now() - hiddenAt > 60000) emit({ entity: 'resync' });
    hiddenAt = 0;
  });

  return { start, stop, on };
})();

window.Live = Live;
