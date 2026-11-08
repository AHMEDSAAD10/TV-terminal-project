# TradingView-Behavior Clone — Build Plan (own UI, own data)

**Goal:** reproduce the *behavior and interaction model* of the TradingView chart app — panels, dialogs, menus, the indicator workflow, the screener UX, the watchlist, the drawing tools — running on **your** data source, with **no** dependency on TradingView's servers, token, or entitlements.

**Companion document:** `tradingview-analysis.md` (the evidence report — every behavior below is tagged `§n` to it).

**Date:** 2026-11-02

---

## 0. Straight answers (read this first)

1. **Yes — the app behavior is cloneable.** Everything you touch in the UI (panels, docks, dialogs, menus, context menus, the indicator add-flow, watchlist switching, the screener grid, interval change, layout switching, the object tree) is **client-side** logic. We observed it and mapped it. None of that is secret or unobservable.
2. **No — you don't need to log in, and I don't need your browser session.** The UI code that runs for an anonymous visitor is the same UI code that runs for a paid user; only the *data* and *entitlement checks* differ, and those are server-side. Since you're replacing the server, the anonymous client code is all we need.
3. **Your data model is exactly right.** The app is a **View** over a data feed. Point it at your own API (Yahoo Finance, your broker, whatever) through one adapter and the whole UI works. The app never "owns" the data.
4. **The indicators are the easy part.** RSI, MACD, Bollinger, Stochastic, ATR, EMA/SMA/WMA/HMA, VWAP, Supertrend, Ichimoku, ADX, CCI, Williams %R, OBV, MFI, Parabolic SAR, Keltner, Donchian, Pivots, Fibonacci retracement, etc. are **public mathematical formulas** — the same ones TradingView documents in its public Pine Script reference. You reimplement them in your own code. They are not TradingView's secret.
5. **Pine Script vs "the indicators in the app":** Pine Script is a *language* for writing indicators; the built-in indicator *list* is just code expressed in that language. You don't need Pine to clone the built-ins — you write the math directly. What you must **not** copy is the ~100,000 **community** scripts (those are other users' IP) and TradingView's proprietary internal study runtime.
6. **The only real limits are data licensing and a handful of product decisions** — see §8–§10. None of them block "build my own app that behaves like theirs."

> Note on your screenshots: the images you attached did **not** come through to me (the session records them as `image.png` placeholders only, no pixels). If a panel I haven't covered in the list below is in those shots, tell me the panel name and I'll spec it.

---

## 1. What "clone the app" concretely means

The report shows TradingView's chart page is a **two-channel app** (`§1`):

| Layer | What it is | Your replacement |
|---|---|---|
| **UI shell** | DOM panels, docks, dialogs, menus, canvas chart | You write it (React/Svelte/vanilla + a chart lib) |
| **Data channel A — streaming** | one JSON-over-WebSocket: quotes, bars, studies | One WS (or SSE) from **your** backend |
| **Data channel B — REST** | screener scans, symbol info, news, calendar | REST from **your** backend |
| **Indicator/study engine** | formulas + rendering | Your JS/WASM engine |
| **Persistence** | layouts, watchlists, alerts, saved screens | Your DB (or local storage) |
| **Entitlements** | server-side paid gates | **Gone** — everything is on |

The clone is: **reimplement the shell exactly, replace both data channels, drop the gates.**

---

## 2. Target architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Your frontend (browser)                                     │
│                                                              │
│  App Shell  ── Toolbars / docks / dialogs / context menus    │
│  ChartView  ── canvas candles + overlays + indicator panes   │
│  Screener   ── virtualized data grid + filter DSL            │
│  Watchlist  ── quote list + row switcher                     │
│  StudyEngine── indicator math + render graph                 │
│  Store      ── symbols, series, studies, layout, prefs       │
└───────────────▲───────────────────────────▲─────────────────┘
                │  WS: quotes/bars/study      │  REST: scan/search/
                │  (mirrors §4 method names)  │  symbol/news/calendar
┌───────────────┴───────────────────────────┴─────────────────┐
│  Your backend (Node/Python/Go)                               │
│   - resolve symbol  - history/bars  - live quotes (ws)       │
│   - screener query  - symbol search - news/calendar          │
└───────────────▲──────────────────────────────────────────────┘
                │
        Data adapters (Yahoo / Polygon / Alpaca / broker / CSV)
```

You do **not** have to match TradingView's wire format. But mirroring the method verbs (`§4.2`/`§4.3`) makes the frontend read almost like their code and keeps your protocol debuggable:

```
WS up   : set_auth_token, resolve_symbol, create_series, create_study,
          modify_series, remove_study, remove_series,
          quote_create_session, quote_add_symbols, quote_remove_symbols, quote_set_fields
WS down : symbol_resolved, timescale_update, series_loading, du (study graphs),
          qsd (quote snapshot data), quote_completed, study_loading, study_completed
REST    : /scan (POST), /symbol_search, /symbol, /news, /calendar
```

Framing (`§4.1`), if you want byte-compatibility: `~m~<len>~m~{json}` with `~h~<n>` heartbeats. Otherwise plain JSON frames are fine.

---

## 3. Component-by-component spec

Selectors below are TradingView's observed `data-name` / `data-qa-id` values (from `§10`, `§11`, `§15.7`) — use them as your own component keys so the clone maps 1:1 and stays easy to diff against the report.

### 3.1 App shell / layout (`§2`)
- Three zones: **top toolbar**, **left drawing rail**, **right dock rail** (each rail item is a `data-name` button).
- Docks are **modal overlays**, not routes: opening one dims the chart and floats a panel; Escape closes it (we hit exactly this: a floating dock made the next dock click time out, `§15.1`).
- Grid/multi-chart support (`§15.2` layouts menu: 1–16 grid) with per-cell symbol + interval, and **SYNC IN LAYOUT** toggles for Symbol / Interval / Crosshair / Time.

### 3.2 Chart engine
- Candles, crosshair with OHLC readout, time + price scales, log/percent scale, session breaks, infinite history scroll.
- **Do not build the candles yourself if you don't want to.** TradingView's own **Lightweight Charts** is open-source (Apache-2.0), free, and designed for exactly this. See §7.
- Reconcile against observed behavior: interval change = one `modify_series` + reload, **no** session teardown (`§4.7`); background refresh re-creates the chart session ~20–35 s after load — you can skip that entirely.

### 3.3 Left drawing toolbar (`§7`)
Tools observed (implement each as a *local* tool that draws on an overlay layer and is serialized to your storage):
Trendline, Fib retracement, Gann & Fibonacci, XABCD, Patterns, Long position, Forecasting & measurement, Brush, Geometric shapes, Text, Annotations, Icons, Measure, Zoom, Magnets, Keep drawing, Lock drawings, Hide all, Remove objects.
- TradingView sends **zero wire** for drawing interactions — drawings are purely local until saved (`§7`). Same for you: keep a `DrawingStore`, persist on save.

### 3.4 Top toolbar (`§10`, `§15.2`, `§15.7`)
| Item | Behavior to reproduce |
|---|---|
| Hamburger `main-menu-button` | menu: theme toggle, drawings panel toggle, language, keyboard shortcuts (Ctrl+/), desktop app, auth |
| Symbol button | opens symbol-info minipanel |
| Interval trigger | popover (current favorites) **and** a free-form input dialog (`D` / "1 day" hint) — two different surfaces, don't merge them |
| Indicators `open-indicators-dialog` | see §3.7 |
| Compare `compare-dialog` | symbol search → add overlay (gate removed) |
| Alerts | see §3.9 |
| Replay | see §3.16 |
| Layouts `layouts-menu-button` | grid + sync toggles |
| Trade | broker picker dialog; in the clone this just opens a stub/hook |
| Screenshot | menu: Download image, Copy image, Copy link, Open in new tab, Post image |
| Quick search `header-toolbar-quick-search` | client-side fuzzy symbol switcher |
| Settings `header-toolbar-properties` | tabs: Symbol / Status line / Scales and lines / Canvas / Trading / Alerts / Events |
| Fullscreen | layout toggle |

### 3.5 Watchlist panel (`§15.1`, `§4.7`)
- List of symbols with live quotes; row click = **switch the chart symbol** (observed choreography: `quote_add_symbols` → `resolve_symbol` → `modify_series`, `§4.7`).
- Settings flyout (per-column toggles), sort, symbol logo, %change color.
- Add-symbol flow: search → append to list (**this is the "create your first watchlist" paywall in TV** — in your clone it just works).
- Support **multiple named watchlists** and persistence.

### 3.6 Stock Screener panel (`§5`) — your "scanner"
This is the panel you called out. Reconstruct it as a **REST-backed data grid**:
1. **Filter/column catalog is data-driven.** TV serves 267 filter definitions, 267 param helpers, 1,161 presets in 156 groups (`§5.3`, `§5.4`). Build your own catalog table (you can start with a subset — e.g. 40 filters — and grow).
2. **Query DSL** (`§5.1`): `{ columns:[...], filter:[{left,operation,right}], filter2:{operator,operands:[...]}, range:[start,end], sort:{sortBy,sortOrder}, markets:[...] }`. Ops: `equal, has, has_none_of, above, aboveOrEqual, below, belowOrEqual, between, outside, crosses, crossesUp, crossesDown, abovePercent, belowPercent`.
3. **Response**: `{ totalCount, data:[{s:"NASDAQ:AAPL", d:[...positional...]}] }` (`§5.2`). Positional `d[]` = fast; keep it, or switch to named objects (easier, slightly larger).
4. **UX**: skeleton loading, 100-row lazy pages via `range`, sort by clicking a header, filter builder UI, quick presets, save/load screens (**storage is 403 in TV — yours is free**), column chooser, export CSV.
5. **Market routing**: `markets:["america"]` ↔ URL segment; same grid can serve bonds/forex/crypto by swapping the dataset.
6. Your data comes from your adapter (Yahoo screener-ish endpoint or your own DB). The ×15-min delay TV applies (`kind:"delay"`, `kind-delay:900`, `§5.2`) is theirs — you stream whatever your source allows.

### 3.7 Indicators dialog (`§6`)
- Modal titled "Indicators, metrics, and strategies"; search box; categorized groups (Technicals / Fundamentals / Community).
- Each row = a study descriptor (`data-id="STD;RSI"` style). Clicking a row **adds the study**.
- Typeahead on search (debounced), grouping, favorites, per-row "add to chart".
- In TV this click is **blocked by the `gopro` paywall for anonymous users** (`§6.3`, proven across 7 runs — zero `create_study` frames). **You delete that gate.** Your click emits your own `create_study`-equivalent and the study renders.

### 3.8 Indicator/study lifecycle + object tree (`§4.6`, `§15.4`)
- Add study → engine computes series → render in overlay or its own pane.
- **Object tree** panel lists every study/drawing with: hide (`span[role=img][data-name='hide']`), right-click menu (Add alert, Add indicator, Add to favorites, Visual order, Visibility on intervals, Move to, Pin to scale, Copy, Hide, **Remove**, Settings) `§15.3`.
- **Remove** is the only op that touches the wire in TV (`remove_study ["cs","studyUiId"]` → `study_deleted ["cs","studyUiId","internalId"]`, `§15.4`). Yours just deletes from the store.
- Reimplement all menu actions as local operations (they're all client-side in TV except remove).

### 3.9 Alerts panel (`§15.1`)
- Tabs Alerts / Log, empty state, list of alerts with symbol / condition / status.
- Create-alert: pick symbol, condition (crossing price, indicator value, % change...), expiration, notification channel.
- TV paywalls this for anonymous (`§15.5`); yours evaluates conditions **client-side or in your backend** and fires webhooks/notifications. No gate.

### 3.10 Economic calendar (`§15.1`)
- TV: `economic-calendar` + `scanner /global/scan?label-product=calendar-{dividends,earnings,ipo}`. Reproduce as a table: date / country / event / importance / actual / forecast / previous, plus Dividends / Earnings / IPO tabs filtered by your data source.

### 3.11 Community / News (`§15.6`)
- News dialog = REST-only (`/news-flow`); render headline list with tabs (key-facts / headlines).
- Community ideas feed = REST list of cards. Optional in v1.

### 3.12 Settings & interval (`§15.6`, `§15.2`)
- Chart Settings: tabs Symbol / Status line / Scales and lines / Canvas / Trading / Alerts / Events; sections Candles, Data modification. All client-side → all local prefs.
- Interval model: **favorites list** + **full preset tree** (Ticks/Seconds/Minutes/Hours/Days/Ranges) + free-form input. Favorites are stored locally in TV (`favorite-indicators` chunk + localStorage).

### 3.13 Context menus (`§15.3`)
- **Chart pane** right-click: Copy price / Paste / Add alert / Buy limit / Sell stop / Add order / Lock vertical cursor / Table view / Object tree / Remove N indicators / Settings.
- **Object-tree row** right-click: the 12 items above.
- **Both are pure client-side in TV** → pure client-side in yours.

### 3.14 Bar replay (`§15.5`)
- TV paywalls it; functionally it replays bars already in the dataset, step/play/speed, with a "trading" bottom widget. Yours: replay from your locally-buffered history. No new data channel needed (TV proved this: **zero wire** beyond prefetch).

### 3.15 Layouts / multi-chart / snapshot (`§15.2`)
- Layout grid (1–16), sync toggles, save/load layouts (TV: client-side + your storage).
- Snapshot menu → render chart to image (canvas `toDataURL`), download/copy/copy-link.

---

## 4. The indicator engine

**Built-ins everyone expects** (all public math): SMA, EMA, WMA, HMA, RMA/Wilder, VWMA, VWAP, Bollinger Bands, Keltner, Donchian, Envelopes, RSI, Stochastic, Stochastic RSI, MACD, ADX/DMI, ATR, CCI, Williams %R, Momentum, ROC, TRIX, Ultimate Osc, OBV, Volume, MFI, Force Index, Parabolic SAR, Supertrend, Ichimoku, Pivot Points (classic/Fib/Camarilla/Woodie), ZigZag, PSAR, Anchored VWAP, plus candlestick pattern recognizers.

**Implementation shape:**
```ts
interface Study {
  id: string; name: string;
  inputs: InputSpec[];          // length, source, ...
  overlay: boolean;             // price pane vs own pane
  calc(bars: Bar[], in: Values): PlotSeries[] | PlotPoints[];
}
```
- Compute incrementally: cache per bar index, recompute only on new/updated bar.
- Keep a **registry** (id → Study) so the dialog, favorites, object tree, and persistence all read the same catalog.
- Optional stretch: a **user-script layer** (mini pine-like DSL: `ta.rsi(close,14)`) if you want power users to author studies. Not required for the clone.

**What you cannot/should not copy:** the ~100,000 community scripts (third-party IP) and TradingView's proprietary server-side study execution. The math for built-ins is public; the community marketplace is not yours to clone.

---

## 5. Data layer / adapter

```ts
interface DataAdapter {
  resolveSymbol(q: string): Promise<SymbolMeta>;      // §4.5 shape
  history(sym, resolution, range): Promise<Bar[]>;    // OHLCV
  subscribeQuotes(symbols: string[], cb): Unsub;      // live ticks
  scan(query: ScanQuery): Promise<ScanResult>;        // §5.1/5.2
  searchSymbols(text: string): Promise<SymbolMeta[]>;
  news?(): Promise<NewsItem[]>;
  calendar?(): Promise<CalendarEvent[]>;
}
```
- Ship adapters: `yahoo.ts`, `csv.ts`, `polygon.ts`/`alpaca.ts` (if licensed), `mock.ts` (deterministic random walker for dev).
- **Realtime vs delayed is your choice**, driven by what the source permits. The delayed/realtime markers TV uses (`update_mode:"streaming"` vs `delayed_streaming_600`, `SP_NAUTH:`, `kind:"delay"`/`kind-delay:900`, `§4.4`) become an optional `delaySeconds` field you can surface in the UI ("Delayed 15 min") — informational, not a gate.
- **Symbol identity:** keep `{exchange}:{ticker}` plus a night/overnight alias concept (`§4.5`) only if your source has it.

---

## 6. Persistence & accounts (optional)

- Local-first: `localStorage`/IndexedDB for layout, watchlists, drawings, favorites, chart settings.
- If you want accounts: your own auth + DB (`watchlists`, `layouts`, `alerts`, `screens`, `drawings`). No entitlement tiers required — but you can add your own tiers later if it's a product.
- **Alerts** need a backend (cron/evaluator + push/webhook). This is the only piece that's genuinely server-y.

---

## 7. Reusing TradingView's own building blocks (the licensing reality)

| Option | Status | Notes |
|---|---|---|
| **Lightweight Charts** (TradingView, Apache-2.0) | Free, no license request | Candles/line/area, crosshair, scales. **Best starting point.** No built-in indicators UI — you add that. |
| **Advanced Charts / Charting Library** (TradingView) | Free but **licensed**, request access | Full TV-grade chart incl. studies UI. The license has conditions/restrictions — **read it before shipping**; it is not a no-strings open-source license. |
| **Third-party** (e.g. other OSS chart libs) | Varies | Fine for the shell; you still build the panels. |

Recommendation: **Lightweight Charts for the candles** + your own panels for everything else. It's the fastest legitimate path and the license is permissive.

---

## 8. Roadmap

**Phase A — skeleton (1–2 wks).** shell layout, rails, Lightweight Charts candle view, mock adapter, symbol switch, interval switch, timeframes.

**Phase B — data (1–2 wks).** real adapter, WS/SSE live quotes, history paging, symbol search, watchlist CRUD + persistence.

**Phase C — studies (2–3 wks).** study registry + 20 core indicators, dialog, overlay/pane rendering, object tree (add/hide/remove/settings), legend.

**Phase D — screener (2–3 wks).** filter/column catalog, DSL, grid (virtualized, lazy, sort), presets, saved screens, CSV export.

**Phase E — trading UX (1–2 wks).** drawing tools + persistence, context menus, alerts (backend), layouts/multi-chart, snapshot, replay, settings.

**Phase F — polish.** keyboard shortcuts, themes, favorites, mobile/responsive, docs.

---

## 9. What cannot be reproduced (and why it doesn't matter to you)

| Thing | Why not | Impact on you |
|---|---|---|
| TradingView's **paid entitlement behavior** on *their* site | Enforced server-side; there is no client flag to flip | You're building your **own** app — the gate doesn't exist in yours |
| TradingView's **licensed market data** (realtime exchange feeds) | Licensed; rebroadcasting is illegal | You use **your** source (Yahoo/broker/etc.) |
| The **exact Pine runtime** and the 100k community scripts | Proprietary runtime; scripts are users' IP | You reimplement **public** indicator math; you don't need their marketplace |
| Exact **internal study ids/params** byte-for-byte | Internal to their backend | Your own ids; the UI behavior is what matters |
| Live capture of a **logged-in** session | Not needed — anonymous client code == paid client code for the UI | None |

---

## 10. Legal / ethical line

- **Fine:** cloning UI behavior, reimplementing public technical indicators, using your own/your-licensed data, using Apache-licensed libraries, mirroring a wire *shape* for your own server.
- **Not fine:** scraping/rebroadcasting TradingView's data or community scripts, circumventing their server-side entitlements on their site, shipping their Charting Library in breach of its license, using their trademarks/logo as your product identity.

The clone is legitimate because it's **your** app with **your** data — not a proxy into theirs.

---

*Build plan ends. Behavioral claims map to `tradingview-analysis.md` §§1–15 (anchored to the per-run evidence ids in §14/§15.8).*
