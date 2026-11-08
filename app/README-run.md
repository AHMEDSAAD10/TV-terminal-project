# Run the mirrored TradingView app locally (with live chart data)

This folder is the extracted mirror of the TradingView web-app build. It runs
locally and pulls the live (anonymous, delayed) feed through a small WebSocket
proxy, so charts render and **Bar Replay works**.

## 1. Start the two local servers

Open a terminal and run both (each in its own window / background):

```powershell
cd "C:\Users\Trading\Documents\Default Project\_captures\tv-app-mirror"
node serve.js      # static server on http://127.0.0.1:8088
node wsproxy.js    # WebSocket re-origin proxy on ws://127.0.0.1:8090
```

- `serve.js` serves the mirror and rewrites absolute `*.tradingview.com` URLs to
  local paths. It also patches the page so the feed points at the local WS proxy:
  - `window.WEBSOCKET_HOST`  -> `127.0.0.1:8090`
  - `window.PUSHSTREAM_URL`  -> `ws://127.0.0.1:8090`
  - socket protocol `wss:`   -> `ws:` (and accepts `ws:`)
- `wsproxy.js` accepts a plain local socket and re-originates it upstream as
  `https://www.tradingview.com` (correct `Origin`), relaying frames verbatim.

Why the proxy is needed: the page runs on `http://127.0.0.1`, so it is a
*cross-site* origin to `tradingview.com`. The feed server rejects the local
origin (and cookies are withheld). The proxy makes the socket look like it
comes from the real site, so the feed connects.

## 2. Open the app

```
http://127.0.0.1:8088/www.tradingview.com/chart/j3mUKCaZ/
```

(The short path `http://127.0.0.1:8088/chart/j3mUKCaZ/` works too.)

## What works

- Full chart UI (top toolbar, intervals, drawing tools, side panels, watchlist).
- **Live candles** — NAS100 · 1D · Capital.com, via the proxy (anonymous, delayed).
- **Bar Replay** — click the Replay button in the top toolbar, click a bar to
  set the start point, then use play / step / speed / skip-to-realtime. The
  chart truncates at the replay cursor and future bars are dimmed.
- **Watchlist dropdown** — opens, lists Recently used, switches the active list.
- **Create list / Make a copy / Rename / Clear / Add section** — all work and
  write to the local backend (`watchlists.json`), no plan gate.
- **More than 30 symbols per list** — the free-plan cap is raised, and rows past
  index 30 are **unlocked** (they used to hide quote values behind an "Upgrade
  to access" lock).
- **No paywall anywhere** — the paywall opener is a no-op, so plan dialogs can
  never render.
- **Symbol search** — routed through `/__ss` to the real
  `symbol-search.tradingview.com`, returns live results.
- **Persistence** — watchlists (`watchlists.json`) and UI/chart settings
  (`settings-store.json`, via `/savesettings/`) survive restarts.

Proof screenshots:

- `..\local-app-candles.png` — candles rendering
- `..\local-app-replay-selected.png` — replay entered, start bar selected
- `..\local-app-replay-playing.png` — replay running
- `..\local-app-search-working.png` — symbol search results
- `..\local-app-watchlist-menu.png` — watchlist loaded with live quotes
- `local2-menu.png` — watchlist dropdown open (matches live)
- `local3-created-list.png` / `local3-copied-list.png` — create/copy dialogs
- `live-create-dialog.png` — live site's paywall for the same action

## Why the dropdown did not open (fixed)

`serve.js` originally rewrote the HTML, but the capture only contained ~77 of
~1682 JS chunks. Opening the watchlist menu lazy-loads
`alerts-external-services.*.js` (chunk 57275); the missing chunk made the
lazy import reject and the menu never rendered (silent, no visible error).

Fix: the exact chunk filename list is encoded in `runtime.<hash>.js`
(`__webpack_require__.u` / `.miniCssF`). A script enumerated every
`(name||id).<hash>.js|css` pair and downloaded the 1696 missing files from
`https://static.tradingview.com/static/bundles/`. Now 2435 JS + 1054 CSS are
present (38 vendor chunks — monaco language packs, workers, zxcvbn — are not
published on the CDN; they are not needed by the chart/watchlist UI).

## Why rows past 30 were locked (fixed)

Adding a 31st symbol worked, but rows from index 30 onward rendered as
`upgradeAccessTableItem` — an "Upgrade to access" button where the price /
change / volume cells should be. The cause was a hardcoded client-side flag in
`58681.*.js`:

```js
const Dt = isFeatureEnabled("watchlist_free_user_symbols_data_limit");
function Wt(e) { return Dt && e >= 30 && !window.user?.is_pro }
```

The row component does `g = columns.length > 1 && Wt(index)` and, when `g` is
true, replaces the data cells with the lock. `patches.js` now points that
feature key at a name that does not exist, so `Dt` is `false`, `Wt()` always
returns `false`, and every row renders its values.

Note *this* lock was **not** the `openPaywall` dialog — clicking still opened
the symbol on the chart, but the quote columns were hidden. Both layers are now
gone: the row lock above, plus `openPaywall` turned into a no-op and
`openWall("paywall", …)` short-circuited in the walls module.

## Live site vs local (captured 2026-11-04)

| Action | Live (Basic/free login) | Local mirror |
| --- | --- | --- |
| Open watchlist dropdown | works | works (after chunk fix) |
| Create list / Make a copy | **paywall** "Multiple watchlists" | works |
| > 30 symbols in a list | blocked (limit 30) | works; rows unlocked, no paywall |
| Symbol search | works | works (via `/__ss`) |
| Bar Replay | plan-limited | works |

So the user-visible problems on the live site are plan limits, not bugs; the
local mirror removes the limits and keeps the same UI/data.

## Known non-fatal gaps

- A few API hosts are not proxied (`pricealerts.`, `notifications.`,
  `news-mediator.`), so those calls fail with CORS/ERR_FAILED. Alerts and news
  panels are affected; the chart and watchlist are not.
- `ws://127.0.0.1:8090/message-pipe-ws/private_feed` is not accepted by the
  proxy yet (alerts pushstream).
- `clear-old-settings.71376172db8e3e206c81.js` and `timer.worker.*.js` are 404
  on the CDN; harmless.
- Feed data is anonymous/delayed (no logged-in entitlements through the proxy).

## Local overrides / removing limits

All our changes to the app live in `patches.js`, applied by `serve.js` **while
serving** (the mirrored files stay untouched). Rules are plain find/replace pairs,
so they are easy to review, toggle and re-apply after a fresh capture.

`patches.js` currently:
- grants pro-only features to the `free` plan,
- raises every numeric free-plan limit to `999999` (watchlist symbols,
  indicators on chart, charts/panes, layouts, historical bars, alerts, ...),
- raises the hard watchlist cap (1000 -> 999999),
- removes the paid-plan requirement for multiple watchlists (the gate is
  duplicated in 6 bundles under different minified names, so the patch matches
  the expression body, not the function name),
- reroutes symbol search to the local `/__ss` proxy.

Verified: a 2-pane layout (free = 1) now works — see `..\local-app-2panes.png`.
The top-bar still shows "Upgrade" because the account's plan badge is separate
and cosmetic.

Important: these are **client-side** checks. Anything the TradingView backend
counts/validates (e.g. server-side alert counts) cannot be raised here.

To add an edit: append a `[find, replace]` pair to `LIMIT_PATCHES` (or a new
rule in `applyJsPatches`) and restart `serve.js`.
