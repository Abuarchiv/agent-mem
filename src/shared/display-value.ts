type CanonicalValueType = "text" | "integer" | "number" | "boolean" | "date" | "json";

const canonicalValueTypes: ReadonlySet<string> = new Set(["text", "integer", "number", "boolean", "date", "json"]);

interface CanonicalValue {
  readonly type: CanonicalValueType;
  readonly value: unknown;
}

function canonicalValue(value: unknown): CanonicalValue | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes("type") || !keys.includes("value")) return undefined;
  if (typeof record.type !== "string" || !canonicalValueTypes.has(record.type)) return undefined;
  return { type: record.type as CanonicalValueType, value: record.value };
}

function jsonText(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? "—" : text;
  } catch {
    return "—";
  }
}

/** Render one canonical typed value without exposing its storage envelope. */
export function formatDisplayValue(value: unknown): string {
  const canonical = canonicalValue(value);
  if (canonical === undefined) return jsonText(value);
  if (canonical.type === "json") return jsonText(canonical.value);
  if ((canonical.type === "text" || canonical.type === "date") && typeof canonical.value === "string") return canonical.value;
  if ((canonical.type === "integer" || canonical.type === "number") && (typeof canonical.value === "number" || typeof canonical.value === "string")) return String(canonical.value);
  if (canonical.type === "boolean" && typeof canonical.value === "boolean") return canonical.value ? "true" : "false";
  return jsonText(value);
}

/** Format only summaries with an exact canonical JSON value after `predicate: `. */
export function formatSummaryText(content: string): string {
  const separator = content.indexOf(": ");
  if (separator <= 0) return content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(separator + 2)) as unknown;
  } catch {
    return content;
  }
  if (canonicalValue(parsed) === undefined) return content;
  return `${content.slice(0, separator)}: ${formatDisplayValue(parsed)}`;
}
