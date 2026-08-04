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
