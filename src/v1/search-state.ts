import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  DEFAULT_SEARCH_WEIGHTS,
  SEARCH_SIGNALS,
  type ProcedureRule,
  type SearchKind,
  type SearchReport,
  type SignalValues,
} from "../retrieval/intelligence-types.js";
import { ensurePrivateDirectory, writePrivateJson } from "./config.js";
import { assertPrivatePath } from "./private-files.js";

export const SEARCH_STATE_FILE = "search-state.json";

const STATE_VERSION = 2;
const LEGACY_STATE_VERSION = 1;
const MAX_STATE_BYTES = 1_000_000;
const MAX_REPORTS = 128;
const MAX_FEEDBACK = 1_000;
const MAX_PROCEDURES = 128;
const REPORT_TTL_MS = 15 * 60 * 1_000;
const MIN_LEARNED_SAMPLES = 5;
const MAX_ID_LENGTH = 256;
const MAX_FEATURE = 1_000_000;
const MIN_WEIGHT = 0.01;
const MAX_WEIGHT = 2.5;

const SEARCH_KINDS: readonly SearchKind[] = ["identifier", "recent", "relation", "procedure", "semantic"];
const RERANKER_STATES = ["applied", "disabled", "unavailable", "skipped"] as const;

interface FeedbackRecord {
  scope_id: string;
  query_id: string;
  binding_id: string;
  capture_id: string;
  kind: SearchKind;
  features: SignalValues;
  useful: boolean;
  created_at: string;
}

interface PersistentState {
  version: typeof STATE_VERSION;
  feedback: FeedbackRecord[];
  procedures: ProcedureRule[];
  purge_epochs: Record<string, string>;
}

interface StoredReport {
  report: SearchReport;
  createdAtMs: number;
}

export interface SearchStateStatus {
  feedback: number;
  procedures: number;
  reports: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}

function id(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_LENGTH || value.trim().length === 0) {
    throw new Error(`search_state_${field}_invalid`);
  }
  return value;
}

function date(value: unknown, field: string): { value: string; milliseconds: number } {
  if (typeof value !== "string" || value.length === 0) throw new Error(`search_state_${field}_invalid`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`search_state_${field}_invalid`);
  return { value, milliseconds };
}

function kind(value: unknown): SearchKind {
  if (typeof value !== "string" || !SEARCH_KINDS.includes(value as SearchKind)) throw new Error("search_state_kind_invalid");
  return value as SearchKind;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_FEATURE) {
    throw new Error(`search_state_${field}_invalid`);
  }
  return value;
}

function privacyEpoch(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_ID_LENGTH || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("search_state_privacy_epoch_invalid");
  }
  return value;
}

function comparePrivacyEpoch(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  return left === right ? 0 : left < right ? -1 : 1;
}

function signalValues(value: unknown, field: string): SignalValues {
  if (!isRecord(value) || !exactKeys(value, SEARCH_SIGNALS)) throw new Error(`search_state_${field}_invalid`);
  const result = {} as SignalValues;
  for (const signal of SEARCH_SIGNALS) result[signal] = finiteNumber(value[signal], `${field}_${signal}`);
  return result;
}

function cloneSignals(value: SignalValues): SignalValues {
  return { ...value };
}

function cloneReport(value: SearchReport): SearchReport {
  return {
    ...value,
    stages: [...value.stages],
    weights: cloneSignals(value.weights),
    candidates: value.candidates.map((candidate) => ({ capture_id: candidate.capture_id, features: cloneSignals(candidate.features) })),
    procedure_ids: [...value.procedure_ids],
  };
}

function cloneProcedure(value: ProcedureRule): ProcedureRule {
  return { scope_id: value.scope_id, capture_id: value.capture_id, terms: [...value.terms] };
}

function validateProcedure(value: unknown): ProcedureRule {
  if (!isRecord(value) || !exactKeys(value, ["scope_id", "capture_id", "terms"])) throw new Error("search_state_procedure_invalid");
  const scopeId = id(value.scope_id, "scope_id");
  const captureId = id(value.capture_id, "capture_id");
  if (!Array.isArray(value.terms) || value.terms.length > 32) throw new Error("search_state_procedure_terms_invalid");
  const terms = value.terms.map((term) => {
    if (typeof term !== "string" || term.length === 0 || term.length > 128 || term.trim().length === 0) {
      throw new Error("search_state_procedure_terms_invalid");
    }
    return term;
  });
  return { scope_id: scopeId, capture_id: captureId, terms };
}

function validateFeedback(value: unknown): FeedbackRecord {
  if (!isRecord(value) || !exactKeys(value, ["scope_id", "query_id", "binding_id", "capture_id", "kind", "features", "useful", "created_at"])) {
    throw new Error("search_state_feedback_invalid");
  }
  const createdAt = date(value.created_at, "feedback_created_at");
  if (typeof value.useful !== "boolean") throw new Error("search_state_feedback_invalid");
  return {
    scope_id: id(value.scope_id, "scope_id"),
    query_id: id(value.query_id, "query_id"),
    binding_id: id(value.binding_id, "binding_id"),
    capture_id: id(value.capture_id, "capture_id"),
    kind: kind(value.kind),
    features: signalValues(value.features, "feedback_features"),
    useful: value.useful,
    created_at: createdAt.value,
  };
}

function validateReport(value: SearchReport): { report: SearchReport; createdAtMs: number } {
  if (!isRecord(value) || !exactKeys(value, [
    "query_id", "binding_id", "scope_id", "kind", "created_at", "stages", "reranker", "graph_hops", "graph_added",
    "graph_complete", "weights", "learned_samples", "candidates", "procedure_ids",
  ])) throw new Error("search_state_report_invalid");
  const createdAt = date(value.created_at, "report_created_at");
  if (!Array.isArray(value.stages) || value.stages.length > 128 || value.stages.some((stage) => typeof stage !== "string" || stage.length === 0 || stage.length > 128)) {
    throw new Error("search_state_report_stages_invalid");
  }
  if (typeof value.reranker !== "string" || !RERANKER_STATES.includes(value.reranker as typeof RERANKER_STATES[number])) {
    throw new Error("search_state_report_reranker_invalid");
  }
  if (!Number.isSafeInteger(value.graph_hops) || value.graph_hops < 0 || value.graph_hops > 2) throw new Error("search_state_report_graph_hops_invalid");
  if (!Number.isSafeInteger(value.graph_added) || value.graph_added < 0 || value.graph_added > MAX_FEEDBACK) throw new Error("search_state_report_graph_added_invalid");
  if (typeof value.graph_complete !== "boolean") throw new Error("search_state_report_graph_complete_invalid");
  if (!Number.isSafeInteger(value.learned_samples) || value.learned_samples < 0 || value.learned_samples > MAX_FEEDBACK) throw new Error("search_state_report_samples_invalid");
  if (!Array.isArray(value.candidates) || value.candidates.length > 256) throw new Error("search_state_report_candidates_invalid");
  const candidates = value.candidates.map((candidate) => {
    if (!isRecord(candidate) || !exactKeys(candidate, ["capture_id", "features"])) throw new Error("search_state_report_candidate_invalid");
    return { capture_id: id(candidate.capture_id, "capture_id"), features: signalValues(candidate.features, "candidate_features") };
  });
  if (!Array.isArray(value.procedure_ids) || value.procedure_ids.length > MAX_PROCEDURES) throw new Error("search_state_report_procedures_invalid");
  const procedureIds = value.procedure_ids.map((procedureId) => id(procedureId, "procedure_id"));
  const report: SearchReport = {
    query_id: id(value.query_id, "query_id"),
    binding_id: id(value.binding_id, "binding_id"),
    scope_id: id(value.scope_id, "scope_id"),
    kind: kind(value.kind),
    created_at: createdAt.value,
    stages: [...value.stages],
    reranker: value.reranker as SearchReport["reranker"],
    graph_hops: value.graph_hops,
    graph_added: value.graph_added,
    graph_complete: value.graph_complete,
    weights: signalValues(value.weights, "report_weights"),
    learned_samples: value.learned_samples,
    candidates,
    procedure_ids: procedureIds,
  };
  return { report, createdAtMs: createdAt.milliseconds };
}

function emptyState(): PersistentState {
  return { version: STATE_VERSION, feedback: [], procedures: [], purge_epochs: {} };
}

function validateRecords(value: Record<string, unknown>): { feedback: FeedbackRecord[]; procedures: ProcedureRule[] } {
  if (!Array.isArray(value.feedback) || value.feedback.length > MAX_FEEDBACK) throw new Error("search_state_feedback_limit");
  if (!Array.isArray(value.procedures) || value.procedures.length > MAX_PROCEDURES) throw new Error("search_state_procedure_limit");
  return {
    feedback: value.feedback.map(validateFeedback),
    procedures: value.procedures.map(validateProcedure),
  };
}

function validatePersistentState(value: unknown): { state: PersistentState; migrated: boolean } {
  if (!isRecord(value) || typeof value.version !== "number") throw new Error("search_state_invalid");
  if (value.version === LEGACY_STATE_VERSION) {
    if (!exactKeys(value, ["version", "feedback", "procedures"])) throw new Error("search_state_invalid");
    return { state: { version: STATE_VERSION, ...validateRecords(value), purge_epochs: {} }, migrated: true };
  }
  if (value.version !== STATE_VERSION || !exactKeys(value, ["version", "feedback", "procedures", "purge_epochs"])) {
    throw new Error("search_state_invalid");
  }
  if (!isRecord(value.purge_epochs)) throw new Error("search_state_purge_epochs_invalid");
  const purgeEpochs = Object.fromEntries(
    Object.entries(value.purge_epochs).map(([scopeId, epoch]) => [id(scopeId, "scope_id"), privacyEpoch(epoch)]),
  );
  return { state: { version: STATE_VERSION, ...validateRecords(value), purge_epochs: purgeEpochs }, migrated: false };
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function assertPrivateStateFile(path: string): void {
  let linkInfo;
  try { linkInfo = lstatSync(path); }
  catch (error: unknown) { if (missing(error)) return; throw new Error("search_state_file_must_be_owned_and_private", { cause: error }); }
  if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) {
    throw new Error("search_state_file_must_be_owned_and_private");
  }
  if (linkInfo.size > MAX_STATE_BYTES) throw new Error("search_state_file_too_large");
  assertPrivatePath(path, linkInfo, "search_state_file_must_be_owned_and_private");
}

function readPersistentState(path: string): { state: PersistentState; migrated: boolean } {
  let linkInfo;
  try { linkInfo = lstatSync(path); }
  catch (error: unknown) { if (missing(error)) return { state: emptyState(), migrated: false }; throw new Error("search_state_file_must_be_owned_and_private", { cause: error }); }
  if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) {
    throw new Error("search_state_file_must_be_owned_and_private");
  }
  if (linkInfo.size > MAX_STATE_BYTES) throw new Error("search_state_file_too_large");
  assertPrivatePath(path, linkInfo, "search_state_file_must_be_owned_and_private");

  let fileDescriptor: number;
  try { fileDescriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error: unknown) { throw new Error("search_state_file_must_be_owned_and_private", { cause: error }); }
  try {
    const fileInfo = fstatSync(fileDescriptor);
    if (!fileInfo.isFile() || fileInfo.size > MAX_STATE_BYTES) {
      if (fileInfo.size > MAX_STATE_BYTES) throw new Error("search_state_file_too_large");
      throw new Error("search_state_file_must_be_owned_and_private");
    }
    assertPrivatePath(path, fileInfo, "search_state_file_must_be_owned_and_private");
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(fileDescriptor, "utf8")) as unknown; }
    catch (error: unknown) { throw new Error("search_state_invalid", { cause: error }); }
    try { return validatePersistentState(parsed); }
    catch (error: unknown) {
      if (error instanceof Error && error.message.startsWith("search_state_")) throw error;
      throw new Error("search_state_invalid", { cause: error });
    }
  } finally {
    closeSync(fileDescriptor);
  }
}

function stateBytes(state: PersistentState): string {
  const text = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_STATE_BYTES) throw new Error("search_state_file_too_large");
  return text;
}

function tokens(value: string): string[] {
  const segmenter = new Intl.Segmenter("und", { granularity: "word" });
  const result: string[] = [];
  for (const segment of segmenter.segment(value)) {
    if (segment.isWordLike) result.push(segment.segment.toLocaleLowerCase("und"));
  }
  if (result.length > 0) return result;
  const fallback: string[] = [];
  let current = "";
  for (const character of value.toLocaleLowerCase("und")) {
    if (character.trim().length === 0) {
      if (current.length > 0) fallback.push(current);
      current = "";
    } else current += character;
  }
  if (current.length > 0) fallback.push(current);
  return fallback;
}

function containsPhrase(queryTokens: readonly string[], termTokens: readonly string[]): boolean {
  if (termTokens.length === 0 || termTokens.length > queryTokens.length) return false;
  for (let start = 0; start <= queryTokens.length - termTokens.length; start += 1) {
    if (termTokens.every((token, offset) => queryTokens[start + offset] === token)) return true;
  }
  return false;
}

function bounded(value: number): number {
  return Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, Number.isFinite(value) ? value : 1));
}

function learnedWeights(records: readonly FeedbackRecord[]): SignalValues {
  const result = { ...DEFAULT_SEARCH_WEIGHTS };
  for (const signal of SEARCH_SIGNALS) {
    let useful = 0;
    let notUseful = 0;
    for (const record of records) {
      const feature = Math.min(1, Math.max(0, Math.abs(record.features[signal])));
      if (record.useful) useful += feature;
      else notUseful += feature;
    }
    if (useful + notUseful === 0) continue;
    const rate = (useful + 1) / (useful + notUseful + 2);
    result[signal] = bounded(DEFAULT_SEARCH_WEIGHTS[signal] + (rate - 0.5) * 1.5);
  }
  return result;
}

function key(queryId: string, bindingId: string): string {
  return `${queryId}\u0000${bindingId}`;
}

export class SearchState {
  private readonly statePath: string;
  private feedbackRecords: FeedbackRecord[];
  private procedureRules: ProcedureRule[];
  private purgeEpochs: Record<string, string>;
  private readonly reports = new Map<string, StoredReport>();

  constructor(directory: string) {
    if (typeof directory !== "string" || directory.length === 0) throw new Error("search_state_directory_invalid");
    const root = resolve(directory);
    ensurePrivateDirectory(root);
    this.statePath = join(root, SEARCH_STATE_FILE);
    const loaded = readPersistentState(this.statePath);
    this.feedbackRecords = loaded.state.feedback;
    this.procedureRules = loaded.state.procedures;
    this.purgeEpochs = loaded.state.purge_epochs;
    if (loaded.migrated) this.persist();
  }

  weights(scopeId: string, searchKind: SearchKind): SignalValues {
    const scope = id(scopeId, "scope_id");
    const kindValue = kind(searchKind);
    const records = this.feedbackRecords.filter((record) => record.scope_id === scope && record.kind === kindValue);
    return records.length < MIN_LEARNED_SAMPLES ? { ...DEFAULT_SEARCH_WEIGHTS } : learnedWeights(records);
  }

  sampleCount(scopeId: string, searchKind: SearchKind): number {
    const scope = id(scopeId, "scope_id");
    const kindValue = kind(searchKind);
    return this.feedbackRecords.filter((record) => record.scope_id === scope && record.kind === kindValue).length;
  }

  remember(input: SearchReport): void {
    const stored = validateReport(input);
    this.pruneReports(Date.now());
    const reportKey = key(stored.report.query_id, stored.report.binding_id);
    this.reports.delete(reportKey);
    this.reports.set(reportKey, stored);
    while (this.reports.size > MAX_REPORTS) {
      const oldest = this.reports.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.reports.delete(oldest);
    }
  }

  report(queryId: string, bindingId: string): SearchReport | undefined {
    const query = id(queryId, "query_id");
    const binding = id(bindingId, "binding_id");
    this.pruneReports(Date.now());
    const stored = this.reports.get(key(query, binding));
    return stored === undefined ? undefined : cloneReport(stored.report);
  }

  feedback(scopeId: string, queryId: string, captureId: string, useful: boolean): { samples: number; weights: SignalValues } {
    const scope = id(scopeId, "scope_id");
    const query = id(queryId, "query_id");
    const capture = id(captureId, "capture_id");
    if (typeof useful !== "boolean") throw new Error("search_state_feedback_label_invalid");
    const now = Date.now();
    const queryReports = [...this.reports.values()].filter((stored) => stored.report.query_id === query);
    const freshReports = queryReports.filter((stored) => now - stored.createdAtMs <= REPORT_TTL_MS);
    this.pruneReports(now);
    if (queryReports.length > 0 && freshReports.length === 0) throw new Error("feedback_report_stale");
    if (freshReports.length === 0) throw new Error("feedback_report_missing");
    const scopedReports = freshReports.filter((stored) => stored.report.scope_id === scope);
    if (scopedReports.length === 0) throw new Error("feedback_scope_mismatch");
    if (scopedReports.length !== 1 || freshReports.length !== 1) throw new Error("feedback_report_ambiguous");
    const selected = scopedReports[0]!.report;
    const candidates = selected.candidates.filter((candidate) => candidate.capture_id === capture);
    if (candidates.length === 0) throw new Error("feedback_candidate_missing");
    if (candidates.length > 1) throw new Error("feedback_candidate_ambiguous");
    if (this.feedbackRecords.some((record) => record.scope_id === scope && record.query_id === selected.query_id && record.binding_id === selected.binding_id && record.capture_id === capture)) {
      throw new Error("feedback_already_recorded");
    }

    const record: FeedbackRecord = {
      scope_id: scope,
      query_id: selected.query_id,
      binding_id: selected.binding_id,
      capture_id: capture,
      kind: selected.kind,
      features: cloneSignals(candidates[0]!.features),
      useful,
      created_at: new Date().toISOString(),
    };
    const next = [...this.feedbackRecords, record];
    const boundedNext = next.length > MAX_FEEDBACK ? next.slice(next.length - MAX_FEEDBACK) : next;
    this.persist(this.procedureRules, boundedNext);
    this.feedbackRecords = boundedNext;
    return { samples: this.sampleCount(scope, selected.kind), weights: this.weights(scope, selected.kind) };
  }

  registerProcedure(input: ProcedureRule): void {
    const rule = validateProcedure(input);
    const index = this.procedureRules.findIndex((candidate) => candidate.scope_id === rule.scope_id && candidate.capture_id === rule.capture_id);
    const next = [...this.procedureRules];
    if (index === -1) {
      if (next.length >= MAX_PROCEDURES) throw new Error("search_state_procedure_limit");
      next.push(rule);
    } else next[index] = rule;
    this.persist(next);
    this.procedureRules = next;
  }

  removeProcedure(scopeId: string, captureId: string): void {
    const scope = id(scopeId, "scope_id");
    const capture = id(captureId, "capture_id");
    const next = this.procedureRules.filter((rule) => !(rule.scope_id === scope && rule.capture_id === capture));
    if (next.length === this.procedureRules.length) return;
    this.persist(next);
    this.procedureRules = next;
  }

  procedures(scopeId: string): ProcedureRule[] {
    const scope = id(scopeId, "scope_id");
    return this.procedureRules.filter((rule) => rule.scope_id === scope).map(cloneProcedure);
  }

  matchingProcedures(scopeId: string, query: string): ProcedureRule[] {
    const scope = id(scopeId, "scope_id");
    if (typeof query !== "string" || query.length > 100_000) throw new Error("search_state_query_invalid");
    const queryTokens = tokens(query);
    return this.procedureRules
      .filter((rule) => rule.scope_id === scope && (rule.terms.length === 0 || rule.terms.some((term) => containsPhrase(queryTokens, tokens(term)))))
      .map(cloneProcedure);
  }

  forgetSources(scopeId: string, ids: readonly string[]): void {
    const scope = id(scopeId, "scope_id");
    if (!Array.isArray(ids) || ids.length > MAX_FEEDBACK) throw new Error("search_state_forget_ids_invalid");
    const forgotten = new Set(ids.map((captureId) => id(captureId, "capture_id")));
    if (forgotten.size === 0) return;
    // Indirect graph/ranking dependencies can include any source in this scope.
    // Reset its learned weights rather than retain influence from deleted evidence.
    const nextFeedback = this.feedbackRecords.filter((record) => record.scope_id !== scope);
    const nextProcedures = this.procedureRules.filter((rule) => rule.scope_id !== scope || !forgotten.has(rule.capture_id));
    if (nextFeedback.length !== this.feedbackRecords.length || nextProcedures.length !== this.procedureRules.length) {
      this.persist(nextProcedures, nextFeedback);
      this.feedbackRecords = nextFeedback;
      this.procedureRules = nextProcedures;
    }
    this.pruneReports(Date.now());
    for (const [reportKey, stored] of this.reports) {
      if (stored.report.scope_id !== scope) continue;
      this.reports.delete(reportKey);
    }
  }

  reconcilePurges(scopeId: string, privacyEpochValue: string, ids: readonly string[]): void {
    const scope = id(scopeId, "scope_id");
    const epoch = privacyEpoch(privacyEpochValue);
    if (!Array.isArray(ids) || ids.length > MAX_FEEDBACK) throw new Error("search_state_forget_ids_invalid");
    const forgotten = new Set(ids.map((captureId) => id(captureId, "capture_id")));
    const previousEpoch = this.purgeEpochs[scope];
    if (previousEpoch !== undefined) {
      const comparison = comparePrivacyEpoch(epoch, previousEpoch);
      if (comparison === 0) return;
      if (comparison < 0) throw new Error("search_state_privacy_epoch_regressed");
    }

    const nextFeedback = this.feedbackRecords.filter((record) => record.scope_id !== scope);
    const nextProcedures = this.procedureRules.filter((rule) => rule.scope_id !== scope || !forgotten.has(rule.capture_id));
    const nextPurgeEpochs = { ...this.purgeEpochs, [scope]: epoch };
    this.persist(nextProcedures, nextFeedback, nextPurgeEpochs);
    this.feedbackRecords = nextFeedback;
    this.procedureRules = nextProcedures;
    this.purgeEpochs = nextPurgeEpochs;
    for (const [reportKey, stored] of this.reports) {
      if (stored.report.scope_id === scope) this.reports.delete(reportKey);
    }
  }

  clearReports(): void {
    this.reports.clear();
  }

  status(): SearchStateStatus {
    this.pruneReports(Date.now());
    return { feedback: this.feedbackRecords.length, procedures: this.procedureRules.length, reports: this.reports.size };
  }

  private pruneReports(now: number): void {
    for (const [reportKey, stored] of this.reports) {
      if (now - stored.createdAtMs > REPORT_TTL_MS) this.reports.delete(reportKey);
    }
  }

  private persist(
    procedures = this.procedureRules,
    feedback = this.feedbackRecords,
    purgeEpochs = this.purgeEpochs,
  ): void {
    const state: PersistentState = { version: STATE_VERSION, feedback, procedures, purge_epochs: purgeEpochs };
    stateBytes(state);
    assertPrivateStateFile(this.statePath);
    readPersistentState(this.statePath);
    writePrivateJson(this.statePath, state);
  }
}
