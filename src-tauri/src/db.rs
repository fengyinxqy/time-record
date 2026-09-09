use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;

const SCHEMA: &str = r#"
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL DEFAULT '#7c6cf2',
    sort_order INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS time_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX IF NOT EXISTS idx_time_segments_started_at
    ON time_segments(started_at);
CREATE INDEX IF NOT EXISTS idx_time_segments_project_id
    ON time_segments(project_id);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    active_segment_id INTEGER REFERENCES time_segments(id) ON DELETE SET NULL,
    last_heartbeat_at INTEGER
);

INSERT OR IGNORE INTO runtime_state(id, active_segment_id, last_heartbeat_at)
VALUES (1, NULL, NULL);
"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewProject {
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: i64,
    pub name: String,
    pub color: String,
    pub sort_order: i64,
    pub archived: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimeSegment {
    pub id: i64,
    pub project_id: i64,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportData {
    pub projects: Vec<Project>,
    pub time_segments: Vec<TimeSegment>,
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

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, String> {
        Self::from_connection(Connection::open_in_memory().map_err(|error| error.to_string())?)
    }

    fn from_connection(connection: Connection) -> Result<Self, String> {
        connection
            .execute_batch(SCHEMA)
            .map_err(|error| error.to_string())?;
        ensure_updated_at_columns(&connection)?;
        Ok(Self { connection })
    }

    #[cfg(test)]
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

    pub fn silent_start(&self) -> Result<bool, String> {
        let value = self
            .connection
            .query_row(
                "SELECT value FROM settings WHERE key = 'silent_start'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        Ok(value.as_deref() == Some("true"))
    }

    pub fn set_silent_start(&self, enabled: bool) -> Result<(), String> {
        self.connection
            .execute(
                "INSERT INTO settings(key, value) VALUES ('silent_start', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![enabled.to_string()],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn create_project(&self, input: NewProject, now: i64) -> Result<Project, String> {
        let name = input.name.trim();
        if name.is_empty() {
            return Err("project name must not be empty".to_string());
        }
        self.connection
            .execute(
                "INSERT INTO projects (name, color, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
                params![name, input.color, now],
            )
            .map_err(|error| {
                if error.to_string().contains("UNIQUE constraint failed") {
                    "project name already exists".to_string()
                } else {
                    error.to_string()
                }
            })?;
        let id = self.connection.last_insert_rowid();
        self.project_by_id(id)?
            .ok_or_else(|| "created project missing".to_string())
    }

    pub fn list_projects(&self, include_archived: bool) -> Result<Vec<Project>, String> {
        let query = if include_archived {
            "SELECT id, name, color, sort_order, archived, created_at, updated_at
             FROM projects ORDER BY sort_order, created_at, id"
        } else {
            "SELECT id, name, color, sort_order, archived, created_at, updated_at
             FROM projects WHERE archived = 0 ORDER BY sort_order, created_at, id"
        };
        let mut statement = self
            .connection
            .prepare(query)
            .map_err(|error| error.to_string())?;
        let projects = statement
            .query_map([], project_from_row)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<Project>, _>>()
            .map_err(|error| error.to_string())?;
        Ok(projects)
    }

    pub fn archive_project(&self, project_id: i64, now: i64) -> Result<(), String> {
        if self
            .connection
            .query_row(
                "SELECT 1 FROM time_segments
                 WHERE project_id = ?1 AND ended_at IS NULL LIMIT 1",
                params![project_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            return Err("cannot archive the active project".to_string());
        }
        let changed = self
            .connection
            .execute(
                "UPDATE projects SET archived = 1, updated_at = ?2 WHERE id = ?1",
                params![project_id, now],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err("project not found".to_string());
        }
        Ok(())
    }

    pub fn start_project(&self, project_id: i64, now: i64) -> Result<TimeSegment, String> {
        let project = self
            .project_by_id(project_id)?
            .ok_or_else(|| "project not found".to_string())?;
        if project.archived {
            return Err("cannot start an archived project".to_string());
        }

        let transaction = self
            .connection
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        let active_id: Option<i64> = transaction
            .query_row(
                "SELECT id FROM time_segments WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(active_id) = active_id {
            let active_project_id: i64 = transaction
                .query_row(
                    "SELECT project_id FROM time_segments WHERE id = ?1",
                    params![active_id],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            if active_project_id == project_id {
                transaction.commit().map_err(|error| error.to_string())?;
                return self
                    .segment_by_id(active_id)?
                    .ok_or_else(|| "active segment missing".to_string());
            }
            let active_started_at: i64 = transaction
                .query_row(
                    "SELECT started_at FROM time_segments WHERE id = ?1",
                    params![active_id],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            transaction
                .execute(
                    "UPDATE time_segments SET ended_at = ?1, updated_at = ?1 WHERE id = ?2",
                    params![now.max(active_started_at), active_id],
                )
                .map_err(|error| error.to_string())?;
        }

        transaction
            .execute(
                "INSERT INTO time_segments (project_id, started_at, ended_at, created_at, updated_at)
                 VALUES (?1, ?2, NULL, ?2, ?2)",
                params![project_id, now],
            )
            .map_err(|error| error.to_string())?;
        let segment_id = transaction.last_insert_rowid();
        transaction
            .execute(
                "UPDATE runtime_state
                 SET active_segment_id = ?1, last_heartbeat_at = ?2
                 WHERE id = 1",
                params![segment_id, now],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        self.segment_by_id(segment_id)?
            .ok_or_else(|| "created segment missing".to_string())
    }

    pub fn pause_active(&self, now: i64) -> Result<Option<TimeSegment>, String> {
        let Some(active) = self.active_segment()? else {
            return Ok(None);
        };
        let ended_at = now.max(active.started_at);
        let transaction = self
            .connection
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "UPDATE time_segments SET ended_at = ?1, updated_at = ?1 WHERE id = ?2 AND ended_at IS NULL",
                params![ended_at, active.id],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "UPDATE runtime_state
                 SET active_segment_id = NULL, last_heartbeat_at = NULL
                 WHERE id = 1",
                [],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        self.segment_by_id(active.id)
    }

    pub fn active_segment(&self) -> Result<Option<TimeSegment>, String> {
        self.connection
            .query_row(
                "SELECT id, project_id, started_at, ended_at, created_at, updated_at
                 FROM time_segments WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1",
                [],
                segment_from_row,
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    pub fn heartbeat(&self, now: i64) -> Result<(), String> {
        self.connection
            .execute(
                "UPDATE runtime_state SET last_heartbeat_at = ?1
                 WHERE id = 1 AND active_segment_id IS NOT NULL",
                params![now],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn recover_active(&self, now: i64) -> Result<Option<TimeSegment>, String> {
        let Some(active) = self.active_segment()? else {
            return Ok(None);
        };
        let heartbeat: Option<i64> = self
            .connection
            .query_row(
                "SELECT last_heartbeat_at FROM runtime_state WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .flatten();
        let ended_at = heartbeat.unwrap_or(now).max(active.started_at);
        let transaction = self
            .connection
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "UPDATE time_segments SET ended_at = ?1, updated_at = ?1 WHERE id = ?2 AND ended_at IS NULL",
                params![ended_at, active.id],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "UPDATE runtime_state
                 SET active_segment_id = NULL, last_heartbeat_at = NULL
                 WHERE id = 1",
                [],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        self.segment_by_id(active.id)
    }

    pub fn segments_between(&self, start: i64, end: i64) -> Result<Vec<TimeSegment>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT id, project_id, started_at, ended_at, created_at, updated_at
                 FROM time_segments
                 WHERE started_at < ?2 AND (ended_at IS NULL OR ended_at > ?1)
                 ORDER BY started_at, id",
            )
            .map_err(|error| error.to_string())?;
        let segments = statement
            .query_map(params![start, end], segment_from_row)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<TimeSegment>, _>>()
            .map_err(|error| error.to_string())?;
        Ok(segments)
    }

    pub fn segment_by_id(&self, id: i64) -> Result<Option<TimeSegment>, String> {
        self.connection
            .query_row(
                "SELECT id, project_id, started_at, ended_at, created_at, updated_at
                 FROM time_segments WHERE id = ?1",
                params![id],
                segment_from_row,
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    pub fn project_by_id(&self, id: i64) -> Result<Option<Project>, String> {
        self.connection
            .query_row(
                "SELECT id, name, color, sort_order, archived, created_at, updated_at
                 FROM projects WHERE id = ?1",
                params![id],
                project_from_row,
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    pub fn export_range(
        &self,
        start_utc: i64,
        end_exclusive_utc: i64,
    ) -> Result<ExportData, String> {
        let segments = self.segments_changed_between(start_utc, end_exclusive_utc)?;
        let segment_project_ids = segments
            .iter()
            .map(|segment| segment.project_id)
            .collect::<HashSet<_>>();
        let mut all_projects = self.list_projects(true)?;
        let projects = all_projects
            .drain(..)
            .filter(|project| {
                (project.created_at >= start_utc && project.created_at < end_exclusive_utc)
                    || (project.updated_at >= start_utc && project.updated_at < end_exclusive_utc)
                    || segment_project_ids.contains(&project.id)
            })
            .collect();

        Ok(ExportData {
            projects,
            time_segments: segments,
        })
    }

    fn segments_changed_between(
        &self,
        start_utc: i64,
        end_exclusive_utc: i64,
    ) -> Result<Vec<TimeSegment>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT id, project_id, started_at, ended_at, created_at, updated_at
                 FROM time_segments
                 WHERE (created_at >= ?1 AND created_at < ?2)
                    OR (updated_at >= ?1 AND updated_at < ?2)
                 ORDER BY created_at, id",
            )
            .map_err(|error| error.to_string())?;
        let segments = statement
            .query_map(params![start_utc, end_exclusive_utc], segment_from_row)
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<TimeSegment>, _>>()
            .map_err(|error| error.to_string())?;
        Ok(segments)
    }
}

fn ensure_updated_at_columns(connection: &Connection) -> Result<(), String> {
    for (table, backfill) in [
        (
            "projects",
            "UPDATE projects SET updated_at = created_at WHERE updated_at = 0",
        ),
        (
            "time_segments",
            "UPDATE time_segments
             SET updated_at = MAX(created_at, COALESCE(ended_at, created_at))
             WHERE updated_at = 0",
        ),
    ] {
        let mut statement = connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(|error| error.to_string())?;
        let has_updated_at = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
            .iter()
            .any(|column| column == "updated_at");
        if !has_updated_at {
            connection
                .execute(
                    &format!(
                        "ALTER TABLE {table} ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0"
                    ),
                    [],
                )
                .map_err(|error| error.to_string())?;
        }
        connection
            .execute(backfill, [])
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn project_from_row(row: &Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        color: row.get(2)?,
        sort_order: row.get(3)?,
        archived: row.get::<_, i64>(4)? != 0,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn segment_from_row(row: &Row<'_>) -> rusqlite::Result<TimeSegment> {
    Ok(TimeSegment {
        id: row.get(0)?,
        project_id: row.get(1)?,
        started_at: row.get(2)?,
        ended_at: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

#[cfg(test)]
mod tests {
    use super::{Database, NewProject, Project};
    use rusqlite::Connection;

    fn project(name: &str) -> NewProject {
        NewProject {
            name: name.to_string(),
            color: "#7c6cf2".to_string(),
        }
    }

    fn archived(project: &Project, updated_at: i64) -> Project {
        let mut copy = project.clone();
        copy.archived = true;
        copy.updated_at = updated_at;
        copy
    }

    #[test]
    fn initializes_project_based_tables() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(
            db.table_names().unwrap(),
            vec![
                "projects".to_string(),
                "runtime_state".to_string(),
                "settings".to_string(),
                "time_segments".to_string(),
            ]
        );
    }

    #[test]
    fn migrates_legacy_records_with_an_exportable_update_timestamp() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE projects (
                    id INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    color TEXT NOT NULL,
                    sort_order INTEGER NOT NULL,
                    archived INTEGER NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE time_segments (
                    id INTEGER PRIMARY KEY,
                    project_id INTEGER NOT NULL,
                    started_at INTEGER NOT NULL,
                    ended_at INTEGER,
                    created_at INTEGER NOT NULL
                );
                INSERT INTO projects VALUES (1, '旧项目', '#7c6cf2', 0, 0, 1_000);
                INSERT INTO time_segments VALUES (1, 1, 2_000, 3_000, 2_000);",
            )
            .unwrap();

        let db = Database::from_connection(connection).unwrap();
        let data = db.export_range(2_500, 3_500).unwrap();

        assert_eq!(data.time_segments.len(), 1);
        assert_eq!(data.time_segments[0].updated_at, 3_000);
        assert_eq!(data.projects.len(), 1);
    }

    #[test]
    fn creates_a_persistent_project_without_starting_it() {
        let db = Database::open_in_memory().unwrap();
        let created = db.create_project(project("写代码"), 100).unwrap();

        assert_eq!(created.name, "写代码");
        assert!(!created.archived);
        assert!(db.active_segment().unwrap().is_none());
        assert_eq!(db.list_projects(false).unwrap(), vec![created]);
    }

    #[test]
    fn switching_projects_closes_previous_segment_and_starts_next() {
        let db = Database::open_in_memory().unwrap();
        let first = db.create_project(project("写代码"), 100).unwrap();
        let second = db.create_project(project("上厕所"), 101).unwrap();

        let first_segment = db.start_project(first.id, 200).unwrap();
        let second_segment = db.start_project(second.id, 260).unwrap();

        assert_eq!(
            db.segment_by_id(first_segment.id)
                .unwrap()
                .unwrap()
                .ended_at,
            Some(260)
        );
        assert_eq!(second_segment.project_id, second.id);
        assert_eq!(db.active_segment().unwrap().unwrap().id, second_segment.id);
    }

    #[test]
    fn pausing_ends_the_active_segment_and_leaves_idle_time() {
        let db = Database::open_in_memory().unwrap();
        let created = db.create_project(project("阅读"), 100).unwrap();
        let segment = db.start_project(created.id, 200).unwrap();

        let paused = db.pause_active(320).unwrap().unwrap();
        assert_eq!(paused.id, segment.id);
        assert_eq!(paused.ended_at, Some(320));
        assert!(db.active_segment().unwrap().is_none());
    }

    #[test]
    fn archived_projects_are_hidden_but_their_history_remains() {
        let db = Database::open_in_memory().unwrap();
        let created = db.create_project(project("旧项目"), 100).unwrap();
        db.start_project(created.id, 200).unwrap();
        db.pause_active(240).unwrap();
        db.archive_project(created.id, 300).unwrap();

        assert!(db.list_projects(false).unwrap().is_empty());
        assert_eq!(
            db.list_projects(true).unwrap(),
            vec![archived(&created, 300)]
        );
        assert_eq!(db.segments_between(100, 300).unwrap().len(), 1);
    }

    #[test]
    fn recovery_pauses_an_orphan_at_the_last_heartbeat() {
        let db = Database::open_in_memory().unwrap();
        let created = db.create_project(project("未完成"), 100).unwrap();
        let segment = db.start_project(created.id, 120).unwrap();
        db.heartbeat(180).unwrap();

        let recovered = db.recover_active(300).unwrap().unwrap();
        assert_eq!(recovered.id, segment.id);
        assert_eq!(recovered.ended_at, Some(180));
        assert!(db.active_segment().unwrap().is_none());
    }

    #[test]
    fn persists_the_silent_start_preference() {
        let db = Database::open_in_memory().unwrap();

        assert!(!db.silent_start().unwrap());
        db.set_silent_start(true).unwrap();
        assert!(db.silent_start().unwrap());
        db.set_silent_start(false).unwrap();
        assert!(!db.silent_start().unwrap());
    }

    #[test]
    fn export_range_includes_segments_and_their_projects() {
        let db = Database::open_in_memory().unwrap();
        let coding = db.create_project(project("写代码"), 9_000).unwrap();
        let reading = db.create_project(project("阅读"), 9_500).unwrap();
        db.start_project(coding.id, 10_000).unwrap();
        db.pause_active(10_500).unwrap();
        db.start_project(reading.id, 11_500).unwrap();
        db.pause_active(11_900).unwrap();

        let data = db.export_range(10_200, 11_200).unwrap();

        assert_eq!(data.time_segments.len(), 1);
        assert_eq!(data.time_segments[0].project_id, coding.id);
        let included: Vec<&str> = data.projects.iter().map(|p| p.name.as_str()).collect();
        assert!(included.contains(&"写代码"));
        assert!(!included.contains(&"阅读"));
    }

    #[test]
    fn export_range_includes_projects_created_within_the_range() {
        let db = Database::open_in_memory().unwrap();
        let created_in = db.create_project(project("新项目"), 10_000).unwrap();
        db.create_project(project("旧项目"), 5_000).unwrap();

        let data = db.export_range(9_000, 11_000).unwrap();

        assert!(data.time_segments.is_empty());
        assert_eq!(
            data.projects,
            vec![{
                let mut project = created_in.clone();
                project.created_at = 10_000;
                project
            }]
        );
    }

    #[test]
    fn export_range_is_exclusive_of_the_end() {
        let db = Database::open_in_memory().unwrap();
        let coding = db.create_project(project("写代码"), 9_000).unwrap();
        db.start_project(coding.id, 10_000).unwrap();
        db.pause_active(10_500).unwrap();

        let contained = db.export_range(10_000, 11_000).unwrap();
        let outside = db.export_range(10_600, 11_000).unwrap();

        assert_eq!(contained.time_segments.len(), 1);
        assert!(outside.time_segments.is_empty());
    }

    #[test]
    fn export_range_includes_projects_updated_within_the_range() {
        let db = Database::open_in_memory().unwrap();
        let archived_project = db.create_project(project("归档项目"), 5_000).unwrap();
        db.archive_project(archived_project.id, 10_200).unwrap();

        let data = db.export_range(10_000, 11_000).unwrap();

        assert_eq!(data.projects, vec![archived(&archived_project, 10_200)]);
        assert!(data.time_segments.is_empty());
    }

    #[test]
    fn export_range_excludes_segments_that_only_overlap_the_selected_range() {
        let db = Database::open_in_memory().unwrap();
        let spanning = db.create_project(project("跨越时段"), 8_000).unwrap();
        db.start_project(spanning.id, 9_000).unwrap();
        db.pause_active(12_000).unwrap();

        let data = db.export_range(10_000, 11_000).unwrap();

        assert!(data.projects.is_empty());
        assert!(data.time_segments.is_empty());
    }
}
