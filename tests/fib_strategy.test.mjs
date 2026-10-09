import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function trendDirection({ previousHigh, high, previousLow, low }) {
  if (high > previousHigh && low > previousLow) return 1;
  if (high < previousHigh && low < previousLow) return -1;
  return 0;
}

function limitPrice({ low, high, direction, atr, threshold = 3, strong = 0.618, normal = 0.786 }) {
  const retracement = atr > 0 && (high - low) / atr >= threshold ? strong : normal;
  return direction === 1 ? high - (high - low) * retracement : low + (high - low) * retracement;
}

function canArm({ direction, setupReady = true, close, limit, used = false, flat = true }) {
  return setupReady && !used && flat && (direction === 1 ? close > limit : close < limit);
}

function touchesLimit({ direction, bar, limit }) {
  return direction === 1 ? bar.low <= limit : bar.high >= limit;
}

function invalidated({ direction, bar, low, high, buffer = 0 }) {
  return direction === 1 ? bar.low <= low - buffer || bar.high >= high : bar.high >= high + buffer || bar.low <= low;
}

assert.equal(trendDirection({ previousHigh: 100, high: 110, previousLow: 80, low: 85 }), 1);
assert.equal(trendDirection({ previousHigh: 100, high: 90, previousLow: 80, low: 75 }), -1);
assert.equal(trendDirection({ previousHigh: 100, high: 110, previousLow: 80, low: 75 }), 0);
assert.equal(limitPrice({ low: 80, high: 100, direction: 1, atr: 5 }), 87.64);
assert.equal(limitPrice({ low: 80, high: 100, direction: -1, atr: 5 }), 92.36);
assert.equal(limitPrice({ low: 80, high: 100, direction: 1, atr: 10 }), 84.28);
assert.equal(limitPrice({ low: 80, high: 100, direction: -1, atr: 10 }), 95.72);
assert.equal(limitPrice({ low: 80, high: 100, direction: 1, atr: 20 / 3 }), 87.64, "threshold is inclusive");

const longLimit = limitPrice({ low: 80, high: 100, direction: 1, atr: 5 });
const shortLimit = limitPrice({ low: 80, high: 100, direction: -1, atr: 5 });
assert.equal(canArm({ direction: 1, close: 90, limit: longLimit }), true);
assert.equal(canArm({ direction: 1, close: 87, limit: longLimit }), false, "no marketable buy limit");
assert.equal(canArm({ direction: -1, close: 90, limit: shortLimit }), true);
assert.equal(canArm({ direction: -1, close: 93, limit: shortLimit }), false, "no marketable sell limit");
assert.equal(canArm({ direction: 1, close: 90, limit: longLimit, used: true }), false);
assert.equal(canArm({ direction: -1, close: 90, limit: shortLimit, flat: false }), false);
assert.equal(canArm({ direction: 1, setupReady: false, close: 90, limit: longLimit }), false, "missed setup cannot rearm later");
assert.equal(touchesLimit({ direction: 1, bar: { low: 87, high: 95, close: 94 }, limit: longLimit }), true, "long fills on wick despite close above limit");
assert.equal(touchesLimit({ direction: -1, bar: { low: 85, high: 93, close: 86 }, limit: shortLimit }), true, "short fills on wick despite close below limit");
assert.equal(touchesLimit({ direction: 1, bar: { low: 88, high: 95 }, limit: longLimit }), false);
assert.equal(touchesLimit({ direction: -1, bar: { low: 85, high: 92 }, limit: shortLimit }), false);
assert.equal(invalidated({ direction: 1, bar: { low: 79, high: 90 }, low: 80, high: 100 }), true);
assert.equal(invalidated({ direction: -1, bar: { low: 85, high: 101 }, low: 80, high: 100 }), true);
assert.equal(invalidated({ direction: 1, bar: { low: 88, high: 100 }, low: 80, high: 100 }), true, "target touched before arming invalidates setup");

const pine = readFileSync(new URL("../market_structure_fib_strategy.pine", import.meta.url), "utf8");
assert.match(pine, /strongRetracement = input\.float\(0\.618/, "strong swing uses 0.618 by default");
assert.match(pine, /normalRetracement = input\.float\(0\.786/, "normal swing uses 0.786 by default");
assert.match(pine, /float strengthAtr = ta\.atr\(strengthAtrLength\)/, "strength uses confirmed ATR");
assert.match(pine, /longLimit := math\.round_to_mintick\(eventHighPrice - .*strongSwingAtr \? strongRetracement : normalRetracement/, "long price is frozen at setup");
assert.match(pine, /shortLimit := math\.round_to_mintick\(eventLowPrice \+ .*strongSwingAtr \? strongRetracement : normalRetracement/, "short price is frozen at setup");
assert.match(pine, /close > longLimit/, "buy limit is only armed below current price");
assert.match(pine, /close < shortLimit/, "sell limit is only armed above current price");
assert.match(pine, /bool canPlaceLong = longSetupReady/, "long limit is placed only on setup confirmation");
assert.match(pine, /bool canPlaceShort = shortSetupReady/, "short limit is placed only on setup confirmation");
assert.match(pine, /strategy\.entry\("Long", strategy\.long, limit = orderLimit\)/, "long uses resting limit order");
assert.match(pine, /strategy\.entry\("Short", strategy\.short, limit = orderLimit\)/, "short uses resting limit order");
assert.match(pine, /strategy\.cancel\("Long"\)/, "stale long order is canceled");
assert.match(pine, /strategy\.cancel\("Short"\)/, "stale short order is canceled");
assert.match(pine, /if not longUsed and \(low <= longAnchorLow - stopBuffer or high >= longAnchorHigh\)/, "long setup bar also checks invalidation");
assert.match(pine, /if not shortUsed and \(high >= shortAnchorHigh \+ stopBuffer or low <= shortAnchorLow\)/, "short setup bar also checks invalidation");
assert.match(pine, /strategy\.exit\("Long Exit".*stop = orderStop, limit = orderTarget\)/, "long bracket is submitted with entry");
assert.match(pine, /strategy\.exit\("Short Exit".*stop = orderStop, limit = orderTarget\)/, "short bracket is submitted with entry");
assert.match(pine, /strategy\.closedtrades > activeClosedTrades/, "same-bar roundtrip is detected");
assert.match(pine, /activeTarget := orderTarget/, "filled trade uses locked target");
assert.match(pine, /higherHigh and higherLow/, "automatic long requires rising medium structure");
assert.match(pine, /lowerLow and lowerHigh/, "automatic short requires falling medium structure");
assert.match(pine, /process_orders_on_close = false/, "order cannot fill on setup close");

console.log("fib_strategy: deterministic checks passed");
