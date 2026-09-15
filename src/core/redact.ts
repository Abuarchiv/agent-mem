import { ContractValidationError, CURRENT_REDACTION_POLICY_VERSION, validateBoundedJson } from "../host/contract.js";

export const DEFAULT_REDACTION_POLICY_VERSION = CURRENT_REDACTION_POLICY_VERSION;

const MAX_REDACTION_DEPTH = 64;
const MAX_REDACTION_BYTES = 4_000_000;
// Policy 1.0.0 is intentionally bounded to these credential names and token forms;
// unknown secret formats remain an explicit later policy concern.
const secretKeyPattern = /^(?:api[_-]?(?:key|secret)|access[_-]?token|refresh[_-]?token|session[_-]?token|auth(?:orization|[_-]?token)?|bearer|password|passphrase|secret|secret[_-]?(?:key|value)|client[_-]?secret|private[_-]?key|credential|credentials|cookie|set-cookie|oauth[_-]?token|github[_-]?token|token)$/i;
const privateKeyPattern = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
const bearerPattern = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const knownTokenPattern = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16})\b/g;
const knownTokenKeyPattern = /^(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16})$/i;
const jwtPattern = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const assignmentPattern = /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)/gi;
const privateTagPattern = /<\/?private>/gi;
const safePathKeys = new Set(["options", "excluded_paths", "policy_version", "max_depth", "max_bytes", "payload", "event", "text", "native_ids", "redaction"]);

export interface RedactionOptions {
  readonly policy_version?: string;
  readonly excluded_paths?: readonly string[];
  readonly max_depth?: number;
  readonly max_bytes?: number;
}

export interface RedactedCaptureInput {
  readonly value: unknown;
  readonly applied: boolean;
  readonly policy_version: string;
}

interface RedactionState {
  changed: boolean;
}

function safePathPart(part: string | number): string {
  if (typeof part === "number") return String(part);
  if (isSecretKey(part)) return "<redacted-key>";
  return safePathKeys.has(part) ? part : "<key>";
}

function isSecretKey(key: string): boolean {
  return secretKeyPattern.test(key) || knownTokenKeyPattern.test(key) || /PRIVATE KEY/i.test(key);
}

function safePath(path: readonly (string | number)[]): string {
  return path.length === 0 ? "$" : path.map(safePathPart).join(".");
}

function invalid(path: readonly (string | number)[], code: string): never {
  throw new ContractValidationError("redaction", [{ path: safePath(path), code }]);
}

function parsePointer(path: string, index: number): string[] {
  if (path === "") return [];
  if (!path.startsWith("/")) invalid(["excluded_paths", index], "must_be_json_pointer");
  return path.slice(1).split("/").map((part) => {
    if (/~(?![01])/.test(part)) invalid(["excluded_paths", index], "invalid_json_pointer_escape");
    return part.replaceAll("~1", "/").replaceAll("~0", "~");
  });
}

function pointerKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

function stripPrivateBlocks(value: string, state: RedactionState): string {
  let depth = 0;
  let segmentStart = 0;
  const output: string[] = [];
  for (const match of value.matchAll(privateTagPattern)) {
    const index = match.index ?? 0;
    const tag = match[0];
    if (depth === 0) {
      if (tag.startsWith("</")) continue;
      output.push(value.slice(segmentStart, index));
      depth = 1;
      segmentStart = index + tag.length;
      state.changed = true;
      continue;
    }
    state.changed = true;
    if (tag.startsWith("</")) {
      depth -= 1;
      if (depth === 0) segmentStart = index + tag.length;
    } else {
      depth += 1;
    }
  }
  if (depth === 0) output.push(value.slice(segmentStart));
  return output.join("");
}

function redactedText(value: string, state: RedactionState): string {
  const withoutPrivate = stripPrivateBlocks(value, state);
  const result = withoutPrivate
    .replace(privateKeyPattern, "[REDACTED_PRIVATE_KEY]")
    .replace(bearerPattern, "Bearer [REDACTED]")
    .replace(knownTokenPattern, "[REDACTED_TOKEN]")
    .replace(jwtPattern, "[REDACTED_TOKEN]")
    .replace(assignmentPattern, "[REDACTED_ASSIGNMENT]");
  if (result !== withoutPrivate) state.changed = true;
  return result;
}

function walk(
  value: unknown,
  path: readonly (string | number)[],
  depth: number,
  maxDepth: number,
  excluded: ReadonlySet<string>,
  state: RedactionState,
  active: WeakSet<object>,
): unknown {
  if (depth > maxDepth) invalid(path, "max_depth");
  if (typeof value === "string") {
    return redactedText(value, state);
  }
  if (value === null) {
    return null;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(path, "invalid_json_value");
    return value;
  }
  if (typeof value !== "object") invalid(path, "unsupported_value");
  if (active.has(value)) invalid(path, "cyclic_value");
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const childPath = [...path, index];
        if (excluded.has(pointerKey(childPath.map(String)))) {
          state.changed = true;
          output.push(null);
          continue;
        }
        let child: unknown;
        try {
          child = walk(value[index], childPath, depth + 1, maxDepth, excluded, state, active);
        } catch (error: unknown) {
          if (error instanceof ContractValidationError) throw error;
          invalid(childPath, "unsupported_value");
        }
        output.push(child);
      }
      return output;
    }
    let prototype: object | null;
    let keys: string[];
    try {
      prototype = Object.getPrototypeOf(value);
      keys = Object.keys(value);
    } catch {
      invalid(path, "unreadable_value");
    }
    if (prototype !== Object.prototype && prototype !== null) invalid(path, "unsupported_object");
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const childPath = [...path, key];
      if (path.length === 0 && key === "redaction") {
        // The source flag is untrusted; prepareCaptureInput writes fresh metadata.
        continue;
      }
      if (isSecretKey(key)) {
        state.changed = true;
        continue;
      }
      if (excluded.has(pointerKey(childPath.map(String)))) {
        state.changed = true;
        continue;
      }
      let childValue: unknown;
      try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
          invalid(childPath, "accessor_not_allowed");
        }
        childValue = descriptor.value;
      } catch (error: unknown) {
        if (error instanceof ContractValidationError) throw error;
        invalid(childPath, "unreadable_value");
      }
      const child = walk(childValue, childPath, depth + 1, maxDepth, excluded, state, active);
      output[key] = child;
    }
    return output;
  } finally {
    active.delete(value);
  }
}

function optionsForRedaction(options: RedactionOptions): { policyVersion: string; maxDepth: number; maxBytes: number; excluded: ReadonlySet<string> } {
  if (typeof options !== "object" || options === null || Array.isArray(options)) invalid(["options"], "invalid_options");
  const policyVersion = options.policy_version ?? DEFAULT_REDACTION_POLICY_VERSION;
  if (policyVersion !== CURRENT_REDACTION_POLICY_VERSION) invalid(["policy_version"], "unsupported_policy_version");
  const maxDepth = options.max_depth ?? 32;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > MAX_REDACTION_DEPTH) invalid(["max_depth"], "invalid_bound");
  const maxBytes = options.max_bytes ?? MAX_REDACTION_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_REDACTION_BYTES) invalid(["max_bytes"], "invalid_bound");
  const paths = options.excluded_paths ?? [];
  if (!Array.isArray(paths) || paths.length > 128) invalid(["excluded_paths"], "invalid_bound");
  const excluded = new Set<string>();
  for (const [index, path] of paths.entries()) {
    if (typeof path !== "string" || path.length > 512) invalid(["excluded_paths", index], "invalid_path");
    const parsedPath = parsePointer(path, index);
    if (parsedPath.length === 0) invalid(["excluded_paths", index], "root_exclusion_not_allowed");
    excluded.add(pointerKey(parsedPath));
  }
  return { policyVersion, maxDepth, maxBytes, excluded };
}

export function redactCaptureInput(input: unknown, options: RedactionOptions = {}): RedactedCaptureInput {
  const parsed = optionsForRedaction(options);
  validateBoundedJson(
    input,
    { max_depth: parsed.maxDepth, max_bytes: parsed.maxBytes, max_nodes: 100_000 },
    "redaction",
  );
  const state: RedactionState = { changed: false };
  const value = walk(input, [], 0, parsed.maxDepth, parsed.excluded, state, new WeakSet<object>());
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    (value as Record<string, unknown>).redaction = { applied: state.changed, policy_version: parsed.policyVersion };
  }
  return { value, applied: state.changed, policy_version: parsed.policyVersion };
}
