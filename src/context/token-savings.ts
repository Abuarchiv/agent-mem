export type TokenSavingsMeasurement =
  | {
      readonly status: "computed";
      readonly baselineUnits: number;
      readonly memoryUnits: number;
      readonly savedUnits: number;
      readonly savingsPercent: number;
    }
  | { readonly status: "unobserved"; readonly reason: string };

export interface TokenSavingsAggregate {
  readonly status: "computed" | "partial" | "unobserved";
  readonly measuredCases: number;
  readonly unobservedCases: number;
  readonly baselineUnits: number;
  readonly memoryUnits: number;
  readonly savedUnits: number;
  readonly savingsPercent: number | null;
}

function checkedCount(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field}_invalid`);
  return value;
}

export function savingsFromCounts(baselineUnits: number, memoryUnits: number): TokenSavingsMeasurement {
  const baseline = checkedCount(baselineUnits, "baseline_units");
  const memory = checkedCount(memoryUnits, "memory_units");
  if (baseline === 0) throw new Error("baseline_units_empty");
  const saved = baseline - memory;
  return {
    status: "computed",
    baselineUnits: baseline,
    memoryUnits: memory,
    savedUnits: saved,
    savingsPercent: (saved / baseline) * 100,
  };
}

export function measureSavings(input: {
  readonly baseline: string;
  readonly memory: string;
  readonly countUnits: (text: string) => number;
}): TokenSavingsMeasurement {
  return savingsFromCounts(input.countUnits(input.baseline), input.countUnits(input.memory));
}

/** Sum units before dividing; averaging percentages distorts large records. */
export function aggregateSavings(measurements: readonly TokenSavingsMeasurement[]): TokenSavingsAggregate {
  let measuredCases = 0;
  let unobservedCases = 0;
  let baselineUnits = 0;
  let memoryUnits = 0;
  for (const measurement of measurements) {
    if (measurement.status === "unobserved") {
      unobservedCases += 1;
      continue;
    }
    measuredCases += 1;
    baselineUnits += measurement.baselineUnits;
    memoryUnits += measurement.memoryUnits;
  }
  const savedUnits = baselineUnits - memoryUnits;
  return {
    status: measuredCases === 0 ? "unobserved" : unobservedCases === 0 ? "computed" : "partial",
    measuredCases,
    unobservedCases,
    baselineUnits,
    memoryUnits,
    savedUnits,
    savingsPercent: baselineUnits > 0 ? (savedUnits / baselineUnits) * 100 : null,
  };
}
