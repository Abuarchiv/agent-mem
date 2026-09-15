import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const nativeAsset = process.platform === "darwin"
  ? "vec0.dylib"
  : process.platform === "win32"
    ? "vec0.win32-x64.dll"
    : process.arch === "arm64"
      ? "vec0.linux-arm64.so"
      : "vec0.linux-x64.so";
// Preserve the existing schema contract; this is data, not feature execution.
const store = join(root, "src/store");
const assets = readdirSync(store).filter(name => name.endsWith(".sql")).map(name => `src/store/${name}`);
assets.push(...readdirSync(join(store, "migrations")).filter(name => name.endsWith(".sql")).map(name => `src/store/migrations/${name}`));
assets.push(`src/native/${nativeAsset}`, "src/models/model-manifest.json", "src/models/rerank-manifest.json");
assets.push("tests/fixtures/vault-v1.sql");
for (const asset of assets) {
  const destination = join(root, "dist-v1", asset);
  mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(destination)) chmodSync(destination, 0o644);
  copyFileSync(join(root, asset), destination);
}
