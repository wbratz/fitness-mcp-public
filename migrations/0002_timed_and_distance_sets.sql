-- Not all work is countable in reps.
--
-- Planks, dead hangs, and timed carries are measured in time; farmer's walks,
-- sled pushes, and sprints are often measured in distance. Both were previously
-- unrepresentable: `reps` was required, so duration ended up in free-text notes
-- where it could not be queried or tracked for progression.
--
-- `reps` was already nullable at the schema level, so no column changes there —
-- the requirement lived only in the log_sets tool schema.
--
-- Distance is stored in metres so progression math compares cleanly across
-- yards, feet, and miles. The model converts on the way in and back on the way
-- out; nobody has to read "36.58" as a number of yards.

ALTER TABLE sets ADD COLUMN duration_sec INTEGER;
ALTER TABLE sets ADD COLUMN distance_m REAL;

-- Partial indexes: these two columns are NULL for the overwhelming majority of
-- rows, so indexing only the populated ones keeps them cheap while still making
-- "best plank" and "longest carry" fast.
CREATE INDEX IF NOT EXISTS idx_sets_duration
  ON sets(exercise, duration_sec) WHERE duration_sec IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sets_distance
  ON sets(exercise, distance_m) WHERE distance_m IS NOT NULL;
