# AGENTS.md — instructions for any coding agent working on the TradingView Mirror

You are working on a **local mirror of the TradingView web app** that runs on this machine with the
real live feed, **without plan limits/paywalls**. Read this whole file before doing anything.

---

## 1. What this project is

A byte-copy of the TradingView web-app bundle (downloaded from the CDN), served locally by a small
Node server that (a) rewrites absolute `*.tradingview.com` URLs to local paths, (b) injects client
patches that remove free-plan limits, and (c) reroutes the chart data socket through a local
WebSocket proxy so the *real* TradingView feed connects.

It is NOT a clone/re-implementation. The UI, bundles and feed are TradingView's own. All our work is
patching + proxying.

Live in the browser at:

```
http://127.0.0.1:8088/www.tradingview.com/chart/j3mUKCaZ/
(short form also works: http://127.0.0.1:8088/chart/j3mUKCaZ/)
```

## 2. Folder layout

```
tv-mirror-project/            <- bundle root
├─ README-FIRST.md            <- human quick-start (start here)
├─ AGENTS.md                  <- this file (agent instructions)
├─ HANDOFF.md                 <- latest status log + next task
├─ docs/                      <- analysis notes (TradingView internals, replay trace, build plan)
└─ app/                       <- THE APP (everything needed to run)
   ├─ serve.js                <- static server + URL rewrite + patch injection + store splice (port 8088)
   ├─ patches.js              <- ALL client patches (limit removals, paywall kill, native bridge inject)
   ├─ wsproxy.js              <- WebSocket re-origin proxy (port 8090) -> logs study verdicts
   ├─ tv-agg.js, tv-ws.js     <- aggregation/WS helpers used by analysis scripts
   ├─ symbols-api.js          <- local symbol-search proxy (/__ss) to symbol-search.tradingview.com
   ├─ token-keepalive.js      <- keeps the captured auth token fresh (--watch to loop)
   ├─ token-refresh.js        <- one-shot token refresh
   ├─ auth-token.txt          <- captured auth for the feed (SECRET: do not share this bundle publicly)
   ├─ cookie-header.txt       <- captured cookie header (SECRET)
   ├─ session-cookie.txt      <- session cookie (SECRET)
   ├─ layout-store.json       <- persisted chart layouts (charts/studies/drawings)
   ├─ settings-store.json     <- persisted UI/chart settings
   ├─ watchlists.json         <- persisted watchlists (incl. flag colors)
   ├─ chart-storage-store.json<- persisted chart storage metadata
   ├─ proxy-debug.log         <- authoritative per-study server verdicts (study_completed / study_error)
   ├─ README-run.md           <- the original detailed run notes + history of fixes
   ├─ rea/ (NOT here)         <- unrelated
   └─ www.tradingview.com/    <- the served app pages; contains native-builtin-bridge.js
      └─ native-builtin-bridge.js  <- maps dialog Pine built-ins (STD;<name>) to native study ids
   └─ static.tradingview.com/ <- ~86 MB of JS/CSS bundles (the app's code) — required to run
   └─ <other *.tradingview.com hosts>/  <- mirrored API/CDN payloads
```

## 3. How to run it (Windows)

Start the two servers (each in its own terminal, or as background processes), from inside `app\`:

```powershell
cd app
node wsproxy.js      # port 8090 — start this FIRST
node serve.js        # port 8088
```

Optional (feed auth freshness):

```powershell
node token-keepalive.js --watch
```

Then open the URL in section 1. The chart should load with live candles.

**Restart rule:** if the chart loses its feed or the study log stops growing, `wsproxy.js` died —
restart it. Verify: `Test-NetConnection 127.0.0.1 -Port 8090 -InformationQuiet` (and 8088).

## 4. How it works (the important mechanics)

- **serve.js** serves `www.tradingview.com/chart/j3mUKCaZ/` (and every mirrored host folder) from
  disk, rewriting `<script src="https://static.tradingview.com/...">` etc. to local paths. While
  serving JS it applies **patches.js** on the fly (the mirrored files on disk are never modified).
  It also patches the page boot: `window.WEBSOCKET_HOST -> 127.0.0.1:8090`, `PUSHSTREAM_URL -> ws://...`.
- **wsproxy.js** listens locally, accepts the page's plain `ws://` socket and re-originates it
  upstream to TradingView with a correct `Origin` header, relaying frames verbatim. This is why the
  real feed works from a localhost origin. With `TV_PROXY_DEBUG=1` / `TV_AGG_TRACE=1` it appends the
  study protocol to `proxy-debug.log` — **this log is the source of truth** for whether a study is
  accepted or rejected by the TV server.
- **patches.js** is where every limit removal lives (plain find/replace pairs, applied while serving):
  free-plan numeric limits raised to 999999; pro-only feature flags granted to `free`; the watchlist
  `>30 symbols` row lock disabled by pointing its feature key at a nonexistent name; paywall opener
  turned into a no-op; symbol search rerouted to `/__ss` (symbols-api.js).
- **native-builtin-bridge.js** (injected by patches.js into every served page) wraps
  `studyMarket._insertStudyService.insertStudy` so that dialog Pine built-ins identified as
  `STD;<name>` are inserted as native `@tv-basicstudies` study ids instead. It maps 69 built-ins
  (60 name-matched + 9 aliases, incl. ADX→DM, Money Flow→MF, Sessions, Seasonals, studyADR).
  `USER;`/`PUB;` (community Pine) are deliberately left untouched.

## 5. What is fixed / what works

- Live candles (anonymous, delayed feed) via the proxy; all standard chart styles & intervals.
- **Bar Replay** works (truncates at cursor, dims future bars, play/step/speed).
- Watchlists: create / copy / rename / clear / sections / >30 symbols unlocked / flag colors;
  persisted in `watchlists.json`.
- Persistence across restarts of layouts, drawings, settings, watchlists.
- Paywall can never render (opener no-op + row-lock disabled).
- Symbol search via `/__ss`.
- **Indicators:** 69 built-ins now insert as native studies, verified through the real dialog UI
  (Donchian, DEMA, Fisher, EMA, DMI, Money Flow, ADX, Sessions … all confirmed).

## 6. What is still broken (do not waste time re-testing)

- **Server-side study entitlements.** The TV *server* rejects some native studies for this
  (free/non_pro) account with `study_error {"code":"study_limit_exceeded"}`. Confirmed rejected:
  `TripleEMA@tv-basicstudies-283`, `ENV` — even alone on a fresh chart. Confirmed allowed: MAExp,
  MASimple, RSI, DoubleEMA, DONCH, FisherTransform, DM, MF, Sessions, Earnings, Splits, Dividends.
  **No client patch can fix this.** Fixing it requires computing those studies locally (Charting
  Library local worker) or rendering them in-page. See `HANDOFF.md` gap analysis.
- Community/`USER;` Pine scripts stay broken by design (accepted by the user).
- A few API hosts are not proxied (`pricealerts.`, `notifications.`, `news-mediator.`) — alerts/news
  panels have CORS errors; the chart and watchlist are unaffected.

## 7. Hard rules for the agent

1. **Never touch the user's separate live `tradingview.com` logged-in browser tab.** Work only with
   the mirror at `127.0.0.1:8088`.
2. **Do not re-read big files.** Query with grep/targeted ranges. Never paste whole logs into chat.
3. **`proxy-debug.log` is the authority** on study accept/reject. Check it before claiming anything.
4. **Batch work**: do several steps, verify once, report once. Avoid report/verify loops.
5. **After a meaningful work chunk, update `HANDOFF.md`** (status + next step) so a fresh session can
   continue: the project's memory is these files, not any chat.
6. Patch changes go in `patches.js` as new `[find, replace]` pairs; then restart `serve.js`.
7. Keep `layout-store.backup.json` intact (safety copy of the layout).
8. This bundle contains **live session credentials** (`auth-token.txt`, `cookie-header.txt`,
   `session-cookie.txt`). Never upload/share this zip publicly.

## 8. Current task (from HANDOFF.md)

Give the user their remaining built-ins that the TV server blocks (TripleEMA, Envelope, Supertrend,
Coppock, McGinley, most strategies). Two candidate paths — ask the user which to prototype:
(a) graft the Charting Library local study engine (`chartapi-local-backend.worker.*.js` from the
charting_library bundles), or (b) an in-page custom study renderer following the `style-overlay.js`
pattern. Everything else on the project is done and verified.
