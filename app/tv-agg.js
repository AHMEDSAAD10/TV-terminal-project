// TradingView chart-protocol aggregator for custom intervals.
//
// The mirrored app talks to data.tradingview.com over a tiny JSON protocol:
//   ~m~<byteLen>~m~{"m":"<method>","p":[...]}
//
// Bars arrive as {"i":<index>,"v":[time,open,high,low,close,volume]} under a
// series (`s`) or study (`st`) key. The time scale is delivered separately in
// `timescale_update` as {index, zoffset, changes:[...times]}, where `changes`
// is a contiguous run of bar times starting at bar index `index` and
// `zoffset` is the negated first index.
//
// The live free feed refuses non-standard resolutions ("4", "7", "5S", ...)
// with `series_error: custom_resolution`. This module rewrites those requests
// to a base resolution the feed does serve (1 minute / 1 second) and folds the
// incoming base bars into the requested interval before the client sees them.
//
// Bars and studies are grouped positionally by base index:
//     group = Math.floor(baseIndex / multiplier)
// so the aggregated series and its server-side studies stay aligned. The
// time-scale update is compressed the same way.
'use strict';

const fs = require('fs');
const path = require('path');

// Resolutions the free feed already serves as-is.
const STANDARD_MINUTES = new Set([1, 3, 5, 15, 30, 45, 60, 120, 180, 240, 1440]);
const STANDARD_SECONDS = new Set([1, 5, 15, 30]);

// Special (non-time-series) plot indices used by studies.
const SPECIAL_INDEX = 1e6;

function parseResolution(res) {
  if (typeof res === 'number') res = String(res);
  if (typeof res !== 'string') return null;
  const s = res.trim();
  if (!s) return null;
  let m = /^(\d+)[Ss]$/.exec(s);
  if (m) return { raw: s, kind: 'seconds', value: +m[1], periodSec: +m[1] };
  m = /^(\d+)[Dd]$/.exec(s);
  if (m) return { raw: s, kind: 'days', value: +m[1], periodSec: +m[1] * 86400 };
  m = /^(\d+)[Ww]$/.exec(s);
  if (m) return { raw: s, kind: 'weeks', value: +m[1], periodSec: +m[1] * 7 * 86400 };
  m = /^(\d+)[Mm]$/.exec(s);
  if (m) return { raw: s, kind: 'months', value: +m[1], periodSec: +m[1] * 30 * 86400 };
  m = /^(\d+)$/.exec(s);
  if (m) return { raw: s, kind: 'minutes', value: +m[1], periodSec: +m[1] * 60 };
  return null;
}

function isStandard(r) {
  if (!r) return true;
  if (r.kind === 'minutes') return STANDARD_MINUTES.has(r.value);
  if (r.kind === 'seconds') return STANDARD_SECONDS.has(r.value);
  if (r.kind === 'days') return r.value === 1;
  if (r.kind === 'weeks') return r.value === 1;
  if (r.kind === 'months') return r.value === 1;
  return true;
}

function sameResolution(a, b) {
  if (!a || !b) return false;
  return a.kind === b.kind && a.value === b.value;
}

// Largest standard minute resolution that divides `n` exactly. Folding from a
// bigger base (e.g. 8h = 2 x 4h instead of 480 x 1m) keeps the requested base
// bar count small enough that the free feed will not trip its history limit.
function largestStandardMinuteDivisor(n) {
  let best = 1;
  for (const s of STANDARD_MINUTES) {
    if (s <= n && n % s === 0 && s > best) best = s;
  }
  return best;
}

// Requested custom resolution -> base resolution to fetch + multiplier.
function planFor(r) {
  if (!r) return null;
  if (r.kind === 'minutes' && r.value >= 2 && !STANDARD_MINUTES.has(r.value)) {
    const base = largestStandardMinuteDivisor(r.value);
    return { base: String(base), kind: 'minutes', mult: r.value / base, periodSec: r.value * 60 };
  }
  if (r.kind === 'days' && r.value >= 2) {
    return { base: '1D', kind: 'days', mult: r.value, periodSec: r.value * 86400 };
  }
  if (r.kind === 'weeks' && r.value >= 2) {
    return { base: '1W', kind: 'weeks', mult: r.value, periodSec: r.value * 7 * 86400 };
  }
  if (r.kind === 'months' && r.value >= 2) {
    return { base: '1M', kind: 'months', mult: r.value, periodSec: r.value * 30 * 86400 };
  }
  // Seconds are not servable: the free feed refuses even the 1S base with
  // `seconds_not_entitled`, so there is nothing to aggregate from. Leave the
  // request untouched and let the client's own `secondsIntervalNotPermitted`
  // handler fall back to 1 minute (its native graceful behaviour).
  return null;
}

class SeriesState {
  constructor(plan) {
    this.plan = plan;                 // {base, kind, mult, periodSec}
    this.groups = new Map();          // groupIndex -> {i, bars: Map(baseIndex -> v)}
    this.studyGroups = new Map();     // groupIndex -> {i, bars: Map(baseIndex -> v)}
    this.version = null;
    this.requested = null;
    this.symbolKey = null;
  }

  groupIndex(baseIndex) {
    return Math.floor(baseIndex / this.plan.mult);
  }

  // Fold one base OHLCV bar into its aggregate group. Volume is summed from
  // the per-base-bar values so repeated live updates of the same base bar do
  // not double count.
  addSeries(baseIndex, v) {
    const g = this.groupIndex(baseIndex);
    let grp = this.groups.get(g);
    if (!grp) { grp = { i: g, bars: new Map() }; this.groups.set(g, grp); }
    grp.bars.set(baseIndex, v);

    let t = null;
    let open;
    let high = -Infinity;
    let low = Infinity;
    let close;
    let volume = 0;
    const keys = Array.from(grp.bars.keys()).sort((a, b) => a - b);
    for (const k of keys) {
      const b = grp.bars.get(k);
      if (t === null) { t = b[0]; open = b[1]; }
      if (b[2] > high) high = b[2];
      if (b[3] < low) low = b[3];
      close = b[4];
      if (typeof b[5] === 'number') volume += b[5];
    }
    return { i: g, v: [t, open, high, low, close, volume] };
  }

  // Fold one study plot vector into its group; the group shows the vector of
  // its latest base bar.
  addStudy(baseIndex, v) {
    const g = this.groupIndex(baseIndex);
    let node = this.studyGroups.get(g);
    if (!node) { node = { i: g, bars: new Map() }; this.studyGroups.set(g, node); }
    node.bars.set(baseIndex, v);
    let maxK = null;
    let maxV = null;
    for (const [k, val] of node.bars) if (maxK === null || k > maxK) { maxK = k; maxV = val; }
    return { i: g, v: maxV };
  }

  groupTime(g) {
    const grp = this.groups.get(g);
    if (!grp || !grp.bars.size) return null;
    let minK = null;
    for (const k of grp.bars.keys()) if (minK === null || k < minK) minK = k;
    return grp.bars.get(minK)[0];
  }
}

// --- Bar-set styles (Renko / Kagi / Point & figure / Line break) ----------
// The paid `@tv-prostudies` bar-set studies are just calculators that turn a
// plain OHLC series into bricks; the client already ships the native brick
// renderer. The free feed refuses those studies on intraday resolutions
// (`study_not_auth:BarSetRenko@...`), after which the client falls back to
// Daily. So we strip the wrapper from the symbol descriptor, let the feed
// serve plain OHLC and rebuild the bar set locally as the series. Renko first.
const BARSET_KINDS = {
  BarSetRenko: 'renko',
  BarSetKagi: 'kagi',
  BarSetPriceBreak: 'pricebreak',
  BarSetPnF: 'pnf',
};

function parseSymbolDescriptor(str) {
  if (typeof str !== 'string') return null;
  const s = str.charAt(0) === '=' ? str.slice(1) : str;
  if (s.charAt(0) !== '{') return null;
  try { return JSON.parse(s); } catch { return null; }
}

function barSetKindOf(type) {
  if (typeof type !== 'string') return null;
  return BARSET_KINDS[type.split('@')[0]] || null;
}

// A copy of a `resolve_symbol` message with the bar-set study wrapper removed,
// so the feed answers with a plain OHLC series.
function stripBarSetWrapper(obj) {
  if (!obj || !obj.p || typeof obj.p[2] !== 'string') return obj;
  const parsed = parseSymbolDescriptor(obj.p[2]);
  if (!parsed || parsed.type === undefined) return obj;
  // The wrapper nests the real descriptor under `symbol`; the feed expects it
  // flat (same shape the client sends for a plain symbol), so hoist it.
  let flat;
  if (parsed.symbol && typeof parsed.symbol === 'object') {
    flat = Object.assign({}, parsed.symbol);
  } else {
    flat = {};
    for (const k of Object.keys(parsed)) {
      if (k !== 'type' && k !== 'inputs' && k !== 'symbol') flat[k] = parsed[k];
    }
    if (typeof parsed.symbol === 'string') flat.symbol = parsed.symbol;
  }
  const copy = { m: obj.m, p: obj.p.slice() };
  copy.p[2] = '=' + JSON.stringify(flat);
  return copy;
}

// TradingView time-scale mark "spans" (mirrors the client's TimescaleMark enum):
// coarser spans win, so each time gets the coarsest boundary it falls on.
const MARK_SPAN = { MINUTE: 20, MIN15: 21, MIN30: 22, HOUR: 30, DAY: 40, WEEK: 50, MONTH: 60, YEAR: 70 };

// Each bar-set brick carries the timestamp of the base bar that produced it.
// The chart's time axis labels come from these `marks`, so we rebuild one mark
// per distinct brick time using the coarsest calendar boundary it falls on,
// mirroring how the feed marks a plain series. Without them the axis is blank
// on every timeframe (the native feed used to supply them).
function markSpanForTime(t) {
  const d = new Date(t * 1000);
  const min = d.getUTCMinutes(), hr = d.getUTCHours();
  const day = d.getUTCDate(), mon = d.getUTCMonth(), dow = d.getUTCDay();
  if (mon === 0 && day === 1) return MARK_SPAN.YEAR;
  if (day === 1) return MARK_SPAN.MONTH;
  if (dow === 1) return MARK_SPAN.WEEK;
  if (hr === 0 && min === 0) return MARK_SPAN.DAY;
  if (min === 0) return MARK_SPAN.HOUR;
  if (min % 30 === 0) return MARK_SPAN.MIN30;
  if (min % 15 === 0) return MARK_SPAN.MIN15;
  return MARK_SPAN.MINUTE;
}

function barsetMarks(bricks, startIndex) {
  const out = [];
  let prev = null;
  for (let j = 0; j < bricks.length; j++) {
    const t = bricks[j].t;
    if (t === prev) continue;
    prev = t;
    out.push([markSpanForTime(t), t, startIndex + j]);
  }
  return out;
}

// Wilder ATR over an ordered bar list; null until the first full period.
function wilderAtr(bars, len) {
  const n = bars.length;
  const out = new Array(n).fill(null);
  if (!(len >= 1)) len = 14;
  let prevClose = null;
  let atr = null;
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const tr = prevClose === null
      ? (b.h - b.l)
      : Math.max(b.h - b.l, Math.abs(b.h - prevClose), Math.abs(b.l - prevClose));
    prevClose = b.c;
    if (atr === null) {
      sum += tr; cnt++;
      if (cnt >= len) { atr = sum / len; out[i] = atr; }
    } else {
      atr = (atr * (len - 1) + tr) / len;
      out[i] = atr;
    }
  }
  return out;
}

// Rebuilds a Renko series from the plain OHLC bars the feed sends. Bricks are
// emitted with contiguous indices (the time scale for a bar set is brick
// count, not time); each brick carries the timestamp of the base bar that
// completed it. Wicks are not modelled yet (cosmetic only).
class RenkoState {
  constructor(inputs) {
    this.inputs = inputs || {};
    this.baseByTime = new Map();
    this.order = [];
    this.bricks = [];
    this.emitted = 0;
    this.version = null;
    this.symbolKey = null;
    this.session = null;
  }

  reset() {
    this.baseByTime.clear();
    this.order = [];
    this.bricks = [];
    this.emitted = 0;
  }

  ingest(entries) {
    for (const e of entries) {
      if (!e || typeof e.i !== 'number' || Math.abs(e.i) >= SPECIAL_INDEX) continue;
      const v = e.v;
      if (!Array.isArray(v) || typeof v[0] !== 'number') continue;
      const t = v[0];
      if (!this.baseByTime.has(t)) this.order.push(t);
      this.baseByTime.set(t, { t, o: v[1], h: v[2], l: v[3], c: v[4], v: typeof v[5] === 'number' ? v[5] : 0 });
    }
    this.order.sort((a, b) => a - b);
  }

  baseBars() {
    const out = [];
    for (const t of this.order) { const b = this.baseByTime.get(t); if (b) out.push(b); }
    return out;
  }

  computeBricks() {
    const bars = this.baseBars();
    const inp = this.inputs || {};
    const style = String(inp.style || 'Traditional');
    const pct = Number(inp.percentageLTP) > 0 ? Number(inp.percentageLTP) : 1;
    const trad = Number(inp.boxSize) > 0 ? Number(inp.boxSize) : null;
    const atrLen = Number(inp.atrLength) > 0 ? Number(inp.atrLength) : 14;
    const atr = style === 'ATR' ? wilderAtr(bars, atrLen) : null;

    const bricks = [];
    let lastClose = null;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (lastClose === null) { lastClose = b.c; continue; }
      let box = null;
      if (style === 'ATR') box = atr ? atr[i] : null;
      else if (style === 'Percentage') box = lastClose * pct / 100;
      else box = trad;
      if (!(box > 0)) continue;

      const diff = b.c - lastClose;
      if (diff >= box) {
        const n = Math.floor(diff / box + 1e-9);
        for (let k = 1; k <= n; k++) {
          const o = lastClose + (k - 1) * box;
          const c = lastClose + k * box;
          bricks.push({ t: b.t, o, h: c, l: o, c, v: 0 });
        }
        lastClose += n * box;
        bricks[bricks.length - 1].v = b.v;
      } else if (diff <= -box) {
        const n = Math.floor(-diff / box + 1e-9);
        for (let k = 1; k <= n; k++) {
          const o = lastClose - (k - 1) * box;
          const c = lastClose - k * box;
          bricks.push({ t: b.t, o, h: o, l: c, c, v: 0 });
        }
        lastClose -= n * box;
        bricks[bricks.length - 1].v = b.v;
      }
    }
    this.bricks = bricks;
    return bricks;
  }
}

class TvAggregator {
  constructor(opts) {
    opts = opts || {};
    this.series = new Map();          // "<session>|<seriesKey>" -> SeriesState
    this.studyParent = new Map();     // "<session>|<studyId>" -> "<session>|<seriesKey>"
    // "<session>" -> { point, res, resSec, symbol } : Bar Replay sessions we
    // track so we can translate intraday replay_step into replay_reset.
    this.replay = new Map();
    // Intraday replay fast-forward: a reset response contains the bars up to
    // the reset point, so prefetch a block ahead, cache those bars in the
    // proxy (never forwarding the reload to the chart) and serve each Forward
    // as a one-bar `du` delta, exactly like the feed does natively for daily.
    this.activeReplay = null;
    this.prefetchSeq = 0;
    // "<session>|<seriesKey>" -> Map(time -> bar): every bar the feed has sent
    // for a series, including the window loaded before replay started. An
    // intraday replay point near the live edge is served straight from here, so
    // no extra (and unreliable) live-edge reload is needed.
    this.history = new Map();
    // "<session>|<seriesKey>" -> { upstream, count } : the resolution string
    // last requested from the upstream feed and the client's requested bar
    // count. Custom minutes all alias to the base resolution "1", so an
    // interval switch can resolve to the exact same upstream resolution and
    // look like a no-op to the feed (which then resends nothing and the chart
    // keeps the previous interval's candles). We compare against this to force
    // a real remove+create reload whenever the upstream resolution is unchanged.
    this.upstreamMeta = new Map();
    // Bar-set styles. `barsetSym` holds a `resolve_symbol` whose paid bar-set
    // wrapper is pending the resolution decision; `barset` holds the active
    // local brick series (Renko) keyed by "<session>|<seriesKey>".
    // `barsetArgs` remembers which symbol keys were resolved as a bar set, so
    // a later create/modify can engage/reset even without a fresh resolve and
    // tell an interval change from a switch back to candles (a plain symbol).
    this.barsetSym = new Map();
    this.barset = new Map();
    this.barsetArgs = new Map();
    // Symbol keys whose wrapper-stripped resolve has already been forwarded to
    // the current feed session (re-sending one is a `duplicate id` error).
    this.barsetResolved = new Set();
    this.barsetEnabled = !!opts.barsetRenko;
    this.debug = !!opts.debug;
    this.trace = !!opts.trace;
    this.logPath = opts.logPath || path.join(__dirname, 'proxy-debug.log');
    this.logStream = null;
    if (this.debug) this.logStream = fs.createWriteStream(this.logPath, { flags: 'a' });
  }

  log(line) {
    if (this.logStream) { try { this.logStream.write(line + '\n'); } catch { /* ignore */ } }
  }

  key(session, seriesKey) { return String(session) + '|' + String(seriesKey); }

  replayInfo(session) { return this.replay.get(session) || null; }

  setReplayPoint(session, point) {
    const st = this.replay.get(session);
    if (st) st.point = point;
  }

  // Next bar strictly after the session's current point and not later than
  // `maxTime` (the last completed bar), or null. Consults both the prefetched
  // block and the recorded series history.
  takeNextBar(session, maxTime) {
    const st = this.replay.get(session);
    if (!st || typeof st.point !== 'number') return null;
    let best = null;
    const consider = (t, entry) => {
      if (t > st.point && (maxTime === undefined || t <= maxTime) && (!best || t < best.t)) best = { t, entry };
    };
    if (st.cache) for (const [t, e] of st.cache) consider(t, e);
    const h = (st.dataSession && st.seriesKey) ? this.history.get(this.key(st.dataSession, st.seriesKey)) : null;
    if (h) for (const [t, e] of h) consider(t, e);
    return best ? best.entry : null;
  }

  // How many completed bars are ready ahead of the point (cache + history).
  availableAhead(session, maxTime) {
    const st = this.replay.get(session);
    if (!st || typeof st.point !== 'number') return 0;
    const seen = new Set();
    const add = (t) => { if (t > st.point && (maxTime === undefined || t <= maxTime)) seen.add(t); };
    if (st.cache) for (const t of st.cache.keys()) add(t);
    const h = (st.dataSession && st.seriesKey) ? this.history.get(this.key(st.dataSession, st.seriesKey)) : null;
    if (h) for (const t of h.keys()) add(t);
    return seen.size;
  }

  consumeBar(session, time) {
    const st = this.replay.get(session);
    if (st && st.cache) st.cache.delete(time);
  }

  // The client appends one bar at a time; keep its next absolute index.
  nextClientIndex(session) {
    const st = this.replay.get(session);
    if (!st) return 0;
    if (typeof st.clientIndex !== 'number') st.clientIndex = 299;
    st.clientIndex += 1;
    return st.clientIndex;
  }

  cacheSize(session) {
    const st = this.replay.get(session);
    return st && st.cache ? st.cache.size : 0;
  }

  isPrefetching(session) {
    const st = this.replay.get(session);
    return !!(st && st.prefetching);
  }

  // Drop any in-flight prefetch for this session. Used when the chart
  // reconfigures its series or selects a new point, so a stale reload reply can
  // never leave the session stuck in `prefetching` (which would swallow every
  // later chart update and freeze Forward/autoplay).
  abortPrefetch(session) {
    const st = this.replay.get(session);
    if (!st) return;
    st.prefetching = false;
    st.prefetch = null;
  }

  // Watchdog run on a timer. Releases a reset that has been held too long and
  // aborts a prefetch that never completed, returning any upstream message that
  // must be sent as a result.
  sweep(now) {
    const out = [];
    for (const [session, st] of this.replay) {
      if (st.pendingReset && now - (st.pendingReset.at || 0) > 1200) {
        const msg = st.pendingReset.msg;
        st.pendingReset = null;
        this.abortPrefetch(session);
        this.log('AGG release held reset session=' + session);
        if (msg) out.push({ up: msg });
      } else if (st.prefetching && st.prefetch && now - (st.prefetch.startedAt || 0) > 4000) {
        this.log('AGG prefetch timeout session=' + session);
        this.abortPrefetch(session);
      }
    }
    // A held bar-set resolve that never saw its series create/modify would
    // stall the symbol forever; release it raw after a short grace period.
    if (this.barsetEnabled) {
      for (const [k, bs] of this.barsetSym) {
        if (now - (bs.at || 0) > 800) {
          this.barsetSym.delete(k);
          this.log('AGG barset release orphan resolve ' + k);
          out.push({ up: bs.obj });
        }
      }
    }
    return out;
  }

  // A reset the chart asked for while a prefetch reload was in flight.
  takePendingReset(session) {
    const st = this.replay.get(session);
    if (!st || !st.pendingReset) return null;
    const msg = st.pendingReset.msg;
    st.pendingReset = null;
    return msg;
  }

  activeReplaySession() {
    return this.activeReplay && this.replay.has(this.activeReplay) ? this.activeReplay : null;
  }

  // Ask the feed for a block of bars ahead of the client's point. The reply is
  // captured into the cache and dropped, so the chart never sees the reload.
  beginPrefetch(session) {
    const st = this.replay.get(session);
    if (!st || !st.seriesKey || !(st.resSec > 0) || st.resSec >= 86400) return null;
    if (st.prefetching || typeof st.point !== 'number') return null;
    const now = Math.floor(Date.now() / 1000);
    // Near the live edge a reset to a future target is not answered with a
    // completed replay window; don't rely on it — the chart's own recorded
    // history already holds those bars.
    if ((now - st.resSec) - st.point < 60 * st.resSec) return null;
    // The feed replies to a reset with a ~300-bar window ending at the reset
    // point, so aim almost a full window ahead: the window then starts at or
    // just before the client's point and every following bar lands in the cache.
    let target = st.point + 295 * st.resSec;
    if (target > now) target = now - st.resSec;
    if (target <= st.point) return null;
    const turn = 'aggpf' + (this.prefetchSeq++);
    st.prefetch = { turn, target, ready: false, startedAt: Date.now() };
    st.prefetching = true;
    this.log('AGG prefetch start session=' + session + ' point=' + st.point + ' target=' + target);
    return { m: 'replay_reset', p: [session, turn, target] };
  }

  prefetchReady(session) {
    const st = this.replay.get(session);
    return !!(st && st.prefetch && st.prefetch.ready);
  }

  onClientMessage(obj) {
    if (!obj || !obj.m) return obj;
    const m = obj.m;
    const p = obj.p;
    if (!Array.isArray(p)) return obj;
    // A bar-set message may need a stripped `resolve_symbol` sent immediately
    // before the (forwarded) series message; the reset path fills this in.
    let barsetHead = null;

    if (this.trace && (m === 'create_series' || m === 'modify_series' || m === 'remove_series' || m === 'request_more_data' || m === 'create_study' || m === 'remove_study' || m === 'modify_study')) {
      this.log('TRACE C ' + m + ' ' + JSON.stringify(p).slice(0, 900));
    }
    // Temporary: capture the full request that carries a chart-style change.
    if (this.trace && m === 'resolve_symbol') {
      this.log('TRACE CSYM ' + JSON.stringify(p).slice(0, 600));
    }
    if (this.trace && m === 'chart_create_session') {
      this.log('TRACE CSESS ' + JSON.stringify(p).slice(0, 300));
    }
    if (this.trace && m.lastIndexOf('replay_', 0) === 0) {
      this.log('TRACE CREPLAY ' + m + ' ' + JSON.stringify(p).slice(0, 400));
    }

    // Bar-set styles: hold the symbol resolve so it can be re-sent without its
    // paid study wrapper once the create/modify tells us the resolution.
    if (this.barsetEnabled && m === 'resolve_symbol' && p.length >= 3) {
      const desc = parseSymbolDescriptor(p[2]);
      const kind = desc ? barSetKindOf(desc.type) : null;
      const k = this.key(p[0], p[1]);
      if (kind) {
        const info = { kind, inputs: (desc && desc.inputs) || {}, obj, at: Date.now() };
        this.barsetSym.set(k, info);
        this.barsetArgs.set(k, info);
        this.log('AGG barset hold resolve ' + p[1] + ' kind=' + kind +
          ' style=' + ((desc && desc.inputs && desc.inputs.style) || '?'));
        return null;
      }
      // A plain resolve supersedes any held one, and drops a bar-set series
      // that was bound to this symbol (e.g. the user switched back to candles).
      this.barsetSym.delete(k);
      for (const [bk, st] of this.barset) {
        if (st.session === p[0] && st.symbolKey === p[1]) {
          this.barset.delete(bk);
          this.log('AGG barset drop ' + bk);
        }
      }
    }

    // The chart reconfigures its own series on an interval/symbol change or when
    // entering replay; any prefetch in flight for that series is now stale.
    if ((m === 'create_series' || m === 'modify_series' || m === 'remove_series') && p.length >= 2) {
      const sid = this.activeReplay;
      const rst = sid ? this.replay.get(sid) : null;
      if (rst && rst.prefetching && rst.dataSession && p[0] === rst.dataSession) {
        this.log('AGG prefetch abort: series reconfigured ' + p[0] + '|' + p[1]);
        this.abortPrefetch(sid);
      }
    }

    if ((m === 'create_series' || m === 'modify_series') && p.length >= 5) {
      const session = p[0];
      const seriesKey = p[1];
      const version = p[2];
      const requested = p[4];
      const r = parseResolution(requested);

      // --- Bar-set synthesis (Renko) -------------------------------------
      // `barsetArgs` remembers every symbol key the client ever resolved as a
      // bar set, so re-selecting the style (which reuses the same symbol key
      // without a fresh resolve) still engages the synthesizer.
      const barsetK = this.key(session, seriesKey);
      const symK = this.key(session, p[3]);
      const bsArgs = this.barsetEnabled ? this.barsetArgs.get(symK) : null;
      if (bsArgs) {
        this.barsetSym.delete(symK);
        const active = this.barset.get(barsetK);
        if (active) {
          // Interval change: rebuild from the newly fetched base bars.
          active.inputs = bsArgs.inputs;
          active.reset();
          this.log('AGG barset reset (interval change) ' + seriesKey + ' res=' + requested);
          // The client sometimes switches to a fresh bar-set symbol key on
          // the same series; the modify below references it, so resolve it
          // first if it has not gone out yet in this session.
          if (!this.barsetResolved.has(symK)) {
            barsetHead = stripBarSetWrapper(bsArgs.obj);
            this.barsetResolved.add(symK);
          }
        } else {
          const bst = new RenkoState(bsArgs.inputs);
          bst.version = version;
          bst.symbolKey = p[3];
          bst.session = session;
          this.barset.set(barsetK, bst);
          this.series.delete(barsetK);
          this.log('AGG barset engage ' + seriesKey + ' v=' + version + ' kind=' + bsArgs.kind +
            ' res=' + requested + ' style=' + ((bsArgs.inputs && bsArgs.inputs.style) || '?'));
          const deep = 3000;
          this.upstreamMeta.set(barsetK, { upstream: String(requested), count: deep, custom: false });
          const tf = typeof p[6] === 'string' ? p[6] : '';
          const msgs = [];
          // The feed rejects a symbol resolved twice in one session. The paid
          // bar-set wrapper is never forwarded: the symbol is resolved once as
          // a plain OHLC series and reused for every timeframe, so a later
          // interval change must not re-resolve it.
          if (!this.barsetResolved.has(symK)) {
            msgs.push(stripBarSetWrapper(bsArgs.obj));
            this.barsetResolved.add(symK);
          }
          if (m === 'create_series') {
            msgs.push({ m: 'create_series', p: [session, seriesKey, version, p[3], requested, deep, tf] });
          } else {
            msgs.push({ m: 'remove_series', p: [session, seriesKey] });
            msgs.push({ m: 'create_series', p: [session, seriesKey, version, p[3], requested, deep, tf] });
          }
          return msgs;
        }
      } else if (this.barsetEnabled && this.barset.has(barsetK)) {
        // Switched back to a plain style: drop the bricks so the feed's own
        // OHLC flows through untouched.
        this.barset.delete(barsetK);
        this.log('AGG barset drop ' + barsetK + ' (plain series)');
      }

      const plan = planFor(r);
      const k = this.key(session, seriesKey);
      const desired = plan ? plan.base : String(r ? r.raw : requested);
      const mult = plan ? plan.mult : 1;

      const prevMeta = this.upstreamMeta.get(k);
      // Prefer the count the client sent on create; otherwise reuse the count
      // remembered for this series (modify_series carries no count).
      let baseCount = 300;
      if (m === 'create_series' && typeof p[5] === 'number' && p[5] > 0) baseCount = p[5];
      else if (prevMeta && prevMeta.count) baseCount = prevMeta.count;
      // The upstream resolution is unchanged, so the feed will treat this as a
      // no-op: force a genuine remove+create reload. Only needed when at least
      // one side is a custom interval that aliases onto the same base; a
      // native->native repeat (e.g. same resolution, new symbol) is handled by
      // the feed itself.
      const forceReload = m === 'modify_series' && !!prevMeta && prevMeta.upstream === desired &&
        (prevMeta.custom || !!plan);
      this.upstreamMeta.set(k, { upstream: desired, count: baseCount, custom: !!plan });

      if (plan) {
        const prev = this.series.get(k);
        const intervalChanged = !!prev && !sameResolution(prev.requested, r);
        if (!prev || prev.version !== version || intervalChanged) {
          const st = new SeriesState(plan);
          st.version = version;
          st.requested = r;
          st.symbolKey = p[3];
          this.series.set(k, st);
          this.log('AGG rewrite ' + seriesKey + ' v=' + version + ' ' + requested + ' -> base ' + plan.base + ' x' + plan.mult);
        } else {
          prev.plan = plan;
        }
      } else {
        if (this.series.delete(k)) this.log('AGG state-drop ' + seriesKey + ' requested=' + requested);
      }

      if (forceReload) {
        const count = baseCount * mult;
        this.log('AGG force-reload ' + seriesKey + ' v=' + version + ' ' + requested + ' -> ' + desired + ' via remove+create count=' + count);
        const repl = [
          { m: 'remove_series', p: [session, seriesKey] },
          { m: 'create_series', p: [session, seriesKey, version, p[3], desired, count, p[5]] },
        ];
        return barsetHead ? [barsetHead].concat(repl) : repl;
      }

      p[4] = desired;
      // create_series has [.., resolution, count, timeframe]; ask for enough
      // base bars to build the same number of aggregated bars.
      if (m === 'create_series' && typeof p[5] === 'number' && p[5] > 0) {
        p[5] = p[5] * mult;
      }
      // Client-side bar sets (Renko / Kagi / Point & figure / Line break) are
      // rebuilt from these base bars, so a 300-bar window only yields a handful
      // of bricks. Ask the feed for a deeper intraday window instead; the chart
      // still only renders the visible part of it.
      if (m === 'create_series' && !plan && r && r.periodSec > 0 &&
          r.periodSec < 86400 && typeof p[5] === 'number' && p[5] > 0 &&
          p[5] < 1200) {
        p[5] = 1200;
        this.upstreamMeta.set(k, { upstream: desired, count: p[5], custom: false });
      }
    }

    // create_study: [session, studyId, turnaround, parentSeriesKey, script, inputs]
    if (m === 'create_study' && p.length >= 4) {
      this.studyParent.set(this.key(p[0], p[1]), this.key(p[0], p[3]));
    }
    if (m === 'remove_study' && p.length >= 2) {
      this.studyParent.delete(this.key(p[0], p[1]));
    }

    // request_more_data: [session, seriesKey, count]
    if (m === 'request_more_data' && p.length >= 3) {
      const st = this.series.get(this.key(p[0], p[1]));
      if (st && typeof p[2] === 'number' && p[2] > 0) p[2] = p[2] * st.plan.mult;
    }

    // --- Bar Replay -------------------------------------------------------
    // The free feed's replay backend refuses to *register* intraday series
    // (`replay_error: intraday_not_permitted`), so the client's replay manager
    // never gets a data reference and cannot step. However the feed still
    // honours `replay_reset` for intraday: it moves the replay point and trims
    // the chart's own series to it. So advance intraday replay by turning each
    // `replay_step` into a `replay_reset` at the advanced point, reusing the
    // client's turnaround so the feed's `replay_ok`/`replay_point` replies
    // resolve the pending step.
    if (m === 'replay_create_session') {
      if (this.replay.size > 500) this.replay.clear();
      this.replay.set(p[0], {
        point: null, res: null, resSec: 0, symbol: null,
        seriesKey: null, dataSession: null, clientIndex: null,
        cache: new Map(), prefetch: null, prefetching: false, pendingReset: null,
      });
    } else if (m === 'replay_delete_session') {
      this.abortPrefetch(p[0]);
      this.replay.delete(p[0]);
      if (this.activeReplay === p[0]) this.activeReplay = null;
    } else if (m === 'replay_add_series' && p.length >= 4) {
      const st = this.replay.get(p[0]) || {};
      const r = parseResolution(p[3]);
      if (r) { st.res = p[3]; st.resSec = r.periodSec; }
      st.symbol = p[2];
      if (st.resSec > 0 && st.resSec < 86400) {
        this.activeReplay = p[0];
        st.cache = new Map();
        st.prefetch = null;
        st.prefetching = false;
        st.pendingReset = null;
      } else if (this.activeReplay === p[0]) {
        // Replaying daily/weekly/monthly: the feed handles those natively, so
        // stop treating this session as an intraday one we drive locally.
        this.activeReplay = null;
        this.abortPrefetch(p[0]);
      }
      this.replay.set(p[0], st);
    } else if ((m === 'replay_get_depth' || m === 'replay_remove_series') && p.length >= 4) {
      // The client batches depth queries for every timing mode; only the first
      // entry is the resolution the chart is actually replaying in, so keep the
      // first one we see unless replay_add_series already named one.
      const st = this.replay.get(p[0]) || {};
      if (!st.res) { const r = parseResolution(p[3]); if (r) { st.res = p[3]; st.resSec = r.periodSec; } }
      st.symbol = st.symbol || p[2];
      this.replay.set(p[0], st);
    } else if (m === 'replay_reset' && p.length >= 3) {
      const st = this.replay.get(p[0]) || {};
      st.point = p[2];
      // A reset reloads the series; drop any prefetched block and start over.
      if (st.cache) st.cache.clear();
      st.prefetch = null;
      if (st.prefetching) {
        // A background prefetch reload is in flight. Forwarding this reset now
        // would interleave two reloads; hold it and replay it once the
        // prefetch completes (or when the watchdog releases it).
        st.pendingReset = {
          at: Date.now(),
          msg: { m: 'replay_reset', p: [p[0], p[1], p[2]] },
        };
        this.replay.set(p[0], st);
        return null;
      }
      st.prefetching = false;
      this.replay.set(p[0], st);
    } else if (m === 'replay_step' && p.length >= 3) {
      const st = this.replay.get(p[0]);
      const now = Math.floor(Date.now() / 1000);
      if (st && st.resSec > 0 && st.resSec < 86400 && typeof st.point === 'number' &&
          typeof p[2] === 'number') {
        const nextPoint = st.point + p[2] * st.resSec;
        if (nextPoint <= now) {
          st.point = nextPoint;
          this.log('AGG replay_step->reset session=' + p[0] + ' count=' + p[2] +
            ' res=' + st.res + ' newPoint=' + nextPoint);
          return { m: 'replay_reset', p: [p[0], p[1], nextPoint] };
        }
        // At/after "now": no future bars exist, so leave the step to the feed,
        // which refuses it and is converted to a harmless replay_ok.
        this.log('AGG replay_step at end-of-data session=' + p[0] + ' nextPoint=' + nextPoint + ' now=' + now);
      }
    }

    return barsetHead ? [barsetHead, obj] : obj;
  }

  onServerMessage(obj) {
    if (!obj || !obj.m) return [obj];
    const m = obj.m;
    const p = obj.p;
    if (!Array.isArray(p)) return [obj];

    if (this.trace && m.lastIndexOf('replay_', 0) === 0) {
      this.log('TRACE SRVREPLAY ' + m + ' ' + JSON.stringify(p).slice(0, 400));
    }
    if (this.trace && /study|error|critical|permission|access/i.test(m)) {
      this.log('TRACE SRVSTUDY ' + m + ' ' + JSON.stringify(p).slice(0, 900));
    }

    // While a prefetch is in flight, the feed's replay replies and the replay
    // series reload belong to the prefetch, not to the chart: capture the bars
    // and swallow the messages.
    const prefetchState = () => {
      const sid = this.activeReplay;
      const st = sid ? this.replay.get(sid) : null;
      return st && st.prefetching ? st : null;
    };

    if (m === 'replay_point') {
      const st = this.replay.get(p[0]);
      if (st) {
        if (st.prefetching) return [];
        // For an intraday replay we drive ourselves, only the confirmation of
        // the client's own selection may pass. The feed also reports the point
        // it parked at for the background prefetch; forwarding that would yank
        // the chart to the live edge.
        if (st.resSec > 0 && st.resSec < 86400 && typeof st.point === 'number' &&
            Math.abs(p[1] - st.point) > st.resSec) {
          this.log('AGG drop stray replay_point session=' + p[0] + ' feed=' + p[1] + ' ours=' + st.point);
          return [];
        }
        st.point = p[1];
      }
      return [obj];
    }

    if (m === 'replay_ok' || m === 'replay_error') {
      const st = this.replay.get(p[0]);
      if (st && st.prefetching && st.prefetch && p[1] === st.prefetch.turn) {
        if (m === 'replay_error') {
          this.log('AGG prefetch failed reason=' + p[2]);
          st.prefetching = false;
          st.prefetch = null;
        }
        return [];
      }
    }

    // Resolutions belong to the load we are shadowing, not to the chart.
    if (m === 'replay_resolutions') {
      if (prefetchState()) return [];
    }

    // End of data. For an intraday replay we drive locally, the feed reports
    // end-of-data as soon as a prefetch reset parks its own point at the live
    // edge, which has nothing to do with the chart's point. Forwarding it made
    // the client stop replay and jump back to realtime. Swallow it for tracked
    // intraday sessions; the proxy synthesizes one only when the local cache
    // truly reaches the live edge. Daily+ keeps the feed's native signal.
    if (m === 'replay_data_end') {
      const st = this.replay.get(p[0]);
      if (st && st.resSec > 0 && st.resSec < 86400) {
        this.log('AGG drop replay_data_end session=' + p[0]);
        return [];
      }
    }

    // The free feed's replay backend gates intraday series with
    // `replay_error: intraday_not_permitted`, so the client's replay manager
    // never obtains a data reference and cannot step forward. The feed still
    // trims the chart's own series to the replay point, so report the add as
    // accepted and let reset/step drive the trims.
    if (m === 'replay_error' && p[2] === 'intraday_not_permitted') {
      this.log('AGG convert replay_error intraday_not_permitted -> replay_ok turn=' + p[1]);
      return [{ m: 'replay_ok', p: [p[0], p[1]] }];
    }

    if (m === 'series_error') {
      const seriesKey = p[1];
      const reason = p[3];
      // Only swallow the refusal for a resolution we actually re-served (a
      // custom minute interval). Seconds/ticks and anything else must reach the
      // client so its normal plan-restricted fallback can revert the interval;
      // swallowing those would leave the chart waiting on data forever.
      let owned = false;
      for (const k of this.series.keys()) { if (k.endsWith('|' + seriesKey)) { owned = true; break; } }
      this.log('SRV series_error ' + seriesKey + ' reason=' + reason + ' owned=' + owned);
      if (owned && (reason === 'custom_resolution' || reason === 'resolution_not_entitled')) {
        this.log('AGG suppress series_error ' + seriesKey + ' reason=' + reason);
        return [];
      }
      return [obj];
    }
    if (m === 'series_loading' && p.length >= 3) {
      const st = prefetchState();
      if (st && p[1] === st.seriesKey) return [];
      const sid = this.activeReplay;
      const active = sid ? this.replay.get(sid) : null;
      if (active && (!active.seriesKey || p[1] === active.seriesKey)) active.dataSession = p[0];
      this.log('SRV series_loading ' + p[1] + ' v=' + p[2]);
      return [obj];
    }
    if (m === 'series_completed') {
      this.log('SRV series_completed ' + p[1] + ' v=' + p[2]);
      // A prefetch reply may complete as `replay` or, when its target reached
      // the live edge and the feed keeps streaming, as `streaming`. Both end the
      // prefetch; anything else would leave the session stuck swallowing every
      // later chart update.
      const pf = prefetchState();
      if (pf && p[1] === pf.seriesKey) {
        pf.prefetching = false;
        if (pf.prefetch) pf.prefetch.ready = true;
        this.log('AGG prefetch complete series=' + p[1] + ' cached=' + pf.cache.size + ' v=' + p[2]);
        return [];
      }
      if (p[2] === 'replay') {
        // Learn the replay series key + data session from the feed's own reply.
        const sid = this.activeReplay;
        const active = sid ? this.replay.get(sid) : null;
        if (active) { active.seriesKey = p[1]; active.dataSession = p[0]; }
      }
      return [obj];
    }

    // --- Bar-set synthesis (Renko): rewrite the plain OHLC series as bricks.
    if (this.barsetEnabled && (m === 'timescale_update' || m === 'du') && p.length >= 2) {
      const bsSession = p[0];
      const bsObjects = p[1];
      let bsTouched = false;
      const bsSynth = [];
      if (bsObjects && typeof bsObjects === 'object') {
        for (const bkey of Object.keys(bsObjects)) {
          const bst = this.barset.get(this.key(bsSession, bkey));
          if (!bst) continue;
          bsTouched = true;
          const bnode = bsObjects[bkey];
          if (bnode && Array.isArray(bnode.s)) bst.ingest(bnode.s);
          const all = bst.computeBricks();
          if (m === 'timescale_update') {
            if (bnode && typeof bnode === 'object') {
              bnode.s = all.map((b, i) => ({ i, v: [b.t, b.o, b.h, b.l, b.c, b.v] }));
              if (Array.isArray(bnode.st)) bnode.st = [];
            }
            if (p[2] && typeof p[2] === 'object') {
              const cs = p[2];
              cs.index = 0;
              cs.zoffset = 0;
              cs.changes = all.map((b) => b.t);
              cs.marks = barsetMarks(all, 0);
              delete cs.index_diff;
              delete cs.last_session_switches;
            }
            this.log('AGG barset timescale ' + bkey + ' base=' + bst.baseByTime.size + ' bricks=' + all.length);
            bst.emitted = all.length;
          } else {
            const fresh = all.slice(bst.emitted);
            delete bsObjects[bkey];
            if (fresh.length) {
              bsSynth.push({
                m: 'timescale_update',
                p: [
                  bsSession,
                  { [bkey]: { s: fresh.map((b, j) => ({ i: bst.emitted + j, v: [b.t, b.o, b.h, b.l, b.c, b.v] })) } },
                  { index: bst.emitted, zoffset: 0, changes: fresh.map((b) => b.t), marks: barsetMarks(fresh, bst.emitted) },
                ],
              });
              this.log('AGG barset du +' + fresh.length + ' ' + bkey + ' total=' + all.length);
            }
            bst.emitted = all.length;
          }
        }
      }
      if (bsTouched) {
        if (m === 'du') return bsSynth;
        return [obj];
      }
    }

    if ((m === 'timescale_update' || m === 'du') && p.length >= 2) {
      const session = p[0];
      const objects = p[1];
      if (this.trace && objects && typeof objects === 'object') {
        for (const key of Object.keys(objects)) {
          const n = objects[key];
          if (n && Array.isArray(n.s) && n.s.length) {
            this.log('TRACE RAW ' + m + ' s ' + key + ' n=' + n.s.length + ' idx=' + n.s[0].i + '..' + n.s[n.s.length - 1].i + ' t=' + n.s[0].v[0] + '..' + n.s[n.s.length - 1].v[0] + ' close=' + n.s[n.s.length - 1].v[4]);
          }
        }
        if (m === 'timescale_update' && p[2]) {
          const cs = p[2];
          this.log('TRACE CS-before index=' + cs.index + ' zoffset=' + cs.zoffset + ' changes=' + ((cs.changes || []).length) + ' keys=' + Object.keys(objects).join(',') + ' head=' + JSON.stringify((cs.changes || []).slice(0, 3)) + ' tail=' + JSON.stringify((cs.changes || []).slice(-3)));
        }
      }
      if (objects && typeof objects === 'object') {
        for (const key of Object.keys(objects)) {
          const node = objects[key];
          if (!node || typeof node !== 'object') continue;
          let st = this.series.get(this.key(session, key));
          if (!st) {
            const parent = this.studyParent.get(this.key(session, key));
            if (parent) st = this.series.get(parent);
          }
          if (!st) continue;
          if (Array.isArray(node.s)) node.s = this.aggregateSeries(node.s, st);
          if (Array.isArray(node.st)) node.st = this.aggregateStudies(node.st, st);
          if (this.trace && Array.isArray(node.s) && node.s.length && node.s[0].i >= 0) {
            this.log('TRACE AGG ' + m + ' s ' + key + ' n=' + node.s.length + ' idx=' + node.s[0].i + '..' + node.s[node.s.length - 1].i + ' t=' + node.s[0].v[0] + '..' + node.s[node.s.length - 1].v[0] + ' lastClose=' + node.s[node.s.length - 1].v[4] + ' lastHigh=' + node.s[node.s.length - 1].v[2] + ' lastLow=' + node.s[node.s.length - 1].v[3]);
          }
        }
      }
      // Record every bar the feed sends, per series. A chart loads its recent
      // window before replay starts, so an intraday replay point near the live
      // edge can be stepped straight from this history instead of an extra
      // reload (which the feed may never complete at the edge).
      if (objects && typeof objects === 'object') {
        for (const key of Object.keys(objects)) {
          const node = objects[key];
          if (!node || !Array.isArray(node.s) || !node.s.length) continue;
          const hk = this.key(session, key);
          let h = this.history.get(hk);
          if (!h) { h = new Map(); this.history.set(hk, h); }
          for (const e of node.s) {
            if (e && Array.isArray(e.v) && typeof e.v[0] === 'number') h.set(e.v[0], e);
          }
          if (h.size > 8000) {
            const times = Array.from(h.keys()).sort((a, b) => a - b);
            for (let i = 0; i < times.length - 5000; i++) h.delete(times[i]);
          }
        }
      }
      // Track the replay series and cache prefetched bars. Prefetch replies are
      // dropped so the chart never sees the background reload. Match on the
      // chart session too: different charts reuse the same series-key names, and
      // a stray update from another chart must never feed this cache.
      const sid = this.activeReplay;
      const rst = sid ? this.replay.get(sid) : null;
      if (rst && rst.seriesKey && objects && typeof objects === 'object' &&
          (!rst.dataSession || session === rst.dataSession)) {
        const node = objects[rst.seriesKey];
        if (node && Array.isArray(node.s)) {
          if (rst.prefetching) {
            rst.dataSession = rst.dataSession || p[0];
            const lastClosed = Math.floor(Date.now() / 1000) - rst.resSec;
            let added = 0;
            for (const e of node.s) {
              if (!e || !Array.isArray(e.v)) continue;
              if (e.v[0] > rst.point && e.v[0] <= lastClosed) { rst.cache.set(e.v[0], e); added++; }
            }
            this.log('AGG prefetch cache +' + added + ' total=' + rst.cache.size + ' m=' + m);
            return [];
          }
          rst.dataSession = p[0];
          const last = node.s[node.s.length - 1];
          if (last && typeof last.i === 'number' && Array.isArray(last.v) &&
              last.v[0] <= rst.point + rst.resSec) {
            rst.clientIndex = last.i;
          }
        }
      }
      if (m === 'timescale_update' && p[2] && typeof p[2] === 'object') {
        this.transformChangeset(p[2], session, objects);
        if (this.trace) {
          const cs = p[2];
          this.log('TRACE CS-after index=' + cs.index + ' zoffset=' + cs.zoffset + ' changes=' + ((cs.changes || []).length) + ' head=' + JSON.stringify((cs.changes || []).slice(0, 3)) + ' tail=' + JSON.stringify((cs.changes || []).slice(-3)));
        }
      }
      // While an intraday replay is active the chart's series is trimmed to the
      // replay point and advanced by our own synthesized `du` deltas. Live `du`
      // bars for that series from the feed must not bleed in and drag the chart
      // to realtime.
      if (m === 'du') {
        const sid = this.activeReplay;
        const rst = sid ? this.replay.get(sid) : null;
        if (rst && rst.resSec > 0 && rst.resSec < 86400 && rst.seriesKey &&
            (!rst.dataSession || session === rst.dataSession) &&
            objects && typeof objects === 'object' && objects[rst.seriesKey]) {
          delete objects[rst.seriesKey];
          if (!Object.keys(objects).length) return [];
        }
      }
      return [obj];
    }

    return [obj];
  }

  // Fold a batch of base bars into aggregate groups. Several base bars share
  // one group (e.g. base 2g and 2g+1 -> group g for a 2x interval), so the
  // batch must be emitted exactly once per group, using the fully folded
  // aggregate. Emitting one row per *base* bar duplicated every bar and drew
  // each custom candle twice (a partial first sub-bar plus the complete bar).
  aggregateSeries(entries, st) {
    const groups = new Map();
    const passthrough = [];
    let folded = false;
    for (const e of entries) {
      if (!e || !Array.isArray(e.v) || typeof e.i !== 'number' || Math.abs(e.i) >= SPECIAL_INDEX) {
        passthrough.push(e);
        continue;
      }
      folded = true;
      const bar = st.addSeries(e.i, e.v);
      groups.set(bar.i, bar);
    }
    if (!folded) return entries;
    const out = Array.from(groups.keys()).sort((a, b) => a - b).map((g) => groups.get(g));
    return out.concat(passthrough);
  }

  aggregateStudies(entries, st) {
    const groups = new Map();
    const passthrough = [];
    let folded = false;
    for (const e of entries) {
      if (!e || !Array.isArray(e.v) || typeof e.i !== 'number' || Math.abs(e.i) >= SPECIAL_INDEX) {
        passthrough.push(e);
        continue;
      }
      folded = true;
      const plot = st.addStudy(e.i, e.v);
      groups.set(plot.i, plot);
    }
    if (!folded) return entries;
    const out = Array.from(groups.keys()).sort((a, b) => a - b).map((g) => groups.get(g));
    return out.concat(passthrough);
  }

  // Find the custom-resolution state that owns this timescale update.
  primaryState(session, objects) {
    if (objects && typeof objects === 'object') {
      for (const key of Object.keys(objects)) {
        const st = this.series.get(this.key(session, key));
        if (st) return st;
      }
    }
    for (const [k, st] of this.series) {
      if (k.startsWith(String(session) + '|')) return st;
    }
    return null;
  }

  // Server tick marks arrive for the base resolution: one per base bar for the
  // finest span (minutes) plus coarser ones (5m/15m/30m/1h/day...). Dividing
  // the index by `mult` makes several of them land on the same aggregated bar,
  // and the client keeps only the first one it sees (usually the finest span),
  // so the axis loses every usable coarse label. Keep the coarsest span per
  // bar instead, which is the one the axis would pick anyway.
  compressMarks(cs, mult) {
    if (!Array.isArray(cs.marks)) return;
    const best = new Map();
    const passthrough = [];
    for (const mk of cs.marks) {
      if (!Array.isArray(mk) || mk.length < 3 || typeof mk[2] !== 'number' || Math.abs(mk[2]) >= SPECIAL_INDEX) {
        passthrough.push(mk);
        continue;
      }
      const gi = Math.floor(mk[2] / mult);
      const prev = best.get(gi);
      if (!prev || mk[0] > prev[0]) best.set(gi, [mk[0], mk[1], gi]);
    }
    cs.marks = Array.from(best.values()).concat(passthrough);
  }

  transformChangeset(cs, session, objects) {
    const st = this.primaryState(session, objects);
    if (!st) return;

    const mult = st.plan.mult;
    if (mult > 1) this.compressMarks(cs, mult);

    const changes = cs.changes;
    if (!Array.isArray(changes) || changes.length === 0) return;
    if (typeof cs.index !== 'number') return;

    const B0 = cs.index;
    const Blast = B0 + changes.length - 1;
    const g0 = Math.floor(B0 / mult);
    const g1 = Math.floor(Blast / mult);

    if (g0 === B0 && mult === 1) return;

    const out = [];
    for (let g = g0; g <= g1; g++) {
      const t = st.groupTime(g);
      if (t !== null) {
        out.push(t);
      } else {
        // Empty group (no bar): fall back to the closest base time.
        let b = g * mult;
        if (b < B0) b = B0;
        if (b > Blast) b = Blast;
        out.push(changes[b - B0]);
      }
    }

    cs.index = g0;
    cs.zoffset = Math.ceil((typeof cs.zoffset === 'number' ? cs.zoffset : 0) / mult);
    cs.changes = out;

    // Marks were already compressed above (see compressMarks).

    // index_diff: [[oldIndex, newIndex], ...]
    if (Array.isArray(cs.index_diff)) {
      for (const pair of cs.index_diff) {
        if (!Array.isArray(pair)) continue;
        for (let j = 0; j < pair.length; j++) {
          if (typeof pair[j] === 'number' && Math.abs(pair[j]) < SPECIAL_INDEX) {
            pair[j] = Math.floor(pair[j] / mult);
          }
        }
      }
    }

    // last_session_switches: {seriesKey: {market: index}}
    if (cs.last_session_switches && typeof cs.last_session_switches === 'object') {
      for (const key of Object.keys(cs.last_session_switches)) {
        const st2 = this.series.get(this.key(session, key));
        if (!st2) continue;
        const sw = cs.last_session_switches[key];
        if (sw && typeof sw === 'object' && typeof sw.market === 'number' && Math.abs(sw.market) < SPECIAL_INDEX) {
          sw.market = Math.floor(sw.market / mult);
        }
      }
    }
  }
}

module.exports = {
  TvAggregator,
  RenkoState,
  parseResolution,
  isStandard,
  planFor,
  SeriesState,
  STANDARD_MINUTES,
  STANDARD_SECONDS,
};