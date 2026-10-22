import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const STRICT = "严格内包";
const INCLUSIVE = "含边界内包";
const OFF = "关闭";

function isStrictPivot(values, index, left, right, type) {
  if (index < left || index + right >= values.length) return false;
  const pivot = values[index];
  const before = values.slice(index - left, index);
  const after = values.slice(index + 1, index + right + 1);
  return type === 1
    ? before.every((value) => pivot > value) && after.every((value) => pivot > value)
    : before.every((value) => pivot < value) && after.every((value) => pivot < value);
}

function addPoint(points, point, containmentMode) {
  const last = points.at(-1);
  if (last?.type === point.type) {
    const moreExtreme = point.type === 1 ? point.price > last.price : point.price < last.price;
    if (moreExtreme) points[points.length - 1] = point;
    return;
  }

  points.push(point);
  if (containmentMode === OFF || points.length < 4) return;

  const [outerFirst, outerSecond, innerFirst, innerSecond] = points.slice(-4);
  const sameDirection = outerFirst.type === innerFirst.type && outerSecond.type === innerSecond.type;
  const outerHigh = Math.max(outerFirst.price, outerSecond.price);
  const outerLow = Math.min(outerFirst.price, outerSecond.price);
  const innerHigh = Math.max(innerFirst.price, innerSecond.price);
  const innerLow = Math.min(innerFirst.price, innerSecond.price);
  const inside = containmentMode === STRICT
    ? innerHigh < outerHigh && innerLow > outerLow
    : innerHigh <= outerHigh && innerLow >= outerLow;

  if (sameDirection && inside) points.splice(-2);
}

function normalize(points, containmentMode) {
  const result = [];
  for (const point of points) addPoint(result, point, containmentMode);
  return result;
}

function recordMidPoint(points, point) {
  const position = points.findIndex((current) => current.time >= point.time);
  const insertAt = position === -1 ? points.length : position;
  const existing = points[insertAt];

  if (!existing || existing.time !== point.time) {
    points.splice(insertAt, 0, point);
  } else if (existing.type === point.type) {
    const moreExtreme = point.type === 1 ? point.price > existing.price : point.price < existing.price;
    if (moreExtreme) points[insertAt] = point;
  }
}

function resolveEvents({ midHigh, midLow, recoveryUp, recoveryDown, automatic = true }) {
  const upwardBreak = midLow || recoveryUp;
  const downwardBreak = midHigh || recoveryDown;
  const conflict = automatic && upwardBreak && downwardBreak;
  return {
    conflict,
    midHigh: midHigh && !conflict,
    midLow: midLow && !conflict,
    recoveryUp: recoveryUp && !midLow && !conflict,
    recoveryDown: recoveryDown && !midHigh && !conflict,
    direction: conflict ? 0 : upwardBreak ? 1 : downwardBreak ? -1 : 0,
  };
}

function structureSide(points) {
  const highs = points.filter((point) => point.type === 1).slice(-2);
  const lows = points.filter((point) => point.type === -1).slice(-2);
  if (highs.length < 2 || lows.length < 2) return 0;
  if (highs[1].price > highs[0].price && lows[1].price > lows[0].price) return 1;
  if (highs[1].price < highs[0].price && lows[1].price < lows[0].price) return -1;
  return 0;
}

function recentAlignedSwing(points, side) {
  for (let i = points.length - 2; i >= Math.max(0, points.length - 3); i--) {
    if (points[i].type === -side && points[i + 1].type === side) return [points[i], points[i + 1]];
  }
  return null;
}

function setupLevels(start, end, near, far) {
  const prices = [near, far].map((ratio) => end + (start - end) * ratio);
  return [Math.min(...prices), Math.max(...prices)];
}

function setupEvents(bars, { side, start, end, confirmedAt, shortPoint, shortPointTime, swingEndTime, confirmationBars = 3, maxSetupBars = 60, retireAfterMissedTouch = true }) {
  const [bottom, top] = setupLevels(start, end, 0.5, 0.618);
  let sweptAt = -1;
  let touched = false;
  const signals = [];
  for (let i = confirmedAt + 1; i < bars.length; i++) {
    if (i - confirmedAt > maxSetupBars) break;
    const bar = bars[i];
    const previous = bars[i - 1];
    if (side === 1 ? bar.low <= start : bar.high >= start) break;
    if (sweptAt >= 0 && i - sweptAt > confirmationBars) sweptAt = -1;
    const range = bar.high - bar.low;
    const trend = range > 0 && (side === 1
      ? bar.close > bar.open && bar.close > previous.close && (bar.close - bar.open) / range >= 0.5 && (bar.close - bar.low) / range >= 0.7
      : bar.close < bar.open && bar.close < previous.close && (bar.open - bar.close) / range >= 0.5 && (bar.high - bar.close) / range >= 0.7);
    if (sweptAt >= 0 && i > sweptAt && trend) {
      signals.push(i);
      break;
    }
    const touchesZone = bar.high >= bottom && bar.low <= top;
    if (touchesZone) touched = true;
    const sweep = side === 1
      ? bar.low < shortPoint && bar.close > shortPoint
      : bar.high > shortPoint && bar.close < shortPoint;
    if (touchesZone && shortPointTime > swingEndTime && sweep) sweptAt = i;
    if (retireAfterMissedTouch && touched && sweptAt < 0 && (side === 1 ? bar.close > top : bar.close < bottom)) break;
  }
  return signals;
}

function candidateZoneExpired(zone, bar, index, { obMode = "收盘价", fvgMode = "完全回补", maxZoneBars = 60, oppositeBreak = false } = {}) {
  const crossed = zone.kind === "FVG"
    ? zone.side === 1
      ? bar.low <= (fvgMode === "首次触及" ? zone.top : zone.bottom)
      : bar.high >= (fvgMode === "首次触及" ? zone.bottom : zone.top)
    : zone.side === 1
      ? (obMode === "影线" ? bar.low <= zone.bottom : bar.close < zone.bottom)
      : (obMode === "影线" ? bar.high >= zone.top : bar.close > zone.top);
  return crossed || oppositeBreak || index - zone.born > maxZoneBars;
}

function visibleBreakZone(zone, setup, overlapOnly = true) {
  return !overlapOnly || (setup.active && zone.side === setup.side && zone.top >= setup.bottom && zone.bottom <= setup.top);
}

function advanceObservation(state, { eventSide = 0, anchor, low, high, strictSide = 0, conflict = false, mode = 0 }) {
  state = { ...state };
  if (conflict) {
    state.bias = 0;
    state.invalidated = true;
  } else if (eventSide) {
    state.bias = mode && mode !== eventSide ? 0 : eventSide;
    state.anchor = anchor;
    state.invalidated = state.bias === 0;
  }
  if (state.bias && (state.bias === 1 ? low <= state.anchor : high >= state.anchor)) {
    state.bias = 0;
    state.invalidated = true;
  }
  const confirmed = strictSide !== 0 && !state.invalidated && (!state.bias || state.bias === strictSide);
  return { ...state, side: confirmed ? strictSide : state.bias, confirmed };
}

let direction = advanceObservation({ bias: 0, invalidated: false }, { eventSide: 1, anchor: 100, low: 105, high: 115 });
assert.equal(direction.side, 1, "a first upward medium break gives an early long observation direction");
assert.equal(direction.confirmed, false, "one break does not claim strict trend confirmation");
direction = advanceObservation(direction, { low: 106, high: 120, strictSide: 1 });
assert.equal(direction.confirmed, true, "matching strict structure upgrades the early direction");
direction = advanceObservation(direction, { eventSide: -1, anchor: 120, low: 104, high: 110, strictSide: 1 });
assert.equal(direction.side, -1, "a newer opposite break overrides the older confirmed long structure");
assert.equal(direction.confirmed, false, "opposite provisional direction is not reported as confirmed");
direction = advanceObservation(direction, { low: 103, high: 120, strictSide: 1 });
assert.equal(direction.side, 0, "touching the short origin cancels the direction without reviving an older long");
direction = advanceObservation(direction, { eventSide: 1, anchor: 100, low: 103, high: 115, strictSide: 1 });
assert.equal(direction.confirmed, true, "a new compatible break can restore confirmation");
assert.equal(advanceObservation(direction, { conflict: true, strictSide: 1 }).side, 0, "a two-sided conflict clears observation direction");
assert.equal(advanceObservation(direction, { eventSide: -1, anchor: 120, low: 105, high: 110, mode: 1 }).side, 0, "long-only mode never gives a provisional short");

const highSeries = [10, 12, 11, 9];
assert.equal(isStrictPivot(highSeries, 1, 1, 1, 1), true, "strict isolated high");
assert.equal(isStrictPivot([10, 12, 12], 1, 1, 1, 1), false, "equal high is not isolated");
assert.equal(isStrictPivot([10, 8, 9], 1, 1, 1, -1), true, "strict isolated low");
assert.equal(isStrictPivot([10, 8, 8], 1, 1, 1, -1), false, "equal low is not isolated");

const consecutive = normalize([
  { type: -1, price: 80, time: 1 },
  { type: 1, price: 95, time: 2 },
  { type: 1, price: 100, time: 3 },
  { type: -1, price: 85, time: 4 },
], OFF);
assert.deepEqual(consecutive.map(({ type, price }) => [type, price]), [[-1, 80], [1, 100], [-1, 85]]);

const contained = [
  { type: 1, price: 100, time: 1 },
  { type: -1, price: 80, time: 2 },
  { type: 1, price: 95, time: 3 },
  { type: -1, price: 85, time: 4 },
];
assert.equal(normalize(contained, STRICT).length, 2, "strict containment removes inner pair");
assert.equal(normalize(contained, INCLUSIVE).length, 2, "inclusive containment removes inner pair");
assert.equal(normalize(contained, OFF).length, 4, "disabled containment keeps inner pair");

const touching = [contained[0], contained[1], { type: 1, price: 100, time: 3 }, contained[3]];
assert.equal(normalize(touching, STRICT).length, 4, "strict containment keeps touching boundary");
assert.equal(normalize(touching, INCLUSIVE).length, 2, "inclusive containment removes touching boundary");

const ordered = [];
recordMidPoint(ordered, { type: 1, price: 110, time: 30 });
recordMidPoint(ordered, { type: -1, price: 80, time: 10 });
recordMidPoint(ordered, { type: 1, price: 100, time: 20 });
recordMidPoint(ordered, { type: 1, price: 105, time: 20 });
assert.deepEqual(ordered.map(({ time, price }) => [time, price]), [[10, 80], [20, 105], [30, 110]], "medium points are sorted and deduplicated");

assert.deepEqual(
  resolveEvents({ midHigh: false, midLow: true, recoveryUp: true, recoveryDown: false }),
  { conflict: false, midHigh: false, midLow: true, recoveryUp: false, recoveryDown: false, direction: 1 },
  "direct upward candidate break takes precedence",
);
assert.deepEqual(
  resolveEvents({ midHigh: true, midLow: true, recoveryUp: false, recoveryDown: false }),
  { conflict: true, midHigh: false, midLow: false, recoveryUp: false, recoveryDown: false, direction: 0 },
  "two-sided break is rejected in automatic mode",
);

const rising = [
  { type: -1, price: 80, time: 10 },
  { type: 1, price: 100, time: 20 },
  { type: -1, price: 85, time: 30 },
  { type: 1, price: 110, time: 40 },
];
assert.equal(structureSide(rising), 1, "higher highs and lows qualify long direction");
assert.deepEqual(recentAlignedSwing(rising, 1), rising.slice(-2), "newest rising leg is selected");
const pullback = [...rising, { type: -1, price: 90, time: 50 }];
assert.equal(structureSide(pullback), 1, "higher pullback low retains long direction");
assert.deepEqual(recentAlignedSwing(pullback, 1), rising.slice(-2), "pullback retains previous upward swing");
assert.equal(structureSide([...rising, { type: -1, price: 78, time: 50 }]), 0, "broken low removes long qualification");
assert.equal(structureSide(rising.slice(0, 3)), 0, "one confirmed high is insufficient");
const falling = [
  { type: 1, price: 110, time: 10 },
  { type: -1, price: 90, time: 20 },
  { type: 1, price: 105, time: 30 },
  { type: -1, price: 80, time: 40 },
];
assert.equal(structureSide(falling), -1, "lower highs and lows qualify short direction");
assert.deepEqual(recentAlignedSwing(falling, -1), falling.slice(-2), "newest falling leg is selected");
assert.deepEqual(recentAlignedSwing([...falling, { type: 1, price: 100, time: 50 }], -1), falling.slice(-2), "short swing survives an upward pullback");

assert.deepEqual(setupLevels(80, 100, 0.5, 0.618), [87.64, 90], "long retracement zone uses the confirmed swing");
assert.deepEqual(setupLevels(120, 100, 0.5, 0.618), [110, 112.36], "short retracement zone mirrors the long zone");
const longBars = [
  { open: 98, high: 100, low: 96, close: 99 },
  { open: 94, high: 95, low: 89, close: 89.5 },
  { open: 90, high: 92, low: 87, close: 90.5 },
  { open: 90.4, high: 94, low: 90, close: 93.5 },
];
assert.deepEqual(setupEvents(longBars, { side: 1, start: 80, end: 100, confirmedAt: 0, shortPoint: 88, shortPointTime: 2, swingEndTime: 1 }), [3], "sweep and later trend close produce one long candidate");
assert.deepEqual(setupEvents(longBars, { side: 1, start: 80, end: 100, confirmedAt: 2, shortPoint: 88, shortPointTime: 2, swingEndTime: 1 }), [], "historical sweep before swing confirmation is not tradable");
assert.deepEqual(setupEvents(longBars, { side: 1, start: 80, end: 100, confirmedAt: 0, shortPoint: 88, shortPointTime: 0, swingEndTime: 1 }), [], "old short pivot is not a valid new sweep reference");
const shortBars = [
  { open: 102, high: 104, low: 100, close: 101 },
  { open: 107, high: 111, low: 106, close: 111 },
  { open: 110, high: 113, low: 108, close: 109.5 },
  { open: 109.6, high: 110, low: 106, close: 106.5 },
];
assert.deepEqual(setupEvents(shortBars, { side: -1, start: 120, end: 100, confirmedAt: 0, shortPoint: 112, shortPointTime: 2, swingEndTime: 1 }), [3], "short setup mirrors the long sequence");
const missedLongTouch = longBars.map((bar, index) => index === 1 ? { ...bar, close: 93 } : bar);
assert.deepEqual(setupEvents(missedLongTouch, { side: 1, start: 80, end: 100, confirmedAt: 0, shortPoint: 88, shortPointTime: 2, swingEndTime: 1 }), [], "a missed first touch consumes the long opportunity");
assert.deepEqual(setupEvents(missedLongTouch, { side: 1, start: 80, end: 100, confirmedAt: 0, shortPoint: 88, shortPointTime: 2, swingEndTime: 1, retireAfterMissedTouch: false }), [3], "missed-touch retirement can be disabled");
const missedShortTouch = shortBars.map((bar, index) => index === 1 ? { ...bar, close: 108 } : bar);
assert.deepEqual(setupEvents(missedShortTouch, { side: -1, start: 120, end: 100, confirmedAt: 0, shortPoint: 112, shortPointTime: 2, swingEndTime: 1 }), [], "a missed first touch consumes the short opportunity");
assert.deepEqual(setupEvents([...longBars.slice(0, 3), longBars[1], longBars[1], longBars[3]], { side: 1, start: 80, end: 100, confirmedAt: 0, shortPoint: 88, shortPointTime: 2, swingEndTime: 1, confirmationBars: 2 }), [], "late trend candle cannot confirm an expired sweep");
assert.deepEqual(setupEvents(longBars, { side: 1, start: 80, end: 100, confirmedAt: 0, shortPoint: 88, shortPointTime: 2, swingEndTime: 1, maxSetupBars: 2 }), [], "an expired swing cannot produce a late confirmation");
const longFvg = { kind: "FVG", side: 1, top: 105, bottom: 100, born: 10 };
const shortFvg = { kind: "FVG", side: -1, top: 100, bottom: 95, born: 10 };
assert.equal(candidateZoneExpired(longFvg, { low: 103 }, 11), false, "partial long FVG fill stays active by default");
assert.equal(candidateZoneExpired(longFvg, { low: 103 }, 11, { fvgMode: "首次触及" }), true, "first-touch mode retires a partly filled FVG");
assert.equal(candidateZoneExpired(longFvg, { low: 100 }, 11), true, "full long FVG fill retires the zone");
assert.equal(candidateZoneExpired(shortFvg, { high: 97 }, 11), false, "partial short FVG fill stays active by default");
assert.equal(candidateZoneExpired(shortFvg, { high: 100 }, 11), true, "full short FVG fill retires the zone");
const longOb = { kind: "OB", side: 1, top: 105, bottom: 100, born: 10 };
assert.equal(candidateZoneExpired(longOb, { low: 99, close: 101 }, 11), false, "OB close mode tolerates a wick through its far side");
assert.equal(candidateZoneExpired(longOb, { low: 99, close: 101 }, 11, { obMode: "影线" }), true, "OB wick mode retires on a far-side touch");
assert.equal(candidateZoneExpired(longOb, { low: 102, close: 102 }, 71), true, "age limit retires an untouched zone");
assert.equal(candidateZoneExpired(longOb, { low: 102, close: 102 }, 11, { oppositeBreak: true }), true, "opposite structure break retires the zone");
const activeSetup = { active: true, side: 1, top: 100, bottom: 95 };
assert.equal(visibleBreakZone({ side: 1, top: 105, bottom: 100 }, activeSetup), true, "a same-side edge touch is visible");
assert.equal(visibleBreakZone({ side: 1, top: 94, bottom: 90 }, activeSetup), false, "a disjoint zone stays hidden");
assert.equal(visibleBreakZone({ side: -1, top: 100, bottom: 95 }, activeSetup), false, "an opposite-side zone stays hidden");
assert.equal(visibleBreakZone({ side: 1, top: 100, bottom: 95 }, { ...activeSetup, active: false }), false, "zones hide when no setup is active");
assert.equal(visibleBreakZone({ side: -1, top: 100, bottom: 95 }, activeSetup, false), true, "the filter can be disabled");

// Bar-sequence reference model: exercise lifecycle ordering and confirmation rules.
// This is a specification check, not execution of the Pine runtime.
function regionEntries(bars, { side = 1, kind = "OB", requireSweep = false, limit = 3, obMode = "收盘价", fvgMode = "完全回补" } = {}) {
  const states = new Map();
  const signals = [];
  let previousDirection = 0;
  let zone = { kind, side, top: 110, bottom: 100, born: 0 };
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const direction = bar.direction ?? side;
    if (bar.replace) zone = { kind, side, top: 110, bottom: 100, born: i };
    if (zone && candidateZoneExpired(zone, bar, i, { obMode, fvgMode, oppositeBreak: !!bar.oppositeBreak })) zone = null;
    if (!zone) {
      states.clear();
      previousDirection = direction;
      continue;
    }
    const key = zone.born;
    for (const oldKey of states.keys()) if (oldKey !== key) states.delete(oldKey);
    const state = states.get(key) ?? { touch: null, sweep: null, used: false };
    states.set(key, state);
    if (bar.visible === false || direction !== side || direction !== previousDirection || state.used || i <= zone.born) {
      state.touch = state.sweep = null;
    } else if (state.touch !== null && i - state.touch > limit) {
      state.touch = state.sweep = null;
    } else {
      const range = bar.high - bar.low;
      const trend = range > 0 && (side === 1
        ? bar.close > bar.open && bar.close > bars[i - 1].close && (bar.close - bar.open) / range >= 0.5 && (bar.close - bar.low) / range >= 0.7 && bar.close > zone.top
        : bar.close < bar.open && bar.close < bars[i - 1].close && (bar.open - bar.close) / range >= 0.5 && (bar.high - bar.close) / range >= 0.7 && bar.close < zone.bottom);
      if (state.touch !== null && i > state.touch && (!requireSweep || state.sweep !== null && i > state.sweep) && trend) {
        signals.push(i);
        state.used = true;
      } else if (bar.high >= zone.bottom && bar.low <= zone.top) {
        state.touch ??= i;
        const sweep = side === 1 ? bar.low <= 105 && bar.close >= 107 : bar.high >= 105 && bar.close <= 103;
        if (sweep) state.sweep = i;
      }
    }
    previousDirection = direction;
  }
  return signals;
}
const regionBars = [
  { open: 115, high: 119, low: 114, close: 117 },
  { open: 109, high: 110, low: 106, close: 108 },
  { open: 109, high: 116, low: 109, close: 115 },
  { open: 115, high: 122, low: 115, close: 121 },
];
assert.deepEqual(regionEntries(regionBars), [2], "same-side touch then later trend exit confirms once per region");
const mirroredRegionBars = regionBars.map(({ open, high, low, close }) => ({ open: 210 - open, high: 210 - low, low: 210 - high, close: 210 - close }));
assert.deepEqual(regionEntries(mirroredRegionBars, { side: -1 }), [2], "short region entries are symmetric");
assert.deepEqual(regionEntries(regionBars, { requireSweep: true }), [], "requiring a sweep rejects an otherwise valid trend response");
const sweptRegionBars = regionBars.map((bar, i) => i === 1 ? { ...bar, low: 104 } : bar);
assert.deepEqual(regionEntries(sweptRegionBars, { requireSweep: true }), [2], "a known short-point sweep on touch can confirm on a later bar");
const lateSweptRegionBars = regionBars.map((bar, i) => i === 2 ? { ...bar, low: 104, open: 104 } : bar);
assert.deepEqual(regionEntries(lateSweptRegionBars, { requireSweep: true }), [3], "a trend candle that first sweeps must wait for a later trend confirmation");
assert.deepEqual(regionEntries(regionBars.map((bar, i) => i === 2 ? { ...bar, low: 99, open: 99 } : bar), { obMode: "影线" }), [], "invalidation takes priority over a same-bar trend response");
assert.deepEqual(regionEntries(regionBars, { kind: "FVG", fvgMode: "首次触及" }), [], "a first-touch-retired FVG cannot arm a later entry");
assert.deepEqual(regionEntries(regionBars, { kind: "FVG" }), [2], "partially filled live FVG remains eligible");
assert.deepEqual(regionEntries(regionBars.map((bar, i) => ({ ...bar, direction: i === 1 ? 0 : 1 }))), [], "direction changes cannot reuse a previous touch");
assert.deepEqual(regionEntries(regionBars.map((bar, i) => ({ ...bar, direction: -1 }))), [], "countertrend regions cannot produce entries");
assert.deepEqual(regionEntries(regionBars.map((bar, i) => i === 2 ? { ...bar, replace: true } : bar)), [], "same-side replacement cannot inherit old pending confirmation");
assert.deepEqual(regionEntries(regionBars.map((bar, i) => i === 2 ? { ...bar, oppositeBreak: true } : bar)), [], "opposite structure events cancel before confirmation");
assert.deepEqual(regionEntries(regionBars.map((bar, i) => i === 2 ? { ...bar, visible: false } : bar)), [], "hidden zones cannot confirm or retain a pending touch");
const quietRegionBar = { open: 108, high: 110, low: 106, close: 108 };
assert.deepEqual(regionEntries([...regionBars.slice(0, 2), quietRegionBar, quietRegionBar, regionBars[2]]), [4], "the final allowed confirmation bar remains eligible");
assert.deepEqual(regionEntries([...regionBars.slice(0, 2), quietRegionBar, quietRegionBar, quietRegionBar, regionBars[2]]), [], "repeated touches do not extend the confirmation deadline");
assert.deepEqual(regionEntries([...regionBars.slice(0, 2), quietRegionBar, quietRegionBar, quietRegionBar, quietRegionBar, quietRegionBar, regionBars[2]]), [7], "a new touch after the timeout bar can arm a fresh attempt");
assert.deepEqual(regionEntries([regionBars[0], regionBars[2]]), [], "a trend touch cannot confirm on the same candle");
assert.deepEqual(regionEntries([regionBars[0], regionBars[2], regionBars[3]]), [2], "the next trend candle may confirm an earlier trend touch");

const pine = readFileSync(new URL("../market_structure.pine", import.meta.url), "utf8");
assert.match(pine, /entryMethod = input\.string\("OB\/FVG 确认"/, "default signal mode uses region confirmation");
assert.match(pine, /if barstate\.isconfirmed\s+array<string> liveKeys/, "region states advance only on confirmed candles");
assert.ok(pine.indexOf("[obEntrySignal, obEntryBoundary] = confirmZoneEntries") > pine.indexOf("addCandidateZone(fvgZones"), "confirmation evaluates after invalidation, replacement and zone creation");
assert.match(pine, /observationSide != 0 and observationSide == observationSide\[1\]/, "direction must already be known before the touch candle");
assert.match(pine, /not state\.used and bar_index > born/, "each region signals once and excludes its creation candle");
assert.match(pine, /bar_index > state\.touchedBar and swept and trendResponse/, "touch and trend confirmation cannot share a candle");
assert.match(pine, /not na\(state\.sweptBar\) and bar_index > state\.sweptBar/, "required sweep must precede confirmation");
assert.match(pine, /bullishCandle and close > top : bearishCandle and close < bottom/, "confirmation must close outside the region in its direction");
assert.match(pine, /if not array\.includes\(liveKeys, key\)\s+map\.remove\(states, key\)/, "removed regions cannot leave unbounded stale state");
assert.match(pine, /alertcondition\(not regionEntryMode and longSetupSignal/, "legacy alerts are suppressed in region mode");
assert.match(pine, /directionMethod = input\.string\("中期结构（分级）"/, "default preserves graded structure direction");
assert.match(pine, /options = \["中期结构（分级）", "中期结构（严格）", "高周期 EMA", "高周期 EMA＋中期结构"\]/, "all four direction sources can be selected");
assert.match(pine, /directionEmaTimeframe = input\.timeframe\("5",/, "EMA reference timeframe is configurable and defaults to five minutes");
assert.match(pine, /request\.security\(syminfo\.tickerid, directionEmaTimeframe, \[ta\.ema\(close, directionEmaLength\)\[1\], ta\.ema\(close, directionEmaLength\)\[2\]\], lookahead = barmerge\.lookahead_on\)/, "selected EMA timeframe requests two completed values without future leakage");
assert.match(pine, /chart\.is_standard and not timeframe\.isticks and timeframe\.in_seconds\(\) < timeframe\.in_seconds\(directionEmaTimeframe\)/, "EMA rejects ticks, synthetic charts, and references not strictly above the chart timeframe");
assert.match(pine, /emaDirectionSupported and not na\(directionEma\) and not na\(directionEmaPrevious\)/, "EMA requires both completed values and a supported chart");
assert.match(pine, /int emaObservationSide = not emaDirectionReady \? 0 : directionEma > directionEmaPrevious \? 1 : directionEma < directionEmaPrevious \? -1 : 0/, "slope alone determines EMA direction; equal or unavailable is neutral");
assert.match(pine, /int observationSide = jointDirectionMode \? jointObservationSide : directionMethod == "高周期 EMA" \? emaObservationSide : directionMethod == "中期结构（严格）" \? confirmedObservationSide : structureObservationSide/, "joint routing preserves strict and single-source direction modes");
assert.match(pine, /bool tradeDirectionAllowed = confirmedObservationSide != 0 and observationSide == tradeSide/, "EMA never bypasses strict swing qualification");
assert.match(pine, /bool setupActive = .* and tradeDirectionAllowed/, "retracement signals honor the selected direction");
assert.match(pine, /if showTradeFib and tradeDirectionAllowed/, "trade reference lines honor the same direction gate");
assert.match(pine, /if not setupActive\s+pendingSweepSide := 0\s+pendingSweepBar := na/, "direction disagreement clears a pending sweep rather than releasing a stale confirmation later");
assert.match(pine, /EMA同向多/, "EMA zone wording does not claim confirmed medium structure");
assert.match(pine, /bool showStructureVisuals = directionMethod != "高周期 EMA"/, "EMA direction automatically hides medium structure visuals");
assert.match(pine, /bool emaPlotPoint = timeframe\.change\(directionEmaTimeframe\) or barstate\.islast/, "EMA line connects confirmed update points and extends to the current bar");
assert.match(pine, /plot\(useEmaBackground and emaDirectionReady and emaPlotPoint \? directionEma : na, "方向 EMA（参考周期已收盘）".*style = plot\.style_line\)/, "both EMA modes plot confirmed samples, including when joint structure is visible");
assert.match(pine, /int structureObservationSide = confirmedObservationSide != 0 \? confirmedObservationSide : biasSide/, "joint local direction reuses graded structure with provisional fallback");
assert.match(pine, /int jointObservationSide = emaObservationSide != 0 and emaObservationSide == structureObservationSide \? emaObservationSide : 0/, "joint mode requires nonzero agreement");
assert.match(pine, /jointShowStructure = input\.bool\(false,/, "joint structure visuals default off");
assert.match(pine, /and \(not jointDirectionMode or jointShowStructure\)/, "joint structure visualization is optional");
const jointDirection = (ema, local) => ema !== 0 && ema === local ? ema : 0;
for (const ema of [-1, 0, 1]) for (const local of [-1, 0, 1]) {
  assert.equal(jointDirection(ema, local), ema && ema === local ? ema : 0, "joint truth table rejects neutral or conflicting inputs");
}
const jointBars = regionBars.map((bar, i) => ({ ...bar, direction: jointDirection(1, i === 1 ? -1 : 1) }));
assert.deepEqual(regionEntries(jointBars), [], "alignment cannot reuse a touch made during a counter-background pullback");
const resumedJointBars = [regionBars[0], { ...regionBars[1], direction: 0 }, regionBars[1], regionBars[1], regionBars[2]];
assert.deepEqual(regionEntries(resumedJointBars), [4], "new touch after alignment can confirm without requiring a new reversal cycle");
assert.deepEqual(regionEntries(regionBars.map((bar, i) => ({ ...bar, direction: i === 2 ? 0 : 1 }))), [], "loss of alignment cancels pending confirmation before a trend candle");
assert.match(pine, /midColor, 2, showMidLines and showStructureVisuals, midContainment/, "medium lines respect EMA presentation mode");
for (const condition of [
  "showMidPoints and array.size(midTimes) > 0",
  "showMidFib and midCount >= 2",
  "showTradeFib and tradeDirectionAllowed",
  "showSetupInvalidation and setupActive",
  "showSweepTarget and setupActive and hasSweepTarget",
  "showSetupZone and setupActive and not longSetupSignal and not shortSetupSignal",
]) assert.ok(pine.includes(`if ${condition} and showStructureVisuals`), `${condition} is hidden in EMA mode`);
for (const event of ["autoSwitchUp", "autoSwitchDown", "autoConflict"])
  assert.ok(pine.includes(`plotshape(showStructureVisuals and ${event},`), `${event} markers are hidden in EMA mode`);
assert.doesNotMatch(pine.match(/bool setupActive = .*/)[0], /showStructureVisuals/, "visual suppression does not disable swing calculations");
assert.doesNotMatch(pine.match(/\[obEntrySignal, obEntryBoundary\] = .*/)[0], /showStructureVisuals/, "EMA presentation keeps OB entry confirmation active");
assert.doesNotMatch(pine.match(/\[fvgEntrySignal, fvgEntryBoundary\] = .*/)[0], /showStructureVisuals/, "EMA presentation keeps FVG entry confirmation active");
assert.match(pine, /varip touchAlertKeys = array\.new_string\(\)/, "arrival deduplication survives realtime rollback");
assert.match(pine, /close >= bottom and close <= top/, "instant arrival uses the current price, not the cumulative bar range");
assert.match(pine, /bar_index > array\.get\(bornBars, i\)/, "a creation-bar gap is not treated as a return to the zone");
assert.match(pine, /barstate\.isrealtime and \(not closeTouchCheck or barstate\.isconfirmed\)/, "notifications honor realtime and close-only settings");
assert.ok(pine.indexOf("candidateTouchMessage(obZones") < pine.indexOf("updateCandidateZones(obZones"), "touch notification is evaluated before first-touch retirement");
assert.match(pine, /high\[rightBars\] > leftHigh and high\[rightBars\] > rightHigh/, "Pine uses strict high comparison");
assert.match(pine, /low\[rightBars\] < leftLow and low\[rightBars\] < rightLow/, "Pine uses strict low comparison");
assert.match(pine, /innerHigh < outerHigh and innerLow > outerLow/, "Pine contains strict mode");
assert.match(pine, /innerHigh <= outerHigh and innerLow >= outerLow/, "Pine contains inclusive mode");
assert.match(pine, /while position < array\.size\(times\).*< pointTime/, "Pine sorts medium points by pivot time");
assert.match(pine, /autoConflict := trendMode == "自动\/双向" and upwardBreak and downwardBreak/, "Pine rejects automatic two-sided breaks");
assert.match(pine, /latestHigh > previousHigh and latestLow > previousLow/, "trade reference requires rising medium structure");
assert.match(pine, /latestHigh < previousHigh and latestLow < previousLow/, "trade reference requires falling medium structure");
assert.match(pine, /trendMode == "上涨" and structureSide == -1/, "upward mode suppresses short trade references");
assert.match(pine, /trendMode == "下跌" and structureSide == 1/, "downward mode suppresses long trade references");
assert.match(pine, /for i = tradeMidCount - 2 to math\.max\(0, tradeMidCount - 3\)/, "trade reference checks the current and previous swing");
assert.match(pine, /tradeConfirmedTime := time/, "trade levels start at actual confirmation");
assert.match(pine, /line\.new\(tradeConfirmedTime, level, time \+ 1, level, xloc = xloc\.bar_time/, "trade line does not backdate to a pivot");
assert.match(pine, /tradeSide == 1 and low <= tradeSwingStart/, "long reference expires at its structure low");
assert.match(pine, /tradeSide == -1 and high >= tradeSwingStart/, "short reference expires at its structure high");
assert.match(pine, /if not retainedSwing\s+tradeSide := 0/, "removed anchors invalidate the reference");
assert.match(pine, /float sweepRefLow = previousShortLow/, "sweep uses the short point known before the current bar");
assert.match(pine, /bar_index > tradeConfirmedBar/, "setup waits until the medium swing is confirmed");
assert.match(pine, /bar_index > pendingSweepBar/, "trend candle follows, rather than coincides with, the sweep");
assert.match(pine, /signaledSwingBar := tradeConfirmedBar/, "a confirmed swing signals at most once");
assert.match(pine, /bar_index - tradeConfirmedBar <= maxSetupBars/, "setup has a total age limit");
assert.match(pine, /setupActive and not longSetupSignal and not shortSetupSignal/, "active setup box closes on the signal bar");
assert.match(pine, /retireAfterMissedTouch and setupTouched and pendingSweepSide == 0 and leftWithTrend/, "Pine retires an unconfirmed setup after leaving the zone");
assert.match(pine, /showSetupInvalidation and setupActive/, "Pine marks the current swing invalidation level");
assert.match(pine, /showSweepTarget and setupActive and hasSweepTarget/, "Pine marks the eligible short-term sweep point");
assert.match(pine, /setupIsActive and side == setupSide and top >= setupBottomPrice and bottom <= setupTopPrice/, "Pine shows only same-side overlapping break zones by default");
assert.match(pine, /onlyOverlappingBreakZones = input\.bool\(false,/, "enabled break zones are visible without an active setup by default");
assert.match(pine, /keepExpiredSetupZones = input\.bool\(true,/, "ended retracement zones remain available for chart review by default");
assert.match(pine, /if keepHistory and wasVisible/, "never-visible break zones do not appear as gray history");
assert.match(pine, /box\.set_extend\(setupZone, extend\.none\)/, "historical retracement boxes stop extending");
assert.match(pine, /showTradeFib = input\.bool\(false,/, "trade reference lines default off when the zone is shown");
assert.match(pine, /updateCandidateZones\(obZones,/, "OB candidates are updated each bar");
assert.match(pine, /updateCandidateZones\(fvgZones,/, "FVG candidates are updated each bar");
assert.match(pine, /box\.set_right\(candidate, endTime\)/, "candidate boxes stop at their expiry bar");
assert.match(pine, /text = "回撤"/, "retracement box identifies its purpose");
assert.match(pine, /fibShortColor, "OB", breakSide/, "OB candidate box is labeled");
assert.match(pine, /color\.orange, "FVG", breakSide/, "FVG candidate box is labeled");
assert.match(pine, /box\.set_text_color\(candidate, color\.gray\)/, "retired box label fades with its region");

console.log("market_structure: deterministic checks passed");
