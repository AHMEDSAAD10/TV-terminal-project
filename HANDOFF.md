# HANDOFF — TradingView Mirror Project (read this in a new session)

## What this project is
A local mirror of the TradingView web app, running at:
**http://127.0.0.1:8088/www.tradingview.com/chart/j3mUKCaZ/**
Goal: full live-feed charting with no plan limits — all timeframes, Bar Replay, persistence, and every built-in indicator from the library.

## How to run / what runs
- Folder: `C:\Users\Trading\Documents\Default Project\_captures\tv-app-mirror`
- `serve.js` → static server + layout/token splice, **port 8088** (must always be running)
- `wsproxy.js` → WebSocket proxy, logs study protocol verdicts to `proxy-debug.log`, **port 8090**
  (start with env `TV_PROXY_DEBUG=1`, `TV_AGG_TRACE=1`)
- `token-keepalive.js --watch` → keeps auth token fresh
- Restart a dead one: open a terminal in the folder, run `node <name>.js` in the background.

## Key files
- `patches.js` — injects HTML/JS patches into served pages (incl. the bridge script tag)
- `www.tradingview.com/native-builtin-bridge.js` — maps dialog Pine built-ins (`STD;<name>`) to
  native `@tv-basicstudies` ids; wraps `studyMarket._insertStudyService.insertStudy`; maps 69 built-ins
- `layout-store.json` — saved layout (id `j3mUKCaZ`, symbol CAPITALCOM:NAS100 1D, currently 0 studies)
- `proxy-debug.log` — authoritative per-study server verdicts (`study_completed` / `study_error`)

## Hard facts already proven (do NOT rediscover these)
- Account is free tier (`prostatus non_pro`, `max_studies 2`): the TV **server itself rejects**
  non-entitled native studies with `study_error study_limit_exceeded` — even alone on a fresh chart.
  Verified rejected: `TripleEMA@tv-basicstudies-283`, `ENV`. Verified allowed: MAExp, MASimple, RSI,
  DoubleEMA, DONCH, FisherTransform, DM, MF, Sessions, Earnings, Splits, Dividends.
- So: mapped built-ins working = 69 (via dialog + bridge). Past that the fix is client-side rendering,
  not another bridge edit. Community/`USER;` Pine scripts stay broken — accepted by user.
- Dialog UI automation: type in search box, then click `.container-cDWXFIqV.platform-cDWXFIqV` row
  with mousedown/mouseup/click.
- Do NOT touch the user's separate live logged-in tradingview.com tab (XAUUSD).

## Last work log (Nov 7)
- Bridge is live in served pages (injected by `patches.js`, script id `tv-native-builtin-bridge`);
  69 built-ins mapped. Verified working via the real dialog UI: Donchian, DEMA, Fisher, EMA, DMI,
  Money Flow, ADX, Sessions.
- User's saved layout was cleaned back to 0 studies after tests (server-side entitlements rejected
  several). If chart looks wrong: reload, and rebuild from the dialog.
- If the chart misbehaves: check `serve.js` (8088) and `wsproxy.js` (8090) are running; they die.
  Restart: `node wsproxy.js` (with env TV_PROXY_DEBUG=1 TV_AGG_TRACE=1) and `node serve.js`.
- RULES for the agent (user demand): do not re-read big files already understood; no full log dumps;
  verify once and report once; batch several steps per turn; do NOT re-test facts already in this
  file. Keep responses short.

## What remains / next step
- CLEANUP (Nov 7): the in-page canvas "local study engine" fake was scrapped per user decision.
  All files deleted, patches.js injection reverted, bridge restored to the working v1.
- REAL next step (user demand): graft the Charting Library local backend
  (`chartapi-local-backend.worker.675427229ac409c2671e.js` in
  C:\Users\Trading\Downloads\trading-terminal.tradingview-widget.com\charting_library\bundles\)
  as the chart's study engine so built-ins are computed INSIDE the library, with no
  server entitlement limits. This is path 1. Do NOT rebuild canvas replicas.

## Housekeeping already done
- `mcp.rea` disabled in `C:\Users\Trading\.config\opencode\opencode.json` (was never used, cost
  per-request schema overhead). Takes effect after OpenCode restart.
