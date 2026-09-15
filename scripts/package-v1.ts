import { createHash } from "node:crypto";
import { builtinModules, createRequire } from "node:module";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path, { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { copyOwnedTree } from "./package-tree.js";
import { E5_MODEL_MANIFEST, verifyE5Artifacts } from "../src/models/manifest.js";
import { RERANK_MODEL_ID, parseRerankManifest, verifyRerankArtifacts } from "../src/models/rerank.js";
import { sqliteVecAssetFilename, sqliteVecTarget } from "../src/retrieval/vec0.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const build = join(root, "dist-v1");
const entries = ["scripts/v1.js", "src/v1/service.js", "src/v1/connect.js", "adapters/codex/index.js", "adapters/opencode/plugin.js", "adapters/opencode/bridge.js", "adapters/copilot-cli/index.js"];
const forbidden = /(?:^src\/(?:ui|setup|platform|transfer)\/|^adapters\/(?:claude-code|copilot-vscode)\/|^src\/execution\/(?:api|local|codex|claude|copilot|copilot-auth)\.js$|^src\/retrieval\/(?:graph|controller)\.js$|^src\/context\/(?:prepare|select)\.js$|^src\/worker\/(?:extract-job|consolidate)\.js$|^src\/core\/(?:summaries|lessons|procedures)\.js$)/;
const builtin = new Set([...builtinModules, ...builtinModules.map(n => `node:${n}`)]);
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Manifest and graph names always use '/', regardless of the build host. */
export function packageRelativePath(base: string, target: string, paths = path): string {
  const rel = paths.relative(base, target);
  if (paths.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${paths.sep}`)) throw new Error("package_path_outside_root");
  return rel.split(paths.sep).join("/");
}

export function sharpPlatformPackages(platform = process.platform, arch = process.arch): string[] {
  // Windows sharp packages already contain the libvips DLLs.
  return [`@img/sharp-${platform}-${arch}`, ...(platform === "win32" ? [] : [`@img/sharp-libvips-${platform}-${arch}`])];
}

export function windowsLaunchers(): { cmd: string; powershell: string } {
  return {
    cmd: '@echo off\r\nsetlocal\r\nset "PACKAGE_DIR=%~dp0"\r\nset "NODE_OPTIONS="\r\nset "NODE_PATH="\r\n"%PACKAGE_DIR%runtime\\bin\\node.exe" "%PACKAGE_DIR%dist-v1\\scripts\\v1.js" %*\r\nexit /b %errorlevel%\r\n',
    powershell: `$ErrorActionPreference = 'Stop'
$packageDir = $PSScriptRoot
$oldOptions = $env:NODE_OPTIONS
$oldPath = $env:NODE_PATH
$exitCode = 1
try {
  $env:NODE_OPTIONS = $null
  $env:NODE_PATH = $null
  & "$packageDir\\runtime\\bin\\node.exe" "$packageDir\\dist-v1\\scripts\\v1.js" @args
  $exitCode = $LASTEXITCODE
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
} finally {
  $env:NODE_OPTIONS = $oldOptions
  $env:NODE_PATH = $oldPath
}
exit $exitCode
`,
  };
}

function runtimeGraph(): { files: string[]; packages: string[] } {
  // E5 loads these lazily; they cannot be discovered from static imports.
  const seen = new Set<string>(), packages = new Set<string>(["@huggingface/transformers", "onnxruntime-node"]), pending = [...entries];
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    if (file.startsWith("..") || !existsSync(join(build, file))) throw new Error(`v1_module_missing:${file}`);
    seen.add(file);
    const ast = ts.createSourceFile(file, readFileSync(join(build, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    for (const statement of ast.statements) {
      if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (builtin.has(specifier)) continue;
      if (specifier.startsWith(".")) pending.push(packageRelativePath(build, resolve(build, dirname(file), specifier)));
      else packages.add(specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!);
    }
  }
  const rejected = [...seen].filter(file => forbidden.test(file));
  if (rejected.length) throw new Error(`v1_forbidden_runtime_modules:${rejected.join(",")}`);
  return { files: [...seen].sort(), packages: [...packages].sort() };
}

interface PackageInfo { name: string; version: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; }
function findPackage(name: string, from: string): string {
  const require = createRequire(join(from, "package.json"));
  let entry: string;
  try { entry = require.resolve(`${name}/package.json`); }
  catch {
    try { entry = require.resolve(`${name}/package`); }
    catch { entry = require.resolve(name); }
  }
  let path = dirname(realpathSync(entry));
  while (path !== dirname(path)) {
    const manifest = join(path, "package.json");
    if (existsSync(manifest) && (JSON.parse(readFileSync(manifest, "utf8")) as PackageInfo).name === name) return path;
    path = dirname(path);
  }
  throw new Error(`dependency_root_not_found:${name}`);
}

function copyPackages(names: readonly string[], output: string): { name: string; version: string; path: string }[] {
  const records: { name: string; version: string; path: string }[] = [], copied = new Set<string>();
  function visit(name: string, from: string, optional: boolean): void {
    let source: string;
    try { source = findPackage(name, from); } catch (error) { if (optional) return; throw error; }
    if (copied.has(source)) return;
    const path = packageRelativePath(root, source);
    if (!path.startsWith("node_modules/")) throw new Error(`dependency_outside_repository:${name}`);
    copied.add(source);
    const info = JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as PackageInfo;
    copyOwnedTree(source, join(output, path), rel => {
      const parts = rel.split("/");
      if (name === "onnxruntime-node" && parts[0] === "bin" && parts[1] === "napi-v6") {
        if (parts[2] !== undefined && parts[2] !== process.platform) return true;
        if (parts[3] !== undefined && parts[3] !== process.arch) return true;
      }
      return parts.some(p => ["node_modules", ".git", ".github", "test", "tests", "__tests__", ".npmrc"].includes(p) || p.startsWith(".env"));
    });
    records.push({ name: info.name, version: info.version, path });
    for (const child of Object.keys(info.dependencies ?? {})) if (!(child in (info.optionalDependencies ?? {}))) visit(child, source, false);
    for (const child of Object.keys(info.optionalDependencies ?? {})) visit(child, source, true);
  }
  for (const name of names) visit(name, root, false);
  return records;
}

export async function packageV1(destination: string) {
  sqliteVecTarget();
  if (!process.version.startsWith("v24.")) throw new Error("v1_build_requires_node24");
  const output = resolve(destination);
  if (existsSync(output)) throw new Error("v1_package_destination_must_be_new");
  const graph = runtimeGraph();
  const modelRoot = join(root, ".models", "e5", E5_MODEL_MANIFEST.model_id, E5_MODEL_MANIFEST.revision);
  await verifyE5Artifacts(modelRoot);
  const rerankBase = join(root, ".models", "rerank", RERANK_MODEL_ID);
  const rerankManifestPath = join(root, "release", "rerank-manifest.json");
  const reranker = parseRerankManifest(JSON.parse(readFileSync(rerankManifestPath, "utf8")));
  await verifyRerankArtifacts(join(rerankBase, reranker.revision), reranker);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  for (const file of graph.files) {
    const target = join(output, "dist-v1", file);
    mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(build, file), target);
  }
  function copyData(source: string, target: string): void {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const input = join(source, entry.name), dest = join(target, entry.name);
      if (entry.isDirectory()) copyData(input, dest);
      else if (entry.name.endsWith(".sql")) { mkdirSync(dirname(dest), { recursive: true }); copyFileSync(input, dest); }
    }
  }
  copyData(join(build, "src/store"), join(output, "dist-v1/src/store"));
  const vectorAsset = sqliteVecAssetFilename();
  for (const file of [`src/native/${vectorAsset}`, "release/model-manifest.json", "release/rerank-manifest.json"]) {
    const target = join(output, "dist-v1", file); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(root, file), target);
  }
  mkdirSync(join(output, "release"), { recursive: true });
  copyFileSync(rerankManifestPath, join(output, "release", "rerank-manifest.json"));
  const adapterManifest = join(output, "dist-v1/adapters/copilot-cli/manifest.json");
  mkdirSync(dirname(adapterManifest), { recursive: true });
  copyFileSync(join(root, "adapters/copilot-cli/manifest.json"), adapterManifest);
  const sharpPackages = sharpPlatformPackages();
  const packages = copyPackages([...graph.packages, ...sharpPackages], output);
  for (const name of [...graph.packages, ...sharpPackages]) {
    const resolved = findPackage(name, output);
    const within = packageRelativePath(realpathSync(output), resolved);
    if (!within.startsWith("node_modules/")) throw new Error(`v1_dependency_not_bundled:${name}`);
  }
  const targetModel = join(output, ".models", "e5", E5_MODEL_MANIFEST.model_id, E5_MODEL_MANIFEST.revision);
  for (const artifact of E5_MODEL_MANIFEST.artifacts) {
    const target = join(targetModel, artifact.path); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(modelRoot, artifact.path), target);
  }
  mkdirSync(join(output, "licenses"), { recursive: true });
  const targetRerank = join(output, ".models", "rerank", RERANK_MODEL_ID);
  mkdirSync(targetRerank, { recursive: true });
  for (const artifact of reranker.artifacts) {
    const target = join(targetRerank, reranker.revision, artifact.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(rerankBase, reranker.revision, artifact.path), target);
  }
  copyFileSync(join(root, "release/offline-licenses/rerank-Apache-2.0-LICENSE"), join(output, "licenses/rerank-Apache-2.0-LICENSE"));
  copyFileSync(join(root, "docs/v1-start.md"), join(output, "README.md"));
  for (const name of ["node-LICENSE", "e5-LICENSE", "onnxruntime-LICENSE", "onnxruntime-ThirdPartyNotices.txt", "sqlite-vec-LICENSE-MIT", "sharp-libvips-THIRD-PARTY-NOTICES.md"]) {
    copyFileSync(join(root, "release/offline-licenses", name), join(output, "licenses", name));
  }
  const runtimeNode = process.platform === "win32" ? "node.exe" : "node";
  mkdirSync(join(output, "runtime/bin"), { recursive: true });
  copyFileSync(process.execPath, join(output, "runtime/bin", runtimeNode));
  if (process.platform !== "win32") chmodSync(join(output, "runtime/bin", runtimeNode), 0o755);
  writeFileSync(join(output, "package.json"), JSON.stringify({ name: "agent-memory-v1", version: "1.0.0", type: "module", private: true }, null, 2) + "\n");
  const launcher = process.platform === "win32"
    ? windowsLaunchers().cmd
    : `#!/usr/bin/env sh\nset -eu\nPACKAGE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nunset NODE_OPTIONS NODE_PATH\nexec "$PACKAGE_DIR/runtime/bin/${runtimeNode}" "$PACKAGE_DIR/dist-v1/scripts/v1.js" "$@"\n`;
  writeFileSync(join(output, process.platform === "win32" ? "memory.cmd" : "memory"), launcher, process.platform === "win32" ? undefined : { mode: 0o755 });
  if (process.platform === "win32") writeFileSync(join(output, "memory.ps1"), windowsLaunchers().powershell);
  const files: { path: string; bytes: number; sha256: string }[] = [];
  function inspect(directory: string): void {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), stat = statSync(path);
      if (stat.isDirectory()) inspect(path);
      else files.push({ path: packageRelativePath(output, path), bytes: stat.size, sha256: hash(path) });
    }
  }
  inspect(output);
  const manifest = { version: "1.0.0", platform: process.platform, arch: process.arch, node: process.version, roots: entries, modules: graph.files, dependencies: packages, model: E5_MODEL_MANIFEST, reranker, files };
  writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { path: output, files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0), modules: graph.files.length, manifest_sha256: hash(join(output, "manifest.json")) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--output" || !args[1]) throw new Error("usage: package:v1 -- --output NEW_DIRECTORY");
  console.log(JSON.stringify(await packageV1(args[1])));
}
