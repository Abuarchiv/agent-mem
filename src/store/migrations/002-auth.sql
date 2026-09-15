-- Explicit v1 -> v2 expansion. The caller wraps this file in BEGIN IMMEDIATE/COMMIT.
CREATE TABLE auth_registry (
  version INTEGER NOT NULL CHECK (version = 1),
  account_ref TEXT PRIMARY KEY CHECK (length(account_ref) = 36),
  -- Kept while revoked cleanup is pending; cleared after all owned entries
  -- have been deleted and the registry transition is committed.
  entry_id TEXT CHECK (entry_id IS NULL OR length(entry_id) = 36),
  client_id TEXT NOT NULL CHECK (length(client_id) > 0 AND length(client_id) <= 128),
  issuer TEXT NOT NULL CHECK (issuer = 'https://github.com'),
  account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 20 AND account_id NOT GLOB '*[^0-9]*' AND account_id NOT GLOB '0*'),
  auth_epoch TEXT NOT NULL CHECK (length(auth_epoch) > 0),
  state TEXT NOT NULL CHECK (state IN ('provisioning', 'ready', 'refreshing', 'cleanup_pending', 'revoked')),
  auth_generation TEXT NOT NULL CHECK (length(auth_generation) = 36),
  pending_entry_id TEXT CHECK (pending_entry_id IS NULL OR length(pending_entry_id) = 36),
  operation_id TEXT CHECK (operation_id IS NULL OR length(operation_id) = 36),
  retiring_entry_id TEXT CHECK (retiring_entry_id IS NULL OR length(retiring_entry_id) = 36),
  access_expires_at TEXT NOT NULL,
  refresh_expires_at TEXT NOT NULL,
  granted_scope TEXT NOT NULL,
  refresh_started_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (
    (state = 'provisioning' AND pending_entry_id IS NULL AND operation_id IS NOT NULL AND retiring_entry_id IS NULL AND refresh_started_at IS NOT NULL) OR
    (state = 'ready' AND pending_entry_id IS NULL AND operation_id IS NULL AND retiring_entry_id IS NULL AND refresh_started_at IS NULL) OR
    (state = 'refreshing' AND pending_entry_id IS NOT NULL AND operation_id IS NOT NULL AND retiring_entry_id IS NULL AND refresh_started_at IS NOT NULL) OR
    (state = 'cleanup_pending' AND pending_entry_id IS NULL AND operation_id IS NOT NULL AND retiring_entry_id IS NOT NULL AND refresh_started_at IS NULL) OR
    (state = 'revoked' AND refresh_started_at IS NULL AND
      (entry_id IS NOT NULL OR (pending_entry_id IS NULL AND operation_id IS NULL AND retiring_entry_id IS NULL)))
  )
) STRICT;

CREATE INDEX auth_registry_state ON auth_registry (state, updated_at);

CREATE TABLE auth_operations (
  version INTEGER NOT NULL CHECK (version = 1),
  operation_id TEXT PRIMARY KEY CHECK (length(operation_id) = 36),
  account_ref TEXT NOT NULL CHECK (length(account_ref) = 36),
  client_id TEXT NOT NULL CHECK (length(client_id) > 0 AND length(client_id) <= 128),
  issuer TEXT NOT NULL CHECK (issuer = 'https://github.com'),
  owner_pid INTEGER NOT NULL CHECK (owner_pid >= 0),
  owner_nonce TEXT NOT NULL CHECK (length(owner_nonce) = 36),
  auth_generation TEXT CHECK (auth_generation IS NULL OR length(auth_generation) = 36),
  kind TEXT NOT NULL CHECK (kind IN ('authorization', 'provisioning', 'refresh')),
  entry_id TEXT NOT NULL CHECK (length(entry_id) = 36),
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX auth_operations_account_state ON auth_operations (account_ref, state);

CREATE TABLE auth_cleanup_entries (
  version INTEGER NOT NULL CHECK (version = 1),
  account_ref TEXT NOT NULL CHECK (length(account_ref) = 36),
  revoked_generation TEXT NOT NULL CHECK (length(revoked_generation) = 36),
  entry_id TEXT NOT NULL CHECK (length(entry_id) = 36),
  state TEXT NOT NULL CHECK (state IN ('pending', 'deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_ref, revoked_generation, entry_id)
) STRICT;

CREATE INDEX auth_cleanup_entries_state ON auth_cleanup_entries (account_ref, revoked_generation, state);

UPDATE schema_meta SET value = '2' WHERE key = 'schema_version';
