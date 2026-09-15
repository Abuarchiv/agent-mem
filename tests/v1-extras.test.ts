import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ExtraError,
  RERANKER_EXTRA_ID,
  installRerankerExtra,
  ensureRerankerExtra,
  removeRerankerExtra,
  rerankerDataRoot,
  rerankerModelRoot,
  verifyRerankerExtra,
} from "../src/v1/extras.js";

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "v1-extra-"));
}

test("reranker extra paths are absolute and scoped to the data directory", () => {
  const data = fixture();
  try {
    assert.equal(RERANKER_EXTRA_ID, "reranker");
    assert.equal(rerankerDataRoot(data), join(data, "models", "rerank"));
    assert.equal(rerankerModelRoot(data).startsWith(rerankerDataRoot(data)), true);
    assert.throws(() => rerankerDataRoot("relative"), (error: unknown) => error instanceof ExtraError && error.code === "extra_path_invalid");
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test("missing and incomplete reranker artifacts are reported without network access", async () => {
  const data = fixture();
  try {
    const bundledRoot = join(data, "not-bundled");
    assert.deepEqual(await verifyRerankerExtra(data, bundledRoot), { state: "unavailable", reason: "extra_not_installed" });
    mkdirSync(rerankerModelRoot(data), { recursive: true, mode: 0o700 });
    writeFileSync(join(rerankerModelRoot(data), "config.json"), "{}", { mode: 0o600 });
    const result = await verifyRerankerExtra(data, bundledRoot);
    assert.equal(result.state, "unavailable");
    if (result.state === "unavailable") assert.equal(result.reason, "extra_artifacts_invalid");
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test("removal refuses symlinked extra roots and never follows them", () => {
  const data = fixture();
  const outside = fixture();
  try {
    mkdirSync(join(rerankerDataRoot(data), "cross-encoder", "mmarco-mMiniLMv2-L12-H384-v1"), { recursive: true, mode: 0o700 });
    symlinkSync(outside, rerankerModelRoot(data));
    writeFileSync(join(outside, "sentinel"), "keep", { mode: 0o600 });
    assert.throws(() => removeRerankerExtra(data), (error: unknown) => error instanceof ExtraError && error.code === "extra_target_unverified");
  } finally {
    rmSync(data, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a failed reranker download reports a stable error and removes staging", async () => {
  const data = fixture();
  try {
    await assert.rejects(
      installRerankerExtra(data, { bundledRoot: null, fetch: async () => new Response("not the pinned artifact", { status: 200 }) }),
      (error: unknown) => error instanceof ExtraError && error.code === "extra_download_hash_mismatch",
    );
    assert.deepEqual((await import("node:fs")).readdirSync(rerankerDataRoot(data)), []);
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test("recommended reranker activation is optional and degrades without blocking core", async () => {
  const data = fixture();
  try {
    assert.deepEqual(await ensureRerankerExtra(data, false), { enabled: false, state: "disabled", reason: null });
    const unavailable = await ensureRerankerExtra(data, true, async () => {
      throw new ExtraError("extra_download_failed");
    });
    assert.deepEqual(unavailable, { enabled: false, state: "unavailable", reason: "extra_download_failed" });
  } finally { rmSync(data, { recursive: true, force: true }); }
});
