-- Schema 15: T11/T11b extraction batches bound to reconciled execution attempts (plan T11/T11b).
-- T11/T11b durable extraction and semantic-verification state. Source text is
-- copied only after the normal provider grant/purge checks and remains bounded
-- by the batch source limit; candidates and verdicts are immutable protocol
-- records, never public status setters.
CREATE TABLE IF NOT EXISTS extraction_batch (
  batch_id TEXT PRIMARY KEY CHECK (length(batch_id) = 36),
  job_id TEXT NOT NULL UNIQUE CHECK (length(job_id) = 36),
  scope_id TEXT NOT NULL CHECK (length(scope_id) = 36),
  source_capture_id TEXT NOT NULL CHECK (length(source_capture_id) = 36),
  task_version TEXT NOT NULL CHECK (length(task_version) > 0 AND length(task_version) <= 128),
  input_fingerprint TEXT NOT NULL CHECK (length(input_fingerprint) = 64),
  input_privacy_epoch TEXT NOT NULL CHECK (length(input_privacy_epoch) > 0),
  source_token_count INTEGER NOT NULL CHECK (source_token_count > 0 AND source_token_count <= 6000),
  source_measurement_unit TEXT NOT NULL CHECK (source_measurement_unit IN ('tokens', 'utf8_bytes')),
  continuation_json TEXT CHECK (continuation_json IS NULL OR (json_valid(continuation_json) AND length(continuation_json) <= 4096)),
  target_json TEXT NOT NULL CHECK (json_valid(target_json) AND length(target_json) <= 32768),
  state TEXT NOT NULL CHECK (state IN ('prepared', 'extracted', 'verified', 'completed', 'failed')),
  extraction_digest TEXT CHECK (extraction_digest IS NULL OR length(extraction_digest) = 64),
  verification_digest TEXT CHECK (verification_digest IS NULL OR length(verification_digest) = 64),
  completion_receipt_json TEXT CHECK (completion_receipt_json IS NULL OR (json_valid(completion_receipt_json) AND length(completion_receipt_json) <= 32768)),
  extract_attempt_id TEXT CHECK (extract_attempt_id IS NULL OR length(extract_attempt_id) = 36),
  extract_result_digest TEXT CHECK (extract_result_digest IS NULL OR length(extract_result_digest) = 64),
  verify_attempt_id TEXT CHECK (verify_attempt_id IS NULL OR length(verify_attempt_id) = 36),
  verify_result_digest TEXT CHECK (verify_result_digest IS NULL OR length(verify_result_digest) = 64),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES job (job_id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, source_capture_id) REFERENCES source_event (scope_id, capture_id) ON DELETE RESTRICT,
  FOREIGN KEY (extract_attempt_id) REFERENCES execution_attempt (attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (verify_attempt_id) REFERENCES execution_attempt (attempt_id) ON DELETE RESTRICT,
  CHECK ((extract_attempt_id IS NULL) = (extract_result_digest IS NULL)),
  CHECK ((verify_attempt_id IS NULL) = (verify_result_digest IS NULL)),
  CHECK (state NOT IN ('extracted', 'verified', 'completed') OR extract_attempt_id IS NOT NULL),
  CHECK (state NOT IN ('verified', 'completed') OR verify_attempt_id IS NOT NULL),
  CHECK ((state = 'completed') = (completion_receipt_json IS NOT NULL))
) STRICT;

CREATE TABLE IF NOT EXISTS extraction_batch_source (
  batch_id TEXT NOT NULL CHECK (length(batch_id) = 36),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal < 256),
  scope_id TEXT NOT NULL CHECK (length(scope_id) = 36),
  capture_id TEXT NOT NULL CHECK (length(capture_id) = 36),
  span_id TEXT NOT NULL CHECK (length(span_id) = 36),
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  evidence_class TEXT NOT NULL CHECK (evidence_class IN ('prompt', 'assistant_output', 'tool_input', 'tool_output', 'lifecycle', 'diagnostic')),
  captured_at TEXT NOT NULL,
  occurred_at TEXT,
  text TEXT NOT NULL CHECK (length(text) > 0 AND length(text) <= 100000),
  PRIMARY KEY (batch_id, ordinal),
  UNIQUE (batch_id, scope_id, capture_id, span_id),
  FOREIGN KEY (batch_id) REFERENCES extraction_batch (batch_id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, capture_id, span_id) REFERENCES source_span (scope_id, source_id, span_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS extraction_batch_source_lookup
  ON extraction_batch_source (batch_id, capture_id, span_id);

CREATE TABLE IF NOT EXISTS extraction_candidate (
  batch_id TEXT NOT NULL CHECK (length(batch_id) = 36),
  candidate_id TEXT NOT NULL CHECK (length(candidate_id) = 36),
  candidate_digest TEXT NOT NULL CHECK (length(candidate_digest) = 64),
  candidate_json TEXT NOT NULL CHECK (json_valid(candidate_json) AND length(candidate_json) <= 16384),
  state TEXT NOT NULL CHECK (state IN ('candidate', 'verified', 'disputed', 'error')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (batch_id, candidate_id),
  UNIQUE (batch_id, candidate_digest),
  FOREIGN KEY (batch_id) REFERENCES extraction_batch (batch_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS extraction_candidate_digest
  ON extraction_candidate (candidate_digest);

CREATE TABLE IF NOT EXISTS extraction_verdict (
  batch_id TEXT NOT NULL CHECK (length(batch_id) = 36),
  candidate_id TEXT NOT NULL CHECK (length(candidate_id) = 36),
  candidate_digest TEXT NOT NULL CHECK (length(candidate_digest) = 64),
  entailment TEXT NOT NULL CHECK (entailment IN ('entailed', 'contradicted', 'uncertain')),
  attribution TEXT NOT NULL CHECK (attribution IN ('positive', 'negative', 'uncertain')),
  modality TEXT NOT NULL CHECK (modality IN ('positive', 'negative', 'uncertain')),
  negation TEXT NOT NULL CHECK (negation IN ('positive', 'negative', 'uncertain')),
  time TEXT NOT NULL CHECK (time IN ('positive', 'negative', 'uncertain')),
  receipt_digest TEXT NOT NULL CHECK (length(receipt_digest) = 64),
  created_at TEXT NOT NULL,
  PRIMARY KEY (batch_id, candidate_id),
  UNIQUE (batch_id, candidate_id, candidate_digest),
  FOREIGN KEY (batch_id, candidate_id) REFERENCES extraction_candidate (batch_id, candidate_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS extraction_verdict_receipt
  ON extraction_verdict (batch_id, receipt_digest);

UPDATE schema_meta SET value = '15' WHERE key = 'schema_version';
