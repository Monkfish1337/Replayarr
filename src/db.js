import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Each entry runs once, in order, inside a transaction. Append only: an
// existing install has already applied the earlier ones.
const MIGRATIONS = [
  `CREATE TABLE settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );
   CREATE TABLE events (
     id TEXT PRIMARY KEY,
     promotion_id TEXT,
     title TEXT NOT NULL,
     date TEXT NOT NULL,
     time TEXT,
     aliases TEXT NOT NULL DEFAULT '[]',
     source TEXT NOT NULL,
     source_revision TEXT,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX events_date ON events (date);
   CREATE TABLE requests (
     id INTEGER PRIMARY KEY,
     event_id TEXT NOT NULL UNIQUE REFERENCES events (id),
     status TEXT NOT NULL,
     candidate_id INTEGER,
     search_count INTEGER NOT NULL DEFAULT 0,
     next_search_at TEXT,
     error TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE search_attempts (
     id INTEGER PRIMARY KEY,
     request_id INTEGER NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
     source TEXT NOT NULL,
     queries TEXT NOT NULL,
     result_count INTEGER NOT NULL,
     matched_count INTEGER NOT NULL,
     duration_ms INTEGER NOT NULL,
     error TEXT,
     created_at TEXT NOT NULL
   );
   CREATE TABLE candidates (
     id INTEGER PRIMARY KEY,
     request_id INTEGER NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
     identity TEXT NOT NULL,
     source TEXT NOT NULL,
     indexer TEXT,
     protocol TEXT NOT NULL,
     title TEXT NOT NULL,
     download_url TEXT,
     info_hash TEXT,
     size INTEGER,
     seeders INTEGER,
     quality TEXT,
     score INTEGER NOT NULL,
     decision TEXT NOT NULL,
     reason TEXT,
     evidence TEXT NOT NULL DEFAULT '[]',
     published_at TEXT,
     found_at TEXT NOT NULL,
     UNIQUE (request_id, identity)
   );
   CREATE TABLE jobs (
     id INTEGER PRIMARY KEY,
     request_id INTEGER NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
     candidate_id INTEGER NOT NULL REFERENCES candidates (id),
     client TEXT NOT NULL,
     remote_id TEXT,
     state TEXT NOT NULL,
     progress REAL NOT NULL DEFAULT 0,
     remote_path TEXT,
     error TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE library (
     id INTEGER PRIMARY KEY,
     event_id TEXT NOT NULL UNIQUE REFERENCES events (id),
     request_id INTEGER REFERENCES requests (id) ON DELETE SET NULL,
     path TEXT NOT NULL,
     size INTEGER NOT NULL,
     quality TEXT,
     release_title TEXT,
     imported_at TEXT NOT NULL
   );
   CREATE TABLE activity (
     id INTEGER PRIMARY KEY,
     request_id INTEGER,
     kind TEXT NOT NULL,
     text TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE TABLE promotion_rules (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN ('custom', 'overlay')),
     spec TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );`,
  // Which configured indexer found a candidate; Easynews downloads need its credentials.
  `ALTER TABLE candidates ADD COLUMN source_id TEXT;`,
  // Replayarr fetches schedules itself. Events keep the full normalised record
  // the matchers read (team names, week, season, round...); promotions carry
  // follow state, provider choice, start date, logo and last refresh result.
  `ALTER TABLE events ADD COLUMN payload TEXT;
   CREATE TABLE providers (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     source TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE TABLE promotion_meta (
     promotion_id TEXT PRIMARY KEY,
     followed INTEGER NOT NULL DEFAULT 0,
     provider_id TEXT,
     start_date TEXT,
     logo_url TEXT,
     refreshed_at TEXT,
     refresh_count INTEGER,
     refresh_error TEXT
   );
   INSERT INTO promotion_meta (promotion_id, followed)
     SELECT DISTINCT events.promotion_id, 1 FROM events JOIN requests ON requests.event_id = events.id
     WHERE events.promotion_id IS NOT NULL;`,
  // Season/episode numbers given to an imported event, kept so renames and
  // media-server metadata stay stable.
  `ALTER TABLE library ADD COLUMN season INTEGER;
   ALTER TABLE library ADD COLUMN episode INTEGER;`,
];

export function openDatabase(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let index = version; index < MIGRATIONS.length; index += 1) {
    transaction(db, () => {
      db.exec(MIGRATIONS[index]);
      db.exec(`PRAGMA user_version = ${index + 1}`);
    });
  }
  return db;
}

export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
