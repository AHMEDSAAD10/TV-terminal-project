# Bar Replay — full click trace on your logged-in TradingView account

**Captured:** 2026-11-04, ~16:29 (UTC+3) — live session, your browser
**Browser used:** Brave, profile `C:\BraveProfile`, **remote-debug port 999**, tab = `https://www.tradingview.com/chart/j3mUKCaZ/` ("us30 copy" layout, NAS100 · Capital.com)
**Account state proven in-page:** accessibility name `button: "Logged in as Ahmed_3 Active layout: us30 copy"` — entitled session (no "Join / Sign in" promos present)
**Method:** read-only CDP observation + scripted clicks (REA `capture-browser-scenario` / `rea.cmd capture-browser-scenario`). Nothing in TradingView's files was downloaded or modified. Screenshots/DOM/accessibility and the network log are retained as Evidence (paths in §9).

> Note on which window was traced: an earlier attempt hit a *separate* Edge automation window that had grabbed port 9222 (anonymous session → replay showed the "Unlock Bar Replay / Join for free" ad). That Edge window was my leftover and was closed. This document is from **your** Brave window on port 999.

---

## 1. Before the click (baseline)

| Thing | Value |
|---|---|
| Chart | CAPITALCOM:NAS100, **1 hour** initially (switched to **1 day** as first action) |
| Canvas accessible name | `Canvas: Chart for CAPITALCOM:NAS100, 1 hour` |
| Replay button | in top toolbar; **`id="header-toolbar-replay"`**, aria-label "Bar replay" |
| Interval pills | radios: `1 hour`, `1 day` |
| Toolbar neighbourhood | `Create alert` … `Bar replay` … separator |
| Replay-mode DOM | **absent** (no `replay-*` nodes anywhere in the DOM) |

---

## 2. The click sequence (every step completed, no errors)

| # | Step | Action | Result |
|---|---|---|---|
| 0 | scenario_start | load `chart/j3mUKCaZ` | page/WS bootstrap |
| 1 | ready | wait for `#header-toolbar-replay` | visible |
| 2 | set-daily | click radio **"1 day"** | interval → **1D** |
| 3 | interval-settle | 2.5 s | daily series arrives over WS |
| 4 | **open-replay** | click **`#header-toolbar-replay`** | replay engine starts; **lazy chunks load** (§5) |
| 5 | mode-settle | 1.8 s | playback toolbar fully mounted (§3) |
| 6 | **pick-start** | click chart canvas (start bar) | **data after chosen bar cut off**; console: `REPLAYBROKER is already selected` (§6) |
| 7 | panel-settle | 3.0 s | state settles; "Replay Trading" available |

Screenshots: `_captures/replay-trace/r5-step5-shot.png` (mode armed), `r5-step6-shot.png` (pre-pick), **`r5-step7-shot.png` (cut applied at Fri 17 Oct '25)**.

---

## 3. What "came alive" in the DOM/CSS when Replay was clicked

Pre-click the DOM held only the header toggle (`#header-toolbar-replay` ×1); no `replay-bottom-toolbar`, no `replayWrapper`, no "Select bar". The toolbar **container mounts at the same instant as the click**, and its controls render once the lazy bundles finish (~1.8 s later):

| snapshot | `replay-bottom-toolbar` | `replayWrapper` | `replayIcon` | "Select bar" |
|---|---|---|---|---|
| step 2–3 (pre-click) | 0 | 0 | 0 | 0 |
| step 4 (click) | 1 | 1 | 0 | 0 |
| step 5–7 (settled) | 1 | 1 | 4 | 2 |

The tree sits **inside the chart panel**, bottom-anchored (`position:absolute; bottom:39px` of `layout__area--center`, min height 49 px), as a child of `div[data-is-chart-toolbar-component="true"]`:

```
data-name="replay-bottom-toolbar"
  class="replayWrapper-CvWEQ6Ei"
    class="replayToolbar-CvWEQ6Ei noTrading-CvWEQ6Ei"      ← "noTrading" variant until Replay Trading connects
      class="controlsPanel-CvWEQ6Ei"
        horizontal scroll wrapper (scrollWrap-qYm4x2uu …)
        controls-x6NoHjDT
```

Controls mounted (DOM `title` attributes, left→right):

| Order | title | class / hook |
|---|---|---|
| 1 | **Select bar** | `selectDateBar-Q3_c93rj` (`selectDateBar__button`), text variant |
| 2 | Select starting point (chevron menu) | `data-qa-id="select-date-bar-mode-menu"` |
| 3 | **Play** | `controls__button-x6NoHjDT` + hotkey tooltip payload |
| 4 | **Forward** | `controls__control_type_forward-x6NoHjDT` (step one bar) |
| 5 | **Replay speed** (text `10x`) | `js-button-text` |
| 6 | **Update interval** (text `D`) | replay resolution selector |
| 7 | **Jump to real-time chart** | icon button |
| 8 | **Exit Bar Replay** | last control, closes mode |

Other things that appeared at the same moment:

- Top toolbar button now `button "Bar replay" [pressed]` (`aria-pressed="true"`).
- Chart-header area gained `button "Replay mode"`.
- Bottom-left pill `button "Open Replay Trading": Replay Trading`.
- Status line item: class `statusItem-KqlJzsVD small-KqlJzsVD replayModePause-KqlJzsVD` — replay state badge (pause / autoplay / point-select variants exist).
- The date axis got a highlighted cut tag on the chosen bar (**Fri 17 Oct '25**) and **all bars after it were removed from the rendered chart**.

---

## 4. Where the click is "handled" (operation location)

1. **Header toolbar** (`#header-toolbar-replay`, aria `Bar replay`) — the entry point. This button only mounts when the toolbar's runtime registry supplies a Replay component (in the standalone bundle that is the `e.Replay &&` gate in `header-toolbar.*.js`).
2. **Chart controller** switches mode (`switchToReplay` / `isNewReplaySupportingPlatform` in `library.*.js` — stubbed in the standalone copy, see §7).
3. **Trading replay broker**: on the live site the click selects the internal broker `REPLAYBROKER` (`InternalBrokerId.ReplayBroker`), which is what the console line at step 6 confirms.
4. **Playback toolbar** mounts in the chart panel (DOM above) and drives actions through the bar-replay action set (your local `trading.js` names them exactly: `open_replay`, `do_step`, `start_autoplay`, `pause_autoplay`, `change_frequency`, `change_replay_resolution`, `toggle_jump_to_bar`, `go_to_realtime`, `close_replay_from_toolbar`, `close_replay_from_header_button`, `trade_with_broker`, `open_performance_report`, `open_replay_from_bottom_panel`).

---

## 5. What came from the server at click time

The click **lazy-loaded** these bundles from `static.tradingview.com/static/bundles/` (all HTTP 200) — i.e. they were **not in the page before the click**:

**Immediately on click (step 4):**
- `51647.5d4059540b58bb3b38e6.js`
- `backtesting-replay-strategy-facade.b81fc3f94c534e128cde.js`
- `76174.a792fd0c933c467ea432.js`
- `paper-maintenance-checker.a47e92ef4d600b0c7070.js`
- `chart-strategies-provider.946a1fb58ec859e51e0d.js`
- `fetch → https://www.tradingview.com/savesettings/` (replay state persisted)

**While the mode settled (step 5):**
- `replay-broker.94815ceaa54ac783e0cf.js`
- `replay-broker-host.1c8652a574f92c0a01f7.js`
- `modular-broker.e57f16831174be44bed8.js`
- `order-widget.c19e3b4de3a5abb85448.js`, `position-widget.3c50b57a573d040a9854.js`
- `fetch → https://crud-storage.tradingview.com/api/order_preset/`
- ~20 stylesheet chunks (the replay toolbar / trading UI CSS)
- several `en.*.js` locale chunks

**After picking the start bar (step 7):** economic-calendar fetch + telemetry only.

### What did *not* come from the server
The **cut itself** is client-side. WebSocket analysis:
- step 3 (interval → 1D): received `timescale_update` with the NAS100 daily series; sent `create_pointset`, `request_more_data` (normal datafeed traffic).
- steps 4–7 (replay click + bar pick): **no new `timescale_update` / data requests** — only small pointset frames.

So replay re-uses the already-fetched series and simply stops rendering bars past the chosen point; more history is requested only if you step beyond the loaded window.

---

## 6. Entitlement: the same button, two outcomes

| Session | Click `#header-toolbar-replay` → |
|---|---|
| **Anonymous** (the Edge window on 9222) | DOM dialog: `Unlock Bar Replay` / "Get a free account…" / `Join for free` / link `/support/solutions/43000712747/`; chart stays blocked behind the modal |
| **Your login (Ahmed_3)** | replay mode starts immediately: toolbar mounts (§3), broker switches to `REPLAYBROKER` |

In the entitled run, the click's only traffic is the lazy module loads (§5) — **no entitlement server call was observed**; the branch is taken in client code from the session's tier. (The anonymous window's post-click traffic was not retained — event capture there ended at the failed step — so for that branch the dialog is observed, not its preceding requests.)

Console line captured at bar-pick (step 6):
```
2026-11-04T13:29:18.920Z:Trading.Core:REPLAYBROKER is already selected.
```

---

## 7. Mapping the live trace onto **your** local v33 files

Local folder checked (read-only):
`C:\Users\Trading\Downloads\trading-terminal.tradingview-widget.com\charting_library\bundles`

| Live-site module (loaded on click) | Present locally? | What your copy has instead |
|---|---|---|
| header replay button | ✅ | `header-toolbar.9d286efaa7c0b8773cda.js`: `e.Replay="header-toolbar-replay"` and the mount gate `e.Replay && (0,i.jsx)(e.Replay,{…})` |
| chart mode switch | ⚠️ stubbed | `library.44380942f99004ae1449.js`: `switchToReplay(e,t,i){0}` — `switchToRealtime(){0}` — `isNewReplaySupportingPlatform(){return!1}`; also `TradingUIControllerReplayFactory` service descriptor + the `_loadTrading()` dynamic chunk list |
| replay broker | ✅ core present | `trading.2976e05f0cba3a7e1f53.js`: `ReplayBroker:"REPLAYBROKER"`, `pickDefaultBroker()` compares against it, `_initReplayBroker()` / `_connectToReplayBroker()`; also `trading-bottom-widget*`, `trading-widget-controller*` |
| bar-replay actions | ✅ full set | `trading.2976e05f0cba3a7e1f53.js` → `BarReplayActions = {do_step, start_autoplay, pause_autoplay, open_replay, change_frequency, change_replay_resolution, toggle_jump_to_bar, close_replay_from_toolbar, close_replay_from_header_button, go_to_realtime, trade_with_broker, open_performance_report, open_replay_from_bottom_panel}` |
| replay-mode status styling | ✅ | `92724.9a1a33a1ce40b24f1fd5.js`: `replayModeAutoPlay / replayModePause / replayModePointSelect-…` (same class-family suffix `KqlJzsVD` as the live page) |
| `replay-broker.js`, `replay-broker-host.js` | ❌ none | not in any local bundle |
| `backtesting-replay-strategy-facade.js` | ❌ none | not in any local bundle |
| `modular-broker.js`, `chart-strategies-provider.js`, `paper-maintenance-checker.js` | ❌ none | not in any local bundle |
| replay toolbar markup (`replay-bottom-toolbar`, `replayToolbar`, "Select bar"/"Replay speed"/"Exit Bar Replay") | ❌ none | no such strings in any local bundle |
| order/position widgets | ✅ (bundle names only) | `runtime.20c07beb9e6101b89d3c.js` references `order-widget` / `position-widget` |

Config/config-switch sweep (earlier, still valid): no featureset, feature flag, or `enabled_features` token anywhere enables replay; the only replay-named flag in the bundles is `mobile_app_hide_replay_toolbar` (a *hide* switch).

---

## 8. Plain-language conclusion — where the switch is (and isn't)

- On your account replay is real and working in **your logged-in window**: button → mode → toolbar → cut → step/play/speed/resolution/jump/exit — all observed live.
- The button in your own v33 files is only a **mount point plus stubs**. The parts that make replay actually run (replay controller/UI modules: `replay-broker`, `replay-broker-host`, `backtesting-replay-strategy-facade`, `modular-broker`, the toolbar markup + CSS) are **served by TradingView's platform at click time**, not shipped in the standalone library you have on disk. That is why `switchToReplay(){0}` exists locally but nothing ever calls into a working implementation.
- Therefore there is **no line to flip in your bundle** to "activate" it; the missing piece is server-side code plus the platform host. What you *can* do in your own project without touching their files is drive replay through the public API against your own datafeed (the approach already sketched for your Binance terminal page) — that keeps working even offline.

---

## 9. Evidence index

| File | What it is |
|---|---|
| `_captures/replay-trace/replay-scenario-real.json` | the exact scenario (actions + capture config) that produced this trace |
| `_captures/replay-trace/r5-step5-shot.png` | after Replay click: playback toolbar live, still full data range |
| `_captures/replay-trace/r5-step6-shot.png` | just before start-bar pick |
| `_captures/replay-trace/r5-step7-shot.png` | after pick: data cut at "Fri 17 Oct '25", toolbar armed |
| `%TEMP%\opencode\replay-capture-real5.json` (12.07 MB) | full Evidence: all 8 steps, DOM + accessibility + screenshots + 2,886 network/WS/console events |
| `%TEMP%\opencode\r5-step*-dom.txt` / `-accessibility.txt` | extracted DOM/accessibility trees per step |

---

## 10. State I left your chart in

The chart in that Brave window is **still in replay mode, paused at Fri 17 Oct '25** (`Select bar | ▶ | ⏭ | 10x | D | ⏭| | ✕`). Press **▶** to watch it unfold, **⏭ (Forward)** to step bar by bar, or click **✕ (Exit Bar Replay)** to return to the live chart. Nothing else was changed; no TradingView file was touched.

---

# PART II — The actual code behind every click

Everything below is **real code served by the site at the moment of your click**, pulled from the exact chunk files the page loaded (downloaded to a temp folder for reading only — nothing was added to your project or their bundle). Module names and the code are verbatim; only whitespace was collapsed and long minified blocks were split for readability.

Files involved (loaded on page boot / at click):

| File | Role |
|---|---|
| `header-toolbar.c2616834b1f7e3110382.js` | top-toolbar button registry + **mount gate for the Replay button** |
| `replay.0dac6e29e0f06faafb56.js` | **the whole playback engine + the bottom toolbar React components** |
| `trading-replay.270022fb3…js` | trading-side replay wiring (`BarReplayActions` dispatch) |
| `chart-bottom-toolbar.7dc05cda118b83def518.js` | bottom-toolbar host that mounts the replay widget |
| `replay-broker.94815ceaa54ac783e0cf.js`, `replay-broker-host…`, `modular-broker…`, `backtesting-replay-strategy-facade…` | broker/transport loaded on click |

---

## 11. The header button — its id, its gate, its HTML

### 11.1 The id constant

`header-toolbar.c2616834b1f7e3110382.js`:

```js
e.Replay = "header-toolbar-replay";
```

That string becomes the DOM `id` you clicked: `#header-toolbar-replay`, accessible name **"Bar replay"**.

### 11.2 The mount gate (why the button exists at all)

Same file, inside the left-tools render:

```js
e.Alert && jsxs(M, { children: [
    jsx(e.Alert,  { id: l ? void 0 : H.HeaderToolbarComponentIds.Alerts,
                    className: se, displayMode: i }),
    e.Replay && jsx(e.Replay, { id: l ? void 0 : H.HeaderToolbarComponentIds.Replay,
                    className: se, displayMode: i })
]}, "alert")
```

So the Replay button is **conditionally rendered**: if the host does not pass a `Replay` component into the header toolbar, the node never appears. In the standalone widget build you have, that component is absent → no button.

### 11.3 What the button's markup becomes

The live DOM node (captured) is a normal toolbar tool button:

```html
<button id="header-toolbar-replay"
        class="button-zm3YRUFG ..."
        aria-label="Bar replay"
        aria-pressed="false">
  <span class="icon-zm3YRUFG" aria-hidden="true">
    <svg viewBox="0 0 28 28" width="28" height="28" fill="none">
      <path fill="currentColor" fill-rule="evenodd"
            d="m17.13 9.74 7.37.9-5.44 5.06L20.4 23 14 19.38 7.6 23l1.34-7.3-5.44-5.06 7.37-.9L14 3l3.13 6.74Zm5.11 1.63-4.26 3.97 1.04 5.74L14 18.24l-5.02 2.84 1.04-5.74-4.26-3.97 5.79-.7L14 5.37l2.45 5.3 5.8.7Z"/>
    </svg>
  </span>
</button>
```

After the click the same node flips to `aria-pressed="true"` — that is the only visual "state" the header button carries.

---

## 12. The playback toolbar — the real component tree

When replay starts, this React component renders into a container inside the chart panel. From `replay.0dac6e29e0f06faafb56.js`.

### 12.1 CSS-module constants (the class names you saw)

```js
const ca = "replayWrapper-CvWEQ6Ei",
      da = "replayToolbar-CvWEQ6Ei",
      ua = "noTrading-CvWEQ6Ei",
      ha = "highlighted-CvWEQ6Ei",
      pa = "replayToolbar_size_medium-CvWEQ6Ei",
      ya = "noPL-CvWEQ6Ei",
      _a = "replayToolbar_size_small-CvWEQ6Ei",
      ma = "horizontalScrollWrapper-CvWEQ6Ei",
      ga = "horizontalScrollWrapperWithoutMargin-CvWEQ6Ei",
      va = "controlsPanel-CvWEQ6Ei",
      ba = "closeControl-CvWEQ6Ei",
      Ra = "closeControl_hide-CvWEQ6Ei",
      fa = "control-CvWEQ6Ei";
```

### 12.2 The toolbar shell (`Sa`)

```js
function Sa(e){
  const {
    isTradingInReplayEnabled:t, isPlShownWV:a, isInReplayWV:i, isAnimationShouldBePlayed:s,
    onCloseClicked:o, resizeUpdater:l, onSelectBarClicked:n, onSelectDateClicked:r,
    onSelectFirstAvailableDateClicked:c, onSelectRandomDateClicked:d, onForwardClicked:u,
    onGoToRealtimeClicked:h, onPlayPauseClicked:p, changeAutoplayDelay:y, changeReplayResolution:_,
    isJumpToBarModeEnabledWV:m, isSelectDateDialogActive:g, isAutoplayEnabledWV:v,
    autoplayDelayWV:b, isSelectRandomDateEnabled:f, isSelectFirstAvailableDateEnabled:C,
    readyToPlay:S
  } = e;

  // resize observer -> toolbarSize (Medium / Small)
  const [w, M] = useResize(e.resizeUpdater);
  const { toolbarSize: D } = M;

  const A = useWatchedValueReadonly({ watchedValue:a, defaultValue:!1 }); // is PL shown
  const x = useWatchedValueReadonly({ watchedValue:i });                 // is in replay
  const T = useWatchedValueReadonly({ watchedValue:m });                 // jump-to-bar mode
  const I = useWatchedValueReadonly({ watchedValue:v });                 // autoplay running
  const k = useWatchedValueReadonly({ watchedValue:b });                 // autoplay delay (speed)
  const E = useWatchedValueReadonly({ watchedValue:e.replayResolutions });
  const P = useWatchedValueReadonly({ watchedValue:e.currentReplayResolution });
  const N = useWatchedValueReadonly({ watchedValue:e.autoReplayResolution });
  const W = useWatchedValueReadonly({ watchedValue:e.autoReplayResolutionTitle });
  const B = useWatchedValueReadonly({ watchedValue:S });                 // readyToPlay

  return jsx(et.Provider, { value:M, children:
    jsx("div", { ref:w, className:ca, "data-name":"replay-bottom-toolbar", children:
      jsx("div", {
        className: ke()(da, [D===Medium && pa, D===Small && _a],
                        t ? (!A && ya) : ua,     // noTrading when trading not enabled
                        s && ha),                // highlight animation
        onClick: ra,
        children: B
          ? jsxs(Fragment, { children: [
              jsx("div", { className: va, children:
                jsx(Pe.HorizontalScroll, {
                  isVisibleFade:true, shouldMeasure:true, isVisibleScrollbar:false,
                  scrollWrapClassName: ke()(ma, ga),
                  children: t => jsx(oa, {           // <-- the controls component, §13
                    ref:t,
                    onSelectBarClicked:n, onSelectDateClicked:r,
                    onSelectFirstAvailableDateClicked:c, onSelectRandomDateClicked:d,
                    onPlayPauseClicked:p, onForwardClicked:u, onGoToRealtimeClicked:h,
                    changeAutoplayDelay:y, onCloseClicked:o, changeReplayResolution:_,
                    isInReplay:x, isJumpToBarModeEnabled:T, isSelectDateDialogActive:g,
                    isSelectRandomDateEnabled:f, isSelectFirstAvailableDateEnabled:C,
                    isAutoplayEnabled:I, autoplayDelay:k,
                    replayResolutions:E, currentReplayResolution:P,
                    autoReplayResolutionTitle:W, autoReplayResolution:N,
                    openSolution:e.openSolution
                  })
                })
              }),
              e.renderTradingWidget?.(D),       // the "Replay Trading" pill slot
              jsx("div", { className: ke()(ba, D===Small && Ra), children:
                jsx(Ue.ToolWidgetButton, { title:Ca, className:fa, icon:zt(), onClick:o }) // exit (duplicate/right-side)
              })
            ]})
          : jsx(Ne.SpaceLoader, { size:Small, position:overlay })   // spinner until readyToPlay
      })
    })
  });
}
```

Notes that matter:
- `data-name="replay-bottom-toolbar"` is the anchor we found in the DOM.
- While `readyToPlay` is false it renders **only a `SpaceLoader`** — that is the 1.8 s gap between the container mounting and the controls appearing.
- `noTrading-CvWEQ6Ei` is applied whenever trading-in-replay is not enabled (your account without Replay Trading connected → `noTrading`).

### 12.3 The controls component (`oa`) — every button, in order

This is the exact list of controls you see: **Select bar ▾ · ▶ · ⏭ · 10x ▾ · D ▾ · ⏭| · ✕**.

```js
const Pt = {
  controls:"controls-x6NoHjDT",
  controls__control:"controls__control-x6NoHjDT",
  controls__control_type_selectBar:"controls__control_type_selectBar-x6NoHjDT",
  controls__control_type_forward:"controls__control_type_forward-x6NoHjDT",
  controls__control_type_close:"controls__control_type_close-x6NoHjDT",
  controls__control_type_close_hide:"controls__control_type_close_hide-x6NoHjDT",
  controls__separator:"controls__separator-x6NoHjDT",
  controls__divider:"controls__divider-x6NoHjDT",
  controls__button:"controls__button-x6NoHjDT",
  speedMenu__title:"speedMenu__title-x6NoHjDT",
  ...
};

const oa = Me.forwardRef(function(e, t){
  const {
    onSelectBarClicked:a, onSelectDateClicked:i, onSelectFirstAvailableDateClicked:s,
    onSelectRandomDateClicked:o, onPlayPauseClicked:l, onForwardClicked:n,
    changeAutoplayDelay:r, onGoToRealtimeClicked:c, onCloseClicked:d,
    isJumpToBarModeEnabled:u, isSelectDateDialogActive:h, isSelectRandomDateEnabled:y,
    isSelectFirstAvailableDateEnabled:_, isAutoplayEnabled:m, isInReplay:v,
    autoplayDelay:b, replayResolutions:R, currentReplayResolution:f,
    autoReplayResolutionTitle:C, autoReplayResolution:S, changeReplayResolution:w,
    openSolution:M
  } = e;

  // resolution dropdown items: e.g. 1S, 5S, 1, 5, 15, 30, 1H, ...
  const A = useMemo(() => R.filter(notNull).map(res => {
    const m = getTranslatedResolutionModel(res);
    return { label:m.hint, description:m.hint, value:res };
  }), [R]);

  // current resolution label, e.g. "D"
  const x = useMemo(() => {
    const m = getTranslatedResolutionModel(f ?? S);
    return `${m.mayOmitMultiplier ? "" : m.multiplier}${m.shortKind}`;
  }, [f, S]);
  const T = null === f;   // "auto select interval" is on

  return jsxs("div", { ref:t, className: ke()(Pt.controls, D===Small && Pt.controls_size_phone), children: [

    /* 1) SELECT BAR -------------------------------------------------- */
    jsx("div", { className: ke()(Pt.controls__control, Pt.controls__control_type_selectBar), children:
      jsx(It, { onSelectDateClicked:i, onSelectFirstAvailableDateClicked:s,
                onSelectBarClicked:a, onSelectRandomDateClicked:o,
                isJumpToBarModeEnabled:u, isSelectDateDialogActive:h,
                isSelectFirstAvailableDateEnabled:_, isSelectRandomDateEnabled:y })
    }),

    /* divider */
    jsx("div", { className: Pt.controls__separator, children:
      jsx(ToolbarDivider, { className:Pt.controls__divider, orientation:Vertical }) }),

    /* 2) PLAY / PAUSE ------------------------------------------------ */
    jsx("div", { className: Pt.controls__control, children:
      jsx(Ue.ToolWidgetButton, {
        title: m ? Jt : Yt,              // "Pause" / "Play"
        "data-tooltip-hotkey": aa,
        icon: m ? Lt() : Wt(),           // pause / play icon
        onClick: l,                      // -> _onPlayPauseClicked
        isDisabled: !v,                  // disabled when not in replay
        className: Pt.controls__button
      })
    }),

    /* 3) FORWARD (step one bar) -------------------------------------- */
    jsx("div", { className: ke()(Pt.controls__control, Pt.controls__control_type_forward), children:
      jsx(Ue.ToolWidgetButton, {
        title: Kt,                       // "Forward"
        "data-tooltip-hotkey": ta,
        icon: Vt(),                      // forward icon
        onClick: n,                      // -> _onForwardClicked
        isDisabled: !v,
        className: Pt.controls__button
      })
    }),

    /* 4) SPEED (10x) + 5) RESOLUTION (D) ----------------------------- */
    jsxs("div", { className: Pt.controls__control, children: [

      jsx(Ge.ToolWidgetMenu, {
        content: jsx(Ue.ToolWidgetButton, {
          title: Xt,                     // "Replay speed"
          text: findAutoplayDelayOptionItems(b).label,   // "1x".."10x"
          className: Pt.controls__button
        }),
        verticalDropDirection: FromBottomToTop,
        children: jsxs(Fragment, { children: [
          jsx("div", { className: Pt.speedMenu__title, children: Xt }),
          autoplayDelayOptionItems.map(({value,label,description}) =>
            jsx(PopupMenuItem, {
              onClick: () => r(value),   // -> _changeAutoplayDelay
              isActive: b === value,
              label: jsx(la, { isActive:b===value, label, description })
            }, value))
        ]})
      }),

      jsx(Ge.ToolWidgetMenu, {
        content: jsx(Ue.ToolWidgetButton, {
          title: ea,                     // "Update interval"
          text: x,                       // "D"
          className: Pt.controls__button
        }),
        children: jsxs(Fragment, { children: [
          jsxs("div", { className: Pt.resolutionMenu__title, children: [
            ea,
            jsx(IconQuestionInformationButton, { /* help -> solution HOW_TO_CHANGE_REPLAY_INTERVAL */ })
          ]}),
          A.map(({value, description}) =>
            jsx(PopupMenuItem, {
              onClick: () => w(value),   // -> _changeReplayResolution
              isActive: f === value,
              label: jsx(na, { isActive:f===value, description })
            }, value)),
          jsx(PopupMenuSeparator, {}),
          jsx(MenuItemSwitcher, {
            checked: T,
            onChange: e => w(e ? null : S),   // null = auto interval
            label: C,
            value: "autoSelectIntervalSwitcher"
          })
        ]})
      })
    ]}),

    /* divider */
    jsx("div", { className: Pt.controls__separator, children:
      jsx(ToolbarDivider, { className:Pt.controls__divider, orientation:Vertical }) }),

    /* 6) JUMP TO REAL-TIME ------------------------------------------- */
    jsx("div", { className: Pt.controls__control, children:
      jsx(Ue.ToolWidgetButton, {
        title: Qt,                       // "Jump to real-time chart"
        icon: Ft(),
        onClick: c,                      // -> _onGoToRealtimeClicked
        isDisabled: !v,
        className: Pt.controls__button
      })
    }),

    /* 7) EXIT -------------------------------------------------------- */
    jsx("div", { className: ke()(Pt.controls__control, Pt.controls__control_type_close,
                                 D!==Small && Pt.controls__control_type_close_hide), children:
      jsx(Ue.ToolWidgetButton, {
        title: Zt,                       // "Exit Bar Replay"
        icon: zt(),
        onClick: d,                      // -> _onCloseClicked
        className: Pt.controls__button
      })
    })
  ]});
});
```

### 12.4 The "Select bar" button + its mode menu (`It`)

The left-most control is not one button — it's a mode selector that swaps its face based on `replayTimingModeProperty`:

```js
const y = useCallback(() => { replayTimingModeProperty.setValue(ReplayTimingMode.Manual);            a(true); }, []);
const _ = useCallback(() => { replayTimingModeProperty.setValue(ReplayTimingMode.Date);              i();     }, []);
const m = useCallback(() => { replayTimingModeProperty.setValue(ReplayTimingMode.FirstAvailableDate); s();     }, []);
const g = useCallback(() => { replayTimingModeProperty.setValue(ReplayTimingMode.Random);            o();     }, []);
```

Render:

```js
b === ReplayTimingMode.Manual
  ? jsx(ToolWidgetButton, { className:yt, icon:lt(), title:Rt, text:R&&Rt, onClick:()=>a(), theme:xt, isActive:l })
  : b === ReplayTimingMode.FirstAvailableDate
    ? jsx(ToolWidgetButton, { className:yt, icon:dt(), title:Ct, text:R&&Ct, onClick:s, theme:xt, isActive:n, isDisabled:!p })
    : jsx(ToolWidgetButton, { className:yt, icon:ht(), title:St, text:R&&St, onClick:o, theme:xt, isDisabled:!h }),

    jsxs(ToolWidgetMenu, {
      drawerBreakpoint: TabletSmall,
      children: [
        jsx(PopupMenuItem, { onClick:y, isActive:b===Manual,            label:Rt, className:vt }), // "Select bar"
        jsx(PopupMenuItem, { onClick:_, isActive:b===Date,              label:ft, className:vt }), // "Select date"
        jsx(PopupMenuItem, { onClick:m, isActive:b===FirstAvailableDate,label:Ct, className:vt }), // "First available date"
        jsx(PopupMenuItem, { onClick:g, isActive:b===Random,            label:At, icon:ht(), className:vt }) // "Random date"
      ]
    })
```

So when you click **Select bar ▾**, the menu is literally four `PopupMenuItem`s, each just writing an enum into `replayTimingModeProperty`. `Manual` = "I'll click a bar on the chart". `Date` = open the date-picker dialog. That is the entire "select bar" feature.

---

## 13. What each click calls — handler → engine → wire

The toolbar's callbacks are bound in the replay widget controller. Verbatim:

```js
this._onForwardClicked = () => {
  this._isInReplay().value() && (
    this._uiController.doStep(),
    trackEvent("Replay", "Do step"),
    this._trackReplaySnowplowEvent(BarReplayActions.DoStep)
  );
};

this._onPlayPauseClicked = () => {
  this._isInReplay().value() && (
    this._uiController.toggleAutoplay(),
    trackEvent("Replay", this._uiController.isAutoplayStarted().value() ? "Start autoplay" : "Pause autoplay"),
    this._trackReplaySnowplowEvent(
      this._uiController.isAutoplayStarted().value()
        ? BarReplayActions.StartAutoplay
        : BarReplayActions.PauseAutoplay)
  );
};

this._onGoToRealtimeClicked = () => {
  this._isInReplay().value() && (
    this._uiController.goToRealtime(),
    trackEvent("Replay", "Go to realtime"),
    this._trackReplaySnowplowEvent(BarReplayActions.GoToRealtime)
  );
};

this._onCloseClicked = () => {
  this._uiController.requestCloseReplay(),
  trackEvent("Replay", "Close replay from toolbar"),
  this._trackReplaySnowplowEvent(BarReplayActions.CloseReplayFromToolbar);
};

this._changeAutoplayDelay = e => {
  this._uiController.changeAutoplayDelay(e),
  trackEvent("Replay", "Change frequency", e / 1000 + " sec"),
  this._trackReplaySnowplowEvent(BarReplayActions.ChangeFrequency, e / 1000 + " sec");
};

this._changeReplayResolution = e => {
  this._uiController.changeReplayResolution(e),
  trackEvent("Replay", "Change replay resolution", `${e}`),
  this._trackReplaySnowplowEvent(BarReplayActions.ChangeReplayResolution);
};
```

### 13.1 The controller methods they hit

```js
doStep() {
  return this._replayManager.isReplayFinished()
    ? (logNormal("Replay is finished"),
       this._replayManager.stopReplay(),
       Promise.reject("Replay is finished"))
    : this._replayManager.doReplayStep();
}

goToRealtime() {
  this._updateReplaySessionState();
  this._replayManager.isReplayFinished()
    ? this._replayManager.stopReplay()
    : (this._onReplayEnd(),
       this._replayTradingUIController?.isTradingReplaySessionHasExecutions()
         ? this._replayManager.finishReplay()
         : this._replayManager.stopReplay());
}

changeAutoplayDelay(e) { this._replayManager.changeAutoplayDelay(e); }

requestCloseReplay() { /* checks manager state, then _setReplayModeEnabled(false) */ }
```

### 13.2 The engine → the replay session (the actual "wire")

`replay.…js` — the replay **session** is a message transport; each control maps to one wire command:

```js
startAutoplay(e, t) {                       // e = delay in ms
  const a = this._generateNextTurnaround();
  this._notificationHandlers[a] = t;
  return this._sendMessage("replay_start", [this.sessionId(), a, e]);
}
stopAutoplay(e) {
  const t = this._generateNextTurnaround();
  this._notificationHandlers[t] = e;
  return this._sendMessage("replay_stop", [this.sessionId(), t]);
}
doStep(e, t) {
  const a = this._generateNextTurnaround();
  this._notificationHandlers[a] = t;
  return this._sendMessage("replay_step", [this.sessionId(), a, e]);
}
resetReplay(e, t) { const a = this._generateNextTurnaround(); /* … */ }
```

And the manager-level wrappers add state + status:

```js
startAutoplay() {
  assert(this._isReplayStarted.value(), "Replay is not started");
  assert(!this._isAutoplayEnabled.value(), "Cannot start autoplay multiple times");
  const e = this._autoplayDelay.value();
  assert(-1 !== e, "Autoplay delay is not set");
  this._replaySession.startAutoplay(e, this._handleMessage.bind(this, 1));
  this._logNormal(`Start autoplay with delay ${e}ms`);
  this._isAutoplayEnabled.setValue(true);
  const t = this._models.filter(m => m.isInReplay().value());
  this.setReplayStatus(t, ReplayStatus.Autoplay);
}
```

### 13.3 Entering replay (what the header click starts)

```js
startReplay(point) {
  assert(this._models.length > 0, "There is no models to replay");
  this._replaySession.connect();
  assert(!this._isReplayStarted.value(), "Replay is not stopped");
  this._isReplayStarted.setValue(true);
  this.setReplayStatus(this._models, ReplayStatus.Pause);
  void 0 !== point && this.resetReplay(point, false);
  assert(this._replaySession.isConnected().value(), "Session must be connected");
  assert(this._subscriberManager.isEmpty(), "Non-empty state before start");

  for (const t of this._models)
    t.switchToReplay(
      this._subscriberManager.createSubscriber(t.id()),
      this._isReplayResolutionAvailableForUser,
      point);

  t.isInReplay().subscribe(this._onModelReplayEnabledChanged, { once: true });
  this._logNormal(`Replay has been started with ${this._models.length} model(s)`);
}
```

`this._models` are the chart series models; `switchToReplay(...)` tells each series to enter replay at `point`. `point` is the bar you clicked. That call is also where the **data cut** happens: the series model stops exposing points after the replay point (client-side — matching the WS evidence: no new data at click).

### 13.4 The status enum (what drives `replayModePause` etc.)

```js
ReplayStatus = { Pause, Autoplay, Finish };
```

`setReplayStatus(models, ReplayStatus.Pause | .Autoplay | .Finish)` toggles the `replayModePause / replayModeAutoPlay / replayModeFinish` class family you saw on the status badge.

### 13.5 The action enum (verbatim, identical to your local `trading.js`)

```js
var BarReplayActions = function (e) {
  return e.DoStep                   = "do_step",
         e.StartAutoplay            = "start_autoplay",
         e.PauseAutoplay            = "pause_autoplay",
         e.OpenReplay               = "open_replay",
         e.ChangeFrequency          = "change_frequency",
         e.ChangeReplayResolution   = "change_replay_resolution",
         e.ToggleJumpToBar          = "toggle_jump_to_bar",
         e.CloseReplayFromToolbar   = "close_replay_from_toolbar",
         e.CloseReplayFromHeaderButton = "close_replay_from_header_button",
         e.GoToRealtime             = "go_to_realtime",
         e.TradingPopUp             = "trading_pop_up",
         e.PositionClose            = "position_close",
         e.PositionReverse          = "position_reverse",
         e.StartTradingInReplay     = "start_trading_in_replay",
         e.Buy                      = "buy",
         e.Sell                     = "sell",
         e.TradeWithBroker          = "trade_with_broker",
         e.OpenPerformanceReport    = "open_performance_report",
         e.OpenReplayFromBottomPanel= "open_replay_from_bottom_panel",
         e;
}({});
```

---

## 14. Control-by-control cheat sheet

| Toolbar control (title) | DOM class | React element | onClick | Calls | Engine / effect |
|---|---|---|---|---|---|
| **Select bar** (＋▾) | `selectDateBar-Q3_c93rj` / `selectDateBar__button-Q3_c93rj` | `It` → `ToolWidgetButton` + `ToolWidgetMenu` | `onSelectBarClicked` | sets `replayTimingModeProperty = Manual`, arms point-select | chart click sets replay point |
| **Select starting point ▾** items | `selectDateBarModeMenu__item-Q3_c93rj` | `PopupMenuItem` ×4 | `y/_/m/g` | `ReplayTimingMode.Manual\|Date\|FirstAvailableDate\|Random` | point-select / date dialog / first bar / random bar |
| **Play / Pause** | `controls__button-x6NoHjDT` | `ToolWidgetButton` | `_onPlayPauseClicked` | `uiController.toggleAutoplay()` | `session.startAutoplay(delay)` / `session.stopAutoplay()` → `replay_start` / `replay_stop` |
| **Forward** | `controls__control_type_forward-x6NoHjDT` | `ToolWidgetButton` | `_onForwardClicked` | `uiController.doStep()` → `manager.doReplayStep()` | `session.doStep()` → `replay_step` |
| **Replay speed** (10x) | `speedMenu__title-x6NoHjDT` | `ToolWidgetMenu` + `PopupMenuItem[]` | `_changeAutoplayDelay` | `uiController.changeAutoplayDelay(ms)` | `manager.changeAutoplayDelay(ms)` |
| **Update interval** (D) | `resolutionMenu` | `ToolWidgetMenu` + `PopupMenuItem[]` + `MenuItemSwitcher` | `_changeReplayResolution` | `uiController.changeReplayResolution(res)` | re-slices the replay at a different bar interval |
| **Jump to real-time chart** | `controls__button-x6NoHjDT` | `ToolWidgetButton` | `_onGoToRealtimeClicked` | `uiController.goToRealtime()` | `finishReplay()` or `stopReplay()` |
| **Exit Bar Replay** | `controls__control_type_close-x6NoHjDT` | `ToolWidgetButton` | `_onCloseClicked` | `uiController.requestCloseReplay()` | leaves replay, restores live chart |
| **Replay Trading** pill | rendered via `e.renderTradingWidget(D)` | host slot | — | — | only when trading-in-replay enabled (hence `noTrading` class for you) |

---

## 15. Live module → your local v33 file (same code, different build hashes)

Local folder (read-only): `C:\Users\Trading\Downloads\trading-terminal.tradingview-widget.com\charting_library\bundles`

| What you need | Live file (served now) | Your local equivalent | State in your copy |
|---|---|---|---|
| header button id + gate | `header-toolbar.c2616834…js` | `header-toolbar.9d286efaa7c0b8773cda.js` | ✅ `e.Replay="header-toolbar-replay"`, gate `e.Replay && jsx(...)` |
| `BarReplayActions` enum | `replay.…js` / `trading-replay.…js` | `trading.2976e05f0cba3a7e1f53.js` | ✅ full enum |
| `REPLAYBROKER` broker | `replay-broker…js` | `trading.2976e05f0cba3a7e1f53.js`, `trading-bottom-widget*`, `trading-widget-controller*` | ✅ hooks present |
| `replayMode*` status classes | `replay.…js` | `92724.9a1a33a1ce40b24f1fd5.js` | ✅ classes present |
| toolbar CSS (`controls-x6NoHjDT`, `replayWrapper-CvWEQ6Ei`, …) | inline in `replay.…js` (CSS modules) | **none** | ❌ absent |
| toolbar components `Sa` / `oa` / `It` | `replay.…js` | **none** | ❌ absent |
| engine (`startAutoplay`, `doStep`, `switchToReplay`, `resetReplay`, `setReplayStatus`) | `replay.…js` | stub only | ⚠️ `switchToReplay(e,t,i){0}`, `switchToRealtime(){0}`, `isNewReplaySupportingPlatform(){return!1}` in `library.44380942f99004ae1449.js` |
| `replay-broker.js`, `replay-broker-host.js`, `modular-broker.js`, `backtesting-replay-strategy-facade.js` | served on click | **none** | ❌ absent |

**Bottom line for building your own:** the toolbar is ~150 lines of React (`Sa` + `oa` + `It`) over a tiny controller (`doStep` / `toggleAutoplay` / `goToRealtime` / `requestCloseReplay`) that maps 1:1 to an action enum, and the engine is a session object with four commands (`replay_start`, `replay_stop`, `replay_step`, plus `switchToReplay` on the series). Everything visual is CSS-module classes on plain `div`/`button` elements — nothing magic, no proprietary canvas tricks. Reimplement that shape against your own datafeed and you have Bar Replay.
