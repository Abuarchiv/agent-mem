export type SessionHost = "Codex CLI" | "Codex Desktop" | "OpenCode CLI" | "GitHub Copilot CLI";
export type SessionCapabilityState = "ready" | "degraded" | "unavailable";
export type SessionRerankerState = "ready" | "disabled" | "unavailable";

export interface AgentMemorySessionStatus {
  readonly version: 1;
  readonly state: "connected" | "degraded";
  readonly host: SessionHost;
  readonly core: SessionCapabilityState;
  readonly e5: SessionCapabilityState;
  readonly reranker: SessionRerankerState;
  readonly mcp: "verified" | "unavailable";
  readonly reason?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function state(value: unknown): SessionCapabilityState {
  return value === "ready" ? "ready" : value === "degraded" ? "degraded" : "unavailable";
}

function reason(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z][a-z0-9_.:-]{0,127}$/u.test(value) ? value : undefined;
}

export function sessionStatusFromBackend(host: SessionHost, backend: unknown): AgentMemorySessionStatus {
  const root = record(backend);
  const embedding = record(root?.embedding);
  const intelligence = record(root?.intelligence);
  const rerankerValue = record(intelligence?.reranker ?? root?.source_reranker);
  const e5 = state(embedding?.state);
  const core = root?.state === "core_ready" ? "ready" : root?.state === "degraded" || e5 === "degraded" ? "degraded" : e5 === "ready" ? "ready" : "unavailable";
  const reranker = rerankerValue?.state === "ready" ? "ready" : rerankerValue?.state === "disabled" ? "disabled" : "unavailable";
  const selectedReason = reason(embedding?.reason) ?? (reranker === "unavailable" ? reason(rerankerValue?.reason) : undefined);
  return {
    version: 1,
    state: core === "ready" ? "connected" : "degraded",
    host,
    core,
    e5,
    reranker,
    mcp: root === undefined ? "unavailable" : "verified",
    ...(selectedReason === undefined ? {} : { reason: selectedReason }),
  };
}

export function connectedSessionStatus(host: SessionHost): AgentMemorySessionStatus {
  return { version: 1, state: "connected", host, core: "ready", e5: "ready", reranker: "disabled", mcp: "verified" };
}

export function formatSessionStatus(status: AgentMemorySessionStatus): string {
  const lines = [
    `Agent Memory V1: ${status.state}`,
    `Host: ${status.host}`,
    `Core: ${status.core} · E5: ${status.e5} · Reranker: ${status.reranker}`,
    `MCP: ${status.mcp}`,
  ];
  if (status.reason !== undefined) lines.push(`Reason: ${status.reason}`);
  return lines.join("\n");
}
