# 时间段编辑与补录设计

日期：2026-09-11  
状态：已确认，待审阅

## 目标与范围

为历史记录窗口增加对时间段的纠错能力，解决三类真实使用问题：忘记点开始导致漏记、忘记点暂停导致多记、项目选错。

新增三项能力：

- **补录**：手动新增一段已经发生但未被记录的时段。
- **修改**：调整已有时段的所属项目、开始时间和结束时间。
- **删除**：移除误记的时段。

三者都在历史窗口中完成，复用该窗口既有的项目列表与当日记录数据。

范围外：时间轴色块的拖拽/拉伸编辑、批量编辑或框选操作、编辑或删除进行中的时段、时间段备注字段、撤销/历史版本，以及跨窗口的额外实时同步（历史窗口已有的 2 秒轮询足够）。

## 数据模型与不变量

沿用现有 `time_segments` 表，不新增字段、不新增迁移。补录产生的记录与计时段结构完全一致。

必须继续成立的不变量：

1. **同一时刻最多一个进行中的段**：由 `ended_at IS NULL` 查询出一条。补录与修改**强制要求 `ended_at` 非空**，因此编辑出来的段永远不会成为进行中的段。
2. **`runtime_state.active_segment_id` 与进行中的段一致**：本功能不触碰 `runtime_state`。进行中的段不可编辑、不可删除，所以活跃状态不受影响。
3. **回看时间与导出的一致性**：修改后的段必须立即反映在 [get_segments_for_date](src-tauri/src/lib.rs#L143) 与 [export_range](src-tauri/src/db.rs#L483) 的结果中；两者都直接读表，无需改动。

时间语义沿用现有约定：`started_at` / `ended_at` 为 Unix 秒，区间**左闭右开**（`ended_at` 不含在内）。因此相邻两段首尾相接（`前段.ended_at == 后段.started_at`）不算重叠。

## 后端口径与校验

### 时区换算

[domain.rs:80](src-tauri/src/domain.rs#L80) 的 `utc_datetime_to_utc` 把 `datetime-local` 值（`YYYY-MM-DDTHH:MM`）加时区偏移转成 UTC 秒，正是所需。将其可见性由私有改为 **`pub`**，供命令层复用。

**不复用** `utc_datetime_range_bounds`：后者给结束时刻追加 `+60s`（导出需要包含末分钟的全部秒），而时间段边界必须使用原样的时刻。

### 新增命令

在 [lib.rs](src-tauri/src/lib.rs) 增加三个命令，接受 `datetime-local` 字符串与整数时区偏移，与 [export_data_to_file](src-tauri/src/lib.rs#L160) 的入参风格一致：

| 命令 | 入参 | 行为 |
| --- | --- | --- |
| `create_segment` | `start`, `end`, `projectId`, `timezoneOffsetHours` | 校验后插入一段已结束的记录 |
| `update_segment` | `segmentId`, `start`, `end`, `projectId`, `timezoneOffsetHours` | 校验后更新项目与起止时间，并置 `updated_at = now` |
| `delete_segment` | `segmentId` | 硬删除该段 |

三条命令共用一套校验，对应 [db.rs](src-tauri/src/db.rs) 中新增的方法（`create_segment` / `update_segment` / `delete_segment`），由 `lib.rs` 负责字符串解析与错误码转换。`create_segment` 的插入实现与 `start_project` 的插入分支同构，区别仅在于 `ended_at` 直接写入而非 `NULL`，且不更新 `runtime_state`。

### 校验规则

下表每条规则都标注了适用的命令；按顺序执行，任一失败即返回错误码，不做任何写入。`delete_segment` 只执行 R5、R6——删除不涉及时间与项目，因此不跑时间类校验。

| # | 规则 | 错误码 | 适用命令 |
| --- | --- | --- | --- |
| R1 | `start` / `end` 能被解析为合法的 `datetime-local` 值 | `segment_datetime_invalid` | create, update |
| R2 | `end > start` | `segment_range_invalid` | create, update |
| R3 | `end <= now`（`now` 取后端 `now_seconds()`）；禁止补录尚未发生的时段，同时拦截把年份填错这类手滑 | `segment_in_future` | create, update |
| R4 | 目标项目存在。**归档项目允许作为目标**——历史视图本就展示归档项目的记录，补录同样的项目应当被允许 | `project_not_found` | create, update |
| R5 | 目标段存在 | `segment_not_found` | update, delete |
| R6 | 目标段不是进行中的段（即 `ended_at IS NOT NULL`）；进行中的段必须先暂停再编辑 | `segment_active` | update, delete |
| R7 | 不与其他任何段重叠 | `segment_overlap` | create, update |

R7 的重叠查询沿用 [segments_between](src-tauri/src/db.rs#L441) 的半开区间语义并排除自身：

```sql
SELECT 1 FROM time_segments
WHERE id != :self
  AND started_at < :new_end
  AND (ended_at IS NULL OR ended_at > :new_start)
LIMIT 1
```

把进行中的段（`ended_at IS NULL`）视作一直延伸到未来，因此补录若撞上当前正在计时的时段同样会被拒绝。跨天段按绝对时间比较，不做按天裁剪。

### 错误码与前端映射

后端对上述校验失败返回**稳定的英文错误码**（上表所列），不透传 SQL 或内部堆栈。前端在 `segmentEditModel.ts` 的 `segmentEditErrorMessage` 中把错误码映射为中文提示，未知错误回落为原始字符串（沿用 [friendlyError](src/App.tsx#L43) 的现有行为）。

| 错误码 | 界面提示 |
| --- | --- |
| `segment_datetime_invalid` | 时间格式不正确 |
| `segment_range_invalid` | 开始时间必须早于结束时间 |
| `segment_in_future` | 不能补录尚未发生的时间 |
| `project_not_found` | 所选项目不存在 |
| `segment_not_found` | 这段记录已不存在，请刷新后重试 |
| `segment_active` | 请先暂停计时，再编辑这段记录 |
| `segment_overlap` | 该时段与已有记录重叠 |

`segment_datetime_invalid` 与 `segment_range_invalid` 分开是必要的：前端的即时校验正则是 `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$`，它比后端解析更宽松（例如 `2026-13-01T09:00` 能通过正则，却因月份越界而解析失败）。若两者共用一个错误码，这类型输入会被显示成「开始时间必须早于结束时间」，与实际原因不符。

## 界面与数据流

### 新增前端模块

新增 `src/segmentEditModel.ts`（配 `src/segmentEditModel.test.ts`），把领域逻辑从 UI 中拆出：

- `toDateTimeLocal(epochSeconds: number): string` —— epoch 秒 → 本地 `YYYY-MM-DDTHH:MM`，用于编辑时回填表单。语义与 [App.tsx:76](src/App.tsx#L76) 的 `localDateTimeKey` 相同，因需要在编辑表单复用而独立成模块。
- `isSegmentDraftValid(start: string, end: string): boolean` —— 复用 [isExportRangeValid](src/historyModel.ts#L6) 的字符串比较风格，用于提交按钮的即时启用/禁用与「起 < 止」提示。不承担正确性，只做即时反馈。
- `defaultSegmentDraft(dateKey: string, now: number): { start: string; end: string }` —— 补录时的默认值。常态取所选日期的 `09:00`–`10:00`；当所选日期是今天且 `now` 尚未到 `10:00` 时，改为以 `now` 所在分钟为上界、向前取 1 小时的可填区间，避免默认值直接触发 `segment_in_future`。
- `segmentEditErrorMessage(error: unknown): string` —— 错误码到中文的映射。

### 历史窗口改动

在 [HistoryWindow](src/App.tsx#L366) 中：

1. **入口**：[App.tsx:469-481](src/App.tsx#L469-L481) 的「记录明细」标题行增加「补录」按钮；每个 `entry-row` 增加「编辑」与「删除」。进行中的行（`segmentEndLabel(segment) === "计时中"`）两个按钮置灰并附 `title` 说明需先暂停。
2. **表单 Dialog**：新增一个 [Dialog](src/App.tsx#L349-L361)，新增与编辑共用。内容为项目下拉（`<select>`，选项来自 `list_projects` 已取的**含归档**列表）+ 两个 `datetime-local` 输入，提交按钮受 `isSegmentDraftValid` 控制。「补录」以 `defaultSegmentDraft(date)` 预填并默认选中第一个项目；「编辑」以该段的 `projectId` 与 `toDateTimeLocal(startedAt)` / `toDateTimeLocal(endedAt)` 预填。
3. **删除确认**：复用同款 Dialog 做确认，不使用 `window.confirm`。
4. **提交**：调用对应命令，成功则关闭 Dialog 并调用现有 `loadHistory()` 立即刷新（2 秒轮询为兜底）；失败则保持 Dialog 打开，把 `segmentEditErrorMessage` 的结果显示在 Dialog 内，不清空用户输入。

### 编辑回填使用原始时间

回填使用表中**原始**的 `startedAt` / `endedAt`。`clipSegmentToDay` 只在渲染时按当天裁剪，不改动数据。因此一个 `23:00–01:00` 的跨天段，在当日明细行里显示为 `00:00–01:00`，而点击「编辑」时应显示真实的本地时间 `23:00–01:00`——这是正确行为，并且该表单允许保存回原始值。

## 异常处理与安全边界

- 校验全部在后端完成，前端只做即时表单提示；后端是唯一权威，前端不做「抢先写库」类优化。
- 所有输入经 `rusqlite` 参数化查询写入，不拼接 SQL。
- 错误码不包含 SQL 语句、文件路径或堆栈。
- 命令不改变 `runtime_state`，因此不引入活跃计时状态被破坏的路径。
- 命令入参校验在写入前完成，失败时数据库保持原状（无部分写入）。

## 测试与验收

后端 Rust 单元测试（[db.rs](src-tauri/src/db.rs) 的 `#[cfg(test)]`）：

- 补录一段已结束时段的记录被持久化，且该段**不会**成为进行中的段（`active_segment()` 仍为 `None`）。
- 修改段的项目与起止时间生效，`updated_at` 更新，`created_at` 不变。
- 删除段后 `segments_between` 与 `export_range` 均不再返回它。
- 与已有段重叠的新增/修改被拒绝；首尾相接（`前段.ended_at == 后段.started_at`）被允许。
- 补录撞上进行中的段被拒绝。
- 结束时间晚于 `now` 被拒绝。
- 目标项目不存在被拒绝；归档项目被允许。
- 编辑/删除进行中的段被拒绝。
- 编辑某段时不会因为自身而误判重叠。

前端 Vitest 单元测试（`segmentEditModel.test.ts`）：

- `toDateTimeLocal` 的填充与零填充，含跨天时间点。
- `isSegmentDraftValid` 对合法、反转、格式错误输入的结果。
- `defaultSegmentDraft` 生成所选日期的 `09:00`–`10:00`；今天的早于 `10:00` 时，生成不越过当前时刻的 1 小时区间。
- `segmentEditErrorMessage` 对全部错误码的中文映射，以及未知错误回落为原始字符串。

手动 Windows 验收：

1. 补录一段落在空白时段的记录，确认历史时间轴与「工作总计」立即更新。
2. 补录一段与已有记录重叠的时段，确认被拒绝且提示为中文。
3. 编辑一段的起止时间与项目，确认明细与时间轴同步更新。
4. 对进行中的段点击「编辑」/「删除」，确认按钮不可用或提示先暂停。
5. 删除一段后确认其从明细与时间轴消失，且导出结果不再包含它。
6. 关闭并重启应用，确认以上改动持久化。
