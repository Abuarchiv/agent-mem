-- T11c provider-specific API credential metadata. No secret is persisted.
CREATE TABLE IF NOT EXISTS api_auth_registry (
  version INTEGER NOT NULL CHECK (version = 1),
  provider_id TEXT NOT NULL CHECK (provider_id = 'openrouter'),
  account_ref TEXT PRIMARY KEY CHECK (length(account_ref) = 36),
  entry_id TEXT NOT NULL CHECK (length(entry_id) = 36),
  auth_generation TEXT NOT NULL CHECK (length(auth_generation) = 36),
  auth_epoch TEXT NOT NULL CHECK (length(auth_epoch) > 0),
  state TEXT NOT NULL CHECK (state IN ('ready', 'revoked')),
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS api_auth_registry_state ON api_auth_registry (provider_id, state, updated_at);

UPDATE schema_meta SET value = '13' WHERE key = 'schema_version';
