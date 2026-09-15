import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const testDirectory = join(root, "dist-v1", "tests");
const testFiles = readdirSync(testDirectory)
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => join(testDirectory, name));
const timeoutMs = 120_000;

if (testFiles.length === 0) throw new Error("v1_tests_missing");

for (const file of testFiles) {
  console.error(`[test] ${relative(root, file)}`);
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-concurrency=1", `--test-timeout=${timeoutMs}`, file],
    { cwd: root, stdio: "inherit", timeout: timeoutMs + 10_000, windowsHide: true },
  );
  if (result.error) {
    console.error(`[test] ${relative(root, file)}: ${result.error.message}`);
    process.exitCode = result.error.code === "ETIMEDOUT" ? 124 : 1;
    break;
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
