-- A minimum reader version: older binaries must reject backup quarantine semantics.
-- No table rebuild is needed; schema_meta owns the durable recovery metadata.
UPDATE schema_meta SET value = '24' WHERE key = 'schema_version';
