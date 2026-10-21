import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Reference specification for forward-window measurements, not a Pine emulator.
function measure(bars, signal, window) {
  if (!(signal.atr > 0) || signal.index + window >= bars.length) return null;
  const following = bars.slice(signal.index + 1, signal.index + window + 1);
  const baseline = bars[signal.index].close;
  const highest = Math.max(...following.map(b => b.high));
  const lowest = Math.min(...following.map(b => b.low));
  return {
    ret: signal.side * (following.at(-1).close - baseline) / signal.atr,
    mfe: Math.max(0, signal.side === 1 ? highest - baseline : baseline - lowest) / signal.atr,
    mae: Math.max(0, signal.side === 1 ? baseline - lowest : highest - baseline) / signal.atr,
  };
}
function summarize(samples, side = 0) {
  const complete = samples.filter(s => (!side || s.side === side) && s.result);
  return { count: complete.length, positive: complete.length ? complete.filter(s => s.result.ret > 0).length / complete.length : null };
}
const bars = [
  { close: 100, high: 1000, low: 1 }, // signal candle must be excluded
  { close: 102, high: 104, low: 99 },
  { close: 101, high: 105, low: 98 },
  { close: 103, high: 106, low: 100 },
  { close: 104, high: 107, low: 101 },
  { close: 106, high: 108, low: 102 },
];
const signal = { index: 0, atr: 2, side: 1 };
assert.equal(measure(bars.slice(0, 5), signal, 5), null, "incomplete five-bar windows are excluded");
assert.deepEqual(measure(bars, signal, 5), { ret: 3, mfe: 4, mae: 1 }, "measure only the next five bars using signal ATR and close");
const mirrored = bars.map(b => ({ close: 200 - b.close, high: 200 - b.low, low: 200 - b.high }));
assert.deepEqual(measure(mirrored, { ...signal, side: -1 }, 5), measure(bars, signal, 5), "short and long measurements are symmetric");
assert.equal(measure(bars, { ...signal, atr: 0 }, 5), null, "zero ATR is not a valid divisor");
assert.equal(measure(bars, { ...signal, atr: NaN }, 5), null, "missing ATR is excluded");
const longer = [...bars, ...Array.from({ length: 15 }, (_, i) => ({ high: 110 + i, low: 95 - i, close: 100 }))];
assert.deepEqual(measure(longer, signal, 5), measure(bars, signal, 5), "later bars cannot alter a completed five-bar result");
assert.equal(measure(longer, signal, 10).ret, 0, "ten-bar return uses its own endpoint");
assert.equal(measure(longer, signal, 20).mfe, 12, "twenty-bar extremes include the full forward window");
assert.equal(measure(longer, { ...signal, index: 1 }, 5).ret, -1, "overlapping signals retain their own close baseline");
const favorableOnly = [{ close: 100 }, ...Array.from({ length: 5 }, () => ({ high: 105, low: 101, close: 104 }))];
assert.equal(measure(favorableOnly, signal, 5).mae, 0, "adverse excursion is floored at zero");
assert.deepEqual(summarize([{ side: 1, result: { ret: 1 } }, { side: -1, result: { ret: 0 } }, { side: 1, result: null }]), { count: 2, positive: 0.5 }, "zero return is not positive; pending samples are excluded");
assert.deepEqual(summarize([{ side: 1, result: { ret: 1 } }, { side: -1, result: { ret: -1 } }], -1), { count: 1, positive: 0 }, "direction filter applies to completed samples");
assert.deepEqual(summarize([]), { count: 0, positive: null }, "empty sample set has no reported positive ratio");

const pine = readFileSync(new URL("../market_structure.pine", import.meta.url), "utf8");
assert.match(pine, /array\.from\(5, 10, 20\)/);
assert.match(pine, /if age > 0 and age <= 20/, "never consume the signal candle or post-window bars");
assert.match(pine, /if age == array\.get\(observationWindows, w\)/, "finalize only at exact window endpoints");
assert.match(pine, /SignalObservation\.new\(bar_index, time, signalSide, close, closeAtr/, "snapshot the signal close and ATR");
assert.match(pine, /if array\.size\(observations\) > evaluationLimit\s+array\.shift\(observations\)/, "history storage is bounded");
assert.match(pine, /evaluationMatches\(sample\.side\) and not na\(result\)/, "summary excludes incomplete windows");
assert.match(pine, /int signalSide = regionEntryMode \?/, "only the selected entry mode contributes samples");
assert.match(pine, /var table evaluationPanel = table\.new\(position\.bottom_right/, "evaluation does not overlap the direction panel");
assert.doesNotMatch(pine, /strategy\.(entry|exit|order)\(/, "observations do not place simulated trades");
console.log("signal_observation: deterministic checks passed");
