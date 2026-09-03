# 可配置开机自启动与静默启动 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Windows 当前用户提供可独立配置的开机自启动和仅驻留托盘的静默启动，并通过独立设置窗口管理它们。

**Architecture:** 新建 `autostart.rs`，将 Windows 注册表 `Run` 项访问、启动命令构造及静默参数识别限制在后端单一模块。SQLite `settings` 表保存静默启动偏好；注册表是否存在启动项是自启动状态的权威来源。`lib.rs` 协调这些能力、Tauri command 和窗口生命周期；React 根据窗口标签渲染设置页面，使用纯状态模块验证开关交互。

**Tech Stack:** Tauri v2、Rust、`winreg`、Rusqlite、React 19、TypeScript、Vitest。

---

## 文件结构

- 新建：`src-tauri/src/autostart.rs` — Windows `Run` 注册表 I/O、启动命令和 `--silent-start` 参数的纯逻辑。
- 修改：`src-tauri/Cargo.toml` — 在 Windows 上引入 `winreg`。
- 修改：`src-tauri/src/db.rs` — 读取和写入 `silent_start` 偏好。
- 修改：`src-tauri/src/lib.rs` — 设置 command、设置窗口显示/隐藏、静默启动时隐藏主窗口。
- 修改：`src-tauri/tauri.conf.json` — 将计时器窗口改为初始隐藏，声明初始隐藏的 `settings` 窗口；后端在非静默启动时显式显示计时器，避免静默启动闪现窗口。
- 新建：`src/settingsModel.ts` — 设置快照与乐观更新前后的纯前端状态转换。
- 新建：`src/settingsModel.test.ts` — 设置状态转换的单元测试。
- 修改：`src/viewMode.ts`、`src/viewMode.test.ts` — 增加 `settings` 视图路由。
- 修改：`src/App.tsx` — 添加设置窗口界面、主窗口设置入口与 Tauri 调用。
- 修改：`src/App.css` — 设置界面及开关样式。

> 现有工作区包含与本功能无关、尚未提交的图标和甘特图改动。执行每个提交时只暂存本计划所列文件，绝不混入这些改动。

### Task 1: 注册表启动项模块与 Rust 依赖

**Files:**
- Create: `src-tauri/src/autostart.rs`
- Modify: `src-tauri/Cargo.toml:14-20`
- Modify: `src-tauri/src/lib.rs:1-2`

- [ ] **Step 1: 在 `src-tauri/src/autostart.rs` 写入失败测试与最小模块骨架**

```rust
#[cfg(test)]
mod tests {
    use super::{has_silent_start_argument, startup_command};
    use std::path::Path;

    #[test]
    fn recognizes_the_silent_start_argument() {
        assert!(has_silent_start_argument(["time-record.exe", "--silent-start"]));
        assert!(!has_silent_start_argument(["time-record.exe"]));
        assert!(!has_silent_start_argument(["time-record.exe", "--other"]));
    }

    #[test]
    fn quotes_the_executable_and_adds_silent_start_when_enabled() {
        assert_eq!(
            startup_command(Path::new(r"C:\\Program Files\\时间记录\\time-record.exe"), true),
            r#""C:\Program Files\时间记录\time-record.exe" --silent-start"#,
        );
        assert_eq!(
            startup_command(Path::new(r"C:\\Apps\\time-record.exe"), false),
            r#""C:\Apps\time-record.exe""#,
        );
    }
}
```

暂时只声明这两个函数，以便测试因缺少导出函数而无法编译。

- [ ] **Step 2: 运行新测试，确认其失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml autostart::tests`

Expected: FAIL，指出 `has_silent_start_argument` 和 `startup_command` 未定义。

- [ ] **Step 3: 实现纯启动参数与命令构造逻辑**

在 `src-tauri/src/autostart.rs` 的测试模块之前添加：

```rust
use std::path::Path;

pub const RUN_KEY_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE_NAME: &str = "时间记录";
const SILENT_START_ARGUMENT: &str = "--silent-start";

pub fn has_silent_start_argument(arguments: impl IntoIterator<Item = String>) -> bool {
    arguments
        .into_iter()
        .any(|argument| argument == SILENT_START_ARGUMENT)
}

pub fn startup_command(executable: &Path, silent_start: bool) -> String {
    let executable = executable.display();
    if silent_start {
        format!(r#""{executable}" {SILENT_START_ARGUMENT}"#)
    } else {
        format!(r#""{executable}""#)
    }
}
```

将测试中的字符串数组改为 `String` 值，使其匹配函数签名：

```rust
assert!(has_silent_start_argument(["time-record.exe".to_string(), "--silent-start".to_string()]));
```

- [ ] **Step 4: 运行测试，确认纯逻辑通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml autostart::tests`

Expected: PASS，2 个测试通过。

- [ ] **Step 5: 添加 Windows 注册表依赖与实际 I/O API**

在 `src-tauri/Cargo.toml` 末尾添加：

```toml
[target.'cfg(windows)'.dependencies]
winreg = "0.55"
```

在 `src-tauri/src/autostart.rs` 添加 Windows-only 函数：

```rust
#[cfg(windows)]
pub fn is_enabled() -> Result<bool, String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let current_user = RegKey::predef(HKEY_CURRENT_USER);
    let key = current_user
        .open_subkey(RUN_KEY_PATH)
        .map_err(|error| error.to_string())?;
    Ok(key.get_value::<String, _>(VALUE_NAME).is_ok())
}

上述代码暂时只包含 `is_enabled`；下一步会添加分别负责写入和删除的函数，以避免关闭开关时依赖当前可执行文件路径。

不要为非 Windows 平台添加伪实现：该应用和该功能均只面向 Windows。为使禁用操作不依赖可执行文件路径，将写入和删除拆开：

```rust
#[cfg(windows)]
pub fn set_enabled(executable: &Path, silent_start: bool) -> Result<(), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_WRITE};
    use winreg::RegKey;

    let current_user = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = current_user
        .create_subkey_with_flags(RUN_KEY_PATH, KEY_WRITE)
        .map_err(|error| error.to_string())?;
    key.set_value(VALUE_NAME, &startup_command(executable, silent_start))
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
pub fn set_enabled_without_executable(enabled: bool) -> Result<(), String> {
    if enabled {
        return Err("缺少创建开机自启动所需的应用程序路径。".to_string());
    }
    use winreg::enums::{HKEY_CURRENT_USER, KEY_WRITE};
    use winreg::RegKey;

    let current_user = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = current_user
        .create_subkey_with_flags(RUN_KEY_PATH, KEY_WRITE)
        .map_err(|error| error.to_string())?;
    match key.delete_value(VALUE_NAME) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}
```

随后将 `lib.rs` 顶部改为：

```rust
mod autostart;
mod db;
mod domain;
```

- [ ] **Step 6: 格式化并运行 Rust 测试**

Run: `cargo fmt --check --manifest-path src-tauri/Cargo.toml && cargo test --manifest-path src-tauri/Cargo.toml`

Expected: PASS，格式检查和全部 Rust 测试通过。

- [ ] **Step 7: 提交注册表模块**

```bash
git add src-tauri/Cargo.toml src-tauri/src/autostart.rs src-tauri/src/lib.rs
git commit -m "feat: add Windows autostart registry helper"
```

### Task 2: 持久化静默启动偏好

**Files:**
- Modify: `src-tauri/src/db.rs:73-380`
- Test: `src-tauri/src/db.rs:403-490`

- [ ] **Step 1: 编写数据库偏好失败测试**

在 `db.rs` 的 `tests` 模块末尾添加：

```rust
#[test]
fn persists_the_silent_start_preference() {
    let db = Database::open_in_memory().unwrap();

    assert!(!db.silent_start().unwrap());
    db.set_silent_start(true).unwrap();
    assert!(db.silent_start().unwrap());
    db.set_silent_start(false).unwrap();
    assert!(!db.silent_start().unwrap());
}
```

- [ ] **Step 2: 运行目标测试，确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml db::tests::persists_the_silent_start_preference`

Expected: FAIL，指出 `Database::silent_start` 和 `Database::set_silent_start` 不存在。

- [ ] **Step 3: 为 `Database` 实现偏好读取和 upsert**

在 `impl Database` 中、`table_names` 后插入：

```rust
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
```

- [ ] **Step 4: 运行目标和完整 Rust 测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml db::tests::persists_the_silent_start_preference && cargo test --manifest-path src-tauri/Cargo.toml`

Expected: PASS，新增测试与现有测试均通过。

- [ ] **Step 5: 提交偏好持久化**

```bash
git add src-tauri/src/db.rs
git commit -m "feat: persist silent startup preference"
```

### Task 3: 后端设置 Commands、窗口控制和静默启动

**Files:**
- Modify: `src-tauri/src/lib.rs:1-222`
- Modify: `src-tauri/tauri.conf.json:11-33`
- Test: `src-tauri/src/lib.rs`（新增纯 helper 的 `#[cfg(test)]` 模块）

- [ ] **Step 1: 添加启动可执行文件校验与设置快照的失败测试**

在 `lib.rs` 末尾添加：

```rust
#[cfg(test)]
mod tests {
    use super::valid_startup_executable;
    use std::path::PathBuf;

    #[test]
    fn rejects_autostart_creation_in_a_debug_build() {
        assert!(valid_startup_executable(
            PathBuf::from(r"C:\\work\\target\\debug\\time-record.exe"),
            true,
        )
        .is_err());
    }

    #[test]
    fn accepts_a_packaged_executable_outside_debug() {
        assert_eq!(
            valid_startup_executable(
                PathBuf::from(r"C:\\Program Files\\时间记录\\time-record.exe"),
                false,
            )
            .unwrap(),
            PathBuf::from(r"C:\\Program Files\\时间记录\\time-record.exe"),
        );
    }
}
```

- [ ] **Step 2: 运行新测试，确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml tests::rejects_autostart_creation_in_a_debug_build`

Expected: FAIL，指出 `valid_startup_executable` 未定义。

- [ ] **Step 3: 添加后端数据类型和纯路径校验**

更新 imports：

```rust
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
```

在 `AppState` 后添加：

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StartupSettings {
    autostart_enabled: bool,
    silent_start: bool,
}

fn valid_startup_executable(executable: PathBuf, is_debug_build: bool) -> Result<PathBuf, String> {
    if is_debug_build {
        return Err("开发模式不能启用开机自启动，请使用安装后的应用。".to_string());
    }
    if executable.as_os_str().is_empty() {
        return Err("无法确定应用程序路径，不能启用开机自启动。".to_string());
    }
    Ok(executable)
}

fn startup_executable(executable: PathBuf) -> Result<PathBuf, String> {
    valid_startup_executable(executable, cfg!(debug_assertions))
}
```

- [ ] **Step 4: 添加 settings 窗口声明**

在 `src-tauri/tauri.conf.json` 的 `app.windows` 数组中、`history` 窗口对象之后新增：

```json
{
  "label": "settings",
  "title": "设置",
  "width": 420,
  "height": 300,
  "minWidth": 360,
  "minHeight": 260,
  "resizable": false,
  "visible": false
}
```

确保此前 `history` 对象的结尾从 `}` 改为 `},`，且 JSON 保持有效。

- [ ] **Step 5: 添加读取/更新 settings 和控制设置窗口的 commands**

在 `set_always_on_top` 之前添加：

```rust
#[tauri::command]
fn get_startup_settings(state: State<'_, AppState>) -> Result<StartupSettings, String> {
    Ok(StartupSettings {
        autostart_enabled: autostart::is_enabled()?,
        silent_start: database(&state)?.silent_start()?,
    })
}

#[tauri::command]
fn set_autostart_enabled(
    app: AppHandle,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<StartupSettings, String> {
    let silent_start = database(&state)?.silent_start()?;
    if enabled {
        let executable = startup_executable(app.path().executable().map_err(|error| error.to_string())?)?;
        autostart::set_enabled(&executable, silent_start)?;
    } else {
        autostart::set_enabled_without_executable(false)?;
    }
    Ok(StartupSettings {
        autostart_enabled: enabled,
        silent_start,
    })
}

#[tauri::command]
fn set_silent_start(
    app: AppHandle,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<StartupSettings, String> {
    let mut database = database(&state)?;
    let autostart_enabled = autostart::is_enabled()?;
    if autostart_enabled {
        let executable = startup_executable(app.path().executable().map_err(|error| error.to_string())?)?;
        autostart::set_enabled(&executable, enabled)?;
    }
    database.set_silent_start(enabled)?;
    Ok(StartupSettings {
        autostart_enabled,
        silent_start: enabled,
    })
}

#[tauri::command]
fn open_settings_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("settings")
        .ok_or_else(|| "settings window is not configured".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
fn hide_settings_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("settings")
        .ok_or_else(|| "settings window is not configured".to_string())?;
    window.hide().map_err(|error| error.to_string())
}
```

删除 `let mut database` 的 `mut`，因为 `Database::set_silent_start` 接收 `&self`。

为避免注册表已更新但 SQLite 写入失败导致不一致，先保存 SQLite，随后在自启动开启时重写注册表；注册表失败时用原偏好回滚 SQLite。将 `set_silent_start` 函数替换为：

```rust
#[tauri::command]
fn set_silent_start(
    app: AppHandle,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<StartupSettings, String> {
    let database = database(&state)?;
    let previous = database.silent_start()?;
    let autostart_enabled = autostart::is_enabled()?;
    database.set_silent_start(enabled)?;
    if autostart_enabled {
        let executable = startup_executable(app.path().executable().map_err(|error| error.to_string())?)?;
        if let Err(error) = autostart::set_enabled(&executable, enabled) {
            database.set_silent_start(previous)?;
            return Err(error);
        }
    }
    Ok(StartupSettings {
        autostart_enabled,
        silent_start: enabled,
    })
}
```

在 `on_window_event` 中将匹配改为：

```rust
if matches!(window.label(), "timer" | "history" | "settings") {
```

在 `tauri::generate_handler![]` 中注册：

```rust
get_startup_settings,
set_autostart_enabled,
set_silent_start,
open_settings_window,
hide_settings_window,
```

- [ ] **Step 6: 让初始化无闪现地选择显示或隐藏计时器窗口**

将 `src-tauri/tauri.conf.json` 中 `timer` 窗口的：

```json
"visible": true
```

改为：

```json
"visible": false
```

在 `.setup(|app| {` 的开头定义：

```rust
let silent_start = autostart::has_silent_start_argument(std::env::args());
```

在 `setup_tray(app)?;` 之后添加：

```rust
if !silent_start {
    show_timer(app.handle());
}
```

因为 Tauri 配置让计时器窗口初始隐藏，应用会在 WebView 首次绘制前决定是否显示它；带 `--silent-start` 的启动保持隐藏，其他启动路径调用已有的 `show_timer`，显示且聚焦主窗口。

- [ ] **Step 7: 格式化、运行 Rust 测试和检查配置 JSON**

Run: `cargo fmt --check --manifest-path src-tauri/Cargo.toml && cargo test --manifest-path src-tauri/Cargo.toml && node -e "JSON.parse(require('fs').readFileSync('src-tauri/tauri.conf.json', 'utf8')); console.log('valid JSON')"`

Expected: PASS，所有 Rust 测试通过，并输出 `valid JSON`。

- [ ] **Step 8: 提交后端窗口和 settings commands**

```bash
git add src-tauri/src/lib.rs src-tauri/tauri.conf.json
git commit -m "feat: add startup settings commands"
```

### Task 4: 前端设置状态与视图路由

**Files:**
- Create: `src/settingsModel.ts`
- Create: `src/settingsModel.test.ts`
- Modify: `src/viewMode.ts:1-6`
- Modify: `src/viewMode.test.ts:1-16`

- [ ] **Step 1: 编写设置状态和视图路由的失败测试**

创建 `src/settingsModel.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { initialStartupSettings, startupSettingsReducer } from "./settingsModel";

describe("startupSettingsReducer", () => {
  it("uses the backend snapshot after loading", () => {
    expect(startupSettingsReducer(initialStartupSettings, {
      type: "loaded",
      settings: { autostartEnabled: true, silentStart: false },
    })).toEqual({ autostartEnabled: true, silentStart: false, error: null });
  });

  it("keeps the previous settings when an update fails", () => {
    const loaded = { autostartEnabled: true, silentStart: true, error: null };
    expect(startupSettingsReducer(loaded, { type: "failed", message: "注册表访问失败" }))
      .toEqual({ ...loaded, error: "注册表访问失败" });
  });
});
```

在 `src/viewMode.test.ts` 添加：

```ts
it("uses the settings window label for the settings page", () => {
  expect(resolveViewMode("settings", "")).toBe("settings");
});
```

- [ ] **Step 2: 运行前端测试，确认失败**

Run: `npm test -- settingsModel.test.ts viewMode.test.ts`

Expected: FAIL，因 `settingsModel` 不存在且 `"settings"` 不是 `ViewMode`。

- [ ] **Step 3: 实现纯设置状态模块**

创建 `src/settingsModel.ts`：

```ts
export type StartupSettings = {
  autostartEnabled: boolean;
  silentStart: boolean;
};

type StartupSettingsState = StartupSettings & {
  error: string | null;
};

type StartupSettingsAction =
  | { type: "loaded"; settings: StartupSettings }
  | { type: "failed"; message: string };

export const initialStartupSettings: StartupSettingsState = {
  autostartEnabled: false,
  silentStart: false,
  error: null,
};

export function startupSettingsReducer(
  state: StartupSettingsState,
  action: StartupSettingsAction,
): StartupSettingsState {
  if (action.type === "loaded") {
    return { ...action.settings, error: null };
  }
  return { ...state, error: action.message };
}
```

- [ ] **Step 4: 将设置窗口加入 `ViewMode`**

把 `src/viewMode.ts` 完整替换为：

```ts
export type ViewMode = "timer" | "history" | "settings";

export function resolveViewMode(windowLabel: string, search: string): ViewMode {
  if (windowLabel === "history") return "history";
  if (windowLabel === "settings") return "settings";
  if (windowLabel === "timer") return "timer";
  return new URLSearchParams(search).get("view") === "history" ? "history" : "timer";
}
```

浏览器调试时不需要 `?view=settings` 后备路由，因为该窗口只从 Tauri 打开；保持目前历史页后备行为不变。

- [ ] **Step 5: 运行前端单元测试**

Run: `npm test -- settingsModel.test.ts viewMode.test.ts`

Expected: PASS，全部 6 个测试通过。

- [ ] **Step 6: 提交前端状态与路由**

```bash
git add src/settingsModel.ts src/settingsModel.test.ts src/viewMode.ts src/viewMode.test.ts
git commit -m "feat: add startup settings view state"
```

### Task 5: 设置窗口 React 界面与主窗口入口

**Files:**
- Modify: `src/App.tsx:1-320`
- Modify: `src/App.css:1-99`

- [ ] **Step 1: 将设置状态和 Tauri API 引入 `App.tsx`**

在现有 imports 后添加：

```ts
import {
  initialStartupSettings,
  startupSettingsReducer,
  type StartupSettings,
} from "./settingsModel";
```

- [ ] **Step 2: 为主窗口添加打开设置的异步处理器与按钮**

在 `TimerWindow` 内、`showHistory` 后添加：

```ts
const showSettings = async () => {
  try {
    await invoke("open_settings_window");
  } catch (reason) {
    setError(friendlyError(reason));
  }
};
```

在主窗口 `.header-actions` 内、`历史` 按钮后添加：

```tsx
<button className="icon-button" onClick={showSettings}>设置</button>
```

- [ ] **Step 3: 添加 `SettingsWindow` 组件**

在 `HistoryWindow` 前添加：

```tsx
function SettingsWindow() {
  const [settings, dispatch] = useReducer(startupSettingsReducer, initialStartupSettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadSettings = useCallback(async () => {
    try {
      const snapshot = await invoke<StartupSettings>("get_startup_settings");
      dispatch({ type: "loaded", settings: snapshot });
    } catch (reason) {
      dispatch({ type: "failed", message: friendlyError(reason) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const updateAutostart = async () => {
    setSaving(true);
    try {
      const snapshot = await invoke<StartupSettings>("set_autostart_enabled", {
        enabled: !settings.autostartEnabled,
      });
      dispatch({ type: "loaded", settings: snapshot });
    } catch (reason) {
      dispatch({ type: "failed", message: friendlyError(reason) });
    } finally {
      setSaving(false);
    }
  };

  const updateSilentStart = async () => {
    setSaving(true);
    try {
      const snapshot = await invoke<StartupSettings>("set_silent_start", {
        enabled: !settings.silentStart,
      });
      dispatch({ type: "loaded", settings: snapshot });
    } catch (reason) {
      dispatch({ type: "failed", message: friendlyError(reason) });
    } finally {
      setSaving(false);
    }
  };

  const closeSettings = async () => {
    try {
      await invoke("hide_settings_window");
    } catch (reason) {
      dispatch({ type: "failed", message: friendlyError(reason) });
    }
  };

  return (
    <main className="settings-shell">
      <header className="settings-header">
        <div>
          <p className="eyebrow">PREFERENCES</p>
          <h1>设置</h1>
        </div>
        <button className="icon-button" onClick={() => void closeSettings()}>关闭</button>
      </header>
      <section className="settings-list" aria-busy={loading}>
        <div className="settings-row">
          <div>
            <strong>开机自启动</strong>
            <span>登录 Windows 后自动运行时间记录</span>
          </div>
          <button
            aria-checked={settings.autostartEnabled}
            aria-label="开机自启动"
            className={`toggle ${settings.autostartEnabled ? "enabled" : ""}`}
            disabled={loading || saving}
            onClick={() => void updateAutostart()}
            role="switch"
          ><span /></button>
        </div>
        <div className="settings-row">
          <div>
            <strong>静默启动</strong>
            <span>开机自启动时仅驻留系统托盘</span>
          </div>
          <button
            aria-checked={settings.silentStart}
            aria-label="静默启动"
            className={`toggle ${settings.silentStart ? "enabled" : ""}`}
            disabled={loading || saving || !settings.autostartEnabled}
            onClick={() => void updateSilentStart()}
            role="switch"
          ><span /></button>
        </div>
      </section>
      {settings.error && <p className="error-message">{settings.error}</p>}
    </main>
  );
}
```

- [ ] **Step 4: 路由至设置窗口**

把 `App` 最后一行替换为：

```tsx
if (viewMode === "settings") return <SettingsWindow />;
return viewMode === "history" ? <HistoryWindow /> : <TimerWindow />;
```

- [ ] **Step 5: 添加设置窗口和 switch 样式**

在 `src/App.css` 的 `.history-shell` 规则之后添加：

```css
.settings-shell { min-height: 100vh; padding: 28px; background: #11101a; color: #f3f0ff; }
.settings-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.settings-list { margin-top: 28px; border: 1px solid #2b293d; border-radius: 14px; overflow: hidden; }
.settings-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 18px; background: rgba(26, 25, 39, .7); }
.settings-row + .settings-row { border-top: 1px solid #2b293d; }
.settings-row strong, .settings-row span { display: block; }
.settings-row strong { color: #f3f0ff; font-size: 13px; }
.settings-row span { margin-top: 5px; color: #817c96; font-size: 11px; }
.toggle { display: flex; flex: 0 0 auto; align-items: center; width: 42px; height: 24px; padding: 3px; border: 0; border-radius: 999px; background: #4a465d; cursor: pointer; transition: background .15s ease; }
.toggle span { width: 18px; height: 18px; margin: 0; border-radius: 50%; background: #f8f7ff; transition: transform .15s ease; }
.toggle.enabled { background: #7c6cf2; }
.toggle.enabled span { transform: translateX(18px); }
.toggle:disabled { cursor: not-allowed; opacity: .45; }
```

- [ ] **Step 6: 验证 TypeScript、Vitest 与 Rust 构建**

Run: `npm run build && npm test && cargo fmt --check --manifest-path src-tauri/Cargo.toml && cargo test --manifest-path src-tauri/Cargo.toml`

Expected: PASS，TypeScript 编译、全部 Vitest、Rust 格式检查与 Rust 测试均通过。

- [ ] **Step 7: 使用完整 Tauri 开发应用进行人工 UI 验证**

Run: `npm run tauri -- dev`

验证：

1. 主窗口顶部可打开设置窗口。
2. 设置窗口可正常加载；开发模式中切换“开机自启动”展示明确错误，开关保持关闭。
3. “静默启动”在自启动关闭时禁用。
4. 点击设置窗口关闭按钮会隐藏而非退出整个应用；再次从主窗口打开时窗口仍可正常使用。
5. 历史窗口、置顶、项目开始/暂停和托盘显示主窗口均未回归。

完成验证后正常从托盘“退出”关闭应用；不要通过强制结束进程关闭。

- [ ] **Step 8: 提交设置窗口界面**

```bash
git add src/App.tsx src/App.css
git commit -m "feat: add configurable startup settings"
```

### Task 6: Windows 发布版自启动验收

**Files:**
- No source changes expected.

- [ ] **Step 1: 构建 Windows 安装包**

Run: `npm run tauri -- build`

Expected: PASS，Tauri 在 `src-tauri/target/release/bundle/` 下生成 Windows 安装包。

- [ ] **Step 2: 在非开发环境安装并打开应用**

安装刚构建的安装包。打开应用并在主窗口点击“设置”，确认开关初始均为关闭状态。

- [ ] **Step 3: 验证当前用户启动项写入和删除**

在设置窗口开启“开机自启动”。在 Windows 注册表编辑器检查：

`HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run`

Expected: 存在名为“时间记录”的字符串值，数据为引号包裹的已安装 `time-record.exe` 完整路径，且静默启动关闭时没有 `--silent-start`。

关闭“开机自启动”。

Expected: “时间记录”值被删除；再次关闭不报错。

- [ ] **Step 4: 验证静默启动的启动命令与实际窗口行为**

重新启用“开机自启动”，然后启用“静默启动”。检查相同注册表值：

Expected: 命令以 `"<安装路径>" --silent-start` 形式保存。

从托盘菜单选择“退出”，再将注册表值复制到 Windows“运行”对话框执行。

Expected: 主窗口不出现，应用图标出现在系统托盘；单击托盘图标会显示并聚焦计时器窗口。

- [ ] **Step 5: 验证手动启动不受静默偏好影响**

退出应用后，从开始菜单或安装目录直接运行 `time-record.exe`（不传参数）。

Expected: 即使“静默启动”开关保持开启，计时器窗口仍立即可见。

- [ ] **Step 6: 验证静默偏好在自启动关闭期间保留**

在设置窗口关闭“开机自启动”，确认“静默启动”显示为已开启但禁用；随后重新开启“开机自启动”。

Expected: 新建的注册表值仍附加 `--silent-start`。

- [ ] **Step 7: 提交（仅在验收暴露并修复源码问题时）**

若本任务没有源码改动，不创建空提交。若修复了问题，运行完整验证后只暂存实际修改的文件并使用符合修复内容的 Conventional Commit 信息，例如：

```bash
git add src-tauri/src/lib.rs
git commit -m "fix: correct startup settings behavior"
```

## 实施完成检查

- [ ] 所有源代码提交均只包含该主题文件，未混入既有未提交的图标或甘特图改动。
- [ ] `npm run build`、`npm test`、`cargo fmt --check --manifest-path src-tauri/Cargo.toml` 和 `cargo test --manifest-path src-tauri/Cargo.toml` 全部通过。
- [ ] Windows 安装包中已验证注册表项、静默托盘启动、手动可见启动和静默偏好恢复。
