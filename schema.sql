-- D1 schema for the online booking widget's slot-lock + audit table.
--
-- This table is NOT the source of truth for occupancy -- ServiceM8 is (see
-- readStaffOccupancy in src/servicem8.js). It exists to close the short race
-- between "we told the customer this slot is free" and "we actually created
-- the ServiceM8 jobactivity that makes it busy": the UNIQUE constraint on
-- (staff_uuid, start_date) means two customers racing for the same slot can't
-- both get a 'pending' row, and status tracks the row through to a confirmed
-- ServiceM8 booking (or back out if creation fails).
CREATE TABLE IF NOT EXISTS bookings (
  id               TEXT PRIMARY KEY,
  staff_uuid       TEXT NOT NULL,
  start_date       TEXT NOT NULL,        -- "YYYY-MM-DD HH:MM:SS" Sydney local
  end_date         TEXT NOT NULL,        -- "YYYY-MM-DD HH:MM:SS" Sydney local
  service          TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',   -- pending | confirmed | released
  job_uuid         TEXT,
  jobactivity_uuid TEXT,
  customer_email   TEXT,
  customer_phone   TEXT,
  created_at       INTEGER NOT NULL,     -- epoch ms
  UNIQUE (staff_uuid, start_date)
);
CREATE INDEX IF NOT EXISTS idx_bookings_staff_day ON bookings (staff_uuid, start_date);

-- Visual editor overrides (see src/content-edits.js).
--
-- One row per edited piece of copy: `address` names it by a hash of its
-- current wording rather than by position, so unrelated changes to the page
-- can never repoint an edit at the wrong words. `draft` is what you see in
-- preview, `published` is what visitors see, and `original` records what the
-- HTML file said so scripts/sync-content-edits.js can find it again.
--
-- The Worker creates this table on demand, so applying this file by hand is
-- optional -- it is here so the schema stays documented in one place.
CREATE TABLE IF NOT EXISTS content_edits (
  path         TEXT NOT NULL,        -- "/spider-control"
  address      TEXT NOT NULL,        -- "t:<hash>:<ordinal>" | "a:<tag>:<attr>:<hash>:<ordinal>" | "m:title"
  kind         TEXT NOT NULL,        -- text | attr | meta
  original     TEXT NOT NULL,        -- wording as it appears in the HTML file
  draft        TEXT,                 -- unpublished edit, visible in preview only
  published    TEXT,                 -- live edit, served to visitors
  updated_by   TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,     -- epoch ms
  published_at INTEGER,              -- epoch ms
  PRIMARY KEY (path, address)
);
CREATE INDEX IF NOT EXISTS idx_content_edits_published ON content_edits (published);
