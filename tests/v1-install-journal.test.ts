import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  INSTALL_JOURNAL_PHASES,
  InstallJournalError,
  createInstallJournal,
  readInstallJournal,
  updateInstallJournal,
  writeInstallJournal,
} from "../src/v1/install-journal.js";

function setup(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "v1-install-journal-"));
  return { directory, path: join(directory, "install.json") };
}

function teardown(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

function expectJournalError(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof InstallJournalError && error.code === code;
}

test("install journal round-trips through a private file without secrets", () => {
  const { directory, path } = setup();
  try {
    const created = createInstallJournal({ project: directory, hosts: ["codex", "opencode"], rerank: true });
    assert.equal(created.version, 1);
    assert.equal(created.attempts, 0);
    assert.equal(created.lastErrorCode, null);
    assert.equal(created.lastGoodPhase, null);
    assert.deepEqual([...Object.keys(created.phases)].sort(), [...INSTALL_JOURNAL_PHASES].sort());
    const written = writeInstallJournal(path, created);
    const read = readInstallJournal(path);
    assert.deepEqual(read, written);
    assert.equal(read.project, directory);
    assert.ok(!("secret_hex" in read) && !("source" in read));
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.throws(() => createInstallJournal({ project: "relative/path", hosts: ["codex"], rerank: false }), expectJournalError("install_journal_malformed"));
  } finally {
    teardown(directory);
  }
});
test("install journal replacement is atomic and leaves no temp files", () => {
  const { directory, path } = setup();
  try {
    writeInstallJournal(path, createInstallJournal({ project: directory, hosts: ["codex"], rerank: false }));
    const before = statSync(path);
    const updated = updateInstallJournal(path, (current) => ({
      ...current,
      phases: { ...current.phases, detect: "completed" },
      currentPhase: "plan",
      lastGoodPhase: "detect",
    }));
    assert.equal(updated.currentPhase, "plan");
    assert.equal(updated.lastGoodPhase, "detect");
    assert.equal(readInstallJournal(path).phases.detect, "completed");
    assert.deepEqual(readdirSync(directory), ["install.json"]);
    const after = statSync(path);
    assert.equal(after.dev, before.dev);
    assert.notEqual(after.ino, before.ino);
    assert.ok(!readFileSync(path, "utf8").includes("secret"));
  } finally {
    teardown(directory);
  }
});

test("install journal rejects malformed data", () => {
  const { directory, path } = setup();
  try {
    writeFileSync(path, "{not json", { mode: 0o600 });
    assert.throws(() => readInstallJournal(path), expectJournalError("install_journal_malformed"));
    writeFileSync(path, "[]", { mode: 0o600 });
    assert.throws(() => readInstallJournal(path), expectJournalError("install_journal_malformed"));
    assert.throws(() => readInstallJournal(join(directory, "absent.json")), expectJournalError("install_journal_missing"));
    assert.throws(() => readInstallJournal(join(directory, "new", "absent.json")), expectJournalError("install_journal_missing"));
  } finally {
    teardown(directory);
  }
});

test("install journal rejects unknown versions, keys, and phases", () => {
  const { directory, path } = setup();
  try {
    const base = createInstallJournal({ project: directory, hosts: ["codex"], rerank: false });
    writeFileSync(path, JSON.stringify({ ...base, version: 2 }), { mode: 0o600 });
    assert.throws(() => readInstallJournal(path), expectJournalError("install_journal_unknown"));
    writeFileSync(path, JSON.stringify({ ...base, secret_hex: "00".repeat(32) }), { mode: 0o600 });
    assert.throws(() => readInstallJournal(path), expectJournalError("install_journal_unknown"));
    writeFileSync(path, JSON.stringify({ ...base, phases: { ...base.phases, someday: "pending" } }), { mode: 0o600 });
    assert.throws(() => readInstallJournal(path), expectJournalError("install_journal_unknown"));
    writeFileSync(path, JSON.stringify({ ...base, currentPhase: "someday" }), { mode: 0o600 });
    assert.throws(() => readInstallJournal(path), expectJournalError("install_journal_unknown"));
  } finally {
    teardown(directory);
  }
});

test("install journal rejects stale data by age and by concurrent update", () => {
  const { directory, path } = setup();
  try {
    const base = createInstallJournal({ project: directory, hosts: ["codex"], rerank: false });
    writeInstallJournal(path, { ...base, updatedAt: "2020-01-01T00:00:00.000Z" });
    assert.throws(() => readInstallJournal(path, { maxAgeMs: 1000 }), expectJournalError("install_journal_stale"));
    assert.equal(readInstallJournal(path).attempts, 0);

    const staleBase = readInstallJournal(path);
    writeInstallJournal(path, { ...staleBase, currentPhase: "plan", updatedAt: "2020-01-02T00:00:00.000Z" });
    assert.throws(
      () => updateInstallJournal(path, (current) => current, { expectedUpdatedAt: staleBase.updatedAt }),
      expectJournalError("install_journal_stale"),
    );
  } finally {
    teardown(directory);
  }
});

test("install journal enforces the three-attempt bound", () => {
  const { directory, path } = setup();
  try {
    writeInstallJournal(path, createInstallJournal({ project: directory, hosts: ["codex"], rerank: false }));
    const third = updateInstallJournal(path, (current) => ({ ...current, attempts: 3, lastErrorCode: "install_smoke_failed" }));
    assert.equal(third.attempts, 3);
    assert.throws(
      () => updateInstallJournal(path, (current) => ({ ...current, attempts: current.attempts + 1 })),
      expectJournalError("install_journal_attempts_exceeded"),
    );
    assert.equal(readInstallJournal(path).attempts, 3);
  } finally {
    teardown(directory);
  }
});

test("install journal never follows symlinks", { skip: process.platform === "win32" }, () => {
  const { directory, path } = setup();
  try {
    const target = join(directory, "target.json");
    writeInstallJournal(target, createInstallJournal({ project: directory, hosts: ["codex"], rerank: false }));
    symlinkSync(target, path);
    assert.throws(() => readInstallJournal(path), expectJournalError("install_journal_unverified"));
  } finally {
    teardown(directory);
  }
});
