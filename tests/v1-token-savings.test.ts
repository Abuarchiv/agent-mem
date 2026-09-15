import assert from "node:assert/strict";
import test from "node:test";

import { aggregateSavings, measureSavings, savingsFromCounts } from "../src/context/token-savings.js";

test("measures savings with the same real unit counter", () => {
  const measurement = measureSavings({
    baseline: "one two three four",
    memory: "one two",
    countUnits: (text) => text.trim().split(/\s+/u).filter(Boolean).length,
  });
  assert.deepEqual(measurement, {
    status: "computed",
    baselineUnits: 4,
    memoryUnits: 2,
    savedUnits: 2,
    savingsPercent: 50,
  });
});

test("keeps negative savings visible when the evidence envelope is larger", () => {
  const measurement = savingsFromCounts(10, 12);
  assert.equal(measurement.status, "computed");
  assert.equal(measurement.savedUnits, -2);
  assert.equal(measurement.savingsPercent, -20);
});

test("aggregates units and reports incomplete measurement coverage", () => {
  const aggregate = aggregateSavings([
    savingsFromCounts(100, 40),
    { status: "unobserved", reason: "tokenizer_unavailable" },
    savingsFromCounts(50, 25),
  ]);
  assert.equal(aggregate.status, "partial");
  assert.equal(aggregate.measuredCases, 2);
  assert.equal(aggregate.unobservedCases, 1);
  assert.equal(aggregate.baselineUnits, 150);
  assert.equal(aggregate.memoryUnits, 65);
  assert.equal(aggregate.savedUnits, 85);
  assert.equal(aggregate.savingsPercent, (85 / 150) * 100);
});
