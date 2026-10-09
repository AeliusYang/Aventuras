-- Explicit ownership for history-derived records used by collaborative rollback.
ALTER TABLE checkpoints ADD COLUMN branch_id TEXT REFERENCES branches(id) ON DELETE CASCADE;

UPDATE checkpoints
SET branch_id = (
  SELECT story_entries.branch_id
  FROM story_entries
  WHERE story_entries.id = checkpoints.last_entry_id
)
WHERE branch_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_checkpoints_branch
  ON checkpoints(story_id, branch_id, created_at);

CREATE TRIGGER IF NOT EXISTS delete_branch_world_state_snapshots
AFTER DELETE ON branches
BEGIN
  DELETE FROM world_state_snapshots WHERE branch_id = OLD.id;
END;
