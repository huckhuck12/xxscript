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

const pine = readFileSync(new URL("../market_structure.pine", import.meta.url), "utf8");
assert.match(pine, /high\[rightBars\] > leftHigh and high\[rightBars\] > rightHigh/, "Pine uses strict high comparison");
assert.match(pine, /low\[rightBars\] < leftLow and low\[rightBars\] < rightLow/, "Pine uses strict low comparison");
assert.match(pine, /innerHigh < outerHigh and innerLow > outerLow/, "Pine contains strict mode");
assert.match(pine, /innerHigh <= outerHigh and innerLow >= outerLow/, "Pine contains inclusive mode");
assert.match(pine, /while position < array\.size\(times\).*< pointTime/, "Pine sorts medium points by pivot time");
assert.match(pine, /autoConflict := trendMode == "自动\/双向" and upwardBreak and downwardBreak/, "Pine rejects automatic two-sided breaks");

console.log("market_structure: 14 deterministic checks passed");
