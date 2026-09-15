import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ExtraError,
  RERANKER_EXTRA_ID,
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
    assert.deepEqual(await verifyRerankerExtra(data), { state: "unavailable", reason: "extra_not_installed" });
    mkdirSync(rerankerModelRoot(data), { recursive: true, mode: 0o700 });
    writeFileSync(join(rerankerModelRoot(data), "config.json"), "{}", { mode: 0o600 });
    const result = await verifyRerankerExtra(data);
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
