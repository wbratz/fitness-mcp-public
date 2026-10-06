-- Fitness tracker schema. Applied identically to every per-user database.
-- No user_id columns anywhere: the database IS the user boundary.
-- Dates are TEXT 'YYYY-MM-DD', times 'HH:MM', created_at full ISO-8601 UTC.
-- All weights in pounds (REAL).

CREATE TABLE IF NOT EXISTS workouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,                -- YYYY-MM-DD
  label TEXT,                        -- 'Push', 'Pull', 'Legs', 'BJJ', freeform
  duration_min INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_workouts_date ON workouts(date);

CREATE TABLE IF NOT EXISTS sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workout_id INTEGER REFERENCES workouts(id) ON DELETE SET NULL,
  date TEXT NOT NULL,                -- denormalized so orphan sets query cleanly
  exercise TEXT NOT NULL,            -- canonical free-text name (LLM-normalized)
  set_number INTEGER,
  weight_lbs REAL,                   -- NULL = bodyweight
  reps INTEGER,
  rpe REAL,
  is_warmup INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_sets_exercise_date ON sets(exercise, date);
CREATE INDEX IF NOT EXISTS idx_sets_date ON sets(date);
CREATE INDEX IF NOT EXISTS idx_sets_workout ON sets(workout_id);

CREATE TABLE IF NOT EXISTS weighins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,         -- one per day; log_weighin upserts
  weight_lbs REAL NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS meals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  time TEXT,
  description TEXT NOT NULL,
  calories INTEGER,
  protein_g REAL,
  carbs_g REAL,
  fat_g REAL,
  source TEXT NOT NULL DEFAULT 'estimate',  -- 'estimate' | 'manual'
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_meals_date ON meals(date);

CREATE TABLE IF NOT EXISTS progress_pics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,       -- '<user>/pics/2026-08-05-front-<rand>.jpg'
  pose TEXT,                         -- 'front' | 'side' | 'back' | freeform
  weight_lbs REAL,
  content_type TEXT NOT NULL DEFAULT 'image/jpeg',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_pics_date ON progress_pics(date);

-- goals & plans
CREATE TABLE IF NOT EXISTS profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),   -- singleton row
  goal TEXT,                               -- freeform: 'lose 15 lbs by Christmas, keep strength'
  stats_json TEXT,                         -- height, age, anything the user volunteers
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO profile (id) VALUES (1);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                -- 'PPL + Shoulders/Arms', '3-day full body'
  content TEXT NOT NULL,             -- the plan itself, markdown
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
