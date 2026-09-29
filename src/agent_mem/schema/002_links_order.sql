-- Schema version 2: read the most recent links per entity without sorting all of them.
CREATE INDEX links_entity_owner ON links(entity_id, owner_id);
DROP INDEX links_entity;
