import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import test from "node:test";

import { assertNativeOnnxRuntime } from "../src/models/manifest.js";
import { sqliteVecAssetFilename, sqliteVecTarget } from "../src/retrieval/vec0.js";
import { ipcEndpointPath } from "../src/host/ipc-path.js";
import { nodeRuntimeArchive, nodeRuntimeDirectory, nodeRuntimeTarget, packageProfile, packageRelativePath, packageVectorCapability, sharpPlatformPackages, v1RuntimeGraph, windowsLaunchers } from "../scripts/package-v1.js";
import { isPrivateWindowsAcl } from "../src/v1/private-files.js";
import { V1_OUTPUT_TARGETS, V1_READER_SOURCE_CLASSES } from "../src/v1/service.js";

test("V1 output grants include every supported local host", () => {
  assert.deepEqual([...V1_OUTPUT_TARGETS], ["reader:codex_cli", "reader:opencode_cli", "reader:copilot_cli"]);
});

test("Node runtime packaging uses the pinned portable release for each target", () => {
  assert.equal(nodeRuntimeTarget("darwin", "arm64"), "darwin-arm64");
  assert.equal(nodeRuntimeTarget("darwin", "x64"), "darwin-x64");
  assert.equal(nodeRuntimeTarget("linux", "arm64"), "linux-arm64");
  assert.equal(nodeRuntimeTarget("linux", "x64"), "linux-x64");
  assert.equal(nodeRuntimeTarget("win32", "x64"), "win-x64");
  assert.equal(nodeRuntimeTarget("win32", "arm64"), "win-arm64");
  assert.equal(nodeRuntimeDirectory("darwin", "arm64"), "node-v24.20.0-darwin-arm64");
  assert.equal(nodeRuntimeArchive("darwin", "arm64"), "node-v24.20.0-darwin-arm64.tar.gz");
  assert.equal(nodeRuntimeArchive("win32", "arm64"), "node-v24.20.0-win-arm64.zip");
});

test("unsupported native vector targets use an explicit package fallback", () => {
  assert.deepEqual(packageVectorCapability("darwin", "arm64").state, "bundled");
  assert.deepEqual(packageVectorCapability("darwin", "x64"), { state: "fallback", reason: "sqlite_vec_platform_unsupported" });
  assert.deepEqual(packageVectorCapability("win32", "arm64"), { state: "fallback", reason: "sqlite_vec_platform_unsupported" });
});

test("V1 package profile excludes optional reranker artifacts by default", () => {
  assert.equal(packageProfile(), "core-v1");
  assert.equal(packageProfile({ withReranker: false }), "core-v1");
  assert.equal(packageProfile({ withReranker: true }), "full-v1");
});

test("the V1 package graph excludes legacy extraction and execution modules", () => {
  const graph = v1RuntimeGraph();
  assert.equal(graph.files.some((file) => /^src\/(?:execution|extraction)\//.test(file)), false);
});

test("default reader egress excludes tool and diagnostic source classes", () => {
  assert.deepEqual([...V1_READER_SOURCE_CLASSES], ["prompt", "assistant_output"]);
});

test("package graph and dependency paths are portable and cannot escape the root", () => {
  assert.equal(packageRelativePath("C:\\repo\\dist-v1", "C:\\repo\\dist-v1\\src\\ui\\server.js", win32), "src/ui/server.js");
  assert.equal(packageRelativePath("C:\\repo", "C:\\repo\\node_modules\\@img\\sharp-win32-x64", win32), "node_modules/@img/sharp-win32-x64");
  assert.equal(packageRelativePath("/repo", "/repo/node_modules/sharp", posix), "node_modules/sharp");
  assert.equal(packageRelativePath("\\\\server\\share\\repo", "\\\\server\\share\\repo\\src\\v1.js", win32), "src/v1.js");
  for (const target of ["C:\\outside\\module.js", "D:\\repo\\module.js", "C:\\repo-other\\module.js"]) {
    assert.throws(() => packageRelativePath("C:\\repo", target, win32), /package_path_outside_root/);
  }
  assert.throws(() => packageRelativePath("/repo", "/repo-other/module.js", posix), /package_path_outside_root/);
});

test("Windows sharp bundles libvips while Linux and macOS require its separate package", () => {
  assert.deepEqual(sharpPlatformPackages("win32", "x64"), ["@img/sharp-win32-x64"]);
  assert.deepEqual(sharpPlatformPackages("linux", "x64"), ["@img/sharp-linux-x64", "@img/sharp-libvips-linux-x64"]);
  assert.deepEqual(sharpPlatformPackages("linux", "arm64"), ["@img/sharp-linux-arm64", "@img/sharp-libvips-linux-arm64"]);
  assert.deepEqual(sharpPlatformPackages("darwin", "arm64"), ["@img/sharp-darwin-arm64", "@img/sharp-libvips-darwin-arm64"]);
});

test("generated Windows launchers clear Node injection variables and propagate exit status", () => {
  const { cmd, powershell } = windowsLaunchers();
  assert.match(cmd, /set "NODE_OPTIONS="/);
  assert.match(cmd, /set "NODE_PATH="/);
  assert.match(cmd, /exit \/b %errorlevel%\r\n$/);
  assert.match(powershell, /\$env:NODE_OPTIONS = \$null/);
  assert.match(powershell, /\$env:NODE_PATH = \$null/);
  assert.match(powershell, /v1\.js" @args/);
  assert.match(powershell, /\$exitCode = \$LASTEXITCODE/);
  assert.match(powershell, /finally \{/);
  assert.match(powershell, /\$env:NODE_OPTIONS = \$oldOptions/);
  assert.match(powershell, /\$env:NODE_PATH = \$oldPath/);
  assert.match(powershell, /exit \$exitCode\n$/);
});

test("Windows ACL validation rejects shared, ownerless, unknown or ineffective access", () => {
  const user = "S-1-5-21-100-200-300-1001";
  const rule = { sid: user, allow: true, rights: 2032127, inheritOnly: false };
  const privateAcl = { owner: user, user, rules: [rule, { ...rule, sid: "S-1-5-18" }, { ...rule, sid: "S-1-5-32-544" }] };
  assert.equal(isPrivateWindowsAcl(privateAcl), true);
  for (const value of [null, {}, { ...privateAcl, owner: "S-1-5-32-544" }, { ...privateAcl, rules: [] },
    { ...privateAcl, rules: [{ ...rule, inheritOnly: true }] }, { ...privateAcl, rules: [{ ...rule, rights: 1 }] },
    { ...privateAcl, rules: [{ ...rule, allow: false }] }, { ...privateAcl, rules: [...privateAcl.rules, { ...rule, sid: "S-1-1-0" }] },
    { ...privateAcl, rules: [...privateAcl.rules, { ...rule, sid: "S-1-5-32-545" }] }, { ...privateAcl, rules: [{ ...rule, rights: "FullControl" }] }]) {
    assert.equal(isPrivateWindowsAcl(value), false);
  }
});

test("owned assets allow Users read/execute and Everyone read without weakening private data", () => {
  const user = "S-1-5-21-100-200-300-1001";
  const rule = { sid: user, allow: true, rights: 2032127, inheritOnly: false };
  const acl = { owner: user, user, rules: [rule,
    { ...rule, sid: "S-1-5-18" }, { ...rule, sid: "S-1-5-32-544" },
    { ...rule, sid: "S-1-5-32-545", rights: 0x1200a9 }, // Users: ReadAndExecute + Synchronize
    { ...rule, sid: "S-1-1-0", rights: 0x20089 }, // Everyone: Read
  ] };
  assert.equal(isPrivateWindowsAcl(acl, "asset"), true);
  assert.equal(isPrivateWindowsAcl(acl), false);
  assert.equal(isPrivateWindowsAcl({ ...acl, rules: [{ ...rule, rights: 0x20089 }, ...acl.rules.slice(1)] }, "asset"), true, "asset owner need not have write access");
});

test("asset ACLs reject untrusted mutation, deletion, takeover and unknown rights", () => {
  const user = "S-1-5-21-100-200-300-1001";
  const rule = { sid: user, allow: true, rights: 2032127, inheritOnly: false };
  for (const [name, rights] of Object.entries({ WriteData: 2, AppendData: 4, WriteExtendedAttributes: 16,
    DeleteChildren: 64, WriteAttributes: 256, Delete: 0x10000, ChangePermissions: 0x40000,
    TakeOwnership: 0x80000, GenericWrite: 0x40000000, GenericAll: 0x10000000, Unknown: 0x200,
    TruncatedInteger: 0x100000001 })) {
    for (const inheritOnly of [false, true]) {
      const acl = { owner: user, user, rules: [rule, { ...rule, sid: "S-1-5-32-545", rights, inheritOnly }] };
      assert.equal(isPrivateWindowsAcl(acl, "asset"), false, `${name}, inheritOnly=${inheritOnly}`);
      assert.equal(isPrivateWindowsAcl({ ...acl, rules: [rule, { ...acl.rules[1], rights: rights + 0x1200a9 }] }, "asset"), false, `${name} plus read/execute`);
    }
  }
});

test("asset ACLs accept trusted owners and require a readable, verifiable ACL", () => {
  const user = "S-1-5-21-100-200-300-1001";
  const rule = { sid: user, allow: true, rights: 0x20089, inheritOnly: false };
  const acl = { owner: user, user, rules: [rule] };
  assert.equal(isPrivateWindowsAcl({ ...acl, owner: "S-1-5-32-544" }, "asset"), true);
  for (const value of [null, {}, { ...acl, owner: "S-1-1-0" }, { ...acl, rules: [] },
    { ...acl, rules: [{ ...rule, inheritOnly: true }] }, { ...acl, rules: [{ ...rule, allow: false }] },
    { ...acl, rules: [{ ...rule, rights: 0x20000 }] }, { ...acl, rules: [rule, { ...rule, sid: "Users" }] }]) {
    assert.equal(isPrivateWindowsAcl(value, "asset"), false);
  }
});

test("supported native model targets cover the V1 Windows/Linux matrix", () => {
  for (const [platform, arch] of [["darwin", "arm64"], ["linux", "x64"], ["linux", "arm64"], ["win32", "x64"]] as const) {
    assert.doesNotThrow(() => sqliteVecTarget(platform, arch));
    assert.match(sqliteVecAssetFilename(platform, arch), /^vec0\./);
  }
  assert.throws(() => sqliteVecTarget("win32", "ia32"), /sqlite_vec_platform_unsupported/);
});

test("the current checkout contains the selected sqlite-vec asset", () => {
  for (const [platform, arch] of [["darwin", "arm64"], ["linux", "x64"], ["linux", "arm64"], ["win32", "x64"]] as const) {
    const asset = join(process.cwd(), "src", "native", sqliteVecAssetFilename(platform, arch));
    assert.equal(existsSync(asset), true, asset);
  }
});

test("Windows uses a stable named pipe instead of a filesystem socket", () => {
  const first = ipcEndpointPath("/tmp/v1-platform-data", "win32");
  assert.equal(first, ipcEndpointPath("/tmp/v1-platform-data", "win32"));
  assert.match(first, /^\\\\\.\\pipe\\agent-mem-[a-f0-9]{32}$/);
  assert.match(ipcEndpointPath("/tmp/v1-platform-data", "linux"), /broker\.sock$/);
});

test("the installed ONNX runtime accepts the current V1 target", () => {
  assert.doesNotThrow(() => assertNativeOnnxRuntime("1.24.3"));
});
