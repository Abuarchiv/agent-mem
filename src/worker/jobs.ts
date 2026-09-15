import type { JobClaim, JobPauseReason, JobRepository, JobRetryResult } from "../store/job-repository.js";

/** Deterministic scheduler lifecycle hooks; no model or provider execution is registered here. */
export interface JobRunnerHooks {
  readonly onCompleted?: (claim: JobClaim) => void;
  readonly onPaused?: (claim: JobClaim, reason: JobPauseReason) => void;
  readonly onRetried?: (claim: JobClaim, result: JobRetryResult) => void;
  readonly onError?: (error: unknown) => void;
}

export type JobRepositoryPort = Pick<JobRepository, "claimNext" | "renew" | "complete" | "retry" | "pause" | "resume">;
