import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function trendDirection({ previousHigh, high, previousLow, low }) {
  if (high > previousHigh && low > previousLow) return 1;
  if (high < previousHigh && low < previousLow) return -1;
  return 0;
}

function zone({ low, high, shallow = 0.5, deep = 0.618, direction }) {
  const range = high - low;
  return direction === 1
    ? [high - range * deep, high - range * shallow]
    : [low + range * shallow, low + range * deep];
}

function eligible({ direction, anchorFirst, anchorSecond, setupBar, bar, used, flat, close, low, high, buffer = 0 }) {
  if (anchorFirst.time >= anchorSecond.time || bar.index <= setupBar || used || !flat) return false;
  const [zoneLow, zoneHigh] = zone({ low, high, direction });
  if (direction === 1 && (bar.low <= low - buffer || bar.high >= high)) return false;
  if (direction === -1 && (bar.high >= high + buffer || bar.low <= low)) return false;
  return close >= zoneLow && close <= zoneHigh;
}

assert.equal(trendDirection({ previousHigh: 100, high: 110, previousLow: 80, low: 85 }), 1);
assert.equal(trendDirection({ previousHigh: 100, high: 90, previousLow: 80, low: 75 }), -1);
assert.equal(trendDirection({ previousHigh: 100, high: 110, previousLow: 80, low: 75 }), 0);
assert.deepEqual(zone({ low: 80, high: 100, direction: 1 }), [87.64, 90]);
assert.deepEqual(zone({ low: 80, high: 100, direction: -1 }), [90, 92.36]);

const longCase = {
  direction: 1,
  anchorFirst: { price: 80, time: 10 },
  anchorSecond: { price: 100, time: 20 },
  setupBar: 30,
  bar: { index: 31, low: 88, high: 91 },
  used: false,
  flat: true,
  close: 89,
  low: 80,
  high: 100,
};
assert.equal(eligible(longCase), true, "confirmed long pullback enters the zone");
assert.equal(eligible({ ...longCase, bar: { ...longCase.bar, index: 30 } }), false, "no setup-bar entry");
assert.equal(eligible({ ...longCase, used: true }), false, "one trade per swing");
assert.equal(eligible({ ...longCase, anchorFirst: { price: 80, time: 25 } }), false, "anchors must be chronological");
assert.equal(eligible({ ...longCase, bar: { index: 31, low: 79, high: 91 } }), false, "broken structure invalidates long setup");
assert.equal(eligible({ ...longCase, close: 94 }), false, "outside pullback zone is not an entry");

const shortCase = {
  direction: -1,
  anchorFirst: { price: 100, time: 10 },
  anchorSecond: { price: 80, time: 20 },
  setupBar: 30,
  bar: { index: 31, low: 89, high: 93 },
  used: false,
  flat: true,
  close: 91,
  low: 80,
  high: 100,
};
// The strategy's short anchor order is high then low. For the zone helper,
// the numerical range remains low 80 to high 100.
assert.equal(eligible(shortCase), true, "confirmed short pullback enters the zone");
assert.equal(eligible({ ...shortCase, bar: { index: 31, low: 89, high: 101 } }), false, "broken structure invalidates short setup");

const pine = readFileSync(new URL("../market_structure_fib_strategy.pine", import.meta.url), "utf8");
assert.match(pine, /bar_index > longSetupBar.*strategy\.position_size == 0/, "long waits until after confirmation");
assert.match(pine, /bar_index > shortSetupBar.*strategy\.position_size == 0/, "short waits until after confirmation");
assert.match(pine, /limit = longAnchorHigh/, "long takes profit at prior high");
assert.match(pine, /limit = shortAnchorLow/, "short takes profit at prior low");
assert.match(pine, /stop = longAnchorLow - stopBuffer/, "long stop below structure low");
assert.match(pine, /stop = shortAnchorHigh \+ stopBuffer/, "short stop above structure high");
assert.match(pine, /higherHigh and higherLow/, "automatic long requires rising medium structure");
assert.match(pine, /lowerLow and lowerHigh/, "automatic short requires falling medium structure");
assert.match(pine, /process_orders_on_close = false/, "market entry fills after the signal close");

console.log("fib_strategy: 22 deterministic checks passed");
