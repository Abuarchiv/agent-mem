import assert from "node:assert/strict";
import test from "node:test";

import { connectedSessionStatus, formatSessionStatus, sessionStatusFromBackend } from "../src/v1/session-status.js";

test("session status has one stable human-readable marker", () => {
  const status = sessionStatusFromBackend("Codex CLI", {
    state: "core_ready",
    embedding: { state: "ready" },
    intelligence: { reranker: { state: "disabled" } },
  });
  assert.equal(formatSessionStatus(status), "Agent Mem: connected\nHost: Codex CLI\nCore: ready · E5: ready · Reranker: disabled\nMCP: verified");
});

test("session status exposes a bounded degraded reason without leaking payloads", () => {
  const status = sessionStatusFromBackend("GitHub Copilot CLI", {
    state: "degraded",
    embedding: { state: "unavailable", reason: "model_not_ready" },
    intelligence: { reranker: { state: "unavailable", reason: "model_download_failed" } },
  });
  assert.equal(status.state, "degraded");
  assert.equal(status.core, "degraded");
  assert.equal(status.e5, "unavailable");
  assert.equal(status.reranker, "unavailable");
  assert.match(formatSessionStatus(status), /Reason: model_not_ready/u);
  assert.equal(formatSessionStatus(status).includes("secret_hex"), false);
});

test("fallback status never claims core readiness without a backend status", () => {
  const status = connectedSessionStatus("OpenCode CLI");
  assert.equal(status.state, "degraded");
  assert.equal(status.core, "degraded");
  assert.equal(status.e5, "degraded");
  assert.match(formatSessionStatus(status), /status_unavailable/u);
});
