import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const e5Manifest = JSON.parse(readFileSync(join(root, "src/models/model-manifest.json"), "utf8")) as { model_id: string };
const rerankManifest = JSON.parse(readFileSync(join(root, "src/models/rerank-manifest.json"), "utf8")) as { model_id: string; artifacts?: readonly { path?: unknown }[] };
const e5Id: string = e5Manifest.model_id;
const rerankId: string = rerankManifest.model_id;

test("reranker manifest uses the local Transformers artifact name", () => {
  assert.ok(rerankManifest.artifacts?.some((artifact) => artifact.path === "onnx/model_quantized.onnx"));
});

function runModels(...args: string[]): { status: number | null; combined: string } {
  const result = spawnSync(process.execPath, ["scripts/models.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return { status: result.status, combined };
}

test("unknown model profile exits non-zero with usage mentioning profiles", () => {
  const { status, combined } = runModels("verify", "bogus-profile");
  assert.notEqual(status, 0);
  assert.match(combined, /usage/i);
  assert.match(combined, /core/);
  assert.match(combined, /all/);
  assert.match(combined, /reranker/);
});

test("verify core only mentions the E5 model id", () => {
  const { status, combined } = runModels("verify", "core");
  assert.ok(combined.includes(e5Id), `expected E5 id ${e5Id} in output:\n${combined}`);
  assert.equal(combined.includes(rerankId), false, `unexpected reranker id ${rerankId} in output:\n${combined}`);
  if (status !== 0) {
    assert.match(combined, /model_artifacts_invalid/);
  } else {
    assert.match(combined, /verified/);
  }
});

test("verify all mentions both model ids when artifacts are missing", () => {
  const { status, combined } = runModels("verify", "all");
  if (status !== 0) {
    assert.match(combined, /model_artifacts_invalid/);
    assert.ok(
      combined.includes(e5Id) || combined.includes(rerankId),
      `expected at least one missing model id (${e5Id} or ${rerankId}) in output:\n${combined}`,
    );
  } else {
    assert.ok(combined.includes(e5Id), `expected E5 id ${e5Id} in output:\n${combined}`);
    assert.ok(combined.includes(rerankId), `expected reranker id ${rerankId} in output:\n${combined}`);
    assert.match(combined, /verified/);
  }
});
