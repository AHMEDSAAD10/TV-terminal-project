// Local WebSocket reverse proxy for the mirrored TradingView app.
//
// The app runs on http://127.0.0.1:8088, so it is cross-site to tradingview.com:
// its cookies are withheld and the Origin is rejected. This proxy re-originates
// the socket as https://www.tradingview.com and relays frames.
//
// Unlike a raw byte pipe it speaks the WebSocket framing and the TradingView
// `~m~` message codec, so tv-agg.js can serve custom intervals by fetching a
// base resolution and folding the bars locally.
'use strict';

const http = require('http');
const tls = require('tls');
const crypto = require('crypto');
const { FrameReader, encodeFrame, parseMessages, serializeMessages } = require('./tv-ws');
const { TvAggregator } = require('./tv-agg');

const PORT = 8090;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const aggregator = new TvAggregator({
  debug: process.env.TV_PROXY_DEBUG === '1',
  trace: process.env.TV_AGG_TRACE === '1',
  barsetRenko: process.env.TV_BARSET_RENKO !== '0',
  logPath: require('path').join(__dirname, 'proxy-debug.log'),
});

const server = http.createServer((req, res) => {
  res.writeHead(426, { 'Content-Type': 'text/plain' });
  res.end('websocket upgrade required');
});

server.on('upgrade', (req, clientSocket, head) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { clientSocket.destroy(); return; }
  const path = req.url || '/';
  const host = path.startsWith('/message-pipe') ? 'pushstream.tradingview.com' : 'data.tradingview.com';

  clientSocket.pause();

  const upstream = tls.connect({ host, port: 443, servername: host }, () => {
    const lines = [
      `GET ${path} HTTP/1.1`,
      `Host: ${host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      'Origin: https://www.tradingview.com',
      `User-Agent: ${req.headers['user-agent'] || 'Mozilla/5.0'}`,
      'Accept-Language: en-US,en;q=0.9',
    ];
    if (req.headers.cookie) lines.push(`Cookie: ${req.headers.cookie}`);
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
  });

  let handshakeBuf = Buffer.alloc(0);
  let handshook = false;

  const toClient = (opcode, payload) => {
    try { clientSocket.write(encodeFrame(opcode, payload, false)); } catch { /* closed */ }
  };
  const toUpstream = (opcode, payload) => {
    try { upstream.write(encodeFrame(opcode, payload, true)); } catch { /* closed */ }
  };

  const sendClientJson = (obj) =>
    toClient(0x1, serializeMessages([{ kind: 'json', obj, text: JSON.stringify(obj) }]));
  const sendUpstreamJson = (obj) =>
    toUpstream(0x1, serializeMessages([{ kind: 'json', obj, text: JSON.stringify(obj) }]));

  // Bar Replay autoplay for intraday resolutions. The free feed refuses
  // `replay_start` on intraday, so drive autoplay from the prefetched cache
  // with the same local one-bar advance used by Forward.
  const replayTimers = new Map();
  const localStep = process.env.TV_REPLAY_LOCAL_STEP !== '0';
  const rawStep = process.env.TV_REPLAY_RAW_STEP === '1';
  const prefetchOn = process.env.TV_REPLAY_PREFETCH !== '0';
  let autoSeq = 0;
  const stopAuto = (session) => {
    const t = replayTimers.get(session);
    if (t) { clearInterval(t); replayTimers.delete(session); }
  };

  // Advance one bar from the prefetched cache and hand the chart a one-bar
  // `du` delta — the same message shape the feed sends natively for daily
  // replay, so the chart appends instantly instead of reloading 300 bars.
  const localAdvance = (session, turn) => {
    const info = aggregator.replayInfo(session);
    if (!info || !info.resSec || !info.seriesKey) return false;
    const now = Math.floor(Date.now() / 1000);
    const maxTime = now - info.resSec; // last completed bar
    const entry = aggregator.takeNextBar(session, maxTime);
    if (!entry) {
      if (prefetchOn) aggregator.beginPrefetch(session);
      return false;
    }
    const nextPoint = entry.v[0] + info.resSec - 1;
    if (nextPoint > now) return false;
    aggregator.setReplayPoint(session, nextPoint);
    sendClientJson({ m: 'replay_ok', p: [session, turn] });
    sendClientJson({ m: 'replay_point', p: [session, nextPoint] });
    sendClientJson({
      m: 'du',
      p: [info.dataSession, { [info.seriesKey]: { s: [{ i: aggregator.nextClientIndex(session), v: entry.v }] } }],
    });
    aggregator.consumeBar(session, entry.v[0]);
    // Refill with margin only when the run of ready bars gets short. History
    // normally covers the run up to the live edge, so this rarely fires.
    if (prefetchOn && aggregator.availableAhead(session, maxTime) < 50) aggregator.beginPrefetch(session);
    return true;
  };

  // Prefetch the next block in the background; the reply is swallowed by the
  // aggregator so the chart never sees a reload.
  const kickPrefetch = (session) => {
    const msg = aggregator.beginPrefetch(session);
    if (msg) sendUpstreamJson(msg);
  };

  const startAuto = (session, speed) => {
    stopAuto(session);
    let delay = Number(speed);
    if (!isFinite(delay) || delay < 150) delay = 150;
    if (delay > 5000) delay = 5000;
    if (prefetchOn) aggregator.log('AGG autoplay start session=' + session + ' requested=' + speed + ' delay=' + delay);
    const timer = setInterval(() => {
      const info = aggregator.replayInfo(session);
      if (!info || !info.resSec) { stopAuto(session); return; }
      if (!localAdvance(session, 'aggauto' + (autoSeq++))) {
        const now = Math.floor(Date.now() / 1000);
        if (typeof info.point === 'number' && info.point + info.resSec > now) {
          // Reached the live edge: stop autoplay and end replay, as native
          // replay does at the end of data.
          aggregator.log('AGG autoplay end-of-data session=' + session);
          stopAuto(session);
          sendClientJson({ m: 'replay_ok', p: [session, 'aggauto' + (autoSeq++)] });
          sendClientJson({ m: 'replay_data_end', p: [session] });
          return;
        }
        // Cache empty: keep the prefetch warm and skip this tick.
        kickPrefetch(session);
      }
    }, delay);
    replayTimers.set(session, timer);
  };

  // Watchdog: keeps the replay state machine from deadlocking (a reset held on a
  // prefetch that never finishes, or a prefetch that never completes).
  const sweeper = setInterval(() => {
    const acts = aggregator.sweep(Date.now());
    for (const act of acts) {
      if (act.up) sendUpstreamJson(act.up);
      if (act.client) sendClientJson(act.client);
    }
  }, 300);

  let loggedSession = false;
  const handleText = (raw, fromClient) => {
    const parts = parseMessages(raw);
    const outParts = [];
    if (process.env.TV_AGG_TRACE === '1') {
      for (const p of parts) {
        if (!p.obj) continue;
        if (fromClient && p.obj.m === 'set_auth_token') {
          const rawTok = String(p.obj.p && p.obj.p[0] || '');
          let info = '';
          try {
            const pl = JSON.parse(Buffer.from(rawTok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
            info = ' user=' + pl.user_id + ' exp=' + new Date(pl.exp * 1000).toISOString() + ' max_studies=' + pl.max_studies + ' prostatus=' + pl.prostatus;
          } catch {}
          aggregator.log('[AUTH] set_auth_token len=' + rawTok.length + info);
        }
        if (!fromClient && !loggedSession && /session|protocol|hello/i.test(p.obj.m || '')) {
          loggedSession = true;
          aggregator.log('[SESSION] ' + p.obj.m + ' ' + JSON.stringify(p.obj.p).slice(0, 600));
        }
      }
    }
    for (const part of parts) {
      if (part.kind !== 'json' || !part.obj) { outParts.push(part); continue; }
      if (fromClient) {
        const m = part.obj.m;
        if (m === 'replay_start') {
          const info = aggregator.replayInfo(part.obj.p[0]);
          if (info && info.resSec > 0 && info.resSec < 86400) {
            sendClientJson({ m: 'replay_ok', p: [part.obj.p[0], part.obj.p[1]] });
            startAuto(part.obj.p[0], part.obj.p[2]);
            continue;
          }
        } else if (m === 'replay_stop') {
          if (replayTimers.has(part.obj.p[0])) {
            stopAuto(part.obj.p[0]);
            sendClientJson({ m: 'replay_ok', p: [part.obj.p[0], part.obj.p[1]] });
            continue;
          }
        } else if (m === 'replay_delete_session') {
          stopAuto(part.obj.p[0]);
        } else if (m === 'replay_step' && rawStep) {
          // Diagnostic: let the feed answer an intraday step directly.
          outParts.push(part);
          continue;
        } else if (m === 'replay_step' && localStep) {
          // Intraday: the feed refuses to step a replay series it never
          // registered, and `replay_reset` reloads the whole series (300 bars)
          // on every step. Serve the next bar from the prefetched cache as a
          // one-bar `du` delta instead.
          const session = part.obj.p[0];
          const turn = part.obj.p[1];
          const count = Number(part.obj.p[2]) || 1;
          const info = aggregator.replayInfo(session);
          if (info && info.resSec > 0 && info.resSec < 86400) {
            if (localAdvance(session, turn)) continue;
            const now = Math.floor(Date.now() / 1000);
            if (count === 1 && typeof info.point === 'number' &&
                info.point + info.resSec > now) {
              // The point already sits at the live edge: there is no next bar.
              // Resolve the step and signal end-of-data so autoplay stops
              // instead of spinning forever.
              aggregator.log('AGG step at live edge session=' + session + ' point=' + info.point);
              sendClientJson({ m: 'replay_ok', p: [session, turn] });
              sendClientJson({ m: 'replay_data_end', p: [session] });
              continue;
            }
            if (prefetchOn) kickPrefetch(session);
            if (aggregator.isPrefetching(session)) {
              // A refill is in flight; acknowledge so the click resolves and
              // let the next attempt use the freshly cached bars.
              sendClientJson({ m: 'replay_ok', p: [session, turn] });
              continue;
            }
            // No prefetch running and no cached bar. Fall back to the feed's own
            // reset so Forward still moves (slower, but never frozen).
            const nextPoint = typeof info.point === 'number'
              ? info.point + count * info.resSec : null;
            if (nextPoint !== null && nextPoint <= now) {
              aggregator.setReplayPoint(session, nextPoint);
              sendUpstreamJson({ m: 'replay_reset', p: [session, turn, nextPoint] });
              continue;
            }
          }
        }
        const res = aggregator.onClientMessage(part.obj);
        if (res == null) continue;
        const list = Array.isArray(res) ? res : [res];
        for (const one of list) outParts.push({ kind: 'json', obj: one, text: JSON.stringify(one) });
      } else {
        const res = aggregator.onServerMessage(part.obj);
        if (res == null) continue;
        if (part.obj.m === 'series_completed') {
          const sid = aggregator.activeReplaySession();
          if (res.length) {
            // The chart just got its own series; prefetch the next block in the
            // background so Forward/Play can step without a reload.
            if (prefetchOn && sid && part.obj.p[2] === 'replay') kickPrefetch(sid);
          } else if (sid) {
            // A background prefetch reload just finished; release any reset the
            // chart asked for while it was in flight.
            const pr = aggregator.takePendingReset(sid);
            if (pr) sendUpstreamJson(pr);
          }
        }
        for (const msg of res) outParts.push({ kind: 'json', obj: msg, text: JSON.stringify(msg) });
      }
    }
    if (!outParts.length) return;
    const payload = serializeMessages(outParts);
    if (fromClient) toUpstream(0x1, payload);
    else toClient(0x1, payload);
  };

  const handleFrame = (opcode, payload, fromClient) => {
    if (opcode === 0x1) { handleText(payload, fromClient); return; }
    // Binary frames: pass through untouched.
    if (fromClient) toUpstream(opcode, payload);
    else toClient(opcode, payload);
  };

  const clientReader = new FrameReader((opcode, payload) => handleFrame(opcode, payload, true));
  const upstreamReader = new FrameReader((opcode, payload) => handleFrame(opcode, payload, false));

  upstream.on('data', (chunk) => {
    if (handshook) { upstreamReader.push(chunk); return; }
    handshakeBuf = Buffer.concat([handshakeBuf, chunk]);
    const idx = handshakeBuf.indexOf('\r\n\r\n');
    if (idx < 0) return;
    handshook = true;
    const statusLine = handshakeBuf.slice(0, handshakeBuf.indexOf('\r\n')).toString('latin1');
    if (!/ 101 /.test(statusLine)) {
      clientSocket.write(handshakeBuf);
      clientSocket.end();
      upstream.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    clientSocket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    const rest = handshakeBuf.slice(idx + 4);
    clientSocket.on('data', (c) => clientReader.push(c));
    if (head && head.length) clientReader.push(head);
    if (rest.length) upstreamReader.push(rest);
    clientSocket.resume();
  });

  upstream.on('error', () => { try { clientSocket.destroy(); } catch { /* ignore */ } });
  clientSocket.on('error', () => { try { upstream.destroy(); } catch { /* ignore */ } });
  const clearTimers = () => { replayTimers.forEach((t) => clearInterval(t)); replayTimers.clear(); clearInterval(sweeper); };
  clientSocket.on('close', () => { clearTimers(); try { upstream.destroy(); } catch { /* ignore */ } });
  upstream.on('close', () => { clearTimers(); try { clientSocket.destroy(); } catch { /* ignore */ } });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('ws proxy on ws://127.0.0.1:' + PORT + (process.env.TV_PROXY_DEBUG === '1' ? ' [debug]' : ''));
});