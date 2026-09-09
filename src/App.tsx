import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";
import { elapsedSeconds, formatDuration, localDateKey } from "./timer";
import { initialTimerState, timerReducer, type Project, type TimeSegment } from "./appState";
import { clipSegmentToDay, groupSegmentsByProject } from "./projectModel";
import { resolveViewMode, type ViewMode } from "./viewMode";
import { isExportRangeValid, segmentEndLabel } from "./historyModel";
import { DailyTimeline } from "./DailyTimeline";
import {
  initialStartupSettings,
  startupSettingsReducer,
  type StartupSettings,
} from "./settingsModel";

type TimerSnapshot = {
  activeProject: Project | null;
  activeSegment: TimeSegment | null;
  elapsedSeconds: number;
};

const COLORS = ["#7c6cf2", "#63c6a0", "#e39a62", "#d26378", "#5da6d8"];

function friendlyError(error: unknown): string {
  return typeof error === "string" ? error : "操作失败，请稍后重试";
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function formatClock(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDateLabel(dateKey: string): string {
  return new Date(`${dateKey}T12:00:00`).toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
  });
}

function shiftDate(dateKey: string, offset: number): string {
  const date = new Date(`${dateKey}T12:00:00`);
  date.setDate(date.getDate() + offset);
  return localDateKey(date);
}

function timezoneOffsetHours(): number {
  return -new Date().getTimezoneOffset() / 60;
}

function localDateTimeKey(date: Date): string {
  return `${localDateKey(date)}T${date.toTimeString().slice(0, 5)}`;
}

function projectTotalSeconds(projectId: number, segments: TimeSegment[], now: number): number {
  return segments.reduce((total, segment) => {
    if (segment.projectId !== projectId) return total;
    return total + Math.max(0, (segment.endedAt ?? now) - segment.startedAt);
  }, 0);
}

function TimerWindow() {
  const [timer, dispatch] = useReducer(timerReducer, initialTimerState);
  const [projects, setProjects] = useState<Project[]>([]);
  const [segments, setSegments] = useState<TimeSegment[]>([]);
  const [newProjectName, setNewProjectName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);

  const refresh = useCallback(async () => {
    const today = localDateKey(new Date());
    try {
      const [projectList, snapshot, daySegments] = await Promise.all([
        invoke<Project[]>("list_projects", { includeArchived: false }),
        invoke<TimerSnapshot>("get_timer_state"),
        invoke<TimeSegment[]>("get_segments_for_date", {
          date: today,
          timezoneOffsetHours: timezoneOffsetHours(),
        }),
      ]);
      setProjects(projectList);
      setSegments(daySegments);
      dispatch({
        type: "hydrated",
        activeProject: snapshot.activeProject,
        activeSegment: snapshot.activeSegment,
        elapsedSeconds: snapshot.elapsedSeconds,
      });
      setError(null);
    } catch (reason) {
      setError(friendlyError(reason));
      dispatch({ type: "error", message: friendlyError(reason) });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const retry = window.setTimeout(() => void refresh(), 500);
    const interval = window.setInterval(() => {
      if (timer.activeSegment) {
        dispatch({
          type: "tick",
          elapsedSeconds: elapsedSeconds(timer.activeSegment.startedAt * 1000, Date.now()),
        });
        void invoke("heartbeat").catch(() => undefined);
      }
    }, 1000);
    return () => {
      window.clearTimeout(retry);
      window.clearInterval(interval);
    };
  }, [refresh, timer.activeSegment]);

  const togglePinned = async () => {
    const nextValue = !pinned;
    try {
      await invoke("set_always_on_top", { enabled: nextValue });
      setPinned(nextValue);
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const toggleProject = async (project: Project) => {
    try {
      if (timer.activeProject?.id === project.id) {
        await invoke("pause_timer");
      } else {
        await invoke("start_project", { projectId: project.id });
      }
      await refresh();
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const addProject = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = newProjectName.trim();
    if (!name) return;
    try {
      await invoke("create_project", {
        input: { name, color: COLORS[projects.length % COLORS.length] },
      });
      setNewProjectName("");
      await refresh();
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const showHistory = async () => {
    try {
      await invoke("open_history_window");
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const showSettings = async () => {
    try {
      await invoke("open_settings_window");
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const displayNow = nowSeconds();
  return (
    <main className="timer-shell">
      <header className="timer-header">
        <div>
          <p className="eyebrow">TIME RECORD</p>
          <h1>时间记录</h1>
        </div>
        <div className="header-actions">
          <button className={`icon-button ${pinned ? "selected" : ""}`} onClick={togglePinned}>
            {pinned ? "置顶中" : "置顶"}
          </button>
          <button className="icon-button" onClick={showHistory}>历史</button>
          <button className="icon-button" onClick={showSettings}>设置</button>
        </div>
      </header>

      <section className="project-list">
        {projects.map((project) => {
          const active = timer.activeProject?.id === project.id;
          const duration = active
            ? Math.max(projectTotalSeconds(project.id, segments, displayNow), timer.elapsedSeconds)
            : projectTotalSeconds(project.id, segments, displayNow);
          return (
            <div className={`project-row ${active ? "active" : ""}`} key={project.id}>
              <div className="project-copy">
                <div className="project-title">
                  <span className="project-dot" style={{ backgroundColor: project.color }} />
                  <strong>{project.name}</strong>
                </div>
                <span className="project-state">{active ? "正在计时" : ""}</span>
              </div>
              <time>{formatDuration(duration)}</time>
              <button className="project-control" onClick={() => void toggleProject(project)}>
                {active ? "暂停" : "开始"}
              </button>
            </div>
          );
        })}
        {projects.length === 0 && <div className="empty-projects">还没有项目，先在下面新增一个</div>}
      </section>

      <form className="add-project" onSubmit={addProject}>
        <input
          value={newProjectName}
          onChange={(event) => setNewProjectName(event.target.value)}
          placeholder="输入新的工作内容…"
          aria-label="新的工作内容"
        />
        <button type="submit" disabled={!newProjectName.trim()}>新增</button>
      </form>
      <p className="list-hint">点击右侧按钮开始或暂停。同一时间只运行一个项目。</p>
      {(error || timer.error) && <p className="error-message">{error || timer.error}</p>}
    </main>
  );
}

function HistoryWindow() {
  const [date, setDate] = useState(() => localDateKey(new Date()));
  const [projects, setProjects] = useState<Project[]>([]);
  const [segments, setSegments] = useState<TimeSegment[]>([]);
  const [now, setNow] = useState(nowSeconds());
  const [error, setError] = useState<string | null>(null);
  const [exportStart, setExportStart] = useState(() => `${shiftDate(localDateKey(new Date()), -6)}T00:00`);
  const [exportEnd, setExportEnd] = useState(() => localDateTimeKey(new Date()));
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const [projectList, segmentList] = await Promise.all([
        invoke<Project[]>("list_projects", { includeArchived: true }),
        invoke<TimeSegment[]>("get_segments_for_date", {
          date,
          timezoneOffsetHours: timezoneOffsetHours(),
        }),
      ]);
      setProjects(projectList);
      setSegments(segmentList);
      setError(null);
    } catch (reason) {
      setError(friendlyError(reason));
    }
  }, [date]);

  const closeHistory = async () => {
    try {
      await invoke("hide_history_window");
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const exportData = async () => {
    setExporting(true);
    setExportNote(null);
    try {
      const path = await invoke<string>("export_data_to_file", {
        start: exportStart,
        end: exportEnd,
        timezoneOffsetHours: timezoneOffsetHours(),
      });
      setExportNote(path);
    } catch (reason) {
      setExportNote(null);
      setError(friendlyError(reason));
    } finally {
      setExporting(false);
    }
  };

  useEffect(() => {
    void loadHistory();
    const interval = window.setInterval(() => void loadHistory(), 2000);
    return () => window.clearInterval(interval);
  }, [loadHistory]);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(nowSeconds()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  const dayStart = new Date(`${date}T00:00:00`).getTime() / 1000;
  const dayEnd = dayStart + 24 * 60 * 60;
  const rows = useMemo(
    () => groupSegmentsByProject(projects, segments).filter((row) => row.segments.length > 0),
    [projects, segments],
  );
  const totalSeconds = useMemo(() => segments.reduce((total, segment) => {
    const clipped = clipSegmentToDay(segment, dayStart, dayEnd, now);
    return total + (clipped ? clipped.endedAt - clipped.startedAt : 0);
  }, 0), [dayEnd, dayStart, now, segments]);

  return (
    <main className="history-shell">
      <header className="history-header">
        <div>
          <p className="eyebrow">TIMELINE</p>
          <h1>历史记录</h1>
        </div>
        <button className="icon-button" onClick={() => void closeHistory()}>关闭</button>
      </header>
      <div className="date-toolbar">
        <button className="round-button" onClick={() => setDate(shiftDate(date, -1))}>‹</button>
        <div className="date-title"><strong>{formatDateLabel(date)}</strong><span>{date}</span></div>
        <button className="round-button" onClick={() => setDate(shiftDate(date, 1))}>›</button>
        <button className="today-button" onClick={() => setDate(localDateKey(new Date()))}>今天</button>
      </div>
      <section className="export-controls">
        <label>导出 JSON</label>
        <div className="export-range">
          <input
            aria-label="起始时间"
            className="export-input"
            type="datetime-local"
            value={exportStart}
            onChange={(event) => setExportStart(event.target.value)}
          />
          <span className="export-separator">至</span>
          <input
            aria-label="结束时间"
            className="export-input"
            type="datetime-local"
            value={exportEnd}
            onChange={(event) => setExportEnd(event.target.value)}
          />
        </div>
        <button
          className="export-button"
          disabled={exporting || !isExportRangeValid(exportStart, exportEnd)}
          onClick={() => void exportData()}
        >
          {exporting ? "导出中…" : "导出"}
        </button>
      </section>
      {exportNote && <p className="export-note success">已导出到 {exportNote}</p>}
      <section className="stats-row">
        <div><span>工作总计</span><strong>{formatDuration(totalSeconds)}</strong></div>
        <div><span>项目数</span><strong>{rows.length}</strong></div>
        <div><span>空闲时间</span><strong>{formatDuration(Math.max(0, 24 * 60 * 60 - totalSeconds))}</strong></div>
      </section>
      <>
        {rows.length === 0 ? (
          <section className="timeline-card"><div className="empty-gantt">这一天还没有记录</div></section>
        ) : (
          <DailyTimeline rows={rows} dayEnd={dayEnd} dayStart={dayStart} now={now} />
        )}
      </>
      {rows.length > 0 && <section className="entry-list">
        {rows.flatMap((row) => row.segments.map((segment) => {
          const clipped = clipSegmentToDay(segment, dayStart, dayEnd, now);
          if (!clipped) return null;
          const running = segmentEndLabel(segment) === "计时中";
          return <div className={`entry-row ${running ? "running-entry" : ""}`} key={segment.id}>
            <span className="entry-color" style={{ backgroundColor: row.project.color }} />
            <div><strong>{row.project.name}</strong><span>{formatClock(clipped.startedAt)} – {running ? "计时中" : formatClock(clipped.endedAt)}</span></div>
            <time>{formatDuration(clipped.endedAt - clipped.startedAt)}</time>
          </div>;
        }))}
      </section>}
      {error && <p className="error-message">{error}</p>}
    </main>
  );
}

function SettingsWindow() {
  const [settings, dispatch] = useReducer(startupSettingsReducer, initialStartupSettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadSettings = useCallback(async () => {
    setLoading(true);
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
    let active = true;
    const unlistenPromise = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (active && focused) void loadSettings();
    });
    return () => {
      active = false;
      void unlistenPromise.then((unlisten) => unlisten());
    };
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
          <div className="settings-copy">
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
          <div className="settings-copy">
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

export default function App() {
  const [viewMode, setViewMode] = useState<ViewMode | null>(null);

  useEffect(() => {
    setViewMode(resolveViewMode(getCurrentWindow().label, window.location.search));
  }, []);

  if (viewMode === null) {
    return <main className="loading-shell">正在打开…</main>;
  }
  if (viewMode === "settings") return <SettingsWindow />;
  return viewMode === "history" ? <HistoryWindow /> : <TimerWindow />;
}