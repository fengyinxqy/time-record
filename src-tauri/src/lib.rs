mod autostart;
mod db;
mod domain;

use db::{Database, NewProject, Project, TimeSegment};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::menu::{MenuBuilder, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, State, Window, WindowEvent};

struct AppState {
    database: Mutex<Database>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StartupSettings {
    autostart_enabled: bool,
    silent_start: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TimerState {
    active_project: Option<Project>,
    active_segment: Option<TimeSegment>,
    elapsed_seconds: i64,
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock must be after Unix epoch")
        .as_secs() as i64
}

fn database<'a>(
    state: &'a State<'_, AppState>,
) -> Result<std::sync::MutexGuard<'a, Database>, String> {
    state
        .database
        .lock()
        .map_err(|_| "database lock is poisoned".to_string())
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

fn current_executable(app: &AppHandle) -> Result<PathBuf, String> {
    tauri::process::current_binary(&app.env()).map_err(|error| error.to_string())
}

#[tauri::command]
fn get_timer_state(state: State<'_, AppState>) -> Result<TimerState, String> {
    let db = database(&state)?;
    let active_segment = db.active_segment()?;
    let active_project = active_segment
        .as_ref()
        .map(|segment| db.project_by_id(segment.project_id))
        .transpose()?
        .flatten();
    let elapsed_seconds = active_segment
        .as_ref()
        .map(|segment| (now_seconds() - segment.started_at).max(0))
        .unwrap_or(0);
    Ok(TimerState {
        active_project,
        active_segment,
        elapsed_seconds,
    })
}

#[tauri::command]
fn list_projects(
    include_archived: bool,
    state: State<'_, AppState>,
) -> Result<Vec<Project>, String> {
    database(&state)?.list_projects(include_archived)
}

#[tauri::command]
fn create_project(input: NewProject, state: State<'_, AppState>) -> Result<Project, String> {
    database(&state)?.create_project(input, now_seconds())
}

#[tauri::command]
fn rename_project(
    project_id: i64,
    new_name: String,
    state: State<'_, AppState>,
) -> Result<Project, String> {
    database(&state)?.rename_project(project_id, &new_name)
}

#[tauri::command]
fn project_is_name_taken(name: String, state: State<'_, AppState>) -> Result<bool, String> {
    database(&state)?.project_is_name_taken(&name)
}

#[tauri::command]
fn archive_project(project_id: i64, state: State<'_, AppState>) -> Result<(), String> {
    database(&state)?.archive_project(project_id)
}

#[tauri::command]
fn start_project(project_id: i64, state: State<'_, AppState>) -> Result<TimeSegment, String> {
    database(&state)?.start_project(project_id, now_seconds())
}

#[tauri::command]
fn pause_timer(state: State<'_, AppState>) -> Result<Option<TimeSegment>, String> {
    database(&state)?.pause_active(now_seconds())
}

#[tauri::command]
fn heartbeat(state: State<'_, AppState>) -> Result<(), String> {
    database(&state)?.heartbeat(now_seconds())
}

#[tauri::command]
fn get_segments_for_date(
    date: String,
    timezone_offset_hours: i32,
    state: State<'_, AppState>,
) -> Result<Vec<TimeSegment>, String> {
    let (start, end) = domain::utc_day_bounds(&date, timezone_offset_hours)
        .ok_or_else(|| "invalid date, expected YYYY-MM-DD".to_string())?;
    database(&state)?.segments_between(start, end)
}

#[tauri::command]
fn open_history_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("history")
        .ok_or_else(|| "history window is not configured".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn hide_history_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("history")
        .ok_or_else(|| "history window is not configured".to_string())?;
    window.hide().map_err(|error| error.to_string())
}

#[tauri::command]
fn set_always_on_top(window: Window, enabled: bool) -> Result<(), String> {
    window
        .set_always_on_top(enabled)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_startup_settings(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<StartupSettings, String> {
    let executable = current_executable(&app)?;
    let autostart_enabled = autostart::is_enabled(&executable)?;
    let silent_start = database(&state)?.silent_start()?;
    Ok(StartupSettings {
        autostart_enabled,
        silent_start,
    })
}

#[tauri::command]
fn set_autostart_enabled(
    app: AppHandle,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<StartupSettings, String> {
    let silent_start = database(&state)?.silent_start()?;
    let executable = current_executable(&app)?;
    if enabled {
        let executable = startup_executable(executable)?;
        autostart::set_enabled(&executable, silent_start)?;
    } else {
        autostart::disable(&executable)?;
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
    let database = database(&state)?;
    let previous = database.silent_start()?;
    let executable = current_executable(&app)?;
    let autostart_enabled = autostart::is_enabled(&executable)?;
    let rewrite = if autostart_enabled {
        Some(startup_executable(executable)?)
    } else {
        None
    };
    database.set_silent_start(enabled)?;
    if let Some(executable) = rewrite {
        if let Err(error) = autostart::set_enabled(&executable, enabled) {
            let _ = database.set_silent_start(previous);
            return Err(error);
        }
    }
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
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn hide_settings_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("settings")
        .ok_or_else(|| "settings window is not configured".to_string())?;
    window.hide().map_err(|error| error.to_string())
}

fn show_timer(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("timer") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show_timer_item = MenuItem::with_id(app, "show_timer", "显示计时器", true, None::<&str>)?;
    let history_item = MenuItem::with_id(app, "open_history", "打开历史记录", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = MenuBuilder::new(app)
        .item(&show_timer_item)
        .item(&history_item)
        .separator()
        .item(&quit_item)
        .build()?;

    let mut tray_builder = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon().cloned() {
        tray_builder = tray_builder.icon(icon);
    }
    tray_builder
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show_timer" => show_timer(app),
            "open_history" => {
                let _ = open_history_window(app.clone());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_timer(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let silent_start = autostart::has_silent_start_argument(std::env::args());
            let app_data_dir = app.path().app_data_dir()?;
            let db_path = app_data_dir.join("time_record.db");
            let database = Database::open(db_path).map_err(std::io::Error::other)?;
            database
                .recover_active(now_seconds())
                .map_err(std::io::Error::other)?;
            app.manage(AppState {
                database: Mutex::new(database),
            });
            setup_tray(app)?;
            if !silent_start {
                show_timer(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(window.label(), "timer" | "history" | "settings") {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_timer_state,
            list_projects,
            create_project,
            rename_project,
            project_is_name_taken,
            archive_project,
            start_project,
            pause_timer,
            heartbeat,
            get_segments_for_date,
            open_history_window,
            hide_history_window,
            set_always_on_top,
            get_startup_settings,
            set_autostart_enabled,
            set_silent_start,
            open_settings_window,
            hide_settings_window
        ])
        .build(tauri::generate_context!())
        .expect("error while building time-record application")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(database) = state.database.lock() {
                        let _ = database.pause_active(now_seconds());
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{valid_startup_executable, StartupSettings};
    use std::path::PathBuf;

    #[test]
    fn rejects_autostart_creation_in_a_debug_build() {
        assert!(valid_startup_executable(
            PathBuf::from(r"C:\work\target\debug\time-record.exe"),
            true,
        )
        .is_err());
    }

    #[test]
    fn rejects_an_empty_executable_path() {
        assert!(valid_startup_executable(PathBuf::new(), false).is_err());
    }

    #[test]
    fn accepts_a_packaged_executable_outside_debug() {
        assert_eq!(
            valid_startup_executable(
                PathBuf::from(r"C:\Program Files\时间记录\time-record.exe"),
                false,
            )
            .unwrap(),
            PathBuf::from(r"C:\Program Files\时间记录\time-record.exe"),
        );
    }

    #[test]
    fn serializes_startup_settings_with_camel_case_keys() {
        let settings = StartupSettings {
            autostart_enabled: true,
            silent_start: false,
        };
        assert_eq!(
            serde_json::to_value(settings).unwrap(),
            serde_json::json!({
                "autostartEnabled": true,
                "silentStart": false,
            })
        );
    }
}
