import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`missing_${name.slice(2)}`);
  return value;
};
const packageArgument = option("--package-dir");
const keepTemp = args.includes("--keep-temp");
const noRerank = args.includes("--no-rerank");
if (args.some((arg) => arg !== "--keep-temp" && arg !== "--no-rerank" && arg !== "--package-dir" && arg !== packageArgument)) {
  throw new Error("usage: node scripts/v1-retrieval-probe.mjs --package-dir ABSOLUTE_PACKAGE [--keep-temp]");
}
if (packageArgument === undefined || !isAbsolute(packageArgument)) {
  throw new Error("package_dir_must_be_absolute");
}

const packageDirectory = realpathSync(resolve(packageArgument));
const packageNode = realpathSync(join(packageDirectory, "runtime", "bin", process.platform === "win32" ? "node.exe" : "node"));
const packageLauncher = join(packageDirectory, process.platform === "win32" ? "agent-mem.cmd" : "agent-mem");
const repoRoot = realpathSync(root);
if (packageDirectory === repoRoot || packageDirectory.startsWith(`${repoRoot}${sep}`)) {
  throw new Error("package_must_be_outside_repository_ancestry");
}
if (process.env.NODE_PATH !== undefined) throw new Error("NODE_PATH_must_be_unset");

if ((process.env.AGENT_MEM_PROBE_REEXEC ?? process.env.AGENT_MEMORY_V1_PROBE_REEXEC) !== "1" && realpathSync(process.execPath) !== packageNode) {
  const environment = { ...process.env, AGENT_MEM_PROBE_REEXEC: "1" };
  delete environment.AGENT_MEMORY_V1_PROBE_REEXEC;
  delete environment.NODE_PATH;
  delete environment.NODE_OPTIONS;
  const child = spawnSync(packageNode, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    cwd: root,
    env: environment,
    stdio: "inherit",
  });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
  process.exit();
}
if (realpathSync(process.execPath) !== packageNode) throw new Error("package_runtime_not_active");

const requireFromPackage = createRequire(join(packageDirectory, "package.json"));
const resolvedDependencies = Object.fromEntries(["@huggingface/transformers", "onnxruntime-node", "zod"].map((name) => {
  const resolved = realpathSync(requireFromPackage.resolve(name));
  if (resolved !== packageDirectory && !resolved.startsWith(`${packageDirectory}${sep}`)) throw new Error(`dependency_escaped_package:${name}`);
  return [name, resolved];
}));

const fromPackage = (path) => import(pathToFileURL(join(packageDirectory, "dist-v1", path)).href);
const [{ startService, connectClient }, configModule, eventModule, manifestModule] = await Promise.all([
  fromPackage("src/v1/service.js"),
  fromPackage("src/v1/config.js"),
  fromPackage("src/host/events.js"),
  fromPackage("src/models/manifest.js"),
]);
const { addConnection, bindingFor, loadConfig, saveConfig } = configModule;
const { normalizeNativeEvent } = eventModule;
const { E5_MODEL_MANIFEST, isNativeOnnxRuntimeSupported } = manifestModule;
const nativeSemanticSearch = isNativeOnnxRuntimeSupported();

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const digest = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const json = (value) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
const percentile = (values, quantile) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))] ?? 0;
};
const inside = (path, parent) => path === parent || path.startsWith(`${parent}${sep}`);

const longWhitespaceText = [
  "LONG_WHITESPACE_REGRESSION_ANCHOR: exact source must survive E5 indexing.",
  ...Array.from({ length: 128 }, (_, index) => `${String(index).padStart(3, "0")} | ${" ".repeat(index % 7)}preserve   repeated   whitespace ${"\t".repeat(index % 3)}`),
  "  trailing spaces are intentional   ",
  "\tfinal tabbed line",
  "LONG_WHITESPACE_REGRESSION_END",
].join("\n") + "\n";

const distractorTexts = Object.freeze([
  "Die Stromrechnung für September ist noch offen und wartet auf die Überweisung.",
  "Die Stromrechnung für November wurde storniert und nicht als bezahlt markiert.",
  "Die Wasserrechnung für Oktober wurde bereits bezahlt und im Haushaltsbuch markiert.",
  "Die Internetrechnung für Oktober ist fällig, aber noch nicht beglichen.",
  "Im Haushaltsbuch ist die Stromrechnung für Oktober als geplant, nicht als erledigt, notiert.",
  "Die Miete für Oktober wurde bereits überwiesen und nicht als Stromrechnung verbucht.",
  "Die Stromrechnung für Oktober wurde noch nicht bezahlt und bleibt als offen markiert.",
  "Die Gasrechnung für Oktober wurde bereits bezahlt und im Haushaltsbuch abgehakt.",
  "The school permission form for the museum trip has not been signed yet.",
  "The school permission form for the zoo trip was signed and filed last week.",
  "The museum trip itinerary has been signed, but it is not a school permission form.",
  "The school form for the museum trip is waiting for a parent signature.",
  "The permission email for the museum visit was sent but remains unsigned.",
  "The museum trip consent form expired before the school office received it.",
  "The school permission form was signed for the theater trip, not the museum trip.",
  "The grocery list contains apples, rice, and coffee for this week.",
  "The dentist appointment reminder is in the calendar for Tuesday morning.",
  "The recycling pickup is scheduled for Friday morning, not Thursday.",
  "Die Recyclingabholung findet am Freitagmorgen statt, nicht am Donnerstag.",
  "Der Zahnarzttermin ist am Dienstagmorgen im Kalender eingetragen.",
  "Der Zahnarzttermin für Lina ist am Mittwoch um neun Uhr.",
  "Lina hat einen Zahnarzttermin am Dienstag, aber nicht um neun Uhr.",
  "The dentist appointment for Lina is on Wednesday at nine o'clock.",
  "The recycling pickup for Thursday was canceled and moved to Friday.",
  "Die Recyclingabholung für Donnerstag wurde abgesagt und auf Freitag verschoben.",
  "The Tuesday dentist reminder names Max, not Lina.",
  "Die Stromrechnung für Oktober ist bezahlt, aber nicht im Haushaltsbuch markiert.",
  "The school museum form was returned unsigned in a blue folder.",
  "Die Rechnung für Oktober betrifft Wasser und nicht Strom.",
  "The museum trip permission form was signed by the teacher, not the parent.",
  "Die Oktoberrechnung wurde als bezahlt vorgemerkt, die Überweisung steht noch aus.",
  "The recycling collection is Thursday evening, not Thursday morning.",
]);

const distractors = distractorTexts.map((text, index) => Object.freeze({
  id: `a0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  direction: `distractor-${String(index + 1).padStart(2, "0")}`,
  text,
  query: undefined,
  expected: false,
}));

const corpus = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    direction: "DE-DE",
    text: "Die Stromrechnung für Oktober wurde bereits bezahlt und im Haushaltsbuch als erledigt markiert.",
    query: "Welche Rechnung für Oktober wurde bereits bezahlt?",
    expected: true,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    direction: "DE-DE-distractor",
    text: "Der Wochenendausflug beginnt am Samstagmorgen am Bahnhof und benötigt keine Rechnung.",
    query: undefined,
    expected: false,
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    direction: "EN-EN",
    text: "The school permission form for the museum trip has been signed and placed in the blue folder.",
    query: "Which school form was signed for the museum trip?",
    expected: true,
  },
  {
    id: "44444444-4444-4444-8444-444444444444",
    direction: "EN-EN-distractor",
    text: "The grocery list contains apples, rice, and coffee for the kitchen this week.",
    query: undefined,
    expected: false,
  },
  {
    id: "55555555-5555-4555-8555-555555555555",
    direction: "DE-EN",
    text: "The recycling pickup is scheduled for Thursday morning at the curb.",
    query: "Wann wird das Recycling am Donnerstag abgeholt?",
    expected: true,
  },
  {
    id: "66666666-6666-4666-8666-666666666666",
    direction: "DE-EN-distractor",
    text: "The dentist appointment is on Tuesday morning and the reminder is in the calendar.",
    query: undefined,
    expected: false,
  },
  {
    id: "77777777-7777-4777-8777-777777777777",
    direction: "EN-DE",
    text: "Der Zahnarzttermin für Lina ist am Dienstag um neun Uhr.",
    query: "When is Lina's dentist appointment?",
    expected: true,
  },
  {
    id: "88888888-8888-4888-8888-888888888888",
    direction: "EN-DE-distractor",
    text: "Die Recyclingabholung findet am Donnerstagmorgen an der Straße statt.",
    query: undefined,
    expected: false,
  },
  {
    id: "99999999-9999-4999-8999-999999999999",
    direction: "LONG-WHITESPACE",
    text: longWhitespaceText,
    query: "long whitespace regression anchor exact source",
    expected: true,
  },
  ...distractors,
].map((entry) => Object.freeze(entry));

const directions = corpus.filter((entry) => entry.expected && entry.query !== undefined);
const temporary = mkdtempSync(join(tmpdir(), "amv1-"));
const dataDirectory = join(temporary, "data");
const projectDirectory = join(temporary, "project");
mkdirSync(projectDirectory, { recursive: true, mode: 0o700 });
const modelRoot = join(packageDirectory, ".models", "e5", E5_MODEL_MANIFEST.model_id, E5_MODEL_MANIFEST.revision);
if (!existsSync(modelRoot)) throw new Error("bundled_e5_model_missing");

let service;
let client;
try {
  let config = loadConfig(dataDirectory, true);
  const connection = addConnection(config, "opencode", projectDirectory);
  saveConfig(dataDirectory, config);
  const binding = bindingFor(config, connection);
  const scopeId = connection.scope_id;

  const startAt = performance.now();
  service = await startService(dataDirectory, modelRoot, noRerank ? undefined : { rerank: true });
  const startMs = performance.now() - startAt;
  client = connectClient(dataDirectory, config, connection);
  await client.connect();

  const captureSamples = [];
  const captureIds = [];
  for (const entry of corpus) {
    const capturedAt = new Date().toISOString();
    const event = normalizeNativeEvent({
      version: 1,
      capture_id: entry.id,
      scope_id: scopeId,
      adapter_version: "1.0.0",
      stage: "prompt_submitted",
      native_ids: { session_id: binding.host_session_id, message_id: entry.id, turn_id: entry.id },
      text: entry.text,
      payload: { text: entry.text, probe: "v1-retrieval-probe", direction: entry.direction },
      captured_at: capturedAt,
      occurred_at: capturedAt,
      coverage: { status: "complete" },
      correlation: { status: "correlated", basis: "native_ids", key: `probe:${entry.id}` },
    }, binding);
    const began = performance.now();
    const ack = await client.capture(event, [{
      span_id: randomUUID(),
      root: "event",
      path: "/text",
      start_utf16: 0,
      end_utf16: entry.text.length,
      digest: digest(entry.text),
    }]);
    captureSamples.push(performance.now() - began);
    assert.equal(ack.capture_id, entry.id);
    captureIds.push(ack.capture_id);
  }

  const waitStarted = performance.now();
  let status = service.status();
  if (nativeSemanticSearch) {
    while (status.embedding?.state !== "ready" || status.jobs.pending !== 0 || status.jobs.running !== 0) {
      if (status.jobs.failed > 0) throw new Error(`e5_index_failed:${json(status.jobs)}`);
      if (performance.now() - waitStarted > 120_000) throw new Error(`e5_index_timeout:${json(status)}`);
      await delay(100);
      status = service.status();
    }
  } else {
    assert.equal(status.embedding?.state, "unavailable");
    assert.equal(status.embedding?.reason, "model_load_failed");
  }
  const indexingWaitMs = nativeSemanticSearch ? performance.now() - waitStarted : 0;

  let rpcId = 1;
  const rpc = (message) => client.rpc({ kind: "mcp", message: { jsonrpc: "2.0", id: rpcId++, ...message } });
  const initialize = await rpc({ method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "v1-retrieval-probe", version: "1.0.0" } } });
  if (initialize?.error) throw new Error(`mcp_initialize_failed:${json(initialize.error)}`);
  await client.rpc({ kind: "mcp", message: { jsonrpc: "2.0", method: "notifications/initialized", params: {} } });
  const listed = await rpc({ method: "tools/list", params: {} });
  const toolNames = listed?.result?.tools?.map((tool) => tool.name) ?? [];
  assert.deepEqual(toolNames, ["memory_recall", "memory_get", "memory_forget", "memory_write"]);
  const otherClient = connectClient(dataDirectory, config, connection);
  try {
    await otherClient.connect();
    const message = { jsonrpc: "2.0", id: 9001, method: "tools/call", params: {
      name: "memory_recall", arguments: { query: directions[0].query, scope_ids: [scopeId], mode: "current", max_bytes: 8000 },
    } };
    const paired = await Promise.all([client.rpc({ kind: "mcp", message }), otherClient.rpc({ kind: "mcp", message })]);
    for (const response of paired) {
      assert.equal(response.id, 9001);
      assert.ok(!response.error && !response.result?.isError, "same request ID on separate clients must not collide");
    }
  } finally { await otherClient.close(); }

  const callTool = async (name, argumentsValue) => {
    const response = await rpc({ method: "tools/call", params: { name, arguments: argumentsValue } });
    if (response?.error) throw new Error(`mcp_tool_failed:${name}:${json(response.error)}`);
    if (response?.result?.isError) throw new Error(`mcp_tool_error:${name}:${json(response.result)}`);
    const text = response?.result?.content?.find((item) => item?.type === "text")?.text;
    if (typeof text !== "string") throw new Error(`mcp_tool_text_missing:${name}`);
    return JSON.parse(text);
  };

const recall = async (entry) => {
  const began = performance.now();
  const result = await callTool("memory_recall", { query: entry.query, scope_ids: [scopeId], mode: "current", max_bytes: 8_000 });
  const durationMs = performance.now() - began;
    const packet = result.packet ?? result;
    assert.ok(result.intelligence, "search-stage metadata must be present");
  const topIds = packet.items.filter((item) => item.kind === "source").map((item) => item.item_id).slice(0, 10);
  const top3Ids = topIds.slice(0, 3);
  const rank = topIds.indexOf(entry.id);
  const modeOk = packet.mode === "current" || (!nativeSemanticSearch && packet.mode === "degraded");
  const sourceFound = rank >= 0;
  return {
      durationMs,
      intelligence: result.intelligence,
    ok: modeOk && sourceFound,
    failure: modeOk ? sourceFound ? undefined : `expected_source_missing:${entry.id}` : `unexpected_recall_mode:${packet.mode}`,
    rank: sourceFound ? rank + 1 : null,
    top3_hit: modeOk && top3Ids.includes(entry.id),
    top3Ids,
    topIds,
    mode: packet.mode,
    diagnostics: packet.diagnostics ?? [],
  };
};

const gateFailures = [];
const noteGateFailure = (entry, result) => {
  if (!result.ok && !gateFailures.some((failure) => failure.direction === entry.direction)) {
    gateFailures.push({ direction: entry.direction, expected_source_id: entry.id, failure: result.failure, mode: result.mode, top3: result.top3Ids, top10: result.topIds, diagnostics: result.diagnostics });
  }
};

const warmRecall = [];
for (const entry of directions) {
  noteGateFailure(entry, await recall(entry));
  const samples = [];
  let last;
  for (let repeat = 0; repeat < 3; repeat += 1) {
    last = await recall(entry);
    noteGateFailure(entry, last);
    samples.push(last.durationMs);
  }
  warmRecall.push({ direction: entry.direction, query: entry.query, expected_source_id: entry.id, samples_ms: samples, p95_ms: percentile(samples, 0.95), rank: last.rank, top3_hit: last.top3_hit, top3: last.top3Ids, top10: last.topIds, mode: last.mode, diagnostics: last.diagnostics, intelligence: last.intelligence });
  }

  const longEntry = corpus.find((entry) => entry.direction === "LONG-WHITESPACE");
  assert.ok(longEntry);
  const longRecall = await recall(longEntry);
  noteGateFailure(longEntry, longRecall);
  const fetched = await callTool("memory_get", { scope_id: scopeId, reference: { kind: "source", capture_id: longEntry.id } });
  const exactQuote = fetched.source?.spans?.some((span) => span.quote === longEntry.text) === true;
  if (!exactQuote && !gateFailures.some((failure) => failure.direction === longEntry.direction)) {
    gateFailures.push({ direction: longEntry.direction, expected_source_id: longEntry.id, failure: "long_whitespace_memory_get_mismatch", mode: longRecall.mode, top3: longRecall.top3Ids, top10: longRecall.topIds, diagnostics: longRecall.diagnostics });
  }

  const related = await callTool("memory_recall", {
    query: "Warum hängt die Stromrechnung mit der letzten Sitzung zusammen?", scope_ids: [scopeId], mode: "current", max_bytes: 32_000,
  });
  assert.ok(related.intelligence?.stages.includes("structural_graph"));
  assert.ok(related.intelligence.graph_hops > 0 && related.intelligence.graph_hops <= 2);
  assert.ok(related.intelligence.graph_added <= 16);
  assert.ok(related.packet.items.every(item => captureIds.includes(item.item_id)));
  const command = async (...argumentsValue) => {
    const result = await promisify(execFile)(packageLauncher,
      ["--data-dir", dataDirectory, ...argumentsValue], {
        timeout: process.platform === "win32" ? 120_000 : 30_000,
        shell: process.platform === "win32",
      });
    return JSON.parse(result.stdout);
  };
  const procedureSource = directions[0].id;
  await command("procedure", "add", "--project", projectDirectory, "--capture-id", procedureSource, "--terms", "demoablauf");
  let learned;
  for (let index = 0; index < 5; index++) {
    const result = await callTool("memory_recall", { query: "demoablauf", scope_ids: [scopeId], mode: "current", max_bytes: 8_000 });
    assert.equal(result.packet.items[0]?.item_id, procedureSource, "registered original source must be recommended");
    learned = await command("feedback", "--project", projectDirectory, "--query-id", result.packet.query_id,
      "--capture-id", procedureSource, "--useful", "yes");
  }
  assert.equal(learned.samples, 5);
  assert.ok(learned.weights.procedure > 0.4);
  const purge = await command("forget", procedureSource, "--project", projectDirectory);
  const proceduresAfterForget = await command("procedure", "list", "--project", projectDirectory);
  assert.ok(!JSON.stringify(proceduresAfterForget).includes(procedureSource), "forget removes procedure registration");
  // Exercise the packaged write/recall path with changed evidence, not a repeated answer marker.
  const recordSources = [];
  for (const text of ["Kiebitz stores its invoices in SQLite.", "Korrektur: Kiebitz speichert Rechnungen jetzt in PostgreSQL statt SQLite."]) {
    const id = randomUUID(), at = new Date().toISOString();
    await client.capture(normalizeNativeEvent({
      version: 1, capture_id: id, scope_id: scopeId, adapter_version: "1.0.0",
      stage: "prompt_submitted", native_ids: { session_id: binding.host_session_id, message_id: id, turn_id: id },
      text, payload: { text }, captured_at: at, occurred_at: at,
      coverage: { status: "complete" }, correlation: { status: "correlated", basis: "native_ids", key: id },
    }, binding));
    recordSources.push(id);
  }
  const oldRecord = await callTool("memory_write", { scope_id: scopeId, kind: "decision", key: "kiebitz-storage",
    summary: "Kiebitz invoice storage uses SQLite.", source_ids: [recordSources[0]] });
  const newRecord = await callTool("memory_write", { scope_id: scopeId, kind: "decision", key: "kiebitz-storage",
    summary: "Kiebitz invoice storage now uses PostgreSQL.", source_ids: [recordSources[1]], replaces: oldRecord.record.revision_id });
  await client.close();
  await service.close();
  service = await startService(dataDirectory, modelRoot, noRerank ? undefined : { rerank: true });
  client = connectClient(dataDirectory, config, connection);
  await client.connect();
  await rpc({ method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "record-restart-probe", version: "1" } } });
  const recordRecall = await callTool("memory_recall", { query: "Where does Kiebitz keep invoice data?", scope_ids: [scopeId], max_bytes: 8_000 });
  const recordItems = recordRecall.packet.items.filter(item => item.kind === "record");
  assert.ok(recordItems.some(item => item.revision_id === newRecord.record.revision_id && item.content.includes("PostgreSQL")));
  assert.ok(!recordItems.some(item => item.revision_id === oldRecord.record.revision_id));
  const historical = await callTool("memory_get", { scope_id: scopeId, reference: { kind: "record", revision_id: oldRecord.record.revision_id } });
  assert.equal(historical.record.state, "blocked");
  await command("forget", recordSources[1], "--project", projectDirectory);
  const afterRecordPurge = await callTool("memory_recall", { query: "Kiebitz invoice storage", scope_ids: [scopeId], max_bytes: 8_000 });
  assert.ok(!afterRecordPurge.packet.items.some(item => item.kind === "record"), "purging latest report must not resurrect the superseded report");
  status = service.status();
  if (nativeSemanticSearch && !noRerank && status.intelligence?.reranker?.state !== "ready") {
    gateFailures.push({ direction: "RERANKER", expected_source_id: "reranker", failure: `reranker_not_ready:${status.intelligence?.reranker?.state ?? "unknown"}` });
  }
  console.log(json({
    version: 1,
    proof_scope: "technical_synthetic_capture_via_authenticated_v1_broker; not_native_host_proof",
    package_directory: packageDirectory,
    package_runtime: process.execPath,
    node: process.version,
    node_path: process.env.NODE_PATH ?? null,
    dependencies: resolvedDependencies,
    model: { id: E5_MODEL_MANIFEST.model_id, revision: E5_MODEL_MANIFEST.revision, root: modelRoot },
    corpus: { total: corpus.length, distractors: distractorTexts.length },
    project_scope_id: scopeId,
    expected_source_ids: Object.fromEntries(directions.map((entry) => [entry.direction, entry.id])),
    captured_source_ids: captureIds,
    start_ms: startMs,
    start_target_ms: 10_000,
    capture: { count: captureSamples.length, samples_ms: captureSamples, p95_ms: percentile(captureSamples, 0.95), target_p95_ms: 250 },
    indexing_wait_ms: indexingWaitMs,
    warm_recall: { directions: warmRecall, overall_p95_ms: percentile(warmRecall.flatMap((entry) => entry.samples_ms), 0.95), target_ms: 1_000 },
    long_whitespace: { source_id: longEntry.id, length: longEntry.text.length, sha256: digest(longEntry.text), recall_ms: longRecall.durationMs, exact_memory_get_quote: exactQuote },
    gate: { passed: gateFailures.length === 0, failures: gateFailures },
    final_status: status,
    controls: { graph: related.intelligence, learned, purge, procedures_after_forget: proceduresAfterForget },
    records: { restart: true, replacement: true, source_purge: true, old_revision: oldRecord.record.revision_id, new_revision: newRecord.record.revision_id },
  }));
  if (gateFailures.length > 0) process.exitCode = 1;
} finally {
  await client?.close().catch(() => undefined);
  await service?.close().catch(() => undefined);
  if (!keepTemp) {
    try {
      rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      if (process.platform !== "win32") throw error;
      console.warn(`probe_temp_cleanup_deferred:${temporary}:${error instanceof Error ? error.code ?? error.message : String(error)}`);
    }
  }
}
