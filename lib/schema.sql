-- 5Cycle schema. SQLite (node:sqlite). Idempotent: safe to run on every boot.

-- terms of the academic calendar, e.g. FA2026 / SP2027
CREATE TABLE IF NOT EXISTS terms (
  id          TEXT PRIMARY KEY,            -- 'SP2027'
  year        INTEGER NOT NULL,
  term        TEXT NOT NULL,               -- 'FA' | 'SP' | 'SU'
  label       TEXT NOT NULL,               -- 'Spring 2027'
  is_current  INTEGER NOT NULL DEFAULT 0,
  synced_at   TEXT
);

-- One row per *section* (a specific offering of a course in a term).
CREATE TABLE IF NOT EXISTS sections (
  id             TEXT PRIMARY KEY,         -- 'CSCI-005-HM-01-SP2027'
  term_id        TEXT NOT NULL REFERENCES terms(id),
  department     TEXT NOT NULL,
  course_number  INTEGER NOT NULL,
  suffix         TEXT NOT NULL DEFAULT '',
  affiliation    TEXT NOT NULL,            -- CM/PO/HM/SC/PZ + consortium codes (KS, JP, ...)
  section_number INTEGER NOT NULL,
  half           TEXT,                     -- 'F1','P2', ... or NULL for full term
  code_string    TEXT NOT NULL,            -- 'CSCI 005 HM-01 · SP2027'
  course_code    TEXT NOT NULL,            -- 'CSCI 005 HM' (term-independent identity)
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  school         TEXT NOT NULL,            -- primaryAssociation: teaching campus
  credits        REAL NOT NULL DEFAULT 0,
  perm_count     INTEGER NOT NULL DEFAULT 0,
  seats_total    INTEGER NOT NULL DEFAULT 0,
  seats_filled   INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'U',-- O/C/R/U
  start_date     TEXT,
  end_date       TEXT,
  potential_error INTEGER NOT NULL DEFAULT 0,
  search         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_sections_term    ON sections(term_id);
CREATE INDEX IF NOT EXISTS ix_sections_school  ON sections(school);
CREATE INDEX IF NOT EXISTS ix_sections_dept    ON sections(department);
CREATE INDEX IF NOT EXISTS ix_sections_code    ON sections(course_code);
CREATE INDEX IF NOT EXISTS ix_sections_term_school ON sections(term_id, school);
CREATE INDEX IF NOT EXISTS ix_sections_status  ON sections(status);

CREATE TABLE IF NOT EXISTS section_schedules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  days       TEXT NOT NULL,                -- 'MWF'
  start_time INTEGER NOT NULL,             -- seconds since midnight
  end_time   INTEGER NOT NULL,
  locations  TEXT NOT NULL DEFAULT ''      -- '；'-joined
);
CREATE INDEX IF NOT EXISTS ix_sched_section ON section_schedules(section_id);

-- Instructors are keyed on a normalized name; HyperSchedule gives no stable ID.
CREATE TABLE IF NOT EXISTS instructors (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  normalized    TEXT NOT NULL UNIQUE,
  home_school   TEXT,
  section_count INTEGER NOT NULL DEFAULT 0,
  -- RateMyProfessors mirror (best-effort; see lib/rmp.ts)
  rmp_quality   REAL,
  rmp_difficulty REAL,
  rmp_num_ratings INTEGER,
  rmp_url       TEXT,
  rmp_tags      TEXT,
  rmp_synced_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_instructors_norm ON instructors(normalized);

CREATE TABLE IF NOT EXISTS section_instructors (
  section_id    TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  instructor_id TEXT NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
  PRIMARY KEY (section_id, instructor_id)
);
CREATE INDEX IF NOT EXISTS ix_secinstr_instructor ON section_instructors(instructor_id);

-- Registrar course-area designations. Numbered prefixes (1x POM, 2x SCR,
-- 3x CMC, 4x HM, 5x PZ) are general-education categories; alpha codes are
-- department/interdisciplinary programs.
CREATE TABLE IF NOT EXISTS course_areas (
  code        TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  school      TEXT,                        -- owning campus for GE codes, else NULL
  kind        TEXT NOT NULL DEFAULT 'dept' -- 'ge' | 'dept'
);

CREATE TABLE IF NOT EXISTS section_areas (
  section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  area_code  TEXT NOT NULL REFERENCES course_areas(code),
  PRIMARY KEY (section_id, area_code)
);
CREATE INDEX IF NOT EXISTS ix_areas_area ON section_areas(area_code);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  school        TEXT NOT NULL,             -- home campus code
  grad_year     INTEGER,
  major_id      TEXT,
  major2_id     TEXT,                      -- double major (tracked like major_id)
  minor_id      TEXT,
  advisor       TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

-- A course a student has placed in a term. Drives both the timetable and the
-- requirement checklist.
CREATE TABLE IF NOT EXISTS enrollments (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  section_id    TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  term_id       TEXT NOT NULL,
  planned_year  INTEGER,                   -- for multi-year 'which year do I take it' view
  status        TEXT NOT NULL DEFAULT 'planned', -- planned | waitlist | perm_requested | registered
  note          TEXT,
  added_at      TEXT NOT NULL,
  UNIQUE (user_id, section_id)
);
CREATE INDEX IF NOT EXISTS ix_enroll_user ON enrollments(user_id, term_id);

-- Native professor reviews (our own stars), optionally tied to a section.
CREATE TABLE IF NOT EXISTS reviews (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instructor_id TEXT NOT NULL REFERENCES instructors(id) ON DELETE CASCADE,
  section_id    TEXT REFERENCES sections(id) ON DELETE SET NULL,
  stars         INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  difficulty    REAL,
  workload      TEXT,
  grade         TEXT,
  take_again    INTEGER,
  text          TEXT NOT NULL DEFAULT '',
  tags          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_reviews_instructor ON reviews(instructor_id);

-- Major / minor / GE requirement catalogs. Seeded from data/requirements/*.json
-- (edit those files, then POST /api/requirements/reload).
CREATE TABLE IF NOT EXISTS requirement_sets (
  id            TEXT PRIMARY KEY,          -- 'ge-CMC' | 'major-CMC-CS' | 'minor-PTZ-ORST'
  school        TEXT NOT NULL,
  kind          TEXT NOT NULL,             -- 'ge' | 'major' | 'minor'
  name          TEXT NOT NULL,
  degree_years  INTEGER,
  total_credits REAL,
  notes         TEXT,
  source        TEXT,
  verified      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_sets_school ON requirement_sets(school, kind);

CREATE TABLE IF NOT EXISTS requirement_groups (
  id          TEXT PRIMARY KEY,
  set_id      TEXT NOT NULL REFERENCES requirement_sets(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  min_courses INTEGER,
  min_credits REAL,
  required    INTEGER NOT NULL DEFAULT 1,
  level       TEXT NOT NULL DEFAULT 'any', -- intro | upper | any
  notes       TEXT
);
CREATE INDEX IF NOT EXISTS ix_groups_set ON requirement_groups(set_id);

-- Each group is satisfied by any combination of its rules' matching courses.
CREATE TABLE IF NOT EXISTS requirement_rules (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL REFERENCES requirement_groups(id) ON DELETE CASCADE,
  match    TEXT NOT NULL                   -- JSON matcher, see lib/requirements.ts
);
CREATE INDEX IF NOT EXISTS ix_rules_group ON requirement_rules(group_id);

-- Manual requirement assignment: a student (or their advisor's designation)
-- locks one course to one or more requirement groups. This overrides the
-- matcher for open-ended groups like "Data-science designated courses" and
-- is the double-dip control: a course counts once per requirement SET
-- (GE / major / minor), while Educational-Objective and Breadth groups may
-- take the same course more than once.
-- Manually entered courses: study-abroad classes, transfer credit,
-- "create your own" / designated courses that have no catalog section.
CREATE TABLE IF NOT EXISTS manual_courses (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  term_id     TEXT,                        -- NULL for pseudo-terms (e.g. summer abroad)
  term_label  TEXT NOT NULL,               -- free text: "Summer 2027 (abroad)"
  title       TEXT NOT NULL,
  credits     REAL NOT NULL,               -- 5C-normalized credits, as entered
  kind        TEXT NOT NULL DEFAULT 'custom',  -- abroad | transfer | custom
  note        TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_manual_user ON manual_courses(user_id);

-- One row per (course, group) so a course can be checked off against
-- several boxes at once (multi-select assignment). A course may be pinned
-- into boxes in several sets at once (major + minor + GE), and
-- educational-objective / breadth boxes may double-dip a course that already
-- counts elsewhere in the same set.
CREATE TABLE IF NOT EXISTS requirement_assignments (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- exactly one of section_id / manual_id is set
  section_id  TEXT REFERENCES sections(id) ON DELETE CASCADE,
  manual_id   TEXT REFERENCES manual_courses(id) ON DELETE CASCADE,
  set_id      TEXT NOT NULL REFERENCES requirement_sets(id) ON DELETE CASCADE,
  group_id    TEXT NOT NULL REFERENCES requirement_groups(id) ON DELETE CASCADE,
  note        TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (user_id, section_id, group_id),
  UNIQUE (user_id, manual_id, group_id)
);
CREATE INDEX IF NOT EXISTS ix_assign_user ON requirement_assignments(user_id);

-- Per-term planner flags (study abroad, etc.).
CREATE TABLE IF NOT EXISTS user_term_flags (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  term_id     TEXT NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  is_abroad   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, term_id)
);

-- In-app notifications (a seat opened in a class the student is waitlisted for).
CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  section_id  TEXT,
  kind        TEXT NOT NULL,               -- seat_open
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  read_at     TEXT,
  emailed_at  TEXT
);
CREATE INDEX IF NOT EXISTS ix_notif_user ON notifications(user_id, read_at);

-- "Notify me when a spot opens" ticks on full, planned classes.
CREATE TABLE IF NOT EXISTS seat_alerts (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  section_id  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, section_id)
);

-- Terms a student studies abroad. No FK to terms: students mark summers and
-- future terms the catalog hasn't published yet.
CREATE TABLE IF NOT EXISTS study_abroad_terms (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  term_id     TEXT NOT NULL,               -- FA2026 / SP2027 / SU2027
  PRIMARY KEY (user_id, term_id)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Aggregate view of our own review scores, joined with the RMP mirror.
CREATE VIEW IF NOT EXISTS instructor_ratings AS
SELECT
  i.id,
  i.name,
  i.section_count,
  COUNT(r.id)                       AS review_count,
  ROUND(AVG(r.stars), 2)            AS avg_stars,
  ROUND(AVG(r.difficulty), 2)       AS avg_difficulty,
  i.rmp_quality,
  i.rmp_difficulty                  AS rmp_difficulty,
  i.rmp_num_ratings,
  i.rmp_url
FROM instructors i
LEFT JOIN reviews r ON r.instructor_id = i.id
GROUP BY i.id;
