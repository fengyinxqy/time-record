use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::path::Path;

const SCHEMA: &str = r#"
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS time_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    project TEXT,
    category TEXT,
    color TEXT NOT NULL DEFAULT '#7c6cf2',
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    created_at INTEGER NOT NULL,
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX IF NOT EXISTS idx_time_entries_started_at
    ON time_entries(started_at);

CREATE TABLE IF NOT EXISTS presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    project TEXT,
    category TEXT,
    color TEXT NOT NULL DEFAULT '#7c6cf2',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    active_entry_id INTEGER REFERENCES time_entries(id) ON DELETE SET NULL,
    last_heartbeat_at INTEGER
);

INSERT OR IGNORE INTO runtime_state(id, active_entry_id, last_heartbeat_at)
VALUES (1, NULL, NULL);
"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewEntry {
    pub title: String,
    pub project: Option<String>,
    pub category: Option<String>,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimeEntry {
    pub id: i64,
    pub title: String,
    pub project: Option<String>,
    pub category: Option<String>,
    pub color: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub created_at: i64,
}

pub struct Database {
    connection: Connection,
}

impl Database {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        if let Some(parent) = path.as_ref().parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let connection = Connection::open(path).map_err(|error| error.to_string())?;
        Self::from_connection(connection)
    }

    pub fn open_in_memory() -> Result<Self, String> {
        Self::from_connection(Connection::open_in_memory().map_err(|error| error.to_string())?)
    }

    fn from_connection(connection: Connection) -> Result<Self, String> {
        connection
            .execute_batch(SCHEMA)
            .map_err(|error| error.to_string())?;
        Ok(Self { connection })
    }

    pub fn table_names(&self) -> Result<Vec<String>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT name FROM sqlite_master
                 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                 ORDER BY name",
            )
            .map_err(|error| error.to_string())?;
        let names = statement
            .query_map([], |row| row.get(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<String>, _>>()
            .map_err(|error| error.to_string())?;
        Ok(names)
    }

    pub fn start_entry(&self, input: NewEntry, now: i64) -> Result<TimeEntry, String> {
        if input.title.trim().is_empty() {
            return Err("title must not be empty".to_string());
        }
        if self.active_entry()?.is_some() {
            return Err("an active timer already exists".to_string());
        }

        let transaction = self
            .connection
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO time_entries
                 (title, project, category, color, started_at, ended_at, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?5)",
                params![
                    input.title.trim(),
                    input.project,
                    input.category,
                    input.color,
                    now
                ],
            )
            .map_err(|error| error.to_string())?;
        let id = transaction.last_insert_rowid();
        transaction
            .execute(
                "UPDATE runtime_state
                 SET active_entry_id = ?1, last_heartbeat_at = ?2
                 WHERE id = 1",
                params![id, now],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        self.entry_by_id(id)?.ok_or_else(|| "created entry missing".to_string())
    }

    pub fn pause_active(&self, now: i64) -> Result<Option<TimeEntry>, String> {
        let Some(active) = self.active_entry()? else {
            return Ok(None);
        };
        let ended_at = now.max(active.started_at);
        let transaction = self
            .connection
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "UPDATE time_entries SET ended_at = ?1 WHERE id = ?2 AND ended_at IS NULL",
                params![ended_at, active.id],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "UPDATE runtime_state
                 SET active_entry_id = NULL, last_heartbeat_at = NULL
                 WHERE id = 1",
                [],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        self.entry_by_id(active.id)
    }

    pub fn active_entry(&self) -> Result<Option<TimeEntry>, String> {
        self.connection
            .query_row(
                "SELECT id, title, project, category, color, started_at, ended_at, created_at
                 FROM time_entries WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1",
                [],
                entry_from_row,
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    pub fn heartbeat(&self, now: i64) -> Result<(), String> {
        self.connection
            .execute(
                "UPDATE runtime_state SET last_heartbeat_at = ?1
                 WHERE id = 1 AND active_entry_id IS NOT NULL",
                params![now],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn recover_active(&self, now: i64) -> Result<Option<TimeEntry>, String> {
        let Some(active) = self.active_entry()? else {
            return Ok(None);
        };
        let last_heartbeat: Option<i64> = self
            .connection
            .query_row(
                "SELECT last_heartbeat_at FROM runtime_state WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .flatten();
        let ended_at = last_heartbeat.unwrap_or(now).max(active.started_at);
        let transaction = self
            .connection
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "UPDATE time_entries SET ended_at = ?1 WHERE id = ?2 AND ended_at IS NULL",
                params![ended_at, active.id],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "UPDATE runtime_state
                 SET active_entry_id = NULL, last_heartbeat_at = NULL
                 WHERE id = 1",
                [],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        self.entry_by_id(active.id)
    }

    pub fn entries_between(&self, start: i64, end: i64) -> Result<Vec<TimeEntry>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT id, title, project, category, color, started_at, ended_at, created_at
                 FROM time_entries
                 WHERE started_at < ?2 AND (ended_at IS NULL OR ended_at > ?1)
                 ORDER BY started_at, id",
            )
            .map_err(|error| error.to_string())?;
        let entries = statement
            .query_map(params![start, end], entry_from_row)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<TimeEntry>, _>>()
            .map_err(|error| error.to_string())?;
        Ok(entries)
    }

    fn entry_by_id(&self, id: i64) -> Result<Option<TimeEntry>, String> {
        self.connection
            .query_row(
                "SELECT id, title, project, category, color, started_at, ended_at, created_at
                 FROM time_entries WHERE id = ?1",
                params![id],
                entry_from_row,
            )
            .optional()
            .map_err(|error| error.to_string())
    }
}

fn entry_from_row(row: &Row<'_>) -> rusqlite::Result<TimeEntry> {
    Ok(TimeEntry {
        id: row.get(0)?,
        title: row.get(1)?,
        project: row.get(2)?,
        category: row.get(3)?,
        color: row.get(4)?,
        started_at: row.get(5)?,
        ended_at: row.get(6)?,
        created_at: row.get(7)?,
    })
}

#[cfg(test)]
mod tests {
    use super::{Database, NewEntry};

    fn new_entry(title: &str) -> NewEntry {
        NewEntry {
            title: title.to_string(),
            project: Some("个人".to_string()),
            category: Some("开发".to_string()),
            color: "#7c6cf2".to_string(),
        }
    }

    #[test]
    fn initializes_the_four_domain_tables() {
        let db = Database::open_in_memory().unwrap();
        let tables = db.table_names().unwrap();

        assert_eq!(
            tables,
            vec![
                "presets".to_string(),
                "runtime_state".to_string(),
                "settings".to_string(),
                "time_entries".to_string(),
            ]
        );
    }

    #[test]
    fn start_creates_active_entry_and_pause_closes_it() {
        let db = Database::open_in_memory().unwrap();

        let started = db.start_entry(new_entry("写代码"), 100).unwrap();
        assert_eq!(started.title, "写代码");
        assert_eq!(started.started_at, 100);
        assert_eq!(started.ended_at, None);
        assert_eq!(db.active_entry().unwrap().unwrap().id, started.id);

        let paused = db.pause_active(250).unwrap().unwrap();
        assert_eq!(paused.id, started.id);
        assert_eq!(paused.ended_at, Some(250));
        assert!(db.active_entry().unwrap().is_none());
    }

    #[test]
    fn recovery_pauses_an_orphan_at_the_last_heartbeat() {
        let db = Database::open_in_memory().unwrap();
        let started = db.start_entry(new_entry("未完成"), 100).unwrap();
        db.heartbeat(180).unwrap();

        let recovered = db.recover_active(300).unwrap().unwrap();
        assert_eq!(recovered.id, started.id);
        assert_eq!(recovered.ended_at, Some(180));
        assert!(db.active_entry().unwrap().is_none());
    }

    #[test]
    fn entries_between_returns_overlapping_entries_in_start_order() {
        let db = Database::open_in_memory().unwrap();
        let first = db.start_entry(new_entry("第一段"), 100).unwrap();
        db.pause_active(150).unwrap();
        let second = db.start_entry(new_entry("第二段"), 200).unwrap();
        db.pause_active(260).unwrap();

        let entries = db.entries_between(140, 210).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].id, first.id);
        assert_eq!(entries[1].id, second.id);
    }

    #[test]
    fn rejects_a_second_active_entry() {
        let db = Database::open_in_memory().unwrap();
        db.start_entry(new_entry("第一段"), 100).unwrap();

        let error = db.start_entry(new_entry("第二段"), 200).unwrap_err();
        assert!(error.contains("active"));
    }
}
