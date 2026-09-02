mod db;
mod domain;

use db::{Database, NewEntry, Preset, TimeEntry};
use serde::Serialize;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::menu::{MenuBuilder, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent,
};

struct AppState {
    database: Mutex<Database>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TimerState {
    active: Option<TimeEntry>,
    elapsed_seconds: i64,
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock must be after Unix epoch")
        .as_secs() as i64
}

fn database<'a>(state: &'a State<'_, AppState>) -> Result<std::sync::MutexGuard<'a, Database>, String> {
    state
        .database
        .lock()
        .map_err(|_| "database lock is poisoned".to_string())
}

#[tauri::command]
fn get_timer_state(state: State<'_, AppState>) -> Result<TimerState, String> {
    let db = database(&state)?;
    let active = db.active_entry()?;
    let elapsed_seconds = active
        .as_ref()
        .map(|entry| (now_seconds() - entry.started_at).max(0))
        .unwrap_or(0);
    Ok(TimerState {
        active,
        elapsed_seconds,
    })
}

#[tauri::command]
fn start_timer(input: NewEntry, state: State<'_, AppState>) -> Result<TimeEntry, String> {
    database(&state)?.start_entry(input, now_seconds())
}

#[tauri::command]
fn pause_timer(state: State<'_, AppState>) -> Result<Option<TimeEntry>, String> {
    database(&state)?.pause_active(now_seconds())
}

#[tauri::command]
fn heartbeat(state: State<'_, AppState>) -> Result<(), String> {
    database(&state)?.heartbeat(now_seconds())
}

#[tauri::command]
fn get_entries_for_date(
    date: String,
    timezone_offset_hours: i32,
    state: State<'_, AppState>,
) -> Result<Vec<TimeEntry>, String> {
    let (start, end) = domain::utc_day_bounds(&date, timezone_offset_hours)
        .ok_or_else(|| "invalid date, expected YYYY-MM-DD".to_string())?;
    database(&state)?.entries_between(start, end)
}

#[tauri::command]
fn list_presets(state: State<'_, AppState>) -> Result<Vec<Preset>, String> {
    database(&state)?.list_presets()
}

#[tauri::command]
fn save_preset(input: NewEntry, state: State<'_, AppState>) -> Result<Preset, String> {
    database(&state)?.save_preset(input, now_seconds())
}

#[tauri::command]
fn open_history_window(app: AppHandle) -> Result<(), String> {
    open_history(&app)
}

#[tauri::command]
fn set_always_on_top(window: Window, enabled: bool) -> Result<(), String> {
    window
        .set_always_on_top(enabled)
        .map_err(|error| error.to_string())
}

fn show_timer(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("timer") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn open_history(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("history") {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    WebviewWindowBuilder::new(
        app,
        "history",
        WebviewUrl::App("index.html?view=history".into()),
    )
    .title("历史记录")
    .inner_size(960.0, 680.0)
    .min_inner_size(720.0, 480.0)
    .build()
    .map(|_| ())
    .map_err(|error| error.to_string())
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

    TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show_timer" => show_timer(app),
            "open_history" => {
                let _ = open_history(app);
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
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "timer" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_timer_state,
            start_timer,
            pause_timer,
            heartbeat,
            get_entries_for_date,
            list_presets,
            save_preset,
            open_history_window,
            set_always_on_top
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
