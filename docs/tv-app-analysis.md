# `www.tradingview.com (2).zip` — full library analysis

**What it is:** a complete mirror/capture of the **live tradingview.com chart page** (`/chart/j3mUKCaZ/`, layout `us30 copy`, symbol `CAPITALCOM:NAS100`) — the real web-app build, split into Webpack chunks. It is **not** the embeddable `charting_library` package.

**Extracted to:** `C:\Users\Trading\Documents\Default Project\_captures\tv-app-mirror\`

| Metric | Value |
|---|---|
| Archive | 6.62 MB zip |
| Extracted | 886 files · 25.17 MB |
| JavaScript chunks | **390** |
| CSS stylesheets | **331** |
| HTML pages / API captures | 63 |
| SVG / PNG | 54 / 5 |
| Domains captured | 22 (chart + data + storage + telemetry) |
| Page entry scripts | 46 — **all present** |
| Page entry CSS | 18 — **all present** |

> Completeness: the page's entire initial load set is present, plus every lazy chunk that fired during the capture (chart boot → interval switch → **replay click → bar pick**). Lazy chunks for features you never opened in that session may be absent.

---

## 1. What kind of "library" this is

Three different things are commonly called "the TradingView library":

| Thing | Present here? |
|---|---|
| **Live site app build** (the actual tradingview.com chart, chunk-split) | ✅ **this archive** |
| Embeddable **`charting_library`** (`ChartingLibraryWidget`, `TradingView.widget({...})`, `widget.html`) | ❌ **not here** (searched all 390 chunks: zero `ChartingLibraryWidget` / `TradingView.widget`) |
| Standalone **`charting_library` v33** you already have in `Downloads\...\charting_library\bundles` | separate, on disk elsewhere |

So: this is **the full application**, with every internal module — including Bar Replay — but exposed only through the app's own module graph, not through a public embed API.

---

## 2. Component inventory (what's actually inside)

### 2.1 Chart engine / GUI

| File | KB | What it is |
|---|---:|---|
| `main_chart.86b5a59bfe1b2b52d929.js` | 122 | chart core: panes, series, scales, crosshair, `createChart` |
| `chart-widget-gui.044a056b35a4e6230122.js` | 200 | chart GUI chrome (axes, legend, toolbar wiring) |
| `runtime.d460c5150aac666865fc.js` | 194 | Webpack runtime + chunk loader (781 chunk refs) |
| `floating-toolbars.8169e7aee734882177a6.js` | 185 | floating toolbars (drawing, favorites) |
| `studies.92a3eddb854e9585a5ca.js` | 209 | indicators / studies engine |
| `full-toolset.2075b30efe852fb18685.js` | 66 | full drawing-tool set registration |
| `study-pane-views.86308f8159eda380264d.js` | 108 | indicator pane rendering |
| `drawing-toolbar.48ccca4917c0b9695daf.js` | 94 | left drawing toolbar |
| `line-tool-*` (`trend-line`, `rectangle`, `brush`, `risk-reward`, `text-note`, `image`) | 9–64 | individual drawing tools |
| `tpo-study.5322352a296ee8499ff7.js` / `volume-footprint-study.c62af0ecd0aca09e1388.js` | 18 / 16 | TPO + footprint |
| `header-toolbar.c2616834b1f7e3110382.js` | 56 | top toolbar (contains the **Replay button gate**) |
| `chart-bottom-toolbar.7dc05cda118b83def518.js` | 85 | bottom toolbar host (mounts the replay bar) |
| `chart-toolbar-hosts.e36ef993444d94763214.js` | 10 | toolbar component registry |
| `top-left-button`, `price-scale-mode-buttons`, `end-of-series-banner`, `spinner-renderer`, `error-renderer` | 1–166 | misc UI |

### 2.2 Bar Replay (the one you care about)

| File | KB | Role |
|---|---:|---|
| **`replay.0dac6e29e0f06faafb56.js`** | **156** | **the whole replay engine + bottom toolbar React components** (`Sa`, `oa`, `It`), `switchToReplay`, `startAutoplay`, `doStep`, `setReplayStatus`, timing-mode menu |
| `replay-broker.94815ceaa54ac783e0cf.js` | 15 | replay broker: orders/positions during replay |
| `replay-broker-host.1c8652a574f92c0a01f7.js` | 2 | broker host wiring |
| `trading-replay.270022fb01bda1fa5705.js` | 64 | `BarReplayActions` dispatch + trade-in-replay |
| `backtesting-replay-strategy-facade.b81fc3f94c534e128cde.js` | 2 | backtesting facade |
| `backtesting-widget-controller` / `bottom-backtesting-widget` | 1 / 17 | backtesting panel |
| `bottom-replay-trading-widget.c3f73d7aa1b436919fb4.js` | 3 | "Replay Trading" pill widget |
| `replay-trading-widget-controller` / `-tab-model` | 2 / 6 | replay-trading panel |

This is the **same engine** documented in `_captures/replay-trace-doc.md` — but here you have the actual files on disk, not just extracted snippets.

### 2.3 Trading

`trading.064803543f5d16e1608e.js` (421 KB), `trading-order-ticket.9508c17316ff12e86ed1.js` (564 KB), `order-widget.c19e3b4de3a5abb85448.js`, `position-widget.3c50b57a573d040a9854.js`, `modular-broker.e57f16831174be44bed8.js` (55 KB), `trading-groups`, `trading-custom-sources`, `trading-informer`, `trading-bottom-widget*`, `trading-widget-controller`, `chart-strategies-provider`, `paper-maintenance-checker`.

### 2.4 Panels / widgets

`widgetbar.8f1c7ce7e9a1d2cc64f3.js` (80 KB) — the side panel host. Tabs:
- `watchlist-widget` (115 KB)
- `alerts-*` — **15 files**, full alerts suite (manage/log/rest/session/tracking/notifications)
- `news-*` + `news-symbol-thread-service`
- `screener-dialog` (116 KB) + `filter-presets-stock-merged` (306 KB)
- `symbol-search-dialog` (92 KB) + `symbol-list-service` (128 KB)
- `pine-editor-bottom`, `pine-editor-bottom-widget-model`, `pine-tiles-*` (Pine editor)
- `footer-widget`, `bottom-widgetbar`, `site-models`

### 2.5 Styling

331 CSS files — the complete UI skin, including the replay toolbar rules (`replayWrapper-CvWEQ6Ei`, `replayToolbar-CvWEQ6Ei`, `controls-x6NoHjDT`, `selectDateBar-Q3_c93rj`). Hashed class names, but the rules are readable and copyable.

---

## 3. Captured data (usable as sample data)

| Endpoint | File | Content |
|---|---|---|
| `charts-storage` | `.../layout/j3mUKCaZ/sources-*.html` | **your saved chart layout JSON** — line tools, studies, series state (40 KB) |
| `scanner` | `america/scan.html` | 44 NASDAQ symbols with metadata (19 KB) |
| `scanner` | `enum/ordered.html` | 4.7 MB enum catalogue |
| `pine-facade` | `list.html` | 727 KB public Pine script catalogue |
| `economic-calendar` | `events.html` | calendar events JSON |
| `pricealerts` | `list_alerts.html` | your alerts |
| `screener-facade` / `-storage` | `columns.html`, `screens/*` | screener schema + saved screens |
| `news-mediator` | `public/news/...` | news stories |
| `crud-storage` | `api/order_preset` | order presets |

Note: the WebSocket captures (`wss---data.tradingview.com`, `wss---pushstream.tradingview.com`) are **0 KB stubs** — no live feed frames were saved.

---

## 4. What you can actually do with it

### ✅ 1. Reference / spec (best use)
Every component is real, readable code. This is the definitive answer to "how does X work" for chart, replay, trading, alerts, Pine, screener. Already used for the replay doc.

### ✅ 2. Port the Replay module to your own app
`replay.0dac…js` + `chart-bottom-toolbar…js` + `trading-replay…js` contain the complete pattern:
- toolbar components (`Sa`, `oa`, `It`)
- control → action enum (`BarReplayActions`)
- action → engine (`doStep`, `toggleAutoplay`, `goToRealtime`, `requestCloseReplay`)
- engine → session commands (`replay_start`, `replay_stop`, `replay_step`, `switchToReplay`)
This is ~150 lines of React + a thin controller — portable to your own datafeed. **Not drop-in** (see limits).

### ✅ 3. Reuse the CSS
Copy the replay toolbar rules and rename the hashed classes. Fastest way to get the exact look (`Select bar ▾ · ▶ · ⏭ · 10x ▾ · D ▾ · ⏭| · ✕`).

### ✅ 4. Sample data
Your chart layout, scanner list, Pine catalogue, calendar — useful fixtures for a prototype.

### ⚠️ 5. Run it as an offline snapshot
Possible but non-trivial:
- `index.html` references **absolute** `https://static.tradingview.com/...` URLs → `file://` won't load them.
- Needs a local web server + hosts mapping (or URL rewrite) for `static.`, `www.`, `data.`, `s3.`, etc.
- Even then, the app will call their live APIs/WebSocket for data; without those it renders the shell and blocks on feeds.
- Some lazy chunks for unvisited features may 404.

### ❌ Not possible
- **No embeddable API.** No `ChartingLibraryWidget`, no `TradingView.widget(...)`, no `widget.html`. You cannot `new TradingView.widget()` against this folder.
- **No live market data.** WS captures are empty stubs.
- **No self-contained "drop-in library".** The modules assume the app's DI container, i18n, feature flags, storage, auth, and broker host.
- **Redistribution** of their code is not permitted; personal study/integration is the realistic scope.

---

## 5. Practical build path (given your goal)

If the goal is **your own Bar Replay**:

1. Read `replay.0dac…js` for the exact component + handler shape (also summarized in `_captures/replay-trace-doc.md` §11–15).
2. Recreate the 7 controls with plain React/HTML: `Select bar` (mode menu), `Play/Pause`, `Forward`, `Speed`, `Interval`, `Jump to realtime`, `Exit`.
3. Map each to one action: `do_step`, `start_autoplay`, `pause_autoplay`, `change_frequency`, `change_replay_resolution`, `go_to_realtime`, `close_replay_from_toolbar`.
4. Implement the engine as a tiny state machine: `replayPoint`, `isAutoplay`, `delay`, `resolution`, `status` (`Pause | Autoplay | Finish`).
5. Cut data client-side at `replayPoint` (that is exactly what TradingView does — no server round-trip at the cut).
6. Reuse the CSS from the 331 stylesheets for the look.

---

## 6. Where things are

```
_captures/tv-app-mirror/
├─ www.tradingview.com/chart/j3mUKCaZ/index.html   ← the page (370 KB)
├─ static.tradingview.com/static/bundles/          ← 390 JS + 331 CSS
│   ├─ runtime.d460c5150aac666865fc.js             ← chunk loader
│   ├─ main_chart.86b5a59bfe1b2b52d929.js           ← chart engine
│   ├─ replay.0dac6e29e0f06faafb56.js              ← REPLAY ENGINE + TOOLBAR
│   ├─ replay-broker.94815ceaa54ac783e0cf.js
│   ├─ trading-replay.270022fb01bda1fa5705.js
│   ├─ trading.064803543f5d16e1608e.js
│   ├─ studies.92a3eddb854e9585a5ca.js
│   ├─ full-toolset.2075b30efe852fb18685.js
│   └─ header-toolbar.c2616834b1f7e3110382.js
├─ charts-storage.tradingview.com/...              ← your chart layout JSON
├─ scanner.tradingview.com/...                     ← scanner data
├─ pine-facade.tradingview.com/...                 ← Pine catalogue
└─ economic-calendar.tradingview.com/...           ← calendar data
```

**Verdict:** you are right — the whole app and every component (including replay) is in here, as **runnable-intent source**, not as an embeddable SDK. Treat it as the reference implementation + CSS + fixtures; port the replay pieces into your project rather than trying to mount this build directly.