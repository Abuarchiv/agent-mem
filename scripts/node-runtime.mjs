import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "24.20.0";
const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const checksums = {
  "darwin-arm64": "40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8",
  "darwin-x64": "9e5b2644cf107befb6aefca676b96d3296bc10138096f022ed378d6233ed81f4",
  "linux-arm64": "5f4ddab610c1ab2016b3c227cebdbf6d9495161487e4739c7b90090595f465f7",
  "linux-x64": "2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2",
  "win-x64": "6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba",
  "win-arm64": "31c6799744de8a54601643098040c68c3697e56c94e407d61d0e5fa5f34191d7",
};

function target(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) return `darwin-${arch}`;
  if (platform === "linux" && (arch === "arm64" || arch === "x64")) return `linux-${arch}`;
  if (platform === "win32" && (arch === "x64" || arch === "arm64")) return `win-${arch}`;
  throw new Error("node_runtime_platform_unsupported");
}

function directoryName(currentTarget = target()) {
  return `node-v${VERSION}-${currentTarget}`;
}

function archiveName(currentTarget = target()) {
  return `${directoryName(currentTarget)}${currentTarget.startsWith("linux-") ? ".tar.xz" : currentTarget.startsWith("win-") ? ".zip" : ".tar.gz"}`;
}

function archivePath(currentTarget = target()) {
  return join(root, ".runtime", "downloads", archiveName(currentTarget));
}

function runtimePath(currentTarget = target()) {
  return join(root, ".runtime", directoryName(currentTarget));
}

function executablePath(currentTarget, base) {
  return join(base, currentTarget.startsWith("win-") ? "node.exe" : "bin", ...(currentTarget.startsWith("win-") ? [] : ["node"]));
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function archiveIsValid(path, currentTarget) {
  try {
    return statSync(path).isFile() && digest(path) === checksums[currentTarget];
  } catch {
    return false;
  }
}

async function ensureArchive(currentTarget) {
  const file = archivePath(currentTarget);
  if (archiveIsValid(file, currentTarget)) return "existing";
  const response = await fetch(`https://nodejs.org/dist/v${VERSION}/${archiveName(currentTarget)}`);
  if (!response.ok) throw new Error(`node_runtime_download_http_${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== checksums[currentTarget]) throw new Error("node_runtime_download_hash_mismatch");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.download-${process.pid}`;
  writeFileSync(temporary, bytes, { mode: 0o600 });
  renameSync(temporary, file);
  return "downloaded";
}

function extractArchive(file, currentTarget) {
  const destination = runtimePath(currentTarget);
  const staging = mkdtempSync(join(root, ".runtime", ".extract-"));
  try {
    if (file.endsWith(".tar.gz")) execFileSync("tar", ["-xzf", file, "-C", staging], { stdio: "ignore" });
    else if (file.endsWith(".tar.xz")) execFileSync("tar", ["-xJf", file, "-C", staging], { stdio: "ignore" });
    else {
      try {
        execFileSync("tar", ["-xf", file, "-C", staging], { stdio: "ignore" });
      } catch {
        const systemRoot = process.env.SystemRoot;
        if (!systemRoot) throw new Error("node_runtime_zip_extractor_missing");
        execFileSync(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Expand-Archive", "-LiteralPath", file, "-DestinationPath", staging, "-Force"], { stdio: "ignore" });
      }
    }
    const extracted = join(staging, directoryName(currentTarget));
    const node = executablePath(currentTarget, extracted);
    if (!existsSync(node)) throw new Error("node_runtime_archive_invalid");
    rmSync(destination, { recursive: true, force: true });
    renameSync(extracted, destination);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function verify(currentTarget) {
  const node = executablePath(currentTarget, runtimePath(currentTarget));
  if (!existsSync(node)) throw new Error(`node_runtime_missing:${runtimePath(currentTarget)}`);
  const version = execFileSync(node, ["--version"], { encoding: "utf8", timeout: 10_000, env: { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined } }).trim();
  if (version !== `v${VERSION}`) throw new Error(`node_runtime_version_invalid:${version}`);
  if (!archiveIsValid(archivePath(currentTarget), currentTarget)) throw new Error("node_runtime_archive_invalid");
  return { target: currentTarget, version, root: runtimePath(currentTarget), archive: archivePath(currentTarget) };
}

const command = process.argv[2] ?? "verify";
const currentTarget = target();
if (command === "download") {
  const state = await ensureArchive(currentTarget);
  if (!existsSync(executablePath(currentTarget, runtimePath(currentTarget)))) extractArchive(archivePath(currentTarget), currentTarget);
  console.log(JSON.stringify({ status: "ready", state, ...verify(currentTarget) }));
} else if (command === "verify") {
  console.log(JSON.stringify({ status: "verified", ...verify(currentTarget) }));
} else {
  throw new Error("usage: node scripts/node-runtime.mjs download|verify");
}
