import type {
  NativeSessionRemover,
  RuntimeArtifactRecord,
  RuntimeArtifactRepository,
} from "../store/runtime-artifact-repository.js";

export type { NativeSessionRemover, RegisterRuntimeArtifactInput, RuntimeArtifactRecord } from "../store/runtime-artifact-repository.js";

export interface CleanupReport {
  readonly inspected: number;
  readonly removed: number;
  readonly pending: number;
  readonly ownership_uncertain: number;
  readonly remaining: number;
}

export interface CleanupWorkerOptions {
  readonly nativeSessionRemover?: NativeSessionRemover;
  readonly batchSize?: number;
  readonly timeBudgetMs?: number;
}

/** One bounded pass over the durable inventory; retries are idempotent. */
export class RuntimeCleanupWorker {
  private readonly remover: NativeSessionRemover | undefined;
  private readonly batchSize: number;
  private readonly timeBudgetMs: number;

  constructor(private readonly repository: RuntimeArtifactRepository, options: CleanupWorkerOptions = {}) {
    this.remover = options.nativeSessionRemover;
    this.batchSize = options.batchSize ?? 32;
    this.timeBudgetMs = options.timeBudgetMs ?? 2_000;
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 256) throw new Error("cleanup_batch_invalid");
    if (!Number.isSafeInteger(this.timeBudgetMs) || this.timeBudgetMs < 10 || this.timeBudgetMs > 60_000) throw new Error("cleanup_budget_invalid");
  }

  async reconcileStartup(): Promise<CleanupReport> {
    return this.reconcile(this.repository.listPending().slice(0, this.batchSize));
  }

  reconcileStartupSync(): CleanupReport {
    const artifacts = this.repository.listPending().slice(0, this.batchSize);
    let removed = 0;
    let pending = 0;
    let ownership_uncertain = 0;
    for (const artifact of artifacts) {
      const result = this.repository.reconcileSync(artifact.artifact_id);
      if (result.state === "removed") removed += 1;
      else if (result.state === "ownership_uncertain") ownership_uncertain += 1;
      else pending += 1;
    }
    return { inspected: artifacts.length, removed, pending, ownership_uncertain, remaining: this.repository.countPending() };
  }

  async reconcileAttempt(attemptId: string): Promise<CleanupReport> {
    return this.reconcile(this.repository.listForAttempt(attemptId));
  }

  async reconcileSource(scopeId: string, captureIds: readonly string[]): Promise<CleanupReport> {
    return this.reconcile(this.repository.listForSource(scopeId, captureIds));
  }

  private async reconcile(artifacts: readonly RuntimeArtifactRecord[]): Promise<CleanupReport> {
    const deadline = Date.now() + this.timeBudgetMs;
    let removed = 0;
    let pending = 0;
    let ownershipUncertain = 0;
    for (const artifact of artifacts) {
      if (Date.now() >= deadline) { pending += artifacts.length - removed - pending - ownershipUncertain; break; }
      const result = await this.repository.reconcile(artifact.artifact_id, this.remover);
      if (result.state === "removed") removed += 1;
      else if (result.state === "ownership_uncertain") ownershipUncertain += 1;
      else pending += 1;
    }
    return { inspected: artifacts.length, removed, pending, ownership_uncertain: ownershipUncertain, remaining: this.repository.countPending() };
  }
}
