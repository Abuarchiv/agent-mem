import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import { parseContract } from "../host/contract.js";

const MAX_INT64 = 9_223_372_036_854_775_807n;

export const temporalDateTimeSchema = z.iso.datetime({ offset: true });
export const temporalPrecisionSchema = z.enum([
  "instant",
  "millisecond",
  "second",
  "minute",
  "hour",
  "day",
  "week",
  "month",
  "year",
  "unknown",
]);

const timezoneSchema = z.string().min(1).max(128);
const temporalBoundCommon = {
  precision: temporalPrecisionSchema.optional(),
  timezone: timezoneSchema.optional(),
} as const;

/** One validity endpoint. `open` is an explicit infinity; `unknown` is not. */
export const temporalBoundSchema = z.discriminatedUnion("kind", [
  z.object({ ...temporalBoundCommon, kind: z.literal("exact"), at: temporalDateTimeSchema }).strict(),
  z
    .object({
      ...temporalBoundCommon,
      kind: z.literal("uncertain"),
      earliest: temporalDateTimeSchema,
      latest: temporalDateTimeSchema,
    })
    .strict(),
  z.object({ kind: z.literal("open") }).strict(),
  z.object({ kind: z.literal("unknown") }).strict(),
]);

/**
 * An interval has an independently typed start and end. Operation semantics
 * are applied by the revision repository. observed_current does not assert a
 * future continuation.
 */
export const temporalIntentSchema = z.discriminatedUnion("validity_basis", [
  z.object({ version: z.literal(1), validity_basis: z.literal("unknown") }).strict(),
  z
    .object({
      version: z.literal(1),
      validity_basis: z.literal("observed_current"),
      observed_at: temporalDateTimeSchema,
      precision: temporalPrecisionSchema.optional(),
      timezone: timezoneSchema.optional(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      validity_basis: z.literal("interval"),
      from: temporalBoundSchema,
      to: temporalBoundSchema,
      precision: temporalPrecisionSchema.optional(),
      timezone: timezoneSchema.optional(),
    })
    .strict(),
]);

export type TemporalIntentInput = z.input<typeof temporalIntentSchema>;
export type TemporalPrecision = z.infer<typeof temporalPrecisionSchema>;
export type TemporalBound =
  | {
      readonly kind: "exact";
      readonly at: string;
      readonly original_at: string;
      readonly precision: TemporalPrecision;
      readonly timezone: string;
    }
  | {
      readonly kind: "uncertain";
      readonly earliest: string;
      readonly latest: string;
      readonly original_earliest: string;
      readonly original_latest: string;
      readonly precision: TemporalPrecision;
      readonly timezone: string;
    }
  | { readonly kind: "open" }
  | { readonly kind: "unknown" };

export type CanonicalTemporalIntent =
  | { readonly version: 1; readonly validity_basis: "unknown"; readonly json: string; readonly digest: string }
  | {
      readonly version: 1;
      readonly validity_basis: "observed_current";
      readonly observed_at: string;
      readonly original_observed_at: string;
      readonly precision: TemporalPrecision;
      readonly timezone: string;
      readonly json: string;
      readonly digest: string;
    }
  | {
      readonly version: 1;
      readonly validity_basis: "interval";
      readonly from: TemporalBound;
      readonly to: TemporalBound;
      readonly json: string;
      readonly digest: string;
    };

export interface TemporalBounds {
  readonly from: string | null;
  readonly to: string | null;
  readonly from_earliest: string | null;
  readonly from_latest: string | null;
  readonly to_earliest: string | null;
  readonly to_latest: string | null;
  readonly status: "definite" | "possible" | "unknown";
  readonly precision: TemporalPrecision | null;
  readonly timezone: string | null;
  readonly from_precision: TemporalPrecision | null;
  readonly to_precision: TemporalPrecision | null;
  readonly from_timezone: string | null;
  readonly to_timezone: string | null;
  readonly original_from: string | null;
  readonly original_to: string | null;
}

export interface TemporalIntervalPart {
  readonly from: string | null;
  readonly to: string | null;
  readonly status: "definite" | "possible" | "unknown";
  readonly precision: TemporalPrecision | null;
  readonly timezone: string | null;
  readonly from_precision: TemporalPrecision | null;
  readonly to_precision: TemporalPrecision | null;
  readonly from_timezone: string | null;
  readonly to_timezone: string | null;
  readonly original_from: string | null;
  readonly original_to: string | null;
}

export interface TemporalTransition {
  readonly earliest: string;
  readonly latest: string | null;
  readonly uncertain: boolean;
  readonly precision: TemporalPrecision;
  readonly timezone: string;
}

export class TemporalIntentError extends Error {
  constructor(message = "temporal_intent_invalid") {
    super(message);
    this.name = "TemporalIntentError";
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TemporalIntentError();
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TemporalIntentError();
}

function digestJson(json: string): string {
  return createHash("sha256").update(json, "utf8").digest("hex");
}

function exactUtc(value: unknown, field: string): { readonly original: string; readonly utc: string } {
  const parsed = temporalDateTimeSchema.safeParse(value);
  if (!parsed.success) throw new TemporalIntentError(`${field}_invalid`);
  // Date only retains milliseconds. Refuse finer input instead of silently
  // mapping two distinct instants to one boundary.
  if (/\.\d{4,}(?:Z|[+-][0-9]{2}:[0-9]{2})$/u.test(parsed.data)) {
    throw new TemporalIntentError(`${field}_precision_unsupported`);
  }
  const milliseconds = Date.parse(parsed.data);
  if (!Number.isFinite(milliseconds)) throw new TemporalIntentError(`${field}_invalid`);
  try {
    return { original: parsed.data, utc: new Date(milliseconds).toISOString() };
  } catch {
    throw new TemporalIntentError(`${field}_invalid`);
  }
}

export function normalizeTemporalDateTime(value: unknown): string {
  return exactUtc(value, "timestamp").utc;
}

function derivedTimezone(value: string): string {
  if (value.endsWith("Z")) return "UTC";
  const match = value.match(/([+-][0-9]{2}:[0-9]{2})$/u);
  return match?.[1] ?? "UTC";
}

function canonicalizeBound(
  input: z.infer<typeof temporalBoundSchema>,
  defaultPrecision: TemporalPrecision,
  defaultTimezone: string | undefined,
): TemporalBound {
  if (input.kind === "open" || input.kind === "unknown") return input;
  if (input.kind === "exact") {
    const at = exactUtc(input.at, "bound_at");
    return {
      kind: "exact",
      at: at.utc,
      original_at: at.original,
      precision: input.precision ?? defaultPrecision,
      timezone: input.timezone ?? defaultTimezone ?? derivedTimezone(at.original),
    };
  }
  const earliest = exactUtc(input.earliest, "bound_earliest");
  const latest = exactUtc(input.latest, "bound_latest");
  if (earliest.utc >= latest.utc) throw new TemporalIntentError("bound_interval_invalid");
  return {
    kind: "uncertain",
    earliest: earliest.utc,
    latest: latest.utc,
    original_earliest: earliest.original,
    original_latest: latest.original,
    precision: input.precision ?? defaultPrecision,
    timezone: input.timezone ?? defaultTimezone ?? derivedTimezone(earliest.original),
  };
}

function lowerBound(bound: TemporalBound): string | null {
  if (bound.kind === "exact") return bound.at;
  if (bound.kind === "uncertain") return bound.earliest;
  return null;
}

function upperBound(bound: TemporalBound): string | null {
  if (bound.kind === "exact") return bound.at;
  if (bound.kind === "uncertain") return bound.latest;
  return null;
}

function coreLowerBound(bound: TemporalBound): string | null {
  if (bound.kind === "exact") return bound.at;
  if (bound.kind === "uncertain") return bound.latest;
  return null;
}

function coreUpperBound(bound: TemporalBound): string | null {
  if (bound.kind === "exact") return bound.at;
  if (bound.kind === "uncertain") return bound.earliest;
  return null;
}

function boundPrecision(bound: TemporalBound): TemporalPrecision | null {
  return bound.kind === "exact" || bound.kind === "uncertain" ? bound.precision : null;
}

function boundTimezone(bound: TemporalBound): string | null {
  return bound.kind === "exact" || bound.kind === "uncertain" ? bound.timezone : null;
}

function boundOriginalLower(bound: TemporalBound): string | null {
  if (bound.kind === "exact") return bound.original_at;
  if (bound.kind === "uncertain") return bound.original_earliest;
  return null;
}

function boundOriginalUpper(bound: TemporalBound): string | null {
  if (bound.kind === "exact") return bound.original_at;
  if (bound.kind === "uncertain") return bound.original_latest;
  return null;
}

function boundOriginalCoreLower(bound: TemporalBound): string | null {
  if (bound.kind === "exact") return bound.original_at;
  if (bound.kind === "uncertain") return bound.original_latest;
  return null;
}

function boundOriginalCoreUpper(bound: TemporalBound): string | null {
  if (bound.kind === "exact") return bound.original_at;
  if (bound.kind === "uncertain") return bound.original_earliest;
  return null;
}

function withDigest<T extends Record<string, unknown>>(canonical: T): T & { readonly json: string; readonly digest: string } {
  const json = canonicalJson(canonical);
  return { ...canonical, json, digest: digestJson(json) };
}

export function canonicalizeTemporalIntent(input: unknown): CanonicalTemporalIntent {
  const parsed = parseContract(temporalIntentSchema, input, "temporal-intent");
  if (parsed.validity_basis === "unknown") return withDigest({ version: 1, validity_basis: "unknown" });
  if (parsed.validity_basis === "observed_current") {
    const observed = exactUtc(parsed.observed_at, "observed_at");
    return withDigest({
      version: 1,
      validity_basis: parsed.validity_basis,
      observed_at: observed.utc,
      original_observed_at: observed.original,
      precision: parsed.precision ?? "instant",
      timezone: parsed.timezone ?? derivedTimezone(observed.original),
    });
  }
  const defaultPrecision = parsed.precision ?? "instant";
  const from = canonicalizeBound(parsed.from, defaultPrecision, parsed.timezone);
  const to = canonicalizeBound(parsed.to, defaultPrecision, parsed.timezone);
  const lower = lowerBound(from);
  const upper = upperBound(to);
  if (lower !== null && upper !== null && lower >= upper) throw new TemporalIntentError("temporal_interval_invalid");
  return withDigest({ version: 1, validity_basis: "interval", from, to });
}

export function unknownTemporalIntent(): CanonicalTemporalIntent {
  return canonicalizeTemporalIntent({ version: 1, validity_basis: "unknown" });
}

export function temporalBounds(intent: CanonicalTemporalIntent): TemporalBounds {
  if (intent.validity_basis === "unknown") {
    return {
      from: null,
      to: null,
      from_earliest: null,
      from_latest: null,
      to_earliest: null,
      to_latest: null,
      status: "unknown",
      precision: null,
      timezone: null,
      from_precision: null,
      to_precision: null,
      from_timezone: null,
      to_timezone: null,
      original_from: null,
      original_to: null,
    };
  }
  if (intent.validity_basis === "observed_current") {
    return {
      from: intent.observed_at,
      to: null,
      from_earliest: intent.observed_at,
      from_latest: intent.observed_at,
      to_earliest: null,
      to_latest: null,
      status: "possible",
      precision: intent.precision,
      timezone: intent.timezone,
      from_precision: intent.precision,
      to_precision: null,
      from_timezone: intent.timezone,
      to_timezone: null,
      original_from: intent.original_observed_at,
      original_to: null,
    };
  }
  const fromLower = lowerBound(intent.from);
  const toUpper = upperBound(intent.to);
  const unknown = intent.from.kind === "unknown" || intent.to.kind === "unknown";
  const uncertain = intent.from.kind === "uncertain" || intent.to.kind === "uncertain";
  return {
    from: fromLower,
    to: toUpper,
    from_earliest: fromLower,
    from_latest: coreLowerBound(intent.from),
    to_earliest: coreUpperBound(intent.to),
    to_latest: toUpper,
    status: unknown ? "unknown" : uncertain ? "possible" : "definite",
    precision: boundPrecision(intent.from) ?? boundPrecision(intent.to),
    timezone: boundTimezone(intent.from) ?? boundTimezone(intent.to),
    from_precision: boundPrecision(intent.from),
    to_precision: boundPrecision(intent.to),
    from_timezone: boundTimezone(intent.from),
    to_timezone: boundTimezone(intent.to),
    original_from: boundOriginalLower(intent.from),
    original_to: boundOriginalUpper(intent.to),
  };
}

export function temporalIntervalParts(intent: CanonicalTemporalIntent): readonly TemporalIntervalPart[] {
  if (intent.validity_basis === "unknown") {
    return [{ from: null, to: null, status: "unknown", precision: null, timezone: null, from_precision: null, to_precision: null, from_timezone: null, to_timezone: null, original_from: null, original_to: null }];
  }
  if (intent.validity_basis === "observed_current") {
    return [{ from: intent.observed_at, to: null, status: "possible", precision: intent.precision, timezone: intent.timezone, from_precision: intent.precision, to_precision: null, from_timezone: intent.timezone, to_timezone: null, original_from: intent.original_observed_at, original_to: null }];
  }
  const from = intent.from;
  const to = intent.to;
  if (from.kind === "unknown" || to.kind === "unknown") {
    return [{
      from: lowerBound(from),
      to: upperBound(to),
      status: "unknown",
      precision: boundPrecision(from) ?? boundPrecision(to),
      timezone: boundTimezone(from) ?? boundTimezone(to),
      from_precision: boundPrecision(from),
      to_precision: boundPrecision(to),
      from_timezone: boundTimezone(from),
      to_timezone: boundTimezone(to),
      original_from: boundOriginalLower(from),
      original_to: boundOriginalUpper(to),
    }];
  }
  const lower = lowerBound(from);
  const upper = upperBound(to);
  const coreFrom = coreLowerBound(from);
  const coreTo = coreUpperBound(to);
  const precision = boundPrecision(from) ?? boundPrecision(to);
  const timezone = boundTimezone(from) ?? boundTimezone(to);
  const fromPrecision = boundPrecision(from);
  const toPrecision = boundPrecision(to);
  const fromTimezone = boundTimezone(from);
  const toTimezone = boundTimezone(to);
  const originalFrom = boundOriginalLower(from);
  const originalTo = boundOriginalUpper(to);
  const parts: TemporalIntervalPart[] = [];
  if (!validInterval(coreFrom, coreTo)) {
    return [{ from: lower, to: upper, status: "possible", precision, timezone, from_precision: fromPrecision, to_precision: toPrecision, from_timezone: fromTimezone, to_timezone: toTimezone, original_from: originalFrom, original_to: originalTo }];
  }
  if (from.kind === "uncertain" && validInterval(lower, coreFrom)) {
    parts.push({ from: lower, to: coreFrom, status: "possible", precision, timezone, from_precision: fromPrecision, to_precision: fromPrecision, from_timezone: fromTimezone, to_timezone: fromTimezone, original_from: boundOriginalLower(from), original_to: boundOriginalCoreLower(from) });
  }
  if (validInterval(coreFrom, coreTo)) {
    parts.push({ from: coreFrom, to: coreTo, status: "definite", precision, timezone, from_precision: fromPrecision, to_precision: toPrecision, from_timezone: fromTimezone, to_timezone: toTimezone, original_from: boundOriginalCoreLower(from), original_to: boundOriginalCoreUpper(to) });
  }
  if (to.kind === "uncertain" && validInterval(coreTo, upper)) {
    parts.push({ from: coreTo, to: upper, status: "possible", precision, timezone, from_precision: toPrecision, to_precision: toPrecision, from_timezone: toTimezone, to_timezone: toTimezone, original_from: boundOriginalCoreUpper(to), original_to: boundOriginalUpper(to) });
  }
  if (parts.length === 0 && validInterval(lower, upper)) {
    parts.push({ from: lower, to: upper, status: "possible", precision, timezone, from_precision: fromPrecision, to_precision: toPrecision, from_timezone: fromTimezone, to_timezone: toTimezone, original_from: originalFrom, original_to: originalTo });
  }
  return parts;
}

function validInterval(from: string | null, to: string | null): boolean {
  return from === null || to === null || from < to;
}

export function temporalTransition(intent: CanonicalTemporalIntent): TemporalTransition | undefined {
  if (intent.validity_basis === "unknown") return undefined;
  if (intent.validity_basis === "observed_current") {
    return { earliest: intent.observed_at, latest: null, uncertain: false, precision: intent.precision, timezone: intent.timezone };
  }
  if (intent.from.kind === "exact") return { earliest: intent.from.at, latest: null, uncertain: false, precision: intent.from.precision, timezone: intent.from.timezone };
  if (intent.from.kind === "uncertain") return { earliest: intent.from.earliest, latest: intent.from.latest, uncertain: true, precision: intent.from.precision, timezone: intent.from.timezone };
  return undefined;
}

function rowValue(row: unknown, field: string): unknown {
  if (typeof row !== "object" || row === null || !(field in row)) throw new Error(`missing ${field}`);
  return (row as Record<string, unknown>)[field];
}

function sqlBigInt(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new Error(`invalid ${field}`);
}

function sqlString(value: unknown, field: string): string {
  if (typeof value === "string") return value;
  throw new Error(`invalid ${field}`);
}

export function readDatabaseWallTime(database: DatabaseSync): string {
  const row = database.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS recorded_wall_time").get();
  const value = sqlString(rowValue(row, "recorded_wall_time"), "recorded_wall_time");
  if (!temporalDateTimeSchema.safeParse(value).success) throw new Error("database_clock_invalid");
  return value;
}

export function recordCommitClock(database: DatabaseSync, commitSeq: bigint, clock?: () => string): string {
  if (commitSeq < 0n || commitSeq > MAX_INT64) throw new Error("commit_seq_invalid");
  const wallTime = clock === undefined ? readDatabaseWallTime(database) : clock();
  if (!temporalDateTimeSchema.safeParse(wallTime).success || !Number.isFinite(Date.parse(wallTime))) throw new Error("database_clock_invalid");
  database.prepare("INSERT INTO commit_clock (commit_seq, recorded_wall_time) VALUES (?, ?)").run(commitSeq, wallTime);
  return wallTime;
}

export interface WallClockResolutionResolved {
  readonly status: "resolved";
  readonly requested_wall_time: string;
  readonly known_at_seq: string;
  readonly watermark: string;
}

export interface WallClockResolutionAmbiguous {
  readonly status: "ambiguous";
  readonly requested_wall_time: string;
  readonly known_at_seq: string;
  readonly watermark: string;
  readonly policy: "conservative_prefix";
  readonly anomaly: "clock_regression";
}

export interface WallClockResolutionUnmappable {
  readonly status: "unmappable";
  readonly requested_wall_time: string;
  readonly watermark: string;
  readonly reason: "before_clock_history" | "missing_commit_clock" | "clock_invalid";
}

export type WallClockResolution = WallClockResolutionResolved | WallClockResolutionAmbiguous | WallClockResolutionUnmappable;

interface ClockRow {
  readonly seq: bigint;
  readonly wall: string;
  readonly milliseconds: number;
}

function readClockSnapshot(database: DatabaseSync): { readonly startSeq: bigint; readonly startWall: string; readonly watermark: bigint; readonly rows: readonly ClockRow[] } {
  let committed = false;
  database.exec("BEGIN");
  try {
    const meta = database.prepare("SELECT history_start_seq, history_start_wall_time FROM commit_clock_meta WHERE id = 1").get();
    const counter = database.prepare("SELECT commit_seq FROM vault_counter WHERE id = 1").get();
    if (meta === undefined || counter === undefined) throw new Error("clock_history_missing");
    const startSeq = sqlBigInt(rowValue(meta, "history_start_seq"), "history_start_seq");
    const startWall = sqlString(rowValue(meta, "history_start_wall_time"), "history_start_wall_time");
    const watermark = sqlBigInt(rowValue(counter, "commit_seq"), "commit_seq");
    const rows = database
      .prepare(`SELECT commit_seq, recorded_wall_time FROM commit_clock WHERE commit_seq > ? AND commit_seq <= ? ORDER BY commit_seq`)
      .all(startSeq, watermark)
      .map((row) => {
        const wall = sqlString(rowValue(row, "recorded_wall_time"), "recorded_wall_time");
        const milliseconds = Date.parse(wall);
        if (!temporalDateTimeSchema.safeParse(wall).success || !Number.isFinite(milliseconds)) throw new Error("clock_invalid");
        return { seq: sqlBigInt(rowValue(row, "commit_seq"), "commit_seq"), wall, milliseconds };
      });
    database.exec("COMMIT");
    committed = true;
    return { startSeq, startWall, watermark, rows };
  } finally {
    if (!committed) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original clock read error.
      }
    }
  }
}

export function resolveWallTimeToSequence(database: DatabaseSync, requestedWallTime: string): WallClockResolution {
  const requested = temporalDateTimeSchema.safeParse(requestedWallTime);
  if (!requested.success || !Number.isFinite(Date.parse(requested.data))) {
    return { status: "unmappable", requested_wall_time: requestedWallTime, watermark: "0", reason: "clock_invalid" };
  }
  const requestedMilliseconds = Date.parse(requested.data);
  let snapshot: ReturnType<typeof readClockSnapshot>;
  try {
    snapshot = readClockSnapshot(database);
  } catch {
    return { status: "unmappable", requested_wall_time: requested.data, watermark: "0", reason: "missing_commit_clock" };
  }
  const watermark = snapshot.watermark.toString(10);
  const startMilliseconds = Date.parse(snapshot.startWall);
  if (!Number.isFinite(startMilliseconds) || requestedMilliseconds < startMilliseconds) {
    return { status: "unmappable", requested_wall_time: requested.data, watermark, reason: "before_clock_history" };
  }
  if (snapshot.watermark < snapshot.startSeq || snapshot.watermark - snapshot.startSeq !== BigInt(snapshot.rows.length)) {
    return { status: "unmappable", requested_wall_time: requested.data, watermark, reason: "missing_commit_clock" };
  }
  let previousMilliseconds = startMilliseconds;
  let regression = false;
  let selected = snapshot.startSeq;
  let cutoffReached = false;
  let matchingAfterCutoff = false;
  for (const row of snapshot.rows) {
    if (row.milliseconds < previousMilliseconds) regression = true;
    previousMilliseconds = row.milliseconds;
    if (!cutoffReached && row.milliseconds <= requestedMilliseconds) selected = row.seq;
    else if (row.milliseconds > requestedMilliseconds) cutoffReached = true;
    else if (cutoffReached && row.milliseconds <= requestedMilliseconds) matchingAfterCutoff = true;
  }
  if (regression || matchingAfterCutoff) {
    return { status: "ambiguous", requested_wall_time: requested.data, known_at_seq: selected.toString(10), watermark, policy: "conservative_prefix", anomaly: "clock_regression" };
  }
  return { status: "resolved", requested_wall_time: requested.data, known_at_seq: selected.toString(10), watermark };
}

export const resolveKnownAt = resolveWallTimeToSequence;
