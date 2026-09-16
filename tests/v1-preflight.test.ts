import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseInstallBundleManifest, packageTarget, safeBundlePath, verifyVectorCapability } from "../src/v1/preflight.js";

test("bundle preflight accepts the pinned package shape and rejects target drift", () => {
  const manifest = parseInstallBundleManifest({
    version: "1.0.0",
    platform: "darwin",
    arch: "arm64",
    node: "v24.20.0",
    profile: "core-v1",
    files: [],
  });
  assert.equal(manifest.profile, "core-v1");
  assert.equal(packageTarget(manifest), "darwin-arm64");
  assert.throws(() => parseInstallBundleManifest({ ...manifest, platform: "plan9" }), /install_bundle_manifest_invalid/);
});

test("bundle preflight refuses traversal and malformed manifests", () => {
  assert.equal(safeBundlePath("/tmp/package", "dist-v1/scripts/v1.js"), "/tmp/package/dist-v1/scripts/v1.js");
  assert.throws(() => safeBundlePath("/tmp/package", "../secret"), /install_bundle_path_invalid/);
  assert.throws(() => safeBundlePath("/tmp/package", "/etc/passwd"), /install_bundle_path_invalid/);
  assert.throws(() => parseInstallBundleManifest({ version: "1.0.0", platform: "darwin" }), /install_bundle_manifest_invalid/);
  assert.throws(() => parseInstallBundleManifest({ version: "1.0.0", platform: "darwin", arch: "arm64", node: "v24.20.0", profile: "unknown", files: [] }), /install_bundle_manifest_invalid/);
});

test("bundle preflight proves bundled sqlite-vec assets and reports fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "v1-preflight-vector-"));
  try {
    const asset = "vec0.dylib";
    const relativeAsset = `dist-v1/src/native/${asset}`;
    const assetPath = join(root, relativeAsset);
    const bytes = Buffer.from("synthetic sqlite vec asset");
    mkdirSync(join(root, "dist-v1/src/native"), { recursive: true });
    writeFileSync(assetPath, bytes, { mode: 0o600 });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const manifest = parseInstallBundleManifest({
      version: "1.0.0",
      platform: "darwin",
      arch: "arm64",
      node: "v24.20.0",
      profile: "core-v1",
      sqlite_vec: { state: "bundled", target: "darwin-arm64", asset },
      files: [{ path: relativeAsset, bytes: bytes.length, sha256 }],
    });
    assert.deepEqual(verifyVectorCapability(root, manifest), { state: "bundled", target: "darwin-arm64", asset, sha256 });
    assert.deepEqual(verifyVectorCapability(root, { ...manifest, sqlite_vec: { state: "fallback", reason: "sqlite_vec_platform_unsupported" } }), {
      state: "fallback",
      reason: "sqlite_vec_platform_unsupported",
    });
    writeFileSync(assetPath, Buffer.from("tampered"), { mode: 0o600 });
    assert.throws(() => verifyVectorCapability(root, manifest), /install_bundle_vector_asset_tampered/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bundle preflight rejects an unlisted or missing sqlite-vec asset", () => {
  const root = mkdtempSync(join(tmpdir(), "v1-preflight-vector-missing-"));
  try {
    const manifest = parseInstallBundleManifest({
      version: "1.0.0",
      platform: "darwin",
      arch: "arm64",
      node: "v24.20.0",
      profile: "core-v1",
      sqlite_vec: { state: "bundled", target: "darwin-arm64", asset: "vec0.dylib" },
      files: [],
    });
    assert.throws(() => verifyVectorCapability(root, manifest), /install_bundle_vector_asset_missing/);
    mkdirSync(join(root, "dist-v1/src/native"), { recursive: true });
    writeFileSync(join(root, "dist-v1/src/native/vec0.dylib"), "asset", { mode: 0o600 });
    assert.throws(() => verifyVectorCapability(root, manifest), /install_bundle_vector_asset_unlisted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
