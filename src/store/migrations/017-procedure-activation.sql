-- Schema 17: T18b procedure activation (plan §5 procedure_activation, §7 T18b).
-- A procedure is a memory_item with kind 'procedure' created and revised
-- ONLY through the verified extraction pipeline. This table is the SEPARATE,
-- scoped, CAS-protected recommendation state: activation never creates new
-- authorities and never writes memory items. Only rows with status 'active'
-- may be recommended inside an EvidencePacket, and only within the approved
-- recommendation policy version recorded on the row. revoked/deprecated/purged
-- rows are immediately excluded from every new core-controlled output.
-- Scope is part of every primary and foreign key (plan §5 invariant 7).
CREATE TABLE IF NOT EXISTS procedure_activation (
  scope_id TEXT NOT NULL CHECK (length(scope_id) = 36),
  procedure_item_id TEXT NOT NULL CHECK (length(procedure_item_id) = 36),
  status TEXT NOT NULL CHECK (status IN ('candidate', 'validated', 'active', 'deprecated', 'revoked', 'purged')),
  -- Approved recommendation policy that allowed the activation; required for
  -- 'active', NULL otherwise (a validated row is not yet recommendable).
  policy_version TEXT CHECK (policy_version IS NULL OR (length(policy_version) > 0 AND length(policy_version) <= 128)),
  -- Bounded activation conditions (plan §7: pre-approved policy, explicit scope
  -- and conditions); validated server-side before any recommendation read.
  conditions_json TEXT NOT NULL CHECK (json_valid(conditions_json) AND json_type(conditions_json) = 'object'),
  -- Revision that validation evidence was checked against / that is active.
  validated_revision TEXT CHECK (validated_revision IS NULL OR length(validated_revision) = 36),
  active_revision TEXT CHECK (active_revision IS NULL OR length(active_revision) = 36),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope_id, procedure_item_id),
  FOREIGN KEY (scope_id) REFERENCES scope (scope_id) ON DELETE RESTRICT,
  FOREIGN KEY (scope_id, procedure_item_id) REFERENCES memory_item (scope_id, item_id) ON DELETE RESTRICT,
  CHECK (status <> 'validated' OR validated_revision IS NOT NULL),
  CHECK (
    status <> 'active' OR (
      policy_version IS NOT NULL AND
      validated_revision IS NOT NULL AND
      active_revision IS NOT NULL AND
      active_revision = validated_revision
    )
  ),
  CHECK (status IN ('candidate') OR created_at <= updated_at)
) STRICT;

CREATE INDEX IF NOT EXISTS procedure_activation_scope_status
  ON procedure_activation (scope_id, status);

UPDATE schema_meta SET value = '17' WHERE key = 'schema_version';
