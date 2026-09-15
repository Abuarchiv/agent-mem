import assert from "node:assert/strict";
import test from "node:test";

import { parseInstallBundleManifest, packageTarget, safeBundlePath } from "../src/v1/preflight.js";

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
