# 时间段编辑与补录实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户能在历史记录窗口补录漏记的时段、修改已有段的项目与起止时间、删除误记的段，并保证结果与既有的互斥计时模型一致。

**Architecture:** 所有校验集中在 Rust 侧的三条新命令（`create_segment` / `update_segment` / `delete_segment`），前端只传 `datetime-local` 字符串 + 时区偏移并展示中文错误码。复用 [db.rs](src-tauri/src/db.rs) 中 `segments_between` 已有的半开区间重叠语义；补录段一律带 `ended_at`，因此永不进入活跃段查询，`runtime_state` 完全不需要改动。前端把表单领域逻辑拆进 `src/segmentEditModel.ts` 并配单测，UI 留在 `App.tsx`。

**Tech Stack:** Tauri 2、Rust（rusqlite）、React 19 + TypeScript、Vitest + Testing Library、Radix UI Dialog。

**设计文档:** [docs/superpowers/specs/2026-09-11-segment-edit-backfill-design.md](docs/superpowers/specs/2026-09-11-segment-edit-backfill-design.md)

---

## 文件结构

| 文件 | 职责 | 动作 |
| --- | --- | --- |
| `src-tauri/src/domain.rs` | 本地 `datetime-local` → UTC 秒的换算 | 修改：`utc_datetime_to_utc` 改为 `pub` |
| `src-tauri/src/db.rs` | 段的重叠校验与增改删 | 修改：新增 1 个私有辅助 + 3 个公开方法 |
| `src-tauri/src/lib.rs` | Tauri 命令与入参解析 | 修改：新增 3 条命令 + 1 个解析辅助 |
| `src/segmentEditModel.ts` | 表单领域逻辑（时间格式化、合法性、默认值、错误码映射） | 新建 |
| `src/segmentEditModel.test.ts` | 上述模块的单测 | 新建 |
| `src/App.tsx` | 历史窗口的编辑/补录/删除交互 | 修改：`HistoryWindow` |
| `src/HistoryWindow.test.tsx` | 历史窗口编辑流程的组件测试 | 新建 |
| `src/App.css` | 对话框字段与行内按钮样式 | 修改 |
| `README.md` | 功能列表与「尚未支持补录」的说明 | 修改 |

后端错误码（前后端契约，全部为稳定字符串）：`segment_datetime_invalid`、`segment_range_invalid`、`segment_in_future`、`project_not_found`、`segment_not_found`、`segment_active`、`segment_overlap`。其中 `segment_datetime_invalid` 专用于**解析失败**，`segment_range_invalid` 专用于 db 层的**区间反转**。

---

## Task 1: 暴露 domain 的 datetime 换算

`create_segment` 需要把 `datetime-local` 值原样转成 UTC 秒。`utc_datetime_range_bounds` 会给结束时刻 `+60s`（导出语义），不能复用，必须直接用 `utc_datetime_to_utc`，而它目前是私有函数。

**Files:**
- Modify: `src-tauri/src/domain.rs:80`（函数可见性）、`src-tauri/src/domain.rs:97`（测试导入）、`src-tauri/src/domain.rs:135` 附近（新增测试）

- [ ] **Step 1: 先写会失败的测试**

修改 `domain.rs` 测试模块的导入行（当前为 `use super::{format_duration, utc_datetime_range_bounds, utc_day_bounds, utc_range_bounds};`），加入 `utc_datetime_to_utc`：

```rust
    use super::{
        format_duration, utc_datetime_range_bounds, utc_datetime_to_utc, utc_day_bounds,
        utc_range_bounds,
    };
```

在测试模块内新增用例：

```rust
    #[test]
    fn converts_a_local_datetime_to_utc_seconds_exactly() {
        assert_eq!(
            utc_datetime_to_utc("2026-09-02T09:30", 8),
            Some(1_788_312_600)
        );
        assert_eq!(utc_datetime_to_utc("not-a-datetime", 8), None);
    }
```

- [ ] **Step 2: 运行测试确认新用例的基线**

Run: `cargo test --manifest-path src-tauri/Cargo.toml domain`
Expected: PASS（`mod tests` 是 `domain` 的子模块，本就能访问父模块的私有项，因此这一步**不会**因 `pub` 而编译失败）。该用例是转换逻辑的回归测试；`pub` 改动的真正验证在 Task 4——`lib.rs` 跨模块调用 `domain::utc_datetime_to_utc` 时，若可见性未放开会直接编译失败。

- [ ] **Step 3: 改可见性**

把 `domain.rs:80` 的

```rust
fn utc_datetime_to_utc(value: &str, timezone_offset_hours: i32) -> Option<i64> {
```

改为

```rust
pub fn utc_datetime_to_utc(value: &str, timezone_offset_hours: i32) -> Option<i64> {
```

函数体不变。

- [ ] **Step 4: 运行测试，确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml domain`
Expected: PASS，所有 domain 测试通过

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/domain.rs
git commit -m "refactor: expose datetime-to-utc helper in domain"
```

---

## Task 2: 补录段（db 层）

**Files:**
- Modify: `src-tauri/src/db.rs`：新增 `segment_overlaps` 与 `create_segment`（插入到 `pub fn active_segment(&self) -> Result<Option<TimeSegment>, String> {` 之前，即约 `db.rs:381`）
- Test: `src-tauri/src/db.rs` 的 `mod tests` 内（追加到模块闭合 `}` 之前）

- [ ] **Step 1: 先写会失败的测试**

在 `db.rs` 的 `mod tests` 末尾追加：

```rust
    #[test]
    fn creates_a_completed_segment_without_activating_it() {
        let db = Database::open_in_memory().unwrap();
        let project = db.create_project(project("补录"), 1_000).unwrap();

        let created = db.create_segment(project.id, 2_000, 3_600, 10_000).unwrap();

        assert_eq!(created.started_at, 2_000);
        assert_eq!(created.ended_at, Some(3_600));
        assert_eq!(created.project_id, project.id);
        assert!(db.active_segment().unwrap().is_none());
        assert_eq!(db.segments_between(0, 20_000).unwrap().len(), 1);
    }

    #[test]
    fn rejects_a_segment_whose_end_is_not_after_its_start() {
        let db = Database::open_in_memory().unwrap();
        let project = db.create_project(project("写代码"), 1_000).unwrap();

        let err = db.create_segment(project.id, 3_000, 3_000, 10_000).unwrap_err();

        assert_eq!(err, "segment_range_invalid");
    }

    #[test]
    fn rejects_a_backfill_ending_in_the_future() {
        let db = Database::open_in_memory().unwrap();
        let project = db.create_project(project("写代码"), 1_000).unwrap();

        let err = db.create_segment(project.id, 2_000, 3_000, 2_500).unwrap_err();

        assert_eq!(err, "segment_in_future");
    }

    #[test]
    fn rejects_a_backfill_for_an_unknown_project() {
        let db = Database::open_in_memory().unwrap();

        let err = db.create_segment(99, 2_000, 3_000, 10_000).unwrap_err();

        assert_eq!(err, "project_not_found");
    }

    #[test]
    fn allows_backfilling_an_archived_project() {
        let db = Database::open_in_memory().unwrap();
        let archived_project = db.create_project(project("旧项目"), 1_000).unwrap();
        db.archive_project(archived_project.id, 1_100).unwrap();

        let created = db.create_segment(archived_project.id, 2_000, 3_000, 10_000).unwrap();

        assert_eq!(created.project_id, archived_project.id);
    }

    #[test]
    fn rejects_a_backfill_that_overlaps_an_existing_segment() {
        let db = Database::open_in_memory().unwrap();
        let project = db.create_project(project("写代码"), 1_000).unwrap();
        db.create_segment(project.id, 2_000, 3_000, 10_000).unwrap();

        let err = db.create_segment(project.id, 2_500, 3_500, 10_000).unwrap_err();

        assert_eq!(err, "segment_overlap");
    }

    #[test]
    fn allows_adjacent_segments_that_only_touch() {
        let db = Database::open_in_memory().unwrap();
        let project = db.create_project(project("写代码"), 1_000).unwrap();
        db.create_segment(project.id, 2_000, 3_000, 10_000).unwrap();

        let second = db.create_segment(project.id, 3_000, 4_000, 10_000).unwrap();

        assert_eq!(second.started_at, 3_000);
    }

    #[test]
    fn rejects_a_backfill_over_the_running_segment() {
        let db = Database::open_in_memory().unwrap();
        let project = db.create_project(project("进行中"), 1_000).unwrap();
        db.start_project(project.id, 2_000).unwrap();

        let err = db.create_segment(project.id, 2_100, 2_200, 2_300).unwrap_err();

        assert_eq!(err, "segment_overlap");
    }
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml db::`
Expected: 编译失败，报 `no method named create_segment`

- [ ] **Step 3: 实现重叠查询与补录**

在 `db.rs` 的 `pub fn active_segment(&self)` 之前插入：

```rust
    fn segment_overlaps(
        &self,
        started_at: i64,
        ended_at: i64,
        exclude_id: Option<i64>,
    ) -> Result<bool, String> {
        self.connection
            .query_row(
                "SELECT 1 FROM time_segments
                 WHERE id != ?3
                   AND started_at < ?2
                   AND (ended_at IS NULL OR ended_at > ?1)
                 LIMIT 1",
                params![started_at, ended_at, exclude_id.unwrap_or(-1)],
                |_| Ok(()),
            )
            .optional()
            .map(|row| row.is_some())
            .map_err(|error| error.to_string())
    }

    pub fn create_segment(
        &self,
        project_id: i64,
        started_at: i64,
        ended_at: i64,
        now: i64,
    ) -> Result<TimeSegment, String> {
        if ended_at <= started_at {
            return Err("segment_range_invalid".to_string());
        }
        if ended_at > now {
            return Err("segment_in_future".to_string());
        }
        if self.project_by_id(project_id)?.is_none() {
            return Err("project_not_found".to_string());
        }
        if self.segment_overlaps(started_at, ended_at, None)? {
            return Err("segment_overlap".to_string());
        }
        self.connection
            .execute(
                "INSERT INTO time_segments (project_id, started_at, ended_at, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)",
                params![project_id, started_at, ended_at, now],
            )
            .map_err(|error| error.to_string())?;
        let id = self.connection.last_insert_rowid();
        self.segment_by_id(id)?
            .ok_or_else(|| "created segment missing".to_string())
    }
```

`params!` 与 `OptionalExtension` 已在文件头部导入（`db.rs:1`），无需新增 `use`。

- [ ] **Step 4: 运行测试，确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml db::`
Expected: PASS，新增 8 个用例连同既有用例全部通过

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/db.rs
git commit -m "feat: persist backfilled time segments"
```

---

## Task 3: 修改与删除段（db 层）

**Files:**
- Modify: `src-tauri/src/db.rs`：新增 `update_segment` 与 `delete_segment`（紧接 Task 2 的 `create_segment` 之后）
- Test: `src-tauri/src/db.rs` 的 `mod tests` 内

- [ ] **Step 1: 先写会失败的测试**

在 `db.rs` 的 `mod tests` 末尾追加：

```rust
    #[test]
    fn updates_a_segment_project_and_bounds() {
        let db = Database::open_in_memory().unwrap();
        let first = db.create_project(project("写代码"), 1_000).unwrap();
        let second = db.create_project(project("阅读"), 1_100).unwrap();
        let created = db.create_segment(first.id, 2_000, 3_000, 10_000).unwrap();

        let updated = db.update_segment(created.id, second.id, 2_500, 4_000, 11_000).unwrap();

        assert_eq!(updated.id, created.id);
        assert_eq!(updated.project_id, second.id);
        assert_eq!(updated.started_at, 2_500);
        assert_eq!(updated.ended_at, Some(4_000));
        assert_eq!(updated.created_at, created.created_at);
        assert_eq!(updated.updated_at, 11_000);
    }

    #[test]
    fn editing_a_segment_does_not_treat_itself_as_an_overlap() {
        let db = Database::open_in_memory().unwrap();
        let project = db.create_project(project("写代码"), 1_000).unwrap();
        let created = db.create_segment(project.id, 2_000, 3_000, 10_000).unwrap();

        let updated = db.update_segment(created.id, project.id, 2_100, 3_100, 11_000).unwrap();

        assert_eq!(updated.started_at, 2_100);
    }

    #[test]
    fn rejects_an_update_that_would_overlap_another_segment() {
        let db = Database::open_in_memory().unwrap();
        let project = db.create_project(project("写代码"), 1_000).unwrap();
        db.create_segment(project.id, 2_000, 3_000, 10_000).unwrap();
        let later = db.create_segment(project.id, 5_000, 6_000, 10_000).unwrap();

        let err = db.update_segment(later.id, project.id, 2_500, 3_500, 11_000).unwrap_err();

        assert_eq!(err, "segment_overlap");
    }

    #[test]
    fn rejects_updating_a_missing_segment() {
        let db = Database::open_in_memory().unwrap();
        let project = db.create_project(project("写代码"), 1_000).unwrap();

        let err = db.update_segment(99, project.id, 2_000, 3_000, 10_000).unwrap_err();

        assert_eq!(err, "segment_not_found");
    }

    #[test]
    fn rejects_editing_or_deleting_the_running_segment() {
        let db = Database::open_in_memory().unwrap();
        let project = db.create_project(project("写代码"), 1_000).unwrap();
        let running = db.start_project(project.id, 2_000).unwrap();

        assert_eq!(
            db.update_segment(running.id, project.id, 2_000, 2_500, 3_000)
                .unwrap_err(),
            "segment_active"
        );
        assert_eq!(db.delete_segment(running.id).unwrap_err(), "segment_active");
    }

    #[test]
    fn deletes_a_segment_from_history_and_exports() {
        let db = Database::open_in_memory().unwrap();
        let project = db.create_project(project("写代码"), 1_000).unwrap();
        let created = db.create_segment(project.id, 2_000, 3_000, 10_000).unwrap();

        db.delete_segment(created.id).unwrap();

        assert!(db.segments_between(0, 20_000).unwrap().is_empty());
        assert!(db.export_range(0, 20_000)
            .unwrap()
            .time_segments
            .is_empty());
    }

    #[test]
    fn rejects_deleting_a_missing_segment() {
        let db = Database::open_in_memory().unwrap();

        assert_eq!(db.delete_segment(99).unwrap_err(), "segment_not_found");
    }
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml db::`
Expected: 编译失败，报 `no method named update_segment`

- [ ] **Step 3: 实现**

紧接 `create_segment` 之后插入：

```rust
    pub fn update_segment(
        &self,
        id: i64,
        project_id: i64,
        started_at: i64,
        ended_at: i64,
        now: i64,
    ) -> Result<TimeSegment, String> {
        if ended_at <= started_at {
            return Err("segment_range_invalid".to_string());
        }
        if ended_at > now {
            return Err("segment_in_future".to_string());
        }
        if self.project_by_id(project_id)?.is_none() {
            return Err("project_not_found".to_string());
        }
        let Some(existing) = self.segment_by_id(id)? else {
            return Err("segment_not_found".to_string());
        };
        if existing.ended_at.is_none() {
            return Err("segment_active".to_string());
        }
        if self.segment_overlaps(started_at, ended_at, Some(id))? {
            return Err("segment_overlap".to_string());
        }
        self.connection
            .execute(
                "UPDATE time_segments
                 SET project_id = ?1, started_at = ?2, ended_at = ?3, updated_at = ?4
                 WHERE id = ?5",
                params![project_id, started_at, ended_at, now, id],
            )
            .map_err(|error| error.to_string())?;
        self.segment_by_id(id)?
            .ok_or_else(|| "updated segment missing".to_string())
    }

    pub fn delete_segment(&self, id: i64) -> Result<(), String> {
        let Some(existing) = self.segment_by_id(id)? else {
            return Err("segment_not_found".to_string());
        };
        if existing.ended_at.is_none() {
            return Err("segment_active".to_string());
        }
        self.connection
            .execute("DELETE FROM time_segments WHERE id = ?1", params![id])
            .map_err(|error| error.to_string())?;
        Ok(())
    }
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml db::`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/db.rs
git commit -m "feat: update and delete time segments"
```

---

## Task 4: Tauri 命令

**Files:**
- Modify: `src-tauri/src/lib.rs`：新增 `parse_segment_bounds` 与三条命令（插入到 `fn export_filename(` 之前，即约 `lib.rs:153`）；在 `lib.rs:408` 的 `get_segments_for_date,` 之后注册
- Test: `src-tauri/src/lib.rs` 的 `mod tests`

- [ ] **Step 1: 先写会失败的测试**

把 `lib.rs` 测试模块的导入行（当前为 `use super::{export_filename, title_bar_attributes, valid_startup_executable, StartupSettings};`）改为：

```rust
    use super::{
        export_filename, parse_segment_bounds, title_bar_attributes, valid_startup_executable,
        StartupSettings,
    };
```

在 `lib.rs` 的 `mod tests` 末尾追加：

```rust
    #[test]
    fn parses_segment_bounds_and_rejects_bad_datetimes() {
        assert_eq!(
            parse_segment_bounds("2026-09-02T09:30", "2026-09-02T10:15", 8),
            Ok((1_788_312_600, 1_788_315_300))
        );
        assert_eq!(
            parse_segment_bounds("2026-09-02T00:00", "2026-09-02T23:59", 8),
            Ok((1_788_278_400, 1_788_364_740))
        );
        assert_eq!(
            parse_segment_bounds("nope", "2026-09-02T10:15", 8).unwrap_err(),
            "segment_datetime_invalid"
        );
        assert_eq!(
            parse_segment_bounds("2026-09-02T09:30", "nope", 8).unwrap_err(),
            "segment_datetime_invalid"
        );
        assert_eq!(
            parse_segment_bounds("2026-13-01T09:00", "2026-09-02T10:15", 8).unwrap_err(),
            "segment_datetime_invalid"
        );
        assert!(parse_segment_bounds("2026-09-02T10:15", "2026-09-02T09:30", 8).is_ok());
    }
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml lib::`
Expected: 编译失败，报 `cannot find function parse_segment_bounds`

- [ ] **Step 3: 实现解析辅助与命令**

在 `lib.rs` 的 `fn export_filename(` 之前插入：

```rust
fn parse_segment_bounds(
    start: &str,
    end: &str,
    timezone_offset_hours: i32,
) -> Result<(i64, i64), String> {
    let started_at = domain::utc_datetime_to_utc(start, timezone_offset_hours)
        .ok_or_else(|| "segment_datetime_invalid".to_string())?;
    let ended_at = domain::utc_datetime_to_utc(end, timezone_offset_hours)
        .ok_or_else(|| "segment_datetime_invalid".to_string())?;
    Ok((started_at, ended_at))
}

#[tauri::command]
fn create_segment(
    project_id: i64,
    start: String,
    end: String,
    timezone_offset_hours: i32,
    state: State<'_, AppState>,
) -> Result<TimeSegment, String> {
    let (started_at, ended_at) = parse_segment_bounds(&start, &end, timezone_offset_hours)?;
    database(&state)?.create_segment(project_id, started_at, ended_at, now_seconds())
}

#[tauri::command]
fn update_segment(
    segment_id: i64,
    project_id: i64,
    start: String,
    end: String,
    timezone_offset_hours: i32,
    state: State<'_, AppState>,
) -> Result<TimeSegment, String> {
    let (started_at, ended_at) = parse_segment_bounds(&start, &end, timezone_offset_hours)?;
    database(&state)?.update_segment(segment_id, project_id, started_at, ended_at, now_seconds())
}

#[tauri::command]
fn delete_segment(segment_id: i64, state: State<'_, AppState>) -> Result<(), String> {
    database(&state)?.delete_segment(segment_id)
}
```

- [ ] **Step 4: 注册命令**

在 `lib.rs:408` 的 `get_segments_for_date,` 之后插入三行：

```rust
            create_segment,
            update_segment,
            delete_segment,
```

- [ ] **Step 5: 运行测试与编译检查**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS，含新用例

Run: `cargo fmt --check --manifest-path src-tauri/Cargo.toml`
Expected: 无输出（通过）；若有格式差异，运行 `cargo fmt --manifest-path src-tauri/Cargo.toml` 后重跑

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat: add segment edit tauri commands"
```

---

## Task 5: 前端表单领域逻辑

**Files:**
- Create: `src/segmentEditModel.ts`
- Test: `src/segmentEditModel.test.ts`

- [ ] **Step 1: 先写会失败的测试**

创建 `src/segmentEditModel.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  defaultSegmentDraft,
  isSegmentDraftValid,
  segmentEditErrorMessage,
  toDateTimeLocal,
} from "./segmentEditModel";

describe("toDateTimeLocal", () => {
  it("formats epoch seconds as a zero-padded local datetime", () => {
    const date = new Date(2026, 8, 2, 9, 5, 0);
    expect(toDateTimeLocal(date.getTime() / 1000)).toBe("2026-09-02T09:05");
  });

  it("keeps the local date when the time crosses midnight", () => {
    const date = new Date(2026, 8, 11, 23, 0, 0);
    expect(toDateTimeLocal(date.getTime() / 1000)).toBe("2026-09-11T23:00");
  });
});

describe("isSegmentDraftValid", () => {
  it("accepts a start strictly before the end", () => {
    expect(isSegmentDraftValid("2026-09-02T09:00", "2026-09-02T10:00")).toBe(true);
  });

  it("rejects equal or reversed bounds", () => {
    expect(isSegmentDraftValid("2026-09-02T10:00", "2026-09-02T10:00")).toBe(false);
    expect(isSegmentDraftValid("2026-09-02T11:00", "2026-09-02T10:00")).toBe(false);
  });

  it("rejects malformed values", () => {
    expect(isSegmentDraftValid("", "2026-09-02T10:00")).toBe(false);
    expect(isSegmentDraftValid("2026-09-02T09:00", "2026-09-02")).toBe(false);
  });
});

describe("defaultSegmentDraft", () => {
  it("uses the morning hour for a past date", () => {
    const now = new Date(2026, 8, 11, 15, 0, 0).getTime() / 1000;
    expect(defaultSegmentDraft("2026-09-02", now)).toEqual({
      start: "2026-09-02T09:00",
      end: "2026-09-02T10:00",
    });
  });

  it("clamps to a one hour window ending now when today is early", () => {
    const now = new Date(2026, 8, 11, 8, 30, 0).getTime() / 1000;
    expect(defaultSegmentDraft("2026-09-11", now)).toEqual({
      start: "2026-09-11T07:30",
      end: "2026-09-11T08:30",
    });
  });

  it("keeps the morning hour later in the day", () => {
    const now = new Date(2026, 8, 11, 15, 0, 0).getTime() / 1000;
    expect(defaultSegmentDraft("2026-09-11", now)).toEqual({
      start: "2026-09-11T09:00",
      end: "2026-09-11T10:00",
    });
  });
});

describe("segmentEditErrorMessage", () => {
  it("maps known error codes to Chinese", () => {
    expect(segmentEditErrorMessage("segment_datetime_invalid")).toBe("时间格式不正确");
    expect(segmentEditErrorMessage("segment_range_invalid")).toBe("开始时间必须早于结束时间");
    expect(segmentEditErrorMessage("segment_in_future")).toBe("不能补录尚未发生的时间");
    expect(segmentEditErrorMessage("project_not_found")).toBe("所选项目不存在");
    expect(segmentEditErrorMessage("segment_not_found")).toBe("这段记录已不存在，请刷新后重试");
    expect(segmentEditErrorMessage("segment_active")).toBe("请先暂停计时，再编辑这段记录");
    expect(segmentEditErrorMessage("segment_overlap")).toBe("该时段与已有记录重叠");
  });

  it("falls back to the raw string then a generic message", () => {
    expect(segmentEditErrorMessage("boom")).toBe("boom");
    expect(segmentEditErrorMessage(new Error("x"))).toBe("操作失败，请稍后重试");
  });
});
```

评审追加的 7 个边界用例（分别放进上面对应的 `describe` 块内）：

```ts
// describe("toDateTimeLocal")
it("formats the unix epoch as a valid local datetime", () => {
  expect(toDateTimeLocal(0)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
});

// describe("isSegmentDraftValid")
it("accepts values that carry seconds", () => {
  expect(isSegmentDraftValid("2026-09-02T09:00:00", "2026-09-02T10:00:30")).toBe(true);
});

// describe("defaultSegmentDraft")
it("clamps the default window to the selected day when today is very early", () => {
  const now = new Date(2026, 8, 11, 0, 30, 0).getTime() / 1000;
  expect(defaultSegmentDraft("2026-09-11", now)).toEqual({
    start: "2026-09-11T00:00",
    end: "2026-09-11T00:30",
  });
});

it("keeps the morning hour exactly at 10:00", () => {
  const now = new Date(2026, 8, 11, 10, 0, 0).getTime() / 1000;
  expect(defaultSegmentDraft("2026-09-11", now)).toEqual({
    start: "2026-09-11T09:00",
    end: "2026-09-11T10:00",
  });
});

it("truncates seconds from now when clamping", () => {
  const now = new Date(2026, 8, 11, 8, 30, 45).getTime() / 1000;
  expect(defaultSegmentDraft("2026-09-11", now)).toEqual({
    start: "2026-09-11T07:30",
    end: "2026-09-11T08:30",
  });
});

it("returns the morning hour for a future date, leaving gating to the caller", () => {
  const now = new Date(2026, 8, 11, 15, 0, 0).getTime() / 1000;
  expect(defaultSegmentDraft("2026-09-12", now)).toEqual({
    start: "2026-09-12T09:00",
    end: "2026-09-12T10:00",
  });
});

// describe("segmentEditErrorMessage")
it("does not fall through to Object.prototype members", () => {
  expect(segmentEditErrorMessage("toString")).toBe("toString");
  expect(segmentEditErrorMessage("constructor")).toBe("constructor");
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run src/segmentEditModel.test.ts`
Expected: FAIL，报找不到模块 `./segmentEditModel`

- [ ] **Step 3: 实现**

创建 `src/segmentEditModel.ts`：

```ts
const DEFAULT_DURATION_MINUTES = 60;
const DATETIME_LOCAL_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function toDateTimeLocal(epochSeconds: number): string {
  const date = new Date(epochSeconds * MILLISECONDS_PER_SECOND);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function isSegmentDraftValid(start: string, end: string): boolean {
  if (!DATETIME_LOCAL_PATTERN.test(start) || !DATETIME_LOCAL_PATTERN.test(end)) {
    return false;
  }
  // datetime-local 可能携带秒（HH:MM:SS）；比较只取到分钟，保持固定宽度字典序。
  return start.slice(0, 16) < end.slice(0, 16);
}

export function defaultSegmentDraft(
  dateKey: string,
  nowSeconds: number,
): { start: string; end: string } {
  const preferred = { start: `${dateKey}T09:00`, end: `${dateKey}T10:00` };
  const nowLocal = toDateTimeLocal(nowSeconds);
  const todayKey = nowLocal.slice(0, 10);
  if (dateKey !== todayKey || preferred.end <= nowLocal) {
    return preferred;
  }
  const endMillis =
    Math.floor(nowSeconds / SECONDS_PER_MINUTE) *
    SECONDS_PER_MINUTE *
    MILLISECONDS_PER_SECOND;
  // 已知限制：夏令时切换当天按秒数回推，可能与挂钟直觉不符。
  const dayStartMillis = new Date(`${dateKey}T00:00`).getTime();
  const startMillis = Math.max(
    endMillis -
      DEFAULT_DURATION_MINUTES * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND,
    dayStartMillis,
  );
  return {
    start: toDateTimeLocal(startMillis / MILLISECONDS_PER_SECOND),
    end: toDateTimeLocal(endMillis / MILLISECONDS_PER_SECOND),
  };
}

const ERROR_MESSAGES = new Map<string, string>([
  ["segment_datetime_invalid", "时间格式不正确"],
  ["segment_range_invalid", "开始时间必须早于结束时间"],
  ["segment_in_future", "不能补录尚未发生的时间"],
  ["project_not_found", "所选项目不存在"],
  ["segment_not_found", "这段记录已不存在，请刷新后重试"],
  ["segment_active", "请先暂停计时，再编辑这段记录"],
  ["segment_overlap", "该时段与已有记录重叠"],
]);

export function segmentEditErrorMessage(error: unknown): string {
  if (typeof error !== "string") return "操作失败，请稍后重试";
  return ERROR_MESSAGES.get(error) ?? error;
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run src/segmentEditModel.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/segmentEditModel.ts src/segmentEditModel.test.ts
git commit -m "feat: add segment edit form model"
```

---

## Task 6: 历史窗口交互

**Files:**
- Modify: `src/App.tsx`（`HistoryWindow`，行号约 366-496；导入区行 8-21）
- Modify: `src/App.css`（约 100-108 与 165 附近）
- Create: `src/HistoryWindow.test.tsx`

- [ ] **Step 1: 先写会失败的测试**

创建 `src/HistoryWindow.test.tsx`：

```tsx
import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { HistoryWindow } from "./App";

vi.mock("@tauri-apps/api/core", () => {
  // 时间段必须落在「今天」内，否则历史窗口按当天裁剪后不会渲染明细行。
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const dayStartSeconds = midnight.getTime() / 1000;
  return {
    invoke: vi.fn((command: string) => {
      if (command === "list_projects") {
        return Promise.resolve([
          { id: 1, name: "写代码", color: "#a69bd6", sortOrder: 0, archived: false, createdAt: 0 },
        ]);
      }
      if (command === "get_segments_for_date") {
        return Promise.resolve([
          {
            id: 1,
            projectId: 1,
            startedAt: dayStartSeconds + 3600,
            endedAt: dayStartSeconds + 7200,
            createdAt: dayStartSeconds,
          },
        ]);
      }
      return Promise.resolve(undefined);
    }),
  };
});

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("0.1.2"),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "history",
    onFocusChanged: vi.fn().mockResolvedValue(vi.fn()),
  }),
}));

describe("HistoryWindow segment editing", () => {
  it("creates a segment from the backfill dialog", async () => {
    render(
      <StrictMode>
        <HistoryWindow />
      </StrictMode>,
    );

    await screen.findByRole("button", { name: "编辑" });
    await userEvent.click(screen.getByRole("button", { name: "补录" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "create_segment",
        expect.objectContaining({ projectId: 1 }),
      );
    });
  });

  it("deletes a segment after confirmation", async () => {
    render(
      <StrictMode>
        <HistoryWindow />
      </StrictMode>,
    );

    await screen.findByRole("button", { name: "删除" });
    await userEvent.click(screen.getByRole("button", { name: "删除" }));
    await userEvent.click(await screen.findByRole("button", { name: "确认删除" }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("delete_segment", { segmentId: 1 });
    });
  });

  it("disables the backfill entry for a future date", async () => {
    render(
      <StrictMode>
        <HistoryWindow />
      </StrictMode>,
    );

    await screen.findByRole("button", { name: "编辑" });
    expect(screen.getByRole("button", { name: "补录" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "›" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "补录" })).toBeDisabled();
    });
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run src/HistoryWindow.test.tsx`
Expected: FAIL，报 `HistoryWindow` 未从 `./App` 导出

- [ ] **Step 3: 导出 HistoryWindow 并补导入**

把 `src/App.tsx` 的 `function HistoryWindow() {` 改为 `export function HistoryWindow() {`。

在 `src/App.tsx` 顶部导入区（`import { isExportRangeValid, segmentEndLabel } from "./historyModel";` 之后）加入：

```tsx
import {
  defaultSegmentDraft,
  isSegmentDraftValid,
  segmentEditErrorMessage,
  toDateTimeLocal,
} from "./segmentEditModel";
```

- [ ] **Step 4: 增加状态与处理函数**

在 `HistoryWindow` 内、`const [exportError, setExportError] = useState<string | null>(null);` 之后加入状态：

```tsx
  const [draft, setDraft] = useState<SegmentDraft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TimeSegment | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
```

在 `HistoryWindow` 函数之前（其他类型定义附近）加入类型：

```tsx
type SegmentDraft = {
  mode: "create" | "edit";
  segmentId: number | null;
  projectId: number;
  start: string;
  end: string;
};
```

在 `HistoryWindow` 内、`const closeHistory = async () => {` 之前加入处理函数：

```tsx
  const openCreateDraft = () => {
    setDraftError(null);
    setDraft({
      mode: "create",
      segmentId: null,
      projectId: projects[0]?.id ?? 0,
      ...defaultSegmentDraft(date, nowSeconds()),
    });
  };

  const openEditDraft = (segment: TimeSegment) => {
    setDraftError(null);
    setDraft({
      mode: "edit",
      segmentId: segment.id,
      projectId: segment.projectId,
      start: toDateTimeLocal(segment.startedAt),
      end: toDateTimeLocal(segment.endedAt ?? nowSeconds()),
    });
  };

  const submitDraft = async () => {
    if (!draft) return;
    try {
      if (draft.mode === "create") {
        await invoke("create_segment", {
          projectId: draft.projectId,
          start: draft.start,
          end: draft.end,
          timezoneOffsetHours: timezoneOffsetHours(),
        });
      } else {
        await invoke("update_segment", {
          segmentId: draft.segmentId,
          projectId: draft.projectId,
          start: draft.start,
          end: draft.end,
          timezoneOffsetHours: timezoneOffsetHours(),
        });
      }
      setDraft(null);
      await loadHistory();
    } catch (reason) {
      setDraftError(segmentEditErrorMessage(reason));
    }
  };

  const openDeleteConfirm = (segment: TimeSegment) => {
    setDeleteError(null);
    setDeleteTarget(segment);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await invoke("delete_segment", { segmentId: deleteTarget.id });
      setDeleteTarget(null);
      await loadHistory();
    } catch (reason) {
      setDeleteError(segmentEditErrorMessage(reason));
    }
  };
```

- [ ] **Step 5: 把「补录」入口放进日期工具栏，并给明细行加编辑/删除**

**为什么「补录」不放在明细区**：明细区整体包在 `{rows.length > 0 && ...}` 条件里（`App.tsx:469`），而补录最常见的场景正是某天**完全没有记录**的空白——此时明细区不渲染，入口就不存在，等于无法补录空白天。所以入口必须放在始终可见的日期工具栏上。

把日期工具栏里「今天」按钮那一行

```tsx
        <button className="today-button" onClick={() => setDate(localDateKey(new Date()))}>今天</button>
```

替换为

```tsx
        <button className="today-button" onClick={() => setDate(localDateKey(new Date()))}>今天</button>
        <button
          className="entry-action"
          type="button"
          disabled={projects.length === 0 || date > localDateKey(new Date())}
          title={date > localDateKey(new Date()) ? "不能补录未来日期" : undefined}
          onClick={openCreateDraft}
        >
          补录
        </button>
```

「未来日期禁用」是必要的：日期工具栏可以用 `›` 无界向后翻，未来日期上的补录默认值必然被后端以 `segment_in_future` 拒绝，应在入口就拦下，而不是先给一个注定失败的默认值再报错。

明细区的标题行**保持不变**，仍是：

```tsx
        <div className="entry-heading"><h2>记录明细</h2><span>时段 / 时长</span></div>
```

把行渲染中 `</time>` 之后的结尾替换为：

```tsx
            <time>{formatDuration(clipped.endedAt - clipped.startedAt)}</time>
            <button className="entry-action" type="button" disabled={running} title={running ? "请先暂停计时" : undefined} onClick={() => openEditDraft(segment)}>编辑</button>
            <button className="entry-action danger" type="button" disabled={running} title={running ? "请先暂停计时" : undefined} onClick={() => openDeleteConfirm(segment)}>删除</button>
          </div>;
```

（即：保留原有的 `</time>`，在其后插入两个按钮，再收束 `</div>`。）

- [ ] **Step 6: 加入两个对话框**

在 `</main>` 之前插入：

```tsx
      <Dialog.Root open={draft !== null} onOpenChange={(open) => { if (!open) { setDraft(null); setDraftError(null); } }}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="segment-dialog">
            <Dialog.Title>{draft?.mode === "edit" ? "编辑记录" : "补录记录"}</Dialog.Title>
            {draft && <>
              <label className="dialog-field">
                <span>项目</span>
                <select aria-label="项目" value={draft.projectId} onChange={(event) => setDraft({ ...draft, projectId: Number(event.target.value) })}>
                  {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
              </label>
              <label className="dialog-field">
                <span>开始时间</span>
                <input aria-label="开始时间" type="datetime-local" value={draft.start} onChange={(event) => setDraft({ ...draft, start: event.target.value })} />
              </label>
              <label className="dialog-field">
                <span>结束时间</span>
                <input aria-label="结束时间" type="datetime-local" value={draft.end} onChange={(event) => setDraft({ ...draft, end: event.target.value })} />
              </label>
              {draftError && <p className="error-message" role="alert">{draftError}</p>}
              <div className="dialog-actions">
                <Dialog.Close asChild><button className="dialog-button" type="button">取消</button></Dialog.Close>
                <button className="dialog-button primary" type="button" disabled={!isSegmentDraftValid(draft.start, draft.end)} onClick={() => void submitDraft()}>保存</button>
              </div>
            </>}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={deleteTarget !== null} onOpenChange={(open) => { if (!open) { setDeleteTarget(null); setDeleteError(null); } }}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="segment-dialog">
            <Dialog.Title>删除记录</Dialog.Title>
            <Dialog.Description>确定删除这段记录吗？删除后无法恢复。</Dialog.Description>
            {deleteError && <p className="error-message" role="alert">{deleteError}</p>}
            <div className="dialog-actions">
              <Dialog.Close asChild><button className="dialog-button" type="button">取消</button></Dialog.Close>
              <button className="dialog-button danger" type="button" onClick={() => void confirmDelete()}>确认删除</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
```

- [ ] **Step 7: 运行测试，确认通过**

Run: `npx vitest run src/HistoryWindow.test.tsx`
Expected: PASS

- [ ] **Step 8: 加样式**

在 `src/App.css` 中，把对话框的三条既有规则改为同时覆盖新对话框（`App.css:101`、`102`、`103`）：

```css
.archive-dialog, .segment-dialog { position: fixed; z-index: 51; top: 50%; left: 50%; width: min(360px, calc(100vw - 32px)); transform: translate(-50%, -50%); border: 1px solid var(--border-strong); border-radius: 10px; background: var(--surface); box-shadow: var(--shadow); padding: 18px; }
.archive-dialog h2, .segment-dialog h2 { margin: 0; color: var(--text); font-size: 15px; font-weight: 650; }
.archive-dialog p, .segment-dialog p { margin: 9px 0 0; color: var(--muted); font-size: 12px; line-height: 1.55; }
```

在 `App.css:108` 之后追加新规则：

```css
.dialog-button.primary { border-color: var(--accent); background: var(--accent); color: var(--accent-ink); font-weight: 600; }
.dialog-button.primary:hover:not(:disabled) { background: var(--accent-hover); }
.dialog-button:disabled { cursor: default; opacity: .45; }
.dialog-field { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
.dialog-field span { color: var(--muted); font-size: 11px; }
.dialog-field select, .dialog-field input { border: 1px solid var(--border-strong); border-radius: 10px; background: var(--surface); color: var(--text); padding: 7px 8px; font-size: 12px; color-scheme: inherit; }
.dialog-field select:focus, .dialog-field input:focus { border-color: var(--accent); outline: none; }
.entry-action { border: 1px solid var(--border-strong); border-radius: 8px; background: transparent; color: var(--muted); padding: 4px 9px; font-size: 11px; white-space: nowrap; }
.entry-action:hover:not(:disabled) { background: var(--surface-raised); color: var(--text); }
.entry-action:disabled { cursor: default; opacity: .4; }
.entry-action.danger { border-color: #bc706a; color: #bc706a; }
.entry-action.danger:hover:not(:disabled) { background: #a95e59; color: #fff; }
```

- [ ] **Step 9: 跑全部前端测试与类型检查**

Run: `npm test`
Expected: PASS（含新增的 `segmentEditModel.test.ts` 与 `HistoryWindow.test.tsx`）

Run: `npm run build`
Expected: 类型检查与前端构建通过，无 TS 错误

- [ ] **Step 10: 提交**

```bash
git add src/App.tsx src/App.css src/HistoryWindow.test.tsx
git commit -m "feat: edit and backfill segments in history window"
```

**评审后的加固（已随该任务落地）**：上面 Step 1–10 是最小可用版本，代码质量审查后追加了几项，实际提交里应同时包含：

- `saving` / `deleting` 两个在途状态，防止双击重复提交（与本文件导出区既有的 `exporting` 约定一致）。
- 两个 `datetime-local` 输入加 `max={toDateTimeLocal(now)}`，在原生控件层面提前约束未来时间。
- 删除确认框显示具体是哪一段：`确定删除{deleteLabel}这段记录吗？`，其中 `deleteLabel` 由项目名与起止时刻拼出（对照归档确认框显示项目名的既有做法）。
- 测试从 3 个扩到 6 个，补齐**编辑主路径**（`update_segment` 是否收到正确的 `segmentId`）、**失败时对话框保持打开并显示中文错误**、以及**进行中段的编辑/删除按钮被禁用**。测试夹具需用 `vi.hoisted` + 可变 `harness`（而非 `mockRejectedValueOnce`），避免 2 秒轮询消耗掉一次性 mock。

因此该任务的最终预期是：单文件 6 passed、前端全量 66 passed。

---

## Task 7: 文档更新

`README.md` 当前明确写着尚未提供补录与历史时间段编辑（[README.md:326](README.md#L326)），功能落地后必须改，否则对外说明与实际不符。

**Files:**
- Modify: `README.md`（功能介绍表约 30-41 行、常见问题约 324-326 行、设计资料约 292-298 行）

- [ ] **Step 1: 功能介绍表增加一行**

在 `README.md` 功能介绍表格的「归档与恢复」行之后插入：

```markdown
| 编辑与补录 | 在历史记录中补录漏记的时段，修改已有时段的项目与起止时间，或删除误记的时段 |
```

- [ ] **Step 2: 改写常见问题**

把

```markdown
### 支持补录、修改时间段或自动识别工作内容吗？

当前界面围绕手动开始、切换和暂停展开，尚未提供历史时间段编辑、补录、自动活动识别、云同步或团队协作功能。
```

替换为

```markdown
### 支持补录、修改时间段或自动识别工作内容吗？

可以在历史记录窗口中补录漏记的时段、修改已有时段的项目与起止时间，或删除误记的时段。补录与修改后的时段不能与已有记录重叠，进行中的计时段需先暂停再编辑。

表单中的时间精确到分钟，因此编辑后起止时间会对齐到整分钟；对秒级的原始记录，这意味着最多 59 秒的偏移。尚未提供自动活动识别、云同步或团队协作功能。
```

- [ ] **Step 3: 设计资料增加链接**

在 `README.md` 设计资料列表中，`[可配置自启动设计]` 一行之后插入：

```markdown
- [时间段编辑与补录设计](docs/superpowers/specs/2026-09-11-segment-edit-backfill-design.md)
```

- [ ] **Step 4: 提交**

```bash
git add README.md
git commit -m "docs: document segment edit and backfill"
```

---

## 手工验收（全部任务完成后）

前置：`npm run tauri -- dev` 启动完整桌面应用。

1. 在计时器建一个项目并开始计时；切到历史窗口找一段空白时间，点「补录」，填一个不重叠的时段，保存后确认时间轴与「工作总计」立即更新。
2. 再补录一段与已有记录重叠的时段，确认保存被拒绝且对话框内显示中文「该时段与已有记录重叠」，输入不被清空。
3. 补录一段结束时间在未来的时段，确认提示「不能补录尚未发生的时间」。
4. 点某段「编辑」，改动项目与起止时间后保存，确认明细与时间轴同步更新。
5. 对进行中的段确认「编辑」「删除」按钮均置灰并带「请先暂停计时」提示。
6. 点「删除」并在确认框中确认，确认该段从明细、时间轴与导出结果中消失。
7. 从托盘退出并重新启动应用，确认以上改动均已持久化。
8. 点击当天较早时间段时确认「补录」默认值不会落在未来（当天 10:00 前应得到以当前时刻为上界的 1 小时区间）。
