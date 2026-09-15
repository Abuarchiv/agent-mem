import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";

import { V1_HOSTS, type V1Host } from "./config.js";
import { assertPrivatePath, ensurePrivateDirectory } from "./private-files.js";

export const INSTALL_JOURNAL_VERSION = 1 as const;
export const INSTALL_JOURNAL_PHASES = [
  "detect", "plan", "stage", "verify", "activate", "configure", "start", "smoke", "complete", "failed", "rollback",
] as const;
export type InstallJournalPhase = typeof INSTALL_JOURNAL_PHASES[number];
export const INSTALL_JOURNAL_STATES = ["pending", "running", "completed", "failed"] as const;
export type InstallJournalPhaseState = typeof INSTALL_JOURNAL_STATES[number];
export const MAX_INSTALL_JOURNAL_ATTEMPTS = 3;
export const INSTALL_JOURNAL_SIZE_LIMIT = 64 * 1024;

export type InstallJournalErrorCode =
  | "install_journal_missing"
  | "install_journal_malformed"
  | "install_journal_unknown"
  | "install_journal_stale"
  | "install_journal_unverified"
  | "install_journal_attempts_exceeded"
  | "install_journal_invalid";

export class InstallJournalError extends Error {
  readonly code: InstallJournalErrorCode;

  constructor(code: InstallJournalErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "InstallJournalError";
    this.code = code;
  }
}
const phaseSchema = z.enum(INSTALL_JOURNAL_PHASES);
const schema = z.object({
  version: z.literal(INSTALL_JOURNAL_VERSION),
  project: z.string().min(1).max(4096),
  hosts: z.array(z.enum(V1_HOSTS)).min(1).max(V1_HOSTS.length),
  rerank: z.boolean(),
  phases: z.record(phaseSchema, z.enum(INSTALL_JOURNAL_STATES)),
  currentPhase: phaseSchema,
  attempts: z.number().int().min(0).max(MAX_INSTALL_JOURNAL_ATTEMPTS),
  lastErrorCode: z.string().regex(/^[a-z0-9_]{1,128}$/).nullable(),
  lastGoodPhase: phaseSchema.nullable(),
  updatedAt: z.iso.datetime({ offset: true }),
}).strict();

export type InstallJournal = z.infer<typeof schema>;

export interface CreateInstallJournalInput {
  readonly project: string;
  readonly hosts: readonly V1Host[];
  readonly rerank: boolean;
}

export interface ReadInstallJournalOptions {
  readonly maxAgeMs?: number;
}

export interface UpdateInstallJournalOptions {
  readonly expectedUpdatedAt?: string;
}

const TOP_LEVEL_KEYS = new Set(["version", "project", "hosts", "rerank", "phases", "currentPhase", "attempts", "lastErrorCode", "lastGoodPhase", "updatedAt"]);

function mapIssue(issue: unknown): InstallJournalError {
  if (issue !== null && typeof issue === "object" && "code" in issue && "path" in issue) {
    const code = (issue as { code: unknown }).code;
    const path = (issue as { path: unknown }).path;
    const first = Array.isArray(path) && path.length > 0 ? String(path[0]) : "";
    if (code === "unrecognized_keys" || code === "invalid_value") return new InstallJournalError("install_journal_unknown", issue);
    if (first === "attempts") return new InstallJournalError("install_journal_attempts_exceeded", issue);
  }
  return new InstallJournalError("install_journal_malformed", issue);
}

/** Strict version-1 journal without secrets or source text; unknown keys are rejected. */
export function parseInstallJournal(value: unknown): InstallJournal {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new InstallJournalError("install_journal_malformed");
  const raw = value as Record<string, unknown>;
  if (raw.version === undefined) throw new InstallJournalError("install_journal_malformed");
  if (raw.version !== INSTALL_JOURNAL_VERSION) throw new InstallJournalError("install_journal_unknown");
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) throw new InstallJournalError("install_journal_unknown");
  }
  const phases = raw.phases;
  if (phases === null || typeof phases !== "object" || Array.isArray(phases)) throw new InstallJournalError("install_journal_malformed");
  const phaseKeys = Object.keys(phases);
  if (phaseKeys.some((key) => !(INSTALL_JOURNAL_PHASES as readonly string[]).includes(key))) throw new InstallJournalError("install_journal_unknown");
  if (phaseKeys.length !== INSTALL_JOURNAL_PHASES.length) throw new InstallJournalError("install_journal_malformed");
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw mapIssue(parsed.error.issues[0]);
  const journal = parsed.data;
  if (!isAbsolute(journal.project) || resolve(journal.project) !== journal.project) throw new InstallJournalError("install_journal_malformed");
  if (new Set(journal.hosts).size !== journal.hosts.length) throw new InstallJournalError("install_journal_malformed");
  return journal;
}

export function createInstallJournal(input: CreateInstallJournalInput): InstallJournal {
  const phases = Object.fromEntries(INSTALL_JOURNAL_PHASES.map((phase) => [phase, "pending" as const])) as Record<InstallJournalPhase, InstallJournalPhaseState>;
  return parseInstallJournal({
    version: INSTALL_JOURNAL_VERSION,
    project: input.project,
    hosts: [...input.hosts],
    rerank: input.rerank,
    phases,
    currentPhase: "detect",
    attempts: 0,
    lastErrorCode: null,
    lastGoodPhase: null,
    updatedAt: new Date().toISOString(),
  });
}

function wrapFileError(error: unknown, fallback: InstallJournalErrorCode): InstallJournalError {
  if (error instanceof InstallJournalError) return error;
  if (error instanceof Error && error.message.startsWith("install_journal_")) {
    return new InstallJournalError(error.message as InstallJournalErrorCode, error);
  }
  return new InstallJournalError(fallback, error);
}

function assertJournalParent(directory: string): void {
  if (!existsSync(directory)) return;
  try {
    assertPrivatePath(directory, undefined, "install_journal_unverified");
  } catch (error) {
    throw wrapFileError(error, "install_journal_unverified");
  }
}

/** Read and validate a journal; never follows symlinks. */
export function readInstallJournal(path: string, options: ReadInstallJournalOptions = {}): InstallJournal {
  const file = resolve(path);
  if (options.maxAgeMs !== undefined && (!Number.isSafeInteger(options.maxAgeMs) || options.maxAgeMs < 0)) {
    throw new InstallJournalError("install_journal_invalid");
  }
  assertJournalParent(dirname(file));
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new InstallJournalError("install_journal_missing", error);
    }
    throw new InstallJournalError("install_journal_unverified", error);
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > INSTALL_JOURNAL_SIZE_LIMIT) throw new InstallJournalError("install_journal_malformed");
    try {
      assertPrivatePath(file, info, "install_journal_unverified");
    } catch (error) {
      throw wrapFileError(error, "install_journal_unverified");
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(fd, "utf8")) as unknown;
    } catch (error) {
      throw new InstallJournalError("install_journal_malformed", error);
    }
    const journal = parseInstallJournal(raw);
    if (options.maxAgeMs !== undefined && Date.now() - Date.parse(journal.updatedAt) > options.maxAgeMs) {
      throw new InstallJournalError("install_journal_stale");
    }
    return journal;
  } finally {
    closeSync(fd);
  }
}

/** Validate and store a journal atomically (temp file plus rename), mode 0600. */
export function writeInstallJournal(path: string, journal: InstallJournal): InstallJournal {
  const parsed = parseInstallJournal(journal);
  const file = resolve(path);
  try {
    ensurePrivateDirectory(dirname(file));
  } catch (error) {
    throw wrapFileError(error, "install_journal_unverified");
  }
  if (existsSync(file)) {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new InstallJournalError("install_journal_unverified");
    try {
      assertPrivatePath(file, info, "install_journal_unverified");
    } catch (error) {
      throw wrapFileError(error, "install_journal_unverified");
    }
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      try {
        assertPrivatePath(temporary, fstatSync(fd), "install_journal_unverified");
      } catch (error) {
        throw wrapFileError(error, "install_journal_unverified");
      }
      writeFileSync(fd, JSON.stringify(parsed, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return parsed;
}

/** Read, mutate, re-stamp, and atomically store a journal. Attempts stay within three. */
export function updateInstallJournal(
  path: string,
  mutate: (current: InstallJournal) => InstallJournal,
  options: UpdateInstallJournalOptions = {},
): InstallJournal {
  const current = readInstallJournal(path);
  if (options.expectedUpdatedAt !== undefined && current.updatedAt !== options.expectedUpdatedAt) {
    throw new InstallJournalError("install_journal_stale");
  }
  const next = parseInstallJournal({ ...mutate(current), updatedAt: new Date().toISOString() });
  return writeInstallJournal(path, next);
}
