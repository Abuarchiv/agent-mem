import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const modelRoot = join(root, ".models");
const e5Manifest = JSON.parse(await readFile(join(root, "release/model-manifest.json"), "utf8"));
const rerankManifest = JSON.parse(await readFile(join(root, "release/rerank-manifest.json"), "utf8"));
const specs = [
  { repo: e5Manifest.model_id, revision: e5Manifest.revision, root: join(modelRoot, "e5", e5Manifest.model_id, e5Manifest.revision), artifacts: e5Manifest.artifacts },
  { repo: rerankManifest.model_id, revision: rerankManifest.revision, root: join(modelRoot, "rerank", rerankManifest.model_id, rerankManifest.revision), artifacts: rerankManifest.artifacts },
];

function artifactPath(spec, relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || isAbsolute(relativePath) || relativePath.includes("\0")) throw new Error("model_artifact_path_invalid");
  const absolute = resolve(spec.root, relativePath);
  const rel = relative(spec.root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith("..")) throw new Error("model_artifact_path_invalid");
  return absolute;
}

async function verifyArtifact(spec, artifact) {
  const file = artifactPath(spec, artifact.path);
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size !== artifact.bytes) return false;
    return createHash("sha256").update(await readFile(file)).digest("hex") === artifact.sha256;
  } catch { return false; }
}

async function verifyAll() {
  const missing = [];
  for (const spec of specs) for (const artifact of spec.artifacts) if (!(await verifyArtifact(spec, artifact))) missing.push(`${spec.repo}@${spec.revision}/${artifact.path}`);
  if (missing.length > 0) throw new Error(`model_artifacts_invalid:${missing.join(",")}`);
  console.log(JSON.stringify({ status: "verified", models: specs.map((spec) => ({ model: spec.repo, revision: spec.revision, root: relative(root, spec.root) })) }));
}

async function downloadArtifact(spec, artifact) {
  if (await verifyArtifact(spec, artifact)) return "existing";
  const url = `https://huggingface.co/${spec.repo}/resolve/${spec.revision}/${artifact.path}?download=true`;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`model_download_http_${response.status}:${spec.repo}/${artifact.path}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== artifact.bytes || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error(`model_download_hash_mismatch:${spec.repo}/${artifact.path}`);
  const file = artifactPath(spec, artifact.path);
  const temporary = `${file}.download-${process.pid}`;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, file);
  return "downloaded";
}

const command = process.argv[2] ?? "verify";
if (command === "verify") {
  await verifyAll();
} else if (command === "download") {
  const results = [];
  try {
    for (const spec of specs) for (const artifact of spec.artifacts) results.push({ model: spec.repo, path: artifact.path, state: await downloadArtifact(spec, artifact) });
    await verifyAll();
    console.log(JSON.stringify({ status: "downloaded_or_existing", artifacts: results }));
  } catch (error) {
    for (const spec of specs) for (const artifact of spec.artifacts) await rm(`${artifactPath(spec, artifact.path)}.download-${process.pid}`, { force: true }).catch(() => undefined);
    throw error;
  }
} else {
  throw new Error("usage: node scripts/models.mjs verify|download");
}
