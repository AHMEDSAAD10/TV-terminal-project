# TradingView Chart + Stock Screener — Reverse-Engineering Report

**Target:** `https://www.tradingview.com/chart/` (anonymous / free tier, no login)
**Method:** REA "Reverse Engineer Anything" — live-browser scenario captures (Edge/Chromium 156 headless, `capture_browser_scenario`), plus static mining of the served JS bundles and a standalone API replay.
**Date:** 2026-11-02 (phase 1: 2026-11-01; phase 2 = per-panel click→request coverage + full WS decode + indicators-dialog/paywall analysis)

---

## 1. Executive summary

- The chart page is a **two-channel** application: one JSON-over-WebSocket (`wss://data.tradingview.com/socket.io/websocket?…&type=chart`) for symbol resolution, bar series, studies and quotes; REST XHRs for aggregation data (screener, symbol minipanel, options data, news, logs, telemetry).
- The **Stock Screener** running inside the chart page is a **REST-only** component: it does not speak the chart WS protocol. Its data comes from the **Scanner API** (`scanner.tradingview.com/<market>/scan`), which works standalone with no login, no cookies and no browser — validated by replaying the exact POST from PowerShell.
- The screener's entire filter/column surface is **self-describing**, versioned and fetchable: 267 filter definitions, 267 parameter helper sets, and 1,161 quick presets in 156 groups — all captured and decoded.
- The **chart WS load protocol** was reconstructed frame-by-frame: anonymous auth token → 7 quote sessions + 1 chart session → `resolve_symbol`/`create_series` → 5 boot studies → streaming `qsd` quote batches, `du` study graphs, `timescale_update` marks. Server identifies itself (`release_210-20`, free-tier backend nodes) and delayed quotes are marked with tier markers (`SP_NAUTH:`, `update_mode:"delayed_streaming_600"`, `kind:"delay"`/`kind-delay:900`).
- **Every major UI panel was exercised against the wire.** The complete click→request map is §10. Highlights: screener sort toggle is client-side (no scan POST); watchlist row switches are a documented WS choreography; Ctrl+S / replay toggle / drawings / Alt+T / snapshot-menu **send no application-API traffic** (only ad/telemetry beacons); the snapshot menu is a 5-item treegrid (`Download image`, `Copy image`, `Copy link`, `Open in new tab`, `Post image`) with the three resize shortcuts revealed.
- **The headline finding of phase 2:** on the anonymous tier, clicking an indicator row in the indicators dialog **never adds the study**. The click is gated by a `data-dialog-name="gopro"` paywall modal ("Access over 100,000 trading indicators … You'll need a free account to access", promo video `study-limit.avc1….mp4`, CTA `Join for free`). The gate fires on **every** add attempt (7 runs, 6 attempts, 0 `create_study` frames), the modal's real Close button works but it **auto-reopens within ≤ 3.5 s with no further input**, and `aria-label="Pause"` is merely the promo-video pause control. Full anatomy and timeline in §6.
- Screener "storage" features (recent/created screens) are **auth-gated** (403); screener auto-refresh and interval selection are paywall features with client-side checking (`SCREENER_INTERVALS`, `SCREENER_AUTO_REFRESH` → `openPaywall`).

---

## 2. Page architecture

- Entry HTML for `/chart/` → 50+ script bundles + CSS chunks from `static.tradingview.com/static/bundles/` (list: `tv-script-srcs.txt`). Main entry: `main_chart.7f6165e2bc6ef14ee569.js` (124 KB bootstrap — the bulk of chart logic lives in numbered chunks like `45885`, `83215`, `69540`…).
- Layout: hamburger main-menu (`button[data-qa-id="main-menu-button"]`), exchange toolbar, left drawing-tools column, default `AAPL 1D NASDAQ` chart (344.63, −1.23% at capture), right watchlist panel (SPX, NDQ, DJI, VIX, DXY…), "AAPL" symbol-info dialog areas.
- `window.SS_HOST = "symbol-search.tradingview.com"` — the symbol-search backend host is published in page source (`SS_HOST`).
- `featureToggleState` (inline in HTML) publishes ~60 feature flags; notable: `chart_autosave_5min`, `chart_storage_hibernation_delay_60min`, `alerts-on-position`, `alerts-watchlist-overnight-session`, `earnings-live-calls`, `enable_trading_replay_for_point_indexes`, `nested_drawings_groups`, `screener_stock_ai_filters_enabled`, `enable_symbol_change_restriction_on_widgets`.
- Cross-cutting services on load:
  - Chart WS data (§4), logos (`s3-symbol-logo.tradingview.com/...svg`), news (`news-mediator.tradingview.com/public/news-flow/v2/news`, `/public/doc-screener/v1/events`), live events (`notifications.tradingview.com/news/channel/live-events`), options ring data for AAPL (`options-charting.tradingview.com/v1/volatility-chart/...`, `/v1/in-time-iv/...`).
  - Shop/offerings: `www.tradingview.com/market/shopconf`, `/api/v1/offers`, `/api/v1/brokers/trading_panel`, `/api/v1/study-templates`, `check_language` (POST), `support/support-portal-problems/?language=en`, conversion matcher (`s3.tradingview.com/conversions_en.json`), anonymously-gated `pubscripts-get/personal-access/?…` which re-fires with a **403 console error** on the anonymous tier.
  - Telemetry/analytics: `telemetry.tradingview.com/free/report` + `news/report` with `report_stash` events (`userId:"0"` when anonymous); `snowplow-pixel.tradingview.com/com.tradingview/track`; Google Tag Manager (`G-YVVRYGL0E0` + `DC-13919399` floodlight), DoubleClick ads, Google sign-in (`accounts.google.com/gsi`).
- Server release observed on the WS hello: `release_210-20`; WS metadata includes `studies_metadata_hash: 3e8fbfec07269bbbb9afb8e401d5eea7e833125f`, `auth_scheme_vsn: 2`, `protocol: "json"`, `javastudies: ["3.66"]`.

---

## 3. Session & channel inventory

Two WebSockets plus a REST family:

1. **Chart/quote socket** — `wss://data.tradingview.com/socket.io/websocket?from=chart%2F&date=<ISO>&type=chart&auth=sessionid`. Everything below in §4 rides this socket.
2. **Pub/sub pipe** — `wss://pushstream.tradingview.com/message-pipe-ws/public` — platform-wide push (marketing/experiment/ad traffic), same framing.
3. **REST** — scanner/facade/storage, symbol minipanel, news, options, telemetry (§5).

Server-side node identity: hello assigns chart session ids of the form `0.17166025.0_hkg1-charts-free-4-tvbs-it0ti-5` (`hkgN-charts-free-N…` = free-tier chart backend, Hong Kong datacenter); `du` study graph nodes are named `sin1-charts-free-3-study-ipdg1-N`.

---

## 4. Chart WebSocket protocol (framing, sessions, payloads)

### 4.1 Framing

- Client/server payload frames: `~m~<len>~m~{json}` (len = byte length of the JSON). Heartbeats both directions: `~h~<n>` and `~m~N~m~~h~<n>`.
- The server's **first frame** assigns the chart session (see node identity above); the client's **first frame** is anonymous auth:
  ```
  ~m~54~m~{"m":"set_auth_token","p":["unauthorized_user_token"]}
  ```
- No cookies are used on `data.tradingview.com`; the anonymous token *is* the identity.

### 4.2 Full load protocol (reconstructed from multiple runs; per-frame die-off in ev_7989eade)

Client command order:

```
set_auth_token    ["unauthorized_user_token"]
set_locale        ["en"]
chart_create_session ["cs_<12 chars>"]
switch_timezone   ["cs_…","Etc/UTC"]
quote_create_session ["qs_multiplexer_full_<rand>"]      ("produces delayed quotes", ...)
quote_create_session ["qs_multiplexer_simple_<rand>"]
quote_create_session ["qs_multiplexer_watchlist_<rand>"]
quote_create_session ["qs_snapshoter_basic-symbol-quotes_<rand>"]
quote_create_session ["qs_snapshoter_crypto-asset_<rand>"]
quote_create_session ["qs_snapshoter_session-resolver_<rand>"]
quote_set_fields  ["qs_…", [...field list...]]
quote_add_symbols ["qs_snapshoter_basic-symbol-quotes_…", {17 quoted watchlist symbols}]
                  // quoted form: {"adjustment":"splits","currency-id":"USD","symbol":"BATS:AAPL"}
                  // plain form on simple multiplexer: "BATS:AAPL"
resolve_symbol    ["cs_…","sds_sym_1", "={\"adjustment\":\"splits\",\"flag\":...}", "={\"symbol\":\"BATS:AAPL\", ...}"]
create_series     ["cs_…","sds_1","s1","close","D",300,""]
create_study      ×5  (default studies — see 4.5)
```

Observed session ids in one capture (ev_7989eade): chart `cs_ddLcu0lq39QM`; quote sessions `qs_multiplexer_full_aUSrrqmd1ABx`, `qs_multiplexer_simple_KPg96RhWK7r1`, `qs_multiplexer_watchlist_3rQZXy27hIFg`, `qs_snapshoter_basic-symbol-quotes_anXoxJkQZZQl`, `qs_snapshoter_crypto-asset_Bd333NzoSXVH`, `qs_snapshoter_session-resolver_Psrzp6ROFMXB`; plus what the indicators dialog creates on demand (`cs_AilrnU5EzcyM`, `qs_snapshoter_indicators-dialog_khoKwoFoxicC`, §6.3).

Teardown at end-of-session: `quote_hibernate_all`, up to **20× `quote_remove_symbols`** (batched cleanup of every subscribed symbol), `series_deleted`/`study_deleted`/`chart_delete_session` for the Seasonals scratch session.

### 4.3 Server response vocabulary (ev_7989eade, 209 frames — incl. dialog open + typing + 2 add attempts)

| `m` | count | meaning |
|---|---|---|
| `qsd` | 56 | quote streaming data batch (one symbol per message) |
| `quote_completed` | 49 | all fields for symbol X delivered |
| `study_loading` / `study_completed` | 6 / 6 | per created study |
| `du` | 5 | study data update — bar graphs per node |
| `quote_add_symbols` | 8 | client adds (incl. watchlist switch) |
| `quote_remove_symbols` | 21 | 20 cleanup + 1 during switch |
| `quote_create_session` | 7 | as above |
| `quote_set_fields` / `quote_fast_symbols` | 6 / 7 | field subscription lists |
| `create_study` | 6 | 5 defaults + Seasonals probe (never an RSI add) |
| `timescale_update` | 3 | time index + per-bar marks + study annotations |
| `create_series` / `modify_series` / `remove_series` | 2 / 1 / 1 | series lifecycle |
| `resolve_symbol` / `symbol_resolved` | 3 / 1 | incl. scratch session resolve |
| `chart_create_session` | 2 | main + background-refresh recreate |
| `set_auth_token` / `set_locale` / `switch_timezone` | 1 / 1 / 2 | auth & prefs |
| `request_more_tickmarks`, `request_studies_metadata`, `set_future_tickmarks_mode` | 1 each | tickmark/metadata management |
| `quote_hibernate_all`, `chart_delete_session`, `remove_study` | 1 each | teardown (scratch session cycle) |

### 4.4 Quote payload (`qsd`) — anatomy, verbatim samples, delay tiers

`qsd` frames recur in batches (8–16 KB); each carries one symbol. Two verbatim samples (unescaped):

```json
{"m":"qsd","p":["qs_multiplexer_simple_KPg96RhWK7r1",{"n":"NASDAQ:AAPL","s":"ok","v":{
  "logo":{"logoid":"apple","style":"single"},
  "pro_name":"NASDAQ:AAPL","minmove2":0,"minmov":1,"fractional":false,
  "currency_code":"USD","lp":344.63,"ch":-4.28,"chp":-1.23,
  "current_session":"out_of_session","lp_time":1793404795,
  "original_name":"BATS:AAPL","variable_tick_size":"0.0001 1 0.01",
  "measure":"price","currency_id":"USD","is_tradable":true,
  "local_description":"Apple Inc.","update_mode":"streaming",
  "volume":67841555,"pricescale":100,"short_name":"AAPL",
  "listed_exchange":"NASDAQ","language":"en","typespecs":["common"],
  "currency-logoid":"country/US","logoid":"apple","description":"Apple Inc.",
  "exchange":"Cboe One","type":"stock"}}]}
```

```json
{"m":"qsd","p":["qs_snapshoter_basic-symbol-quotes_anXoxJkQZZQl",{"n":"BITSTAMP:ETHUSD","s":"ok","v":{
  "visible-plots-set":"ohlcv","source-logoid":"source/BITSTAMP",
  "logo":{"logoid":"crypto/XTVCETH","style":"single"},
  "pro_name":"BITSTAMP:ETHUSD","minmov":1,"fractional":false,"lp":2257.78,
  "provider_id":"bitstamp",
  "source2":{"country":"LU","description":"Bitstamp","exchange-type":"exchange",
             "id":"BITSTAMP","name":"Bitstamp","url":"https://www.bitstamp.net/"},
  "update_mode":"streaming","pro_perm":"","pricescale":10,
  "base_name":["BITSTAMP:ETHUSD"],"short_name":"ETHUSD",
  "listed_exchange":"BITSTAMP","typespecs":["crypto"],
  "symbol-primaryname":"BITSTAMP:ETHUSD","currency-logoid":"country/US",
  "base-currency-logoid":"crypto/XTVCETH","description":"Ethereum / U.S. dollar", ...}}]}
```

**Anonymous-tier delay markers (verbatim, index quote):**

```json
{"n":"SP:SPX","s":"ok","v":{"pro_name":"SP:SPX","lp":7580.07,"provider_id":"ice",
 "source2":{"description":"Standard and Poor's Indices","id":"SP","url":"https://www.spglobal.com/",...},
 "update_mode":"delayed_streaming_600","pro_perm":"cme_sp_main_indices",
 "base_name":["SP_NAUTH:SPX"],"short_name":"SPX","typespecs":["main"], ...}}
```

- `SP_NAUTH:` in `base_name` is the server-side **not-authenticated** delayed data source alias (the "NAUTH" tier).
- `update_mode:"delayed_streaming_600"` = delayed streaming (600 s window) — index quotes; equities on the simple multiplexer showed `update_mode:"streaming"` when the feed itself is free (Cboe One).
- The scan API marks the same condition differently: `kind:"delay"`, `"kind-delay":900` (15 min) — §5.2.

### 4.5 `symbol_resolved` — verbatim (reveals overnight session)

```
{"m":"symbol_resolved","p":["cs_AilrnU5EzcyM","ss_1",{
 "exchange_traded_night_name":"BOATS","exchange_traded_night":"BOATS",
 "night_symbol":"BOATS_LS:AAPL",
 "source2":{"country":"US","description":"Cboe One","exchange-type":"exchange",
            "id":"BATS","name":"Cboe One","url":"https://markets.cboe.com/us/equities/overview/"},
 "currency_code":"USD", ...}]}
```

AAPL resolves with a **night session alias** (`BOATS_LS:AAPL` — BOATS overnight-venue liquidity); the chart's trendline "Overnight via BOATS" labeling in the watchlist panel is wired to this.

### 4.6 Studies on the load chart (`create_study` set + `du` graphs + `timescale_update` marks)

Boot studies (verbatim commands, session `cs_fvQIcuLHVqQ0`/`cs_ddLcu0lq39QM` variants across runs):

```
{"m":"create_study","p":["cs_…","cr6QNT","st1","sds_1","Volume@tv-basicstudies-281",
                         {"length":20,"col_prev_close":false}]}
{"m":"create_study","p":["cs_…","2GmgwF","st1","sds_1","Dividends@tv-basicstudies-281",
                         {"currenttime":"now"}]}
{"m":"create_study","p":["cs_…","BuSSra","st1","sds_1","Splits@tv-basicstudies-281",
                         {"currenttime":"now"}]}
{"m":"create_study","p":["cs_…","6KqyW1","st1","sds_1","Earnings@tv-basicstudies-281",
                         {"currenttime":"now"}]}
{"m":"create_study","p":["cs_…","cHtL1G","st1","sds_1","BarSetContinuousRollDates@tv-corestudies-50",
                         {"currenttime":"now"}]}
```

Pattern: `create_study [chartSession, <rand6>, "st1", "sds_1", "<Study>@<repo>-<rev>", <params>]`.

Responses per study:
1. `study_loading [cs, "fuUnHt", "s1_st1"]`
2. one-or-more **`du`** frames carrying the study's bar graphs, keyed by study stub → node name:
   - Volume graphs (22.7 KB frame, node `sin1-charts-free-3-study-ipdg1-8`), rows like
     `{"i":-1000100,"v":[1743427800.0,65299321.0,0.0,53406103.35]}` (negative `i` = lookback index; `v` = [time, volume, flag, avg]).
   - Dividends/Splits/Earnings point rows (node `…-study-ipdg1-10`), 9-wide rows:
     `{"i":-1000104,"v":[1730381400.0,0.9668,1.600377,1727654400.0,1730332800000.0,1.64,94511.953345,94930.0,22.0]}`.
   - empty acknowledgement graphs: `{"8QDxnR":{"st":[],"ns":{"d":"","indexes":[]},"t":"s1_st1"}}` followed immediately by `study_completed` (twice in one frame batch: two stubs, two `study_completed`).
3. `study_completed [cs, stub, "s1_st1"]`.

One **`timescale_update`** carries the shared time index and per-bar marks (verbatim):

```json
{"m":"timescale_update","p":["cs_ddLcu0lq39QM",{},{ "index":300,
  "zoffset":0,
  "changes":[1793629800.0,1793716200.0,1793802600.0,1793889000.0,1793975400.0,
             1794234600.0,1794321000.0,1794407400.0,1794493800.0,1794580200.0],
  "marks":[[60,1793577600,300],[40,1793664000,301],[40,1793750400,302],
           [40,1793836800,303],[40,1793923200,304],[50,1794182400,305],
           [40,1794268800,306],[40,1794355200,307],[40,1794441600,308],
           [40,1794528000,309]],
  "index_diff":[],
  "last_session_switches":{"sds_1":{"market":299}}},
 "t":1793561391,"t_ms":1793561391073]}
```

`marks` = `[<type code>, <epoch>, <series index>]`; type codes `40` (regular bar), `50` and `60` (session/holiday variants — code semantics not exercised, but every earnings/dividend glyph seen in the UI correlates with these rows plus the `du` point rows).

### 4.7 Interval change & watchlist switch (user-driven series surgery, no session teardown)

- **Interval click** ("1Y" = `button[data-name='date-range-tab-12M']`): exactly **one** `modify_series` command then `series_loading` — no re-resolve, no socket teardown; click→wire 267 ms (`ev_c5057441…`).
- **Watchlist row switch** (`ev_31a634ef…`, 25/25 steps): row click →
  1. `quote_add_symbols [qs_multiplexer_watchlist_…, {"adjustment":"splits","currency-id":"USD","symbol":"<SYMBOL>"}]` (quoted form);
  2. `resolve_symbol [cs_…, "sds_sym_<N>", …]`;
  3. `modify_series [cs_…, "sds_1", "s2"/"s3", "<series>", "<resolution>", …]` — the chart re-attaches bar data onto new sub-ids; server answers `series_loading` then `timescale_update` and delayed quotes via `SP_NAUTH:` base for paywalled instruments.
- A full **chart-session recreate** (new `chart_create_session`, re-resolve) also occurs automatically ~20–35 s after load — background refresh, not user-driven.

### 4.8 Seasonals probe (dialog-on-demand scratch session)

Opening the indicators dialog spawns a scratch chart session that probes a hidden study without touching the visible chart:

```
create_study ["cs_AilrnU5EzcyM","st1","st1","sds_2","Seasonals@tv-basicstudies-238!",
 {"config":"{\"ticker\":\"NASDAQ:AAPL\",\"years\":{\"start\":2024,\"end\":202…}"}]
```

followed by its own `symbol_resolved` (`ss_1`, §4.5), `study_loading`/`du`/`study_completed`, and teardown via `remove_study`/`remove_series`/`chart_delete_session`. Re-fires on watchlist switches too — it probes the *currently selected* symbol, not a fixed one. The dialog also opens its own quote session (`qs_snapshoter_indicators-dialog_…`, `{"symbol":"BATS:AAPL"}`).

---

## 5. Stock Screener (REST-only dock) — the incidentally deep-traced panel

- Trigger: scanner icon → right-side dock "Stock Screener" (default "All stocks"), rows render after skeleton. Lazy chunk load on open (webpack `[5980,28592,37813,48940,77586,81835]`): `screener-dialog.64fa30ed3274668ee9a2.js` (140 KB), `filter-presets-stock-merged.6ce888eb34434aff56ad.js` (313 KB JSON presets), `filter-presets-descriptions-stock-merged-translated…js` (12 KB), ~34 CSS and 60+ translation chunks.
- Wire sequence on open (`label-product=popup-screener-stock` because embedded):
  1. `GET scanner-backend…/enum/ordered?id=index,country,…,candlestick_patterns&lang=en` (also bond variant with `metrics_full_name` + `ytm-metrics-plan.json`)
  2. `POST scanner.tradingview.com/america/scan?label-product=popup-screener-stock` ← the data request
  3. `POST scanner.tradingview.com/america/metainfo?…` ×2 (small: `[fundamental_currency_code, currency]`; big: 9 fields with allowed-value ranges)
  4. `GET screener-facade…/screener-facade/api/v1/columns/filters?version=…` and `…/columns/params?version=61`
  5. `GET screener-storage…/screener-storage/api/v2/screens/recent/?screener_key=stock&version=61` → **403** + a POST retry (same 403) — recent/owned screens are login-gated
  6. News feed for screener events (`news-mediator …/doc-screener/v1/events`) + audio/text telemetry `userId:"0"`
- **Sort toggle** (ev_793365f8): clicking a column header flips the table **client-side** — no new scan POST. (Direct header-click synthesis times out in headless; the "Change sort" menu path was captured once instead. See §13 limitations.)
- A **second scan event** was observed from the symbol-search flow: `bond/scan?label-product=symbol-search-button` and `scanner…/symbol?symbol=NASDAQ:AAPL&fields=price_52_week_high,…,Recommend.All,…,theoPrice&no_404=true&label-product=symbol-search-button` (and a `right-details` variant) — the mini-info panel and bond preview share the scanner API with different label-products. Also observed: `snowplow-pixel.tradingview.com/com.tradingview/track`.

### 5.1 Request (verbatim POST body, decoded)

```json
{
  "columns":["ticker-view","close","type","typespecs","pricescale","minmov","fractional",
             "minmove2","currency","change","volume","relative_volume_10d_calc",
             "market_cap_basic","fundamental_currency_code","price_earnings_ttm",
             "earnings_per_share_diluted_ttm","earnings_per_share_diluted_yoy_growth_ttm",
             "dividends_yield_current","sector.tr","market","sector","AnalystRating","AnalystRating.tr"],
  "filter":[{"left":"is_primary","operation":"equal","right":true}],
  "ignore_unknown_fields":false,
  "options":{"lang":"en"},
  "range":[0,100],
  "sort":{"sortBy":"market_cap_basic","sortOrder":"desc"},
  "markets":["america"],
  "filter2":{"operator":"and","operands":[
     {"operation":{"operator":"or","operands":[
        {"operation":{"operator":"and","operands":[{"expression":{"left":"type","operation":"equal","right":"stock"}},{"expression":{"left":"typespecs","operation":"has","right":["common"]}}]},
        {"operation":{"operator":"and","operands":[{"expression":{"left":"type","operation":"equal","right":"stock"}},{"expression":{"left":"typespecs","operation":"has","right":["preferred"]}}]},
        {"operation":{"operator":"and","operands":[{"expression":{"left":"type","operation":"equal","right":"dr"}}]},
        {"operation":{"operator":"and","operands":[{"expression":{"left":"type","operation":"equal","right":"fund"}},{"expression":{"left":"typespecs","operation":"has_none_of","right":["etf","mutual"]}}]}
     ]}},
     {"expression":{"left":"typespecs","operation":"has_none_of","right":["pre-ipo"]}}]
  }
}
```

- `columns[]` — 23 columns; `ticker-view` is a pseudo-column inserting `{description, exchange, kind, kind-delay, logo{logoid,style}, name, type, typespecs}`.
- `filter[]` flat AND; `filter2` recursive and/or tree over `{expression:{left,operation,right}}`; observed ops `equal`, `has`, `has_none_of`; facade DSL adds `above, aboveOrEqual, below, belowOrEqual, between, outside, crosses, crossesUp, crossesDown, abovePercent, belowPercent`.
- `range:[start,end]` — 100-row windows; `totalCount` drives skeletons.
- `sort.sortBy` any column id; `markets` array ↔ URL path segment (`america`, `bond`, …).

### 5.2 Response (positional decode; AAPL row)

`{"totalCount":8127,"data":[{"s":"NASDAQ:AAPL","d":[ …23 items… ]}, …]}`

| # | column | value |
|---|---|---|
| 1 | ticker-view | `{description:"Apple Inc.", exchange:"NASDAQ", kind:"delay", "kind-delay":900, logo:{logoid:"apple",style:"single"}, name:"AAPL", type:"stock", typespecs:["common"]}` |
| 2–9 | close/type/typespecs/pricescale/minmov/fractional/minmove2/currency | `344.63, "stock", ["common"], 100, 1, "false", 0, "USD"` |
| 10–12 | change/volume/relative_volume_10d_calc | `-1.2267, 67840642, 1.6409` |
| 13–14 | market_cap_basic/fundamental_currency_code | `5029592216964, "USD"` |
| 15–18 | P/E ttm / EPS diluted ttm / EPS yoy / div yield | `39.507, 8.7233, 32.609, 0.30758` |
| 19–21 | sector.tr/market/sector | `"Electronic technology", "america", "Electronic Technology"` |
| 22–23 | AnalystRating / .tr | `"Buy", "Buy"` |

(`kind:"delay"` + `kind-delay:900` = 15-min delayed on anonymous tier; scalars are positional.)

### 5.3 Self-describing metadata layer (facade)

- `GET /screener-facade/api/v1/columns/filters?version=…` → 267 definitions: `Condition` ×238, `CheckboxGroup` ×15, `RadioBooleanGroup` ×3, `RadioGroup` ×2, `Date` ×3, null ×6. Enum-backed groups: `AnalystRating`, `TechnicalRating`, `RatingMa`, `RatingOscillators`, `Pattern`, plus meta-and-enum `Sector/Industry/Exchange/Country/Index/SubMarket/SymbolCurrency/CfiCode/HighestIncomeCountry`.
- `GET …/columns/params?version=61` → helpers: `fiscalPeriod` ×130, `resolution` ×48 (`TimeResolution1|5|15|30|60|120|240|1D|1W|1M`), `length` ×20 (2…300), `period` ×10, `plot` ×9, `interval` ×8, `inputsGroup` ×5, `level` ×5 (`Middle/R1..S3`), `timebased` ×2; 19 cross-field comparison helpers (e.g. `TargetPrice` vs `["Price","High","IPOOfferPrice","Low","Open"]`, VWAP-family vs OHLC or channels).
- `POST scanner…/metainfo` → enum scoping per field; `GET scanner-backend…/enum/ordered` → ordered enums (12 ids for stock; bond variant 16 metrics: `ytm, ytc, ytp, ytw, price, macaulay_duration, modified_duration, convexity, dv_01, ytm/ytw_to_bid/ask, g/z/f_spread`).
- Machine-readable catalogs: `Temp\opencode\screener-filter-catalog.txt` (267 rows), `screener-preset-catalog.txt` (1,161 rows).

### 5.4 Quick presets

`filter-presets-stock-merged…js` = `{lastPresetId:101064, presets:{<FilterName>:[{id, filter, descriptionKey}]}}` — 156 groups / 1,161 presets, e.g. `Price above 100 "Fractional shares time"`, `MarketCap between 2000e8.. "Mega"`, `EMA(50) crosses Price "Golden cross"`, `RSI between 30..70 "Neutral"`. Preset DSL: `{filter:{left:{column:{id,params}}, type:"Condition", operation:{type}, target:"value", right:{…}}}`.

### 5.5 Client internals (`screener-dialog` module 287627)

Exports `getCommonScanData, getScanData, getRangedScanData, getScan2Data`. The dock uses `getRangedScanData` (`Accept: application/vnd.tv.rangedSelection.v1+json`); `getScan2Data` posts to `scan2`. Error mapping: HTTP 400 `"user does not have rights to watchlist"` → `WatchlistRightsError` (private watchlist-screeners). Feature gates: `ProductFeatures.SCREENER_INTERVALS` (interval whitelist), `SCREENER_AUTO_REFRESH`, flow `runOrGoPro`/`reloginOrGoPro` → `openPaywall`; IDC add-delay-service agreement flow; watchlist `SYMBOL_LIST_SERVICE` sagas (`addSymbolsThunk`, `saveListAsThunk`, `userCreateWatchlistThunk`); paywall descriptor `multipleWatchLists`.

### 5.6 Auth tiers observed

| Endpoint | Anonymous result |
|---|---|
| `scanner…/scan`, `…/metainfo`, `scanner-backend…/enum/ordered` | 200 — full data, delayed quotes (`kind:"delay"`/`kind-delay:900`) |
| `screener-facade…/columns/{filters,params}` | 200 (full 267-entry schema) |
| `screener-storage…/screens/recent/?screener_key=stock&version=61` | **403** (GET and POST) |
| `scanner…/symbol?symbol=…&fields=…&label-product=…` | 200 (minipanel metrics incl. per-field Greeks/IV/52w) |
| Chart WS `set_auth_token ["unauthorized_user_token"]` | works; sessions show `…-charts-free-…` |
| `pubscripts-get/personal-access/?…` | **403** console error |
| Telemetry | `userId:"0"` |

### 5.7 Standalone replay proof

```powershell
$body = '{"columns":["name","close","market_cap_basic"],"filter":[{"left":"is_primary","operation":"equal","right":true}],"range":[0,5],"sort":{"sortBy":"market_cap_basic","sortOrder":"desc"},"markets":["america"]}'
Invoke-WebRequest 'https://scanner.tradingview.com/america/scan' -Method POST -Body $body -ContentType 'application/json'
# 200 → {"totalCount":13866,"data":[{"s":"NASDAQ:AAPL","d":["AAPL",344.63,5029592216964]}, …]}
```

(`totalCount` 13,866 bare vs 8,127 with the UI's default `filter2` type tree. Community corroboration: `shner-elmo/TradingView-Screener` and agent-scraping guides use exactly this family.)

### 5.8 Bond screener (captured incidentally)

`POST scanner.tradingview.com/bond/scan?label-product=…`:
```json
{"totalCount":49,"data":[{"s":"MUN:US37833ER7","d":[6.1288,20620808]}, …],
 "params":{"bond":{"symbols":{"query":{}},"filter":[{"left":"is_primary","operation":"equal","right":true}],
  "index_filters":[{"name":"bond_issuer_cr_parent_stock_symbol","values":["NASDAQ:AAPL"]}],
  "sort":{"sortBy":"yield_to_worst","sortOrder":"desc","nullsFirst":false}}}}
```
Issuer-index filter links bonds to the underlying stock; sorted by yield-to-worst. Fires from inside symbol search with `label-product=symbol-search-button` and from the screener dock (`right-details`).

---

## 6. Indicators dialog — anatomy, network family, and the paywall gate (phase-2 headline)

### 6.1 Opening & network family

- Button: `#header-toolbar-indicators button[data-name='open-indicators-dialog']`.
- On open + use, the dialog issues REST calls (no WS):
  - `pine-facade/list?filter=candlestick|fundamental|standard` (category scaffolds),
  - `pubscripts-suggest-json/?search=<query>` (typeahead — fires per keystroke-ish),
  - `pubscripts-library/?offset=0&count=20&sort=top|trending` (script cards) and editors-picks;
  - plus the anonymous 403 `pubscripts-get/personal-access/?…`.
- Typing works by pressing letters on `body` (TV's global shortcut router); **`Enter`/`Escape` must be pressed on `#indicators-dialog-search-input` itself** (pressing them on `body` shifts focus out of the dialog).
- The dialog also opens its own WS quote session (`qs_snapshoter_indicators-dialog_…`, `{"symbol":"BATS:AAPL"}`) and its scratch `cs_…` probe cycle (§4.8).

### 6.2 Dialog DOM anatomy (from captured DOM + a11y)

- Dialog: `div[role="dialog"][aria-label="Indicators, metrics, and strategies"]` (a11y name matches header button text); header `button "Close menu"`.
- Search: `searchbox "Search"` = `#indicators-dialog-search-input`; results in groups (a11y): `heading "Technicals"` (`Relative strength index`, `RSI divergence indicator`, `Connors RSI`, `Stochastic RSI`…), `Fundamentals` (e.g. `Cash conversion cycle`), `Community` cards with author links and follower counts (`27 K RSI Divergence` …).
- Rows: `div[data-role='list-item']`, id like `data-id='STD;RSI'` for built-ins (STD;<name>), paneled title spans: `span[class^='title-']`. (A list-item's bounding-box center-click lands in an unfocusable dead zone — always click the title span.)

### 6.3 The paywall gate — what actually happens when you "add" an indicator as anonymous

**Behavior (7 capture runs, 6 add attempts, 0 indicator adds):**

| # | Run | Add attempt | Wire result | UI result |
|---|---|---|---|---|
| 1 | `ev_5c088de3…` | click row-div center | zero new frames | row highlights; nothing added |
| 2 | `ev_7989eade…` | click `span[class^='title-']` + Enter on input | zero `create_study` (all 209 frames accounted: defaults + probe) | **`gopro` paywall open at end** |
| 3 | `ev_7e00db07…` | **control: no selection** | — | no paywall after 10 s — **selection is the trigger** |
| 4 | `ev_8dcea454…` | same control, 10 s wait | — | no paywall; dialog intact |
| 5 | `ev_271f8f3c…` | click row → click `Pause` → click row again | zero `create_study` | `Pause` is the video pause; 2nd click **timed out** (row covered) |
| 6 | `ev_9171e7ce…` | post-Pause probe | — | paywall present with `Play` button (video paused) |
| 7 | `ev_c59721fd…` | click row → click `role` "Close" → click row | zero `create_study` | role-`Close` matched the wrong button; paywall stayed |
| 8 | `ev_81ab248e…` | click row → click `[data-qa-id='promo-dialog-close-button']` → wait → click row | zero `create_study` | **definitive timeline below** |

**Definitive per-step timeline (ev_81ab248e, `after_each_step` accessibility snapshots, 13/13 steps):**

| step | action | paywall in a11y |
|---|---|---|
| 1–7 | load / open dialog / type `rsi` (r,s,i on body) | absent |
| 8 | click RSI title span | **present** |
| 9 | 3.5 s wait | present |
| 10 | click `promo-dialog-close-button` | **absent** (dismissed) |
| 11 | 3 s wait, no input | **present again** (auto-reopen) |
| 12 | click row again | present |
| 13 | end | present (final DOM + a11y confirm) |

Paywall modal anatomy (from captured DOM, names unminified):

```html
<div data-dialog-name="gopro" class="wrapper-… dialog-…" style="z-index:150">
  <!-- carousel: --var-promo-dialog-slides-count:1; --var-promo-dialog-active-slide:0 -->
  <video class="video-…" loop playsinline preload="metadata">
    <source type="video/mp4;codecs=avc1"
            src="https://static.tradingview.com/static/bundles/study-limit.avc1.c857e80fcd03df98dd3a.mp4">
  </video>
  <button aria-label="Pause" class="overlayBtn-…" …>        <!-- video control -->
  <button class="overlayBtn-… close-…" aria-label="Close"
          data-qa-id="promo-dialog-close-button">            <!-- real close -->
  <p class="title-…">Access over 100,000 trading indicators</p>
  <div class="description-…">Reveal hidden trends and trading opportunities with more than
     100,000 public indicators. You'll need a free account to access.</div>
  <button data-name="join-for-free-button">Join for free</button>
  <a href="/support/solutions/43000543626/">Learn more about this feature</a>
</div>
```

- **Conclusion:** the anonymous tier cannot add an indicator through the dialog; the add action is intercepted by the account-required promo (`data-dialog-name="gopro"`, asset name `study-limit`), with **no`create_study` ever transmitted**. The dialog/close behavior is purely client-side: zero HTTP during open/close/reopen cycles except ad/analytics beacons. Playwright clicks are CDP-trusted real input events, so this gate is designed client behavior, not a synthesis artifact — though it is possible the count of existing boot studies (5) is what trips the "study-limit" promo.
- Same `INTERNAL:SEASONALS` scratch probe re-fires on watchlist switches (dialog-independent), riding the main socket — indicators-related WS activity is limited to that probe.

---

## 7. Other UI surfaces — click→wire results

| Surface | Interaction captured | Request behavior |
|---|---|---|
| **Snapshot menu** (`#header-toolbar-screenshot`) | menu opens (ev_853e0103) | a11y: `treegrid "Chart snapshot"` with rows `Download image` (Ctrl+Alt+S), `Copy image` (Ctrl+Shift+S), `Copy link` (Alt+S), `Open in new tab`, `Post image`. **No app-API traffic** — only console/GA |
| **Ctrl+S (save)** | pressed | **zero wire** (nothing saved anonymously; no autosave REST) |
| **Bar replay** toggle (`Alt+T` too) | toggled | **zero wire** — replay is client-side; the chart history was already delivered |
| **Drawing tools** (left toolbar buttons: Trendline, Fib retracement, Gann & Fibonacci, XABCD, Patterns, Long position, Forecasting & measurement, Brush, Geometric shapes, Text, Annotations, Icons, Measure, Zoom, Magnets, Keep drawing, Lock drawings, Hide all, Remove objects) | enumerated in a11y | no per-tool requests; drawings are local until login-backed storage |
| **Symbol search** (Quick search / changing symbol) | exercised via watchlist + header | `SS_HOST = symbol-search.tradingview.com`; application switch flow rides the chart WS (§4.7); scanner `/symbol?…&label-product=symbol-search-button` powers the right-details minipanel |
| **Watchlist row click** | `NASDAQ:AAPL` → other symbol | WS choreography §4.7 + `s3-symbol-logo…` logo fetches |
| **Upgrade button** | present (`button "Upgrade"`) | not clicked (avoid marketing noise); `gopro` paywall family documented via §6 |
| **Screener interval/auto-refresh** | visible client-side checks | paywall gates only — no request |

---

## 8. Console noise catalog (for log-diff work)

| Message | Origin | Significance |
|---|---|---|
| `WebchartClient.QuoteSessionMultiplexer:Check your sub/unsub looks it is leaking (client_id=…, symbol=NASDAQ:AAPL)` | 69484…js | TV's own leak check on quote multiplexer teardown |
| `[GSI_LOGGER]: … FedCM …` | accounts.google.com/gsi | Google sign-in FedCM migration warning |
| `<meta name="apple-mobile-web-app-capable"> is deprecated. … mobile-web-app-capable` | page itself | meta deprecation |
| `Lib.SessionScopedSettings:sessionThenTvSettings.get is about to return the default value due to error: Parsed value does not satisfy the provided validation predicate` | 69484…js | settings parse fallback |
| `auto_open_controller_script from Edge` | extension | browser-extension log line (not TV) |
| 403 console error on `pubscripts-get/personal-access/?…` | network | anonymous-tier gate (also on phase-2 dialog runs) |
| popup-screen workspace errors on heavy runs | Playwright | capture infra, not app |

---

## 9. Anonymous-tier behavior matrix

| Capability | Anonymous result |
|---|---|
| Chart load, `unauthorized_user_token` WS | full streaming quotes for free feeds (Cboe One `update_mode:"streaming"`), 15-min delayed on index/auth sources (`SP_NAUTH:`, `delayed_streaming_600`) |
| Chart intervals (1Y click) | full — one `modify_series` |
| Watchlist switching to delayed instruments | works — server re-serves with NAUTH base |
| Screener scan | 200; full columns; quotes delayed (`kind-delay:900`) |
| Screener recents / created screens | 403 |
| Add indicator from dialog | **blocked by `gopro` paywall; no `create_study` ever sent** |
| Save / study-templates / watchlist edit-thunks | auth-required endpoints (401/403 surface) — not deeply traced |
| Telemetry identity | `userId:"0"` |

---

## 10. Master click→request map

| Panel / button | Validated selector | Wire effect |
|---|---|---|
| Hamburger menu | `button[data-qa-id="main-menu-button"]` | menu only |
| Symbol button (AAPL) | `button` in top toolbar (a11y name "AAPL") | opens symbol-info (scanner `/symbol`-family already fired on load) |
| Interval `1Y` | `button[data-name='date-range-tab-12M']` | 1× `modify_series` (WS) |
| Indicators | `#header-toolbar-indicators button[data-name='open-indicators-dialog']` | opens dialog; dialog REST family (§6.1); scratch probe (§4.8) |
| Indicators search: letters | `press "r|s|i"` on `body` | typeahead REST |
| Indicators search: commit/cancel | `press` Enter/Escape on `#indicators-dialog-search-input` | ESC on input closes |
| Add indicator (row) | `div[data-role='list-item'][data-id='STD;RSI'] span[class^='title-']` | **zero study frames; `gopro` paywall** |
| Paywall close | `[data-qa-id='promo-dialog-close-button']` | none (auto-reopens ≤3.5 s) |
| Paywall pause | `aria-label="Pause"` button | video control only |
| Create alert | `button "Create alert"` | not captured (alerts are login-backed) |
| Replay | `button "Bar replay"` / Alt+T | zero wire |
| Layout setup / Manage layouts | toolbar buttons | not captured |
| Save | `button "Save all charts…"` / Ctrl+S | zero wire |
| Snapshot | `#header-toolbar-screenshot` | menu only; items in §7 |
| Screener dock icon | header screener button | lazy chunks + scan REST trio + facade + storage 403 |
| Screener sort | via "Change sort" menu (role locator) | client-side only |
| Screener title | `screener-topbar-screen-title` `div[role=button]` | (direct role=option synthesis fails, §13) |
| Watchlist row | watchlist `div[data-qa-id…super-dialog]` list rows | quote_add_symbols + resolve_symbol + modify_series (WS) |
| Drawing toolbar | left-toolbar buttons (a11y list §7) | none |

---

## 11. Selectors & locators — validated table

| Target | Locator | Note |
|---|---|---|
| Indicators open | `#header-toolbar-indicators button[data-name='open-indicators-dialog']` | works every run |
| RSI row | `div[data-role='list-item'][data-id='STD;RSI'] span[class^='title-']` | row-div bbox click is a dead zone |
| Dialog search input | `#indicators-dialog-search-input` | commit/cancel target |
| Letters into dialog | `press` on `body` | TV shortcut router |
| Paywall close | `[data-qa-id='promo-dialog-close-button']` | role "Close" is ambiguous (dialog/menu closes) |
| Paywall modal root | `div[data-dialog-name="gopro"]` | z-index 150 |
| Interval tab | `button[data-name='date-range-tab-12M']` | labeled "1Y" |
| Main menu | `button[data-qa-id='main-menu-button']` | |
| Snapshot menu | treegrid rows in a11y (`row "Download image" [level=2]`) | |
| Screener column sort menu | `role "Change sort"`-flow | header direct clicks time out |

---

## 12. Methodology & capture caps (what a repeat replication needs)

- Launch mode `capture_browser_scenario` with Edge (`C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`), headless, viewport 1280×720, `command_timeout_ms ≥ 180000` (30 s causes provider_timeout on TV's heavy load).
- Winners' cap set: `max_events 9000`, `max_event_allocation_bytes 4194304`, `max_total_event_allocation_bytes 209715200`, `max_network_transactions 2000`, `max_network_body_bytes 131072`, header/metadata/body allocations 4194304/4194304/52428800 → dropped = 1–3 frames/run.
- Responses over the ~10 MiB tool budget land as saved files; mining is done with local PowerShell (`-replace`-unescaped JSON, sentinel-based direction inference: each WS event object carries `step_index` before `kind`, direction from the preceding `websocket-frame-sent|received` sentinel).
- To *see* at_end artifacts inline (they do not export into the bundle records), use small captures: `events: ["websockets","console","page-errors"]` with no network bodies and small limits, `at_end: ["accessibility","screenshot","dom","url"]`.
- `after_each_step: ["accessibility"]` gives a per-step UI timeline — the tool that finally pinned the paywall auto-reopen (§6.3).
- After *any* step failure, all later steps cancel; Playwright strict mode requires exactly-one-match locators; key names are Playwright-style (`Control+s`, `Alt+t`).

---

## 13. Known limitations / not observed

- **Evidence retention rotation:** the canonical 24-record evidence export (218.9 MB) predates a REA session-rotation that pared retained evidence to the most recent capture; a re-export therefore produces a 1-record bundle (last run only). The per-run full JSONs (each preserving `evidence_id`, parameters, all events, artifacts) remain in `C:\Users\Trading\.local\share\opencode\tool-output\tool_198…` — see §14 mapping. The main event ledger, decoded tables, and verbatim extracts in this report are reproduced from those files.
- **RSI add** is conclusively blocked for this tier by the `gopro` gate (§6.3); alternate add paths (Add-to-layout stars, keystroke `+`) were not exercised.
- Header-sort direct clicks time out in headless (`ev_74de75e7`); the sort evidence comes from the menu path. Direct `role=option` synthesis inside the indicator dialog never matches (TV virtualizes options outside the a11y tree).
- Alert creation, layouts, study templates, watchlist *editing* (add/remove symbols in UI), buy-data (`WatchlistRightsError`), `scan2`/full-range scans: observed only at the HTTP surface or feature-gate level, not deep-traced.
- WS delayed-quote semantics (`kind-delay:900` vs `delayed_streaming_600` vs `SP_NAUTH:`) are described from observed payloads; the full per-exchange entitlement matrix was out of scope.
- Anonymous quotes in screener rows are 15-min delayed; realtime requires the paid/auth tier (untested here).

---

## 14. Evidence index & artifact map

**Per-run evidence ids** (full where captured this session; `~`-prefixed = truncated id as recorded during phase-1/2a):

| Evidence ID | Run | Outcome (wire-level) |
|---|---|---|
| `ev_629d1c10…8ba` | A — initial 9-min load | full WS load trace; REST inventory |
| `ev_494c151e…98a` | B — screener dock open (+failed interval click) | scan POST captured |
| `ev_c206c8b8…9fc6` | C — full WS lifecycle, big frames | `resolve_symbol` 311 KB, `qsd` 275 KB, `studies_metadata` 584 KB |
| `ev_c5057441…62b1` | C2 — interval click validated | 1× `modify_series`, 267 ms |
| `ev_ba7e44cf…79e54` | D — screener with bodies | facade/columns/metainfo/scan bodies retained |
| `ev_4d9a6b34…`, `ev_0fd70626…`, `ev_323d0e5a…`, `ev_6e1720ae…`, `ev_f64d8eb0…`, `ev_9a868a23…`, `ev_cc383ec4…` | M1/M1b/M2* — WS & REST mining passes | frame tables, method counts, samples |
| `ev_4ff4fdc5…`, `ev_83d03d1e…` | R-A / R-A3 role replay, 18 steps | per-panel a11y timeline |
| `ev_e068cb84…`, `ev_31a634ef…` | R-B / R-B3 watchlist switch, 25/25 | switch choreography + symbol-search scanner triplet |
| `ev_c1829511…`, `ev_cc5b80dc…` | R-C / R-C3 | screener + dialog composites, 13/13 |
| `ev_f1799eef…` | R-S screener title role=option fail | no match |
| `ev_74de75e7…` / `ev_793365f8…` | E1 sort header timeout / E2 sort menu | no scan POST (client-side) |
| `ev_8f6d1aab…` | mega composite | large multi-flow capture |
| `ev_226db99e…`, `ev_ac45a580…` | tiny dialog / verify | dialog sanity |
| `ev_5c088de3…` | RSI row-div click | zero wire |
| `ev_7989eade1e18aa42…b98d` | decisive combined dialog run (13 steps, 209 WS) | §4.3, §6.3 row 2 |
| `ev_7e00db07…`, `ev_8dcea454…` | paywall controls | no paywall without selection |
| `ev_271f8f3c…`, `ev_9171e7ce…` | Pause-click + post-pause | Pause = video control |
| `ev_c59721fd…` | role-Close click | wrong button; stayed |
| `ev_81ab248ee72b55f4…75c9` | **per-step a11y paywall timeline** | §6.3 table — auto-reopen proven |
| `ev_853e0103a6985e8c…509a2` | snapshot menu | §7 names + zero app traffic |

**Files (`C:\Users\Trading\.local\share\opencode\tool-output\` → evidence):**

| tool-output file | Evidence |
|---|---|
| `tool_198978144001Q9DPCBz04Lr0OW` | ev_7989eade full (209 WS frames verbatim + a11y + PNG) |
| `tool_198905c1d001q2RtTeYh7VXY7w` | dialog DOM anatomy + a11y source |
| `tool_19892f8b3001nTGNy1f5DV1tqu` | ev_ac45a580 verify (screenshot + a11y) |
| `tool_198e04fe80013CaTqJzNfSnvTk` | ev_7e00db07 control |
| `tool_198e2c6ce001H215tfwaSTw79D` | ev_271f8f3c (Pause-click) |
| `tool_198e4ca4f001kWBlNDoOkTRaBA` | ev_9171e7ce post-Pause |
| `tool_198e649d4001xLryqPFKzbctyF` | ev_c59721fd role-Close |
| `tool_198ea7481001wvye0f5sbhiIF7` | ev_8dcea454 promo-wait 10 s |
| `tool_198f3b3880016m0RMmHEPG7F5l` | ev_81ab248e per-step timeline (14 a11y snapshots) |
| `tool_19b0cc90f001kU9DNAQALVKzDi` | ev_853e0103 snapshot menu |

**Extracted artifacts (`C:\Users\Trading\AppData\Local\Temp\opencode\`):**

- `tv-api-samples\` — verbatim scan POST (`REQUEST_america-scan-postbody.txt`), standalone replay (`REPLAY_america-scan-minimal.json`), facade `columns_filters/params` (267 each), metainfo ×2, bond scan/enum, 71 translation chunks
- `tv-bundles\` — downloaded bundles (`screener-dialog…`, `filter-presets-stock-merged…`, `main_chart…`)
- `screener-filter-catalog.txt` (267), `screener-preset-catalog.txt` (1,161)
- `tradingview-chart-dom.txt` (initial DOM; validated selectors), `tv-script-srcs.txt`, screener screenshots
- `rea-evidence-bundle.json` — 1-record canonical export (post-rotation; see §13)
- RSI-paywall set: `rsi2…rsi6-a11y.txt/.png/.html`, `rsi-ctrl-*`, `snap-menu-a11y.txt`, `snap-menu.png`
- Miners: `mine-generic2.ps1`, `frames-method.ps1`, `list-posts.ps1`, `extract-api.ps1`, `adjacency.ps1`, `scan-bodies.ps1`, `ga-events.ps1`, `ws-samples.ps1`

---

## 15. Phase 3 — exhaustive anonymous click→wire sweep (docks, menus, dialogs, paywalls)

Phase 3 extended coverage from the indicators/screener surfaces (§5–§7) to **every remaining anonymous-tier entry point** on `tradingview.com/chart/`: all dock widgets, the header menus, both right-click context menus, the object tree, quick search, the News/Settings dialogs, the interval menu, and Bar replay. Method is unchanged (§12). Headline result: **every new surface is either (a) a REST-only panel, (b) a purely client-side UI, or (c) an account-required paywall — no new WebSocket method family was discovered beyond the phase-2 vocabulary (§4.3).**

### 15.1 Dock / panel verdicts

Right (and left) toolbar `data-name` roster is in `tradingview-chart-dom.txt`; each dock was opened and fingerprinted.

| Dock (`data-name`) | Anonymous result | Wire signature |
|---|---|---|
| Watchlist (`watchlists-button` / widget) | full | boot-prefetched quotes; row clicks ride chart WS; **Add symbol → paywall** (§15.5) |
| Object tree (`object_tree`) | full, incl. **delete** | tabs `object_tree`/`data-window`; row ops client-side except delete → WS `remove_study` (§15.4) |
| Alerts (`alerts`) | panel opens; tabs Alerts/Log; empty-state | **Create alert → paywall** (§15.5); view-only anonymous |
| Stock Screener (`screener-dialog-button`) | **fully anonymous with live data** | `screener-facade/api/v1/columns`, `screener-storage/api/v2/screens/recent` (403), scanner scan POST — same family as §5 |
| Calendar | **fully anonymous, live** | `economic-calendar.tradingview.com/events`, `scanner.tradingview.com/global/scan?label-product=calendar-{dividends,earnings,ipo}`, `telemetry/calendars/report` |
| Community | **anonymous ideas feed** | `api/v1/ideas/recommended_web` |
| Notifications | "Log in to see your notifications" wall | `notifications.tradingview.com/news/channel/live-events` (SSE, reconnects) |
| Chats | "Log in to see your chats" wall | SSE live-events |
| Products flyout (`products-button`) | menu only | PRODUCTS (Copilot/Screeners/Pine Editor/Calendars/News Flow/Portfolio/Yield Curves/Options/Macro Maps) + SOCIAL (Community/Notifications/Chats), each with a favorite star |
| Pine Editor (`pine-dialog-button`) | **opens blank / gated** | loads `pine-editor` chunk; no user script area anonymously |
| Copilot (`copilot-dialog`) | opens (paywalled content) | CDN `copilot-dialog.*.js`, `support-copilot-api...`, `fixable-dialog` bundle, `market/shopconf` |

Docks are modal overlays: opening Copilot rendered a floating dialog over the rail, which made a subsequent dock click time out. **Always `Escape` between dock clicks, and target the exact `data-name`.**

### 15.2 Header menus

| Menu | Locator | Content | Wire |
|---|---|---|---|
| Main menu (hamburger) | `button[data-qa-id='main-menu-button']` (**`data-qa-id`, not `data-name`**) | Home, Help Center, What's new, Dark theme toggle, Drawings panel toggle, Language, Keyboard shortcuts `Ctrl+/`, Get desktop app, Log in, Join now | none (client-side) |
| Layouts | `button[data-qa-id='layouts-menu-button']` | 1–16 grid + SYNC IN LAYOUT toggles (Symbol/Interval/Crosshair/Time/…) | none |
| Trade | `role button "Trade"` | "Trade with your broker" dialog: Paper Trading, FxPro ★4.6 FEATURED, easyMarkets, NinjaTrader, Bybit, CFI, Show all brokers, Need a broker? | none at click — broker list boot-prefetched (`api/v1/brokers/trading_panel`) |
| Take a snapshot | `role button "Take a snapshot"` | `treegrid "Chart snapshot"`: Download image `Ctrl+Alt+S`, Copy image `Ctrl+Shift+S`, Copy link `Alt+S`, Open in new tab, Post image (re-confirms §7) | none |
| Interval | container `#header-toolbar-intervals`, trigger `role button "Change interval"`, `data-qa-id='title-wrapper legend-source-interval'` | popover shows only the current favorite (D/1 day) + "Change interval i"; the **free-form dialog** is just a text input (`data-qa-id='ui-lib-Input-input'`, value `D`, hint `data-qa-id='change-interval-hint'` = "1 day"). The **full preset tree** (Ticks/Seconds/Minutes/Hours/Days/Ranges; 64 rows, each `gridcell "Add to favorites"` / `button "Add to favorites"`, some with `button "Remove"`) lives behind the hover/expand of the preset list, **not** in the free-form dialog. Favorites are local (`favorite-indicators` chunk + localStorage); `[data-qa-id='preset-menu-favorite-button']` does **not** exist in the plain popover — that click was the phase-3 failure. | none |

### 15.3 Context menus (both are client-side)

- **Chart pane** (`[data-qa-id='pane-top-canvas']`, `button:"right"`): Copy price / Paste / Add alert / Buy limit / Sell stop / Add order / Lock vertical cursor / Table view / Object tree / Remove 1 indicator / Settings. Zero wire.
- **Object-tree row** (`div.wrap-fLRXLkKY:has-text('Vol')`, `button:"right"`): Add alert / Add indicator / Add this indicator to favorites / Visual order / Visibility on intervals / Move to / Pin to scale / Copy / Hide / **Remove (Del)** / Settings. Zero wire on open; **Remove is the only item that emits a WS frame.**

### 15.4 Object-tree delete protocol (verbatim)

Locator for the menu item: `tr[data-role='menuitem']:has-text("Remove")`.

```
sent      seq 2368  ~m~53~m~{"m":"remove_study","p":["cs_rYaJDaP6iaPv","u7dyvO"]}
received  seq 2382  {"m":"study_deleted","p":["cs_rYaJDaP6iaPv","u7dyvO","s1_st1"],"t":...}
```

The payload maps the UI study id (`u7dyvO`) to the internal id (`s1_st1`) selected internally — useful for correlating object-tree rows with `create_study`/`du` frames from §4.6. No layout-persistence REST fires on delete; the object-tree row's hide button is `span[role=img][data-role=button][data-name='hide']`. (The phase-2 legend `legend-delete-action` / `legend-more-action` clicks time out on chart re-render — a harness actionability limit, worked around via the object tree; no further attempt needed.)

### 15.5 Paywall inventory discovered in phase 3

All four are client-side account gates with **zero WS** for the gated action; several share the `wall-opener.js` / `site-wall-list.js` machinery.

| Trigger | Copy | Notes |
|---|---|---|
| Compare symbols (`symbol-search-input` inside `div[data-name="compare-dialog"]`) | "Compare to your heart's content" | typing fires `symbol-search.tradingview.com/symbol_search/v3/?text=TSLA&…&promo=true`; Enter opens the wall; TSLA never added |
| Watchlist → Add symbol (`data-name='add-symbol-button'` → `watchlist-symbol-search-dialog`, reuses `symbol-search-input`) | "Create your first watchlist" | same autocomplete REST; no symbol added |
| Create alert (`#header-toolbar-alerts`) | "Never miss a trade again … you'll only need a free plan to start. [Join for free]" | |
| Bar replay (`role button "Bar replay"`, also `Alt+T`) | "Unlock Bar Replay … Get a free account… [Join for free]" | loads `replay*.js` + `bottom-replay-trading-widget*.js` chunks and fires a GA `Open replay` event, **but no new WS method and no new REST** — replay data is already in the delivered history |

### 15.6 Other surfaces (REST-only or client-side)

- **Quick search** (`[data-name='header-toolbar-quick-search']`, input `dialog-search-input`): pure client-side; **zero wire**.
- **News** (`news-dialog`, tabs `key-facts` / `headlines`, headline cards): REST-only (`news-mediator.tradingview.com/public/news-flow/v2/news`, `…/doc-screener/v1/events`), **zero WS**.
- **Chart Settings** (`#header-toolbar-properties`): tabs Symbol / Status line / Scales and lines / Canvas / Trading / Alerts / Events; sections CANDLES, DATA MODIFICATION; Template / Cancel / Ok — client-side.
- **Watchlist settings flyout** (`[data-name='settings-button']`): client-side.
- **Seasonals** mini-chart pick (date-range tab): spins **two disposable chart-session cascades** over the WS (create/delete session), no REST.

### 15.7 Phase-3 selectors (additions)

| Target | Locator | Note |
|---|---|---|
| Main menu | `button[data-qa-id='main-menu-button']` | **not** `data-name` |
| Layouts menu | `button[data-qa-id='layouts-menu-button']` | |
| Products flyout | `button[data-qa-id='products-button']` | |
| Interval trigger | `role button "Change interval"` | popover ≠ full preset tree |
| Change-interval input | `[data-qa-id='ui-lib-Input-input']` | hint `[data-qa-id='change-interval-hint']` |
| Object-tree row | `div.wrap-fLRXLkKY:has-text('Vol')` (title `span.title-DhPmaOyr[data-type='data-source']`) | |
| Object-tree row ctx menu item | `tr[data-role='menuitem']:has-text("Remove")` | only Remove emits wire |
| Object-tree widget | `[data-test-id-widget-type='object_tree']`; switcher `[data-qa-id='union-object-tree-widget-switcher']`; toolbar `group-button`/`copy-clone-button`/`move-to-button`/`manage-drawings-button` | |
| Compare dialog | `div[data-name="compare-dialog"]` → `symbol-search-input` | distinct from quick-search's `dialog-search-input` |
| Dock buttons | `[data-name='alerts'|'object_tree'|'calendar'|'copilot'|'screener-dialog-button'|'pine-dialog-button'|'community'|'notifications'|'chats'|'watchlists-button']` | Escape between modal docks |
| Create alert | `#header-toolbar-alerts` | paywall |
| Quick search | `[data-name='header-toolbar-quick-search']` (input `dialog-search-input`) | |
| Fullscreen / properties | `#header-toolbar-fullscreen` / `#header-toolbar-properties` | |

### 15.8 Phase-3 evidence index

| Evidence ID | Run | Outcome |
|---|---|---|
| `ev_f34845586509a1019c62d31676f0c83db1d30b981e898970affd3018e0ea1092` | main menu open | menu tree; zero wire |
| `ev_7faa2b4c16cfe1ad583622f873e03136de2da0e37eeb484a281d55ae581cb517` | chart right-click + object-tree dock | menu captured; no new wire |
| `ev_a427507e09e60de465cc631b328cbaeef74b59e00b77f1bffcf15c61af47454a` | object-tree row context menu | item roster incl. Remove (Del) |
| `ev_d4739d6238ffc144e5f68f9927d9e513c045791e5155b04ada3922d736f1f61a` | **object-tree Remove click** | `remove_study`→`study_deleted` (§15.4) |
| `ev_e6546db2f8b96efeee5bab2c3b6f1d687ddf0521187dd887291071669104e1b7` | Alerts + Screener + Pine docks | screener anonymous / pine gated |
| `ev_74acbb7c7f9183998d02ab4ffa98b7a44a39cc084688e4e587c2efd09ef01d5b` | Pine retry + create-alert click | pine blank; alert no-change |
| `ev_5b7fdc4cd92be44d32b87c261ff1e85ae8bc2282dea2714f94ddd2d82e0c0eb7` | **create alert** | paywall ("Join for free") |
| `ev_05d4d9c8c7e1126965957993dd8c2b2cf93a1a432477861f03ccbb8daf3d8684` | layouts + Trade + snapshot | all client-side |
| `ev_3c612092afc9bc6d753f53b7beadd30e8c6561e26c9d749d764cbbc72ecb88b7` | interval popover + star fail | star qa-id absent in popover |
| `ev_8d566d4095728eabbddc43bc96abf7dcc6912d59e122af6800d31a6da1eed14d` | **Change-interval dialog** | free-form input only ("D"/"1 day") |
| `ev_160b16463beab4f6967545a70a7fe16699794ed6a82edf7acf420f8be48e2786` | **Bar replay** | paywall; replay bundles only; no wire |
| `tool_19b4f7755001DnZzoAgismYLnr` | Seasonals pick | two disposable chart sessions |
| `tool_19b5c46c4001OZTq648ptvzBOc` | News tab | REST-only |
| `tool_19b659558001VDYDjMFRmfMie8` | quick search | zero wire |
| `tool_19b6a30b20015qZSLeKfeqE1Om` / `tool_19b689f82001eCjfffZrtZO3th` | chart settings / watchlist settings | client-side |
| `tool_19b6edb5b001zol4TWpnvAxXTx` / `tool_19b744358001lwC7O166SlAxy1` | compare / watchlist-add | paywalls (zero WS) |
| `tool_19b87fcf9001IuhkJ4UUUzaQCX` / `tool_19b89f8b9001HXUGU1Okvg5Ryr` / `tool_19b8e15b0001MLROUrh6XAW7lB` | docks sweeps 2/3/4 | dock roster + screener/calendar/community anonymous |

### 15.9 Phase-3 additions to the anonymous-tier matrix (§9)

| Capability | Anonymous result |
|---|---|
| Stock Screener dock | **works, live data** |
| Economic calendar dock | **works, live data** |
| Community ideas dock | **works (recommended feed)** |
| Alerts panel (view) | works; **create = paywall** |
| Object tree (+ delete study) | works; WS `remove_study`/`study_deleted` |
| Layouts / Trade picker / snapshot | works (client-side) |
| Quick search / News / Settings / interval menu | works |
| Compare symbols / watchlist Add symbol | **paywall** |
| Notifications / Chats | login wall (SSE still connects) |
| Pine Editor / Copilot content | gated |
| Bar replay | **paywall**, no wire |

**Additional harness limits confirmed in phase 3:** no coordinate/`position` clicks, so canvas stroke placement (drawing a trendline) is impossible; clicks on continuously re-rendering icons (legend actions, Bar replay with prior state) can report `Analysis operation timed out after Nms` — retry only after changing parameters (isolate the step, raise `timeout_ms`, `wait_for` first), never unchanged.

---

*Report ends. All behavioral claims in §4–§10 trace to the per-run evidence ids above; the phase-2 additions (WS deep dive, indicators dialog, paywall gate, snapshot menu, selector table) were produced 2026-11-01→2026-11-02. The phase-3 additions (§15: dock/menu/context-menu/paywall sweep, object-tree delete protocol, Bar-replay paywall) were produced 2026-11-02.*
---

## 16. Screener panel â€” deep dive and replica (2026-11-02)

Target: the **chart-docked Stock Screener panel** (`tradingview.com/chart/...`, right dock) and the full `tradingview.com/screener/` page. Both render the same component.

### 16.1 Panel anatomy (observed)
- Header: widget glyph, `Stock Screener â–¾`, then `â‹¯`, share, maximize, close.
- Screen chip: `All stocks â–¾` (saved-screen selector).
- Filter chip bar (exact order, captured from DOM):
  `AI آ· US آ· Watchlist آ· Index آ· Price آ· Chg % آ· Mkt cap آ· P/E آ· EPS dil growth آ· Div yield % آ· Sector آ· Analyst rating آ· Perf % آ· Revenue growth آ· PEG آ· ROE آ· Beta آ· Recent earnings date آ· Upcoming earnings date آ· + آ· â‹¯`
- View bar: `Table` | `Overview`, search, refresh, maximize.
- Table: sticky Symbol column, colored logo, ticker pill, `D` dividend badge, company name.
- Footer: `Showing N of M`, `Load more`, `Save screen`.

### 16.2 Screener-type menu
`Stock Screener`, `ETF Screener`, `Bond Screener`, `Crypto Coins Screener`, `CEX Screener`, `DEX Screener`.

### 16.3 Header `â‹¯` menu (verbatim)
`Save screen` آ· `Autosave` (switch) آ· `Share screen` آ· `Make a copyâ€¦` آ· `Renameâ€¦` آ·
`Download results as CSV` آ· divider آ· `Create new screenâ€¦` آ· `RECENTLY USED` (`s`,
`1d change > 5 100b`, `1111`) آ· `Open screenâ€¦`.

### 16.4 Filter popup (captured from `Mkt cap`)
`Market capitalization` + search + presets:
`Mega / 200 B and above`, `Large / 10 B to 200 B`, `Mid / 2 B to 10 B`,
`Small / 300 M to 2 B`, `Micro / 50 M to 300 M`, `Nano / 50 M and below`, then
`Manual setup` (operator + value(s)).

Operator DSL: `above`, `aboveOrEqual`, `below`, `belowOrEqual`, `between`, `outside`,
`equal`, `abovePct`, `belowPct` (+ `crossesAbove`/`crossesBelow` for the BB presets).
String metrics (Sector, Analyst rating, Index) use a searchable multi-select. See
§16.11 for the full per-filter dialog.

### 16.5 Columns dialog (captured)
`Columns` + search + categories with counts:
`Security info 26`, `Market data 37`, `Technicals 39`, `Financials 47`, `Valuation 24`,
`Growth 9`, `Margins 69`, `Dividends 8`, `Income statement 18`, â€¦ Expand â†’ checkable
columns. Toggling updates the table live.

### 16.6 Column header menu
Click a header â†’ `Sort ascending`, `Sort descending`, `Move left`, `Move right`,
`Remove column`.

### 16.7 Default table (full page)
Columns and widths: Symbol 328, Price 113, Chg % 73, Vol 76, Rel vol 58, Mkt cap 96,
P/E 78, EPS dil TTM 106, EPS dil growth TTM YoY 101, Div yield % TTM 80, Sector 175,
Analyst rating 112, add-column 45.
Cell pattern: `NVDA / NVIDIA Corporation / D`, `207.13 USD`, `+1.22%`, `31.04 M`,
`0.31`, `4.99 T USD`, `26.18`, `7.91 USD`, `+125.15%`, `0.25%`,
`Electronic technology`, `â–² Strong buy`.

### 16.8 Views
`Table` and `Overview`; Overview sub-tabs: Performance, Technicals, Extended hours,
Forecasts, Valuation, Dividends, Profitability, Income statement, Balance sheet,
Cash flow, Per share.

### 16.9 Replica
Implemented in `screener-widget/` (`screener.js`, `screener.css`, `index.html`),
docked next to a mock chart. Every surface in 16.1â€“16.8 is interactive. Honest gaps:
live data (needs the user's API), AI/persistence/watchlist (need a backend), full
1,161-preset catalog, and column drag-resize.

### 16.10 Add-filter catalog (captured 2026-11-02)

The `+` chip opens a two-level dialog, not a flat list.

Level 1 â€” `Filters` + search, then:

| Section | Count | Item groups |
|---|---|---|
| Security info | 25 | â€” |
| Market data | 40 | REGULAR HOURS, EXTENDED HOURS |
| Technicals | 39 | â€” |
| Financials | 47 | INCOME STATEMENT, CASH FLOW, BALANCE SHEET |
| Valuation | 24 | â€” |
| Growth | 9 | â€” |
| Margins | 69 | â€” |
| Dividends | 8 | â€” |

Level 2 â€” back arrow `<`, section title, search, group headers, items. Every item is a
filterable metric; selecting one opens its value/operator popup and adds a chip.

Note the Filters counts differ from the Columns panel counts (Security info 25 vs 26,
Market data 40 vs 37) because the two dialogs expose different field sets.

All 261 labels are implemented in `screener-widget/screener.js` (`FILTER_CATALOG`);
demo rows get deterministic synthetic values for metrics they do not carry, so every
filter applies. Wire them to real fields via `scan` when the backend exists.

### 16.11 Per-filter configuration dialog (captured 2026-11-02)

Clicking a chip opens that filter's own dialog. Structure:

- **Header** — title (`Price`, `Market capitalization`, `Return on equity`, ...) with
  its period control underneath (see the period-control section below), rendered
  as a `select` or as static text when the period is fixed. Right side: `Reset` +
  a trash icon.
- **Search**, then the preset list (bold label + grey subtitle), then `Manual setup`.

Presets are **not** limited to a curated set — every metric whose dialog exists on
live carries its own ladder. A full capture (2026-11-03, all 261 items) found 238
ladders / ~1,680 rows; see §16.13. Representative rows (verbatim):

| Metric | Period | Presets |
|---|---|---|
| Price | — | 8 (`Above 100`/Fractional shares time ... `Crosses BB, 20, Lower`/Oversold) |
| Price change % | 1 day | 12 (percent ladder) |
| Market capitalization | — | 6 (`200 B and above`/Mega ... `50 M and below`/Nano) |
| P/E ratio | — | 6 (`50 and above`/Extremely high ... `0 to 5`/Very low) |
| EPS diluted growth % | TTM YoY | 7 (`Above 50%`/Exceptional growth ... `Below 0%`/Reduction) |
| Dividend yield % | Trailing 12 months | 7 (`Above 15%`/Exceptional ... `0%`/No dividend) |
| Performance % | Year to date | 12 (percent ladder) |
| Revenue growth % | TTM YoY | 10 (growth ladder) |
| PEG | Trailing 12 months | 7 (`Above 3` ... `Below 0`/Negative) |
| Return on equity % | Trailing 12 months | 10 (`Above 30%`/Very high ... `Below −30%`/Severe loss) |
| Beta (1 year) | 5 years | 7 (`Above 1.5`/Very high volatility ... `Below 0`/Inverse sensitivity) |
| Relative volume | 1 day | 6 (`Above 3`/Unusually high ... `Below 0.5`/Very low) |
| Gross margin % | Annual | 6 (`Above 80%`/Very high ... `Below 0%`/Negative) |
| Relative strength index | 1 day | 8 (`Above 90`/Extremely overbought ... `Below 10`/Extremely oversold) |

The earlier 2026-11-02 probe that reported Volume, Gross margin %, Net margin %,
Current ratio, RSI and others as "manual-only" was wrong: it read the item list
before the settings dialog mounted. Volume genuinely has no ladder (it opens
straight into the manual condition), but Gross margin %, Net margin %, RSI and most
other metrics do. Metrics with no dialog at all (all `… estimate` and the `… forward`
valuation rows) are the only truly manual-only items.

**Manual setup** — opens with a `<` back arrow and the title `Manual setup`, then the
uppercase filter label (e.g. `PRICE`) and the fields:

1. **Condition** (`select`). Price filters expose all 12 captured operators:
   `Above`, `Above or equal`, `Below`, `Below or equal`, `Crosses`, `Crosses up`,
   `Crosses down`, `Between`, `Outside`, `Equal`, `Above %`, `Below %`. Volume
   filters expose 7 (`Above`, `Below`, `Between`, `Outside`, `Equal`, `Above %`,
   `Below %`); percent metrics use the numeric set (no crosses).
2. **Percent box** — appears only for `Above %` / `Below %`, with presets
   `0% to 3%`, `3% to 5%`, `5% or more`, `10% or more`, `20% or more` (image:
   `[Above %] [5% or more]`).
3. **Target** (`select`). Price filters get the complete TARGET list, in the captured
   order:
   `Value, Open, High, Low, Price` | `Bollinger Bands, Donchian channels, Exponential
   moving average, Hull moving average, Ichimoku cloud, Keltner channels, Parabolic
   SAR, Simple moving average, Volume-weighted average price, Volume-weighted moving
   average` | `Pivot points Camarilla, Classic, DeMark, Fibonacci, Woodie` |
   `IPO offer price, Post-market high, Post-market low, Post-market open,
   Post-market price, Pre-market high, Pre-market low, Pre-market open,
   Pre-market price, Target price`.
   Volume filters get `Value` + Volume / Average volume / Post-market volume /
   Pre-market volume; percent metrics get `Value` + price points + change % / perf %.
4. **Target parameters** — Length, Std dev, Band (Upper/Middle/Lower), Step,
   Timeframe.
5. **Average-volume period** — `10 days`, `30 days`, `60 days`, `90 days`, `Manual`
   (+ custom day box). It is present both on the standalone Average volume filter and
   when Average volume is chosen as a target inside another filter.
6. `Value` target shows one numeric input, or two for `Between`/`Outside`.
7. **Footer** — `Cancel` / `Apply` on the price manual dialog (Apply commits, Cancel
   discards); the simpler volume dialog applies immediately.

The chip reads the resolved condition, e.g. `Price > EMA, 50, 1 week`,
`Price > 5% EMA, 21, 1 week`, `Price 100.00–300.00`,
`Volume > Avg vol, 45 days`.

### 16.12 Period / fiscal-period controls (captured 2026-11-03)

Every filter dialog carries the period control the live panel shows for that metric.
They were captured one-by-one across all eight sections; the replica keys them by the
catalog label (`PERIOD_LABEL_SPECS` in `screener-widget/screener.js`) with an id
fallback (`PERIOD_SPECS`).

**Dialog chrome (captured).** The dialog header is a back arrow + metric title + a
`?` help button; the period/parameter values sit in the header's **bottom toolbar as
pills**, not as labelled fields in the body. A tech param can be an **editable pill
menu** (ladders: RSI `14`, Bollinger Bands `20`) or a **greyed-out, non-interactive
chip** (the bare condition form disables it on the free tier — `Average true range`
shows `[14] [1 day]`). The body holds only the operator (`Above`…), the target
(`Value`…) and the value box. There is **no Cancel / Apply footer**: pressing
**Enter** (or clicking outside) applies the filter, and a real `Escape` closes only
the top layer.

**Interval** (10 options, ids `1,5,15,30,60,120,240,1D,1W,1M`):
`1 minute, 5 minutes, 15 minutes, 30 minutes, 1 hour, 2 hours, 4 hours, 1 day, 1 week, 1 month`.
Applied to every Technicals indicator and the Market-data interval metrics
(`Change from open %`, `Change from open`, `Gap %`, `Open`, `Price change %`,
`Price change`, `Price x volume (turnover)`, `Relative volume`, `Volume`,
`Volume change %`, `Volume change`).

**Date Range**:

| Metrics | Options | Live default |
|---|---|---|
| Performance % | 1 week, 1 month, 3 months, 6 months, Year to date, 1 year, 5 years, 10 years, All Time | Year to date |
| Beta | 1 year, 3 years, 5 years | 5 years |
| High / Low | Interval (1 minute … 1 month) + Date Range (1 month, 3 months, 6 months, 52 weeks, All Time), merged in one pill | 1 day |
| Volatility | 1 day, 1 week, 1 month | 1 day |
| Market capitalization performance % | 1 week, 1 month, 3 months, 6 months, Year to date, 1 year, 5 years | 1 week |
| Average volume / Price x average volume | 10 days, 30 days, 60 days, 90 days | 10 days |
| Target price | 1 year | 1 year |

**Fiscal period** (five option sets):

| Set | Options |
|---|---|
| 4-way | Quarterly, Semi-annual, Annual, Trailing 12 months |
| 3-way | Quarterly, Semi-annual, Annual |
| Quarterly/Annual | Quarterly, Annual |
| Annual/TTM | Annual, Trailing 12 months |
| Q/A/TTM | Quarterly, Annual, Trailing 12 months |

**Period** (growth metrics): `TTM YoY, Annual YoY, Quarterly YoY, Quarterly QoQ`;
Free cash flow / Net income / Revenue / EPS-diluted growth also expose `5 year CAGR`
on the live panel; Total assets growth % and Total debt growth % start at
`Annual YoY` (no TTM YoY).

**Static**: PEG is fixed at `Trailing 12 months`.

**Technicals extras** (shown beside Interval):

| Indicator | Control | Options |
|---|---|---|
| EMA / SMA | Length | 2,3,5,6,7,8,9,10,12,13,14,15,20,21,25,26,30,34,40,50,55,60,75,89,100,120,144,150,200,250,300 |
| ADX | Length | 9, 14, 20, 50, 100 |
| Bollinger Bands | Length | 20, 50 |
| Hull MA | Length | 9, 20, 200 |
| Momentum | Length | 10, 14 |
| RSI | Length | 2,3,4,5,7,9,10,14,20,21,30 |
| Ichimoku | Inputs | 9,26,52,26 (default) / 20,60,120,30 |
| Stochastic | Inputs | 5,3,3 / 6,3,3 / 8,3,3 / 14,1,3 / 14,3,3 |
| Average true range | Length | 14 (form: disabled chip on the free tier; options not observable) |

A chosen length is part of the filter identity and shows on the chip, e.g.
`Relative strength index, 14 > 70`.

**Scope**: the control is present on the standalone filter and in the Manual setup
view; the value is stored on the filter as `period` (or `tf` for interval columns,
`avgDays` for Average volume) plus `ctrl = { length | inputs }`, and is passed to
`scan`. Most `*Estimate` metrics (all but `Earnings per share estimate` and
`Revenue estimate`, which carry ladders) open no dialog on the live panel; see §16.13.

### 16.13 Preset ladders across the whole catalog + "do filters compute?" (captured 2026-11-03)

**Method.** Drove the live add-filter menu through all eight sections (261 items),
opened each item, and recorded the dialog title, the period param button(s), and every
preset row (bold label + grey subtitle), ending with `Manual setup`. 238 metrics expose a dialog; 170 carry a ladder (~1,660 rows) and the other 68 open a bare condition form with no presets. 23 items open no dialog at all and are manual-only. `Volume`
has a dialog but no ladder — it opens straight into the manual condition.

**Preset shapes observed**

| Shape | Examples |
|---|---|
| Literal threshold | `Above 80%`, `Above 100`, `5 and below`, `0%` |
| Literal range | `60% to 80%`, `10 B to 200 B`, `−15% to 0%` |
| Open-ended with multiplier | `200 B and above`, `10 B to 200 B`, `50 M and below` (K/M/B/T) |
| Indicator target | `Above EMA, 50`, `Below EMA, 50`, `Above Price`, `Crosses up EMA, 200` (Golden cross), `Crosses down EMA, 200` (Death cross), `Crosses BB, 20, Upper` |
| Multi-series deviation | `Below Price by 0% to 10%`, `Above Price by 20% or more`, `Upper above Lower by 0% to 20%` |
| Categorical equality | sector names (`Finance`, `Electronic technology`), `Strong buy`/`Neutral`/`Strong sell`, candlestick pattern names |
| Date bucket | `Current trading day`, `This week`, `This month` |

**Replica.** `PRESETS_BY_LABEL` in `screener-widget/screener.js` is keyed by the catalog
label and inlined from `_captures/presets.json` (238 ladders). Lookup is
label-normalized, so demo labels that differ from the catalog (`Gross margin` vs
`Gross margin %`) still resolve. Numeric, range, multiplier, categorical and
single-indicator-target rows become real filters; the 170 cross-series / multi-series
rows display with their live label/subtitle but route to `Manual setup` (our own
condition form) when clicked.
Ladders that carry no `Manual setup` on live (dates, `Yes`/`No`, candlestick patterns,
ratings) have every row modeled as an equality preset instead — in the demo those
bucket metrics match a stable hash bucket, so the preset behaves like a real filter.
Regenerate with `node tools/parse-presets.js && node tools/emit-presets.js`.

**Click behaviour across all 261 items (captured 2026-11-03).** Every catalog item was
opened and classified by what the click actually produces. The replica reproduces the
same three classes; `node tools/check-behavior.js` re-derives the matrix into
`_captures/behavior.json`.

| Live click result | Items | Live detail | Replica behaviour |
|---|---|---|---|
| preset ladder | 170 | search + rows; `Manual setup` on 149 of them, absent on 21 | ladder dialog; `Manual setup` (149) opens our own condition form; the 21 without it apply equality presets |
| bare condition form | 68 | no preset list; opens straight into operator/target/value | same form, never an empty list |
| no dialog | 23 | closes the menu, adds nothing | same (no-op) |

- **Ladder without `Manual setup` (21).** All the string/date ladders — `Sector`,
  `Industry`, `Index`, `Exchange`, `Symbol type`, `Analyst rating`, the ratings,
  `Candlestick pattern`, `New high`/`New low`, `IPO offer date`, `Last trade time`,
  `Recent`/`Upcoming earnings date`, `Sharia-compliant`, etc. Their rows apply as
  equality presets; the demo evaluates the non-string ones against a deterministic
  hash bucket so the result set is stable.
- **Condition-form metrics (68).** Eleven are **range-only** (live shows `From` / `To`
  and no operator): `Average daily range`, `Free float %`, `Total common shares
  outstanding`, `Earnings per share reported`, and the seven `... per employee` metrics
  (`EBITDA`, `Free cash flow`, `Net income`, `Operating income`, `R&D`, `Total assets`,
  `Total debt`). The other 57 show live's default operator and `USD` / `%` suffix
  (e.g. `High` → `1 day` + `Above or equal` + `USD`; `Total equity` → `Quarterly` +
  `Above` + `USD`). Per-metric defaults are in `_captures/forms.json`.
- **No-dialog items (23).** 17 financial `… estimate` metrics — every one except
  `Earnings per share estimate` and `Revenue estimate`, which *do* open ladders — plus
  the six forward valuation rows `EV/EBITDA`, `EV/EBIT`, `EV/revenue`, `P/B`, `P/E`,
  `P/S`. They remain selectable as columns. (The replica still computes
  `Price to earnings ratio forward` from the analyst EPS estimate, so the real-data
  coverage counts it as functional and lists the other 22 as no-dialog.)
- **Manual setup on the live free tier** is gated: clicking it opens a subscription
  card, never the form. The replica does **not** attempt to bypass that gate; instead
  it offers its own condition form to everyone (a deliberate product choice for this
  app), built from the same captured operator/target/value component. `Back` returns
  to the preset list.
- **Categorical ladders (17).** `Sector`, `Industry`, `Index`, `Exchange`, `Symbol
  type`, `Analyst rating`, `CFI classification`, the country/currency fields, the
  ratings and `Candlestick pattern` open as single-select ladders (not the old
  multi-select string filter), using the captured row sets — e.g. Sector 21,
  Industry 130, Country of highest income 97, Index 52, Candlestick pattern 44.

**Do the selections actually compute?** On TradingView, yes — each preset becomes a
scanner condition evaluated server-side, so `Price above EMA, 50` is a real comparison
of the price series against the EMA-50 series at the chosen interval. In the replica,
`matchFilter` evaluates every filter against each row: literal and categorical presets
are exact on the demo universe, but per-period values (`tfValue`) and indicator targets
(`indicatorValue`) are deterministic synthetic approximations until the scan API
returns the real per-period fields and computed indicators. So the controls are wired
to a real filter engine, not decorative — the values they compare against are what
still need real data.

### 16.14 Per-filter `Manual setup` model + real-data verification (2026-11-03)

**Each filter's Manual setup is derived from its own presets, not one generic form.**
`tools/derive-manual.js` reads every filter's captured preset ladder + the captured
family operator/target lists and writes `_captures/manual-model.json` (261 items).
The preset rows are the evidence: the distinct `op` values a filter actually uses
show which operators its Manual setup must offer.

**Direct dialog capture (68 filters, no gate).** The no-ladder "form" filters open
their condition form immediately, so their real CONDITION / TARGET / period / unit
dropdowns were opened and recorded in `_captures/live-forms.json` (no `Manual setup`
click, no entitlement bypass). `derive-manual.js` overlays that file, giving three
evidence tiers:

| `conditionSrc` | count | source |
| --- | --- | --- |
| `exact` | 68 | dropdowns opened in the real no-ladder dialog |
| `observed` | 156 | operator appears in that filter's own preset ladder |
| `inferred` | 14 | ladder filter with no operator in its presets; live `Manual setup` is paid |

So 224 of the 238 non-empty filters now carry per-filter operator evidence, up from
156. Examples captured exactly: `Earnings per share diluted` → period
`Trailing 12 months`, `Above / Below / Between / Outside / Equal`, TARGET
`Value / Earnings per share diluted`, unit `USD`; `Price × average volume` → period
`10 days`, adds `Above % / Below %`; `Pre-market change` → TARGET includes
`Post-market change`; `Average volume` → period `10 days`, TARGET
`Value / Post-market volume / Pre-market volume / Volume / Average volume`.

Observed operator signatures across the 238 captured ladders collapse to a handful of
real archetypes:

| archetype | example filters | condition set |
| --- | --- | --- |
| price series | `Price`, `High`, `Low`, `Open` | 12 (`… Above % / Below %`) |
| oscillator | `RSI`, `MFI`, `CCI`, `Williams %R`, `ADX`, `Aroon`, `Stochastic` | `Above / Below / Crosses / Crosses up / Crosses down` |
| indicator-vs-series | `Bollinger Bands`, `MACD`, `VWAP`, `Donchian`, `Keltner`, pivots | compare set incl. crosses, full 30-item TARGET |
| volume / rel-vol | `Volume`, `Average volume`, `Relative volume` | 7 (`Above … Above % / Below %`) |
| money / financials | `EPS`, `Total equity`, `ROCE %`, margins | 5 (`Above … Equal`) |
| categorical | `Sector`, `Analyst rating`, `Technical rating`, `Candlestick pattern` | `Equal` |
| range-only | `Average daily range` | `From / To`, no operator |

This fixed a real gap: technical oscillators previously fell through to the generic
5-operator money set (no `Crosses`). `screener.js` now has `osc` and `indcmp` families
(`OSC_LABELS` / `INDCMP_LABELS`) so `RSI → Manual setup` offers `Crosses` with a
`Value`-only target, and `Bollinger Bands` offers the compare set with the full TARGET
list — verified in the running widget.

**Real-data verification (public Yahoo Finance, no login).** `tools/yahoo-scan.js`
fetches a real 40-symbol universe via the same anonymous handshake `yfinance` uses
(`fc.yahoo.com` → `v1/test/getcrumb` → `v7/quote` + `v10/quoteSummary` + `v8/chart`)
and evaluates every filter against real values. Result: **236 / 261 filters resolve to
a real value from public data; 22 have no filter dialog on live (nothing to compute);
3 are wired but need a field no anonymous feed publishes — zero gaps.** Every
technical indicator is computed from genuine 1-year OHLCV
(true EMA/SMA/RSI/ATR/BB/VWAP/Donchian/Keltner/MACD/ADX/Aroon/AO/BBP/CMF/Stochastic/
StochRSI/MFI/CCI/Williams/Momentum/ROC/Ultimate/pivots); mapped fundamentals come
from `quoteSummary` and `fundamentals-timeseries`; extended-hours values come from the
intraday chart's per-day `tradingPeriods`. Real scans produce real hits, e.g.
`RSI(14) < 40 → 11 symbols`, `Price above SMA(50) → 23`, `P/E 10–20 → 13`,
`Market cap > $1T → 9`, `SPX members → 40`, `Goodwill > $10B → 30`,
`Piotroski ≥ 7 → 26`, `Altman Z > 3 → 32`. Coverage is written to
`_captures/yahoo-coverage.json`.

The three API-supplied filters are `IPO deal amount` (deal size is not public
anonymously), `Number of shareholders` (no SEC XBRL tag), and `Pre-market volume`
(extended-hours bars carry zero volume; price is still real). Documented proxies are
used only where live exposes a value no public source publishes: `CFI classification`
= `ESVUFR` for equities; `Country of highest income` = registration country;
`IPO offer price` = first traded close un-adjusted by later splits; `Sharia-compliant`
= AAOIFI debt/cash/receivables < 33% of market-cap screen; `Index` = membership from
Wikipedia constituent lists (`tools/index-membership.js`, SPX 503 / NDX 101 / DJI 30)
with an `IXIC` fallback for Nasdaq-listed symbols; forward non-GAAP P/E = price ÷
`0y` analyst EPS estimate.

**No paywall bypass.** The free-tier `Manual setup` button is still gated on live; the
replica never forces that gate open. It offers its own equivalent form, built from the
preset evidence and the 68 direct-dialog captures above. Yahoo access is fully public
and account-free.

### 16.15 Dock resize, table scrollbars, delayed-data `D` badge (captured 2026-11-03)

Measured on the live chart page with the screener docked (`viewport 1528×732`):

**Resize mechanism.** `div.js-rootresizer__contents` (`position:relative`) holds three
absolutely-positioned children: the left panel (`x:0 w:1023`), the screener panel
(`x:1027 w:501`), and a bare `div` at `x:1022 w:4 h:732` with `cursor:ew-resize` that
is the drag handle. The page ignores synthetic `pointerdown`/`mousedown` sequences
(width stayed 501), so the live drag itself was only observed structurally, not
replayed; the replica implements the same geometry with its own pointer handling.

**Table scroller.** One element `.wrapper-EWVk0cCv` with `overflow:auto`,
`scrollbar-width:auto`, `scrollbar-color:auto`; content `1259×4130` in a `481×516`
viewport, so both axes scroll. Its `::-webkit-scrollbar` computed width/height is `0px`
with a transparent track, thumb and corner — i.e. the visible scrollbars are overlay
style (thin, dark, no layout gutter, no arrow buttons), which is why
`offsetWidth == clientWidth`. The replica uses a 10px webkit scrollbar with transparent
track/corner, no buttons, and a rounded thumb inset by a 2px transparent border on
both axes, plus Firefox `scrollbar-width: thin`.

**Delayed-data badge.** Each delayed row carries
`<span class="dataMode-… tv-data-mode tv-data-mode--for-s" title="Quotes are delayed by 15 min">D</span>`
— `10px`, `rgb(255,152,0)`, `6×12px`, no border/background, placed immediately after
the ticker. It is per symbol and disappears when that symbol's quotes are real-time
(e.g. index rows on a real-time feed). The replica renders the same span
(`.tvsc-dbadge`) from a row-level flag: `delayed` / `isDelayed` / `dataDelayed` /
`dataMode:'delayed'` / `exchangeDataDelayedBy > 0` / `delayMinutes`, or a host
`isDelayed(row)` callback. `yahoo.js` exports `delayOf(quote)` for that mapping.

### 16.16 Symbol header search/count, ticker-only rows, compact tablet layout, Filters modal (captured 2026-11-03)

Measured on the live chart page with the screener docked at `w:501` (the panel had
already collapsed itself into its compact layout).

**Symbol header cell.** `div.cellWrapper-AGA4CHdX.tickerCell-VLi7SIqp.tickerCellContent-VLi7SIqp`
(`title="Symbol"`) contains, in order:

| part | element | size |
|---|---|---|
| magnifier | `button.searchButton-RK0Ibbh7[title="Search"]` | 34×34 |
| label | `div.upperLine-LSzeNK_2.upperLineThreeLine` → `Symbol` | — |
| sort | `button.iconButton-HDDUYOBI[title="Sort descending"]` | — |
| count | `span.tickerCellMatches-RK0Ibbh7[data-matches]` | 0×0, painted by CSS `content: attr(data-matches)` |

The count is the live result total (e.g. `8112`, later `8113` after quotes refreshed).
Clicking the magnifier swaps the label for `input.input-H0xdCnFS.size-small` — 64×28 at
`x:1078`, placeholder `Search`. Typing is live: `NV` → `data-matches="216"` and the rows
become NVDA, MNST, NBIS, DG, LYB. `Escape` removes the input and restores `8113`.
The replica keeps the same geometry (26px magnifier, label + count line, inline input)
and debounces 220ms before re-running the query.

**Rows.** The ticker cell is `a.apply-common-tooltip.tickerNameBox-t7nCkzMw.ticker` and
shows the ticker only; the company name is a tooltip. A synthetic single click on that
anchor changes the chart (`document.title` went `AAPL …` → `MSFT`). Double-click and
right-click row menus are gated behind trusted events and could not be replayed; the
replica implements the behaviour described by the user: single click → chart symbol,
double click or context menu → `Flag/Add to watchlist` row menu.

**Header second line.** Period/interval columns print the chosen timeframe under the
title (`Chg %` over `1W`, `Vol` over `1D`), alongside the fiscal labels (`EPS dil` over
`TTM`, `EPS dil growth` over `TTM YoY`). The replica reads the same stored timeframe that
the column menu writes, so changing the period updates the sublabel immediately.

**Compact layout.** TradingView collapses at 501px: `pillsContainer` holds two equal buttons `AI` and `Filters` (227×34 each; the container's text is `Filters1` when one filter is applied), and `columnSetPanelWrapper` holds the `Column sets` and `Maximize` buttons. The replica splits compact mode into two tiers measured on the same live screenshot set:

| tier | width | layout |
|---|---|---|
| tablet | 520–759px | single row merged into the view bar: `AI` · `Filters` (+ white count badge over its icon) · separator · icon-only views · `Custom ▾` · search/refresh/expand; desktop type |
| phone | <520px | full-width `AI` + `Filters` row above the view bar; type drops to 12px body / 11px headers |
| desktop | ≥760px | chip bar, labelled views, `Custom ▾` hidden |

Both compact tiers hide the view labels and keep `Custom ▾` plus the search/refresh/expand icons. The layout is re-evaluated by a `ResizeObserver` on the panel root.

**Filters modal.** The compact `Filters` button opens a centered dialog (`x:544`, rows `435×34`, `Ok` at `x:942 y:616 w:42 h:34`). Rows are the chip filters in order — `US, Watchlist, Index, Price, Chg %, Mkt cap, P/E, EPS dil growth, Div yield %, Sector, Analyst rating, Perf %, Revenue growth, PEG, ROE, Beta, Recent earnings date, Upcoming earnings date`. A row with an applied filter keeps the filter's preset ladder and shows a checkmark; an applied row becomes a white-outlined box `Label › value` with an `×` (e.g. `Price › 10 to 100 ×`) that clears the filter without closing the panel. Clicking a row expands that filter's editor inline inside the same panel (period control, search, preset ladder with the chosen entry highlighted in accent blue), and the panel never closes underneath it; nested menus such as `Watchlist` open above the panel on a higher layer. Footer: `+ Add filter` (opens the add-filter catalog), `⋯`, and `Ok` (closes).`
