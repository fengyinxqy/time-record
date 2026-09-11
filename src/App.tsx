import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { Dialog, Popover, Switch } from "radix-ui";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";
import { useTheme } from "./useTheme";
import { elapsedSeconds, formatDuration, localDateKey } from "./timer";
import { initialTimerState, timerReducer, type Project, type TimeSegment } from "./appState";
import { clipSegmentToDay, groupSegmentsByProject } from "./projectModel";
import { resolveViewMode, type ViewMode } from "./viewMode";
import { isExportRangeValid, segmentEndLabel } from "./historyModel";
import { archivedQuickSelects } from "./archiveSuggest";
import { DailyTimeline } from "./DailyTimeline";
import { UpdateSection } from "./UpdateSection";
import { getLatestRelease, isUpdateAvailable, type ReleaseInfo } from "./updateModel";
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

const COLORS = ["#a69bd6", "#86ad94", "#d9a071", "#d88fa4", "#86a9ce"];
let timerStartupUpdatePromise: Promise<ReleaseInfo | null> | null = null;

function getTimerStartupUpdate(): Promise<ReleaseInfo | null> {
  if (timerStartupUpdatePromise === null) {
    timerStartupUpdatePromise = Promise.all([getVersion(), getLatestRelease()])
      .then(([version, release]) => (
        isUpdateAvailable(version, release) ? release : null
      ))
      .catch(() => null);
  }
  return timerStartupUpdatePromise;
}

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

function projectExists(name: string, projects: Project[]): boolean {
  const normalized = name.trim().toLowerCase();
  return projects.some(
    (project) => project.name.trim().toLowerCase() === normalized,
  );
}

export function TimerWindow() {
  const [timer, dispatch] = useReducer(timerReducer, initialTimerState);
  const [projects, setProjects] = useState<Project[]>([]);
  const [archivedProjects, setArchivedProjects] = useState<Project[]>([]);
  const [segments, setSegments] = useState<TimeSegment[]>([]);
  const [newProjectName, setNewProjectName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameOpen, setNameOpen] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const [updateRelease, setUpdateRelease] = useState<ReleaseInfo | null>(null);

  const refresh = useCallback(async () => {
    const today = localDateKey(new Date());
    try {
      const [projectList, archivedList, snapshot, daySegments] = await Promise.all([
        invoke<Project[]>("list_projects", { includeArchived: false }),
        invoke<Project[]>("list_projects", { includeArchived: true }),
        invoke<TimerSnapshot>("get_timer_state"),
        invoke<TimeSegment[]>("get_segments_for_date", {
          date: today,
          timezoneOffsetHours: timezoneOffsetHours(),
        }),
      ]);
      setProjects(projectList.filter((project) => !project.archived));
      setArchivedProjects(archivedList.filter((project) => project.archived));
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

  useEffect(() => {
    let active = true;
    void getTimerStartupUpdate()
      .then((release) => {
        if (active && release) {
          setUpdateRelease(release);
        }
      });
    return () => {
      active = false;
    };
  }, []);

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

  const archiveProject = async (project: Project) => {
    try {
      await invoke("archive_project", { projectId: project.id });
      setArchiveTarget(null);
      await refresh();
    } catch (reason) {
      setArchiveTarget(null);
      setError(friendlyError(reason));
    }
  };

  const addProject = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = newProjectName.trim();
    if (!name) return;
    if (projectExists(name, projects)) {
      setNameError(`已存在名为「${name}」的项目`);
      return;
    }
    setNameError(null);
    try {
      await invoke("create_project", {
        input: { name, color: COLORS[projects.length % COLORS.length] },
      });
      setNewProjectName("");
      setNameOpen(false);
      await refresh();
    } catch (reason) {
      setError(friendlyError(reason));
    }
  };

  const updateNewProjectName = (value: string) => {
    setNewProjectName(value);
    setNameError(
      value.trim() && projectExists(value, projects)
        ? `已存在名为「${value.trim()}」的项目`
        : null,
    );
  };

  const suggestions = useMemo(
    () => archivedQuickSelects(archivedProjects, newProjectName, projects.map((project) => project.name)),
    [archivedProjects, newProjectName, projects],
  );

  const pickSuggestion = async (project: Project) => {
    try {
      await invoke("restore_project", { projectId: project.id });
      setNewProjectName("");
      setNameError(null);
      setNameOpen(false);
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
          <button className={`icon-button ${pinned ? "selected" : ""}`} onClick={() => void togglePinned()}>
            {pinned ? "置顶中" : "置顶"}
          </button>
          <button className="icon-button" onClick={() => void showHistory()}>历史</button>
          <button className="icon-button" onClick={() => void showSettings()}>设置</button>
        </div>
      </header>

      {updateRelease && (
        <button
          className="update-notice"
          aria-label="查看更新"
          onClick={() => void showSettings()}
        >
          发现新版本 v{updateRelease.version}，查看更新
        </button>
      )}

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
                <div className="project-actions">
                  <button className="project-control" onClick={() => void toggleProject(project)}>{active ? "暂停" : "开始"}</button>
                  <button className="project-control archive" onClick={() => setArchiveTarget(project)}>归档</button>
                </div>
            </div>
          );
        })}
        {projects.length === 0 && <div className="empty-projects">还没有项目，先在下面新增一个</div>}
      </section>

      <form className="add-project" onSubmit={addProject}>
        <Popover.Root open={nameOpen && suggestions.length > 0} onOpenChange={setNameOpen}>
          <div className="add-project-field">
            <Popover.Anchor asChild>
              <input
                value={newProjectName}
                onChange={(event) => updateNewProjectName(event.target.value)}
                onFocus={() => setNameOpen(true)}
                placeholder="输入新的工作内容…"
                aria-label="新的工作内容"
                aria-invalid={nameError !== null}
                aria-controls="archived-projects"
              />
            </Popover.Anchor>
            <Popover.Portal>
              <Popover.Content className="archive-suggest" id="archived-projects" side="top" align="start" sideOffset={6} onOpenAutoFocus={(event) => event.preventDefault()}>
                <p className="archive-suggest-label">归档项目</p>
                {suggestions.map((project) => (
                  <button type="button" key={project.id} className="archive-suggest-item" onClick={() => void pickSuggestion(project)} role="option">
                    <span className="project-dot" style={{ backgroundColor: project.color }} />
                    <span>{project.name}</span>
                    <small>恢复</small>
                  </button>
                ))}
              </Popover.Content>
            </Popover.Portal>
          </div>
        </Popover.Root>
        <button type="submit" disabled={!newProjectName.trim() || nameError !== null}>新增</button>
      </form>
      {nameError && <p className="error-message" role="alert">{nameError}</p>}
      <p className="list-hint">同一时间只运行一个项目。</p>
      {(error || timer.error) && <p className="error-message">{error || timer.error}</p>}
      <Dialog.Root open={archiveTarget !== null} onOpenChange={(open) => !open && setArchiveTarget(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="archive-dialog">
            <Dialog.Title>归档项目</Dialog.Title>
            <Dialog.Description>确定归档「{archiveTarget?.name}」吗？你仍可从新工作内容输入框恢复它。</Dialog.Description>
            <div className="dialog-actions">
              <Dialog.Close asChild><button className="dialog-button" type="button">取消</button></Dialog.Close>
              <button className="dialog-button danger" type="button" onClick={() => archiveTarget && void archiveProject(archiveTarget)}>确认归档</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
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
  const [exportError, setExportError] = useState<string | null>(null);

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
    setExportError(null);
    try {
      const path = await invoke<string | null>("export_data_to_file", {
        start: exportStart,
        end: exportEnd,
        timezoneOffsetHours: timezoneOffsetHours(),
      });
      setExportNote(path);
    } catch (reason) {
      setExportNote(null);
      setExportError(friendlyError(reason));
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
        <div className="entry-heading"><h2>记录明细</h2><span>时段 / 时长</span></div>
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
      <section className="export-controls">
        <h2>导出记录</h2>
        <div className="export-range">
          <input aria-label="起始时间" className="export-input" type="datetime-local" value={exportStart} onChange={(event) => setExportStart(event.target.value)} />
          <span className="export-separator">至</span>
          <input aria-label="结束时间" className="export-input" type="datetime-local" value={exportEnd} onChange={(event) => setExportEnd(event.target.value)} />
        </div>
        <button className="export-button" disabled={exporting || !isExportRangeValid(exportStart, exportEnd)} onClick={() => void exportData()}>{exporting ? "导出中…" : "导出 JSON"}</button>
      </section>
      {exportNote && <p className="export-note success">已导出到 {exportNote}</p>}
      {exportError && <p className="error-message" role="alert">{exportError}</p>}
      {error && <p className="error-message">{error}</p>}
    </main>
  );
}

function SettingsWindow({ theme }: { theme: ReturnType<typeof useTheme> }) {
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
        <div className="settings-row theme-row">
          <div className="settings-copy">
            <strong>外观</strong>
            <span>自动模式跟随系统主题</span>
          </div>
          <div className="theme-options" role="group" aria-label="外观模式">
            {(["auto", "light", "dark"] as const).map((mode, index) => (
              <button key={mode} type="button" aria-pressed={theme.mode === mode} onClick={() => theme.updateTheme(mode)}>
                {["自动", "亮色", "深色"][index]}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-copy">
            <strong>开机自启动</strong>
            <span>登录 Windows 后自动运行时间记录</span>
          </div>
          <Switch.Root
            className="toggle"
            checked={settings.autostartEnabled}
            aria-label="开机自启动"
            disabled={loading || saving}
            onCheckedChange={() => void updateAutostart()}
          ><Switch.Thumb className="toggle-thumb" /></Switch.Root>
        </div>
        <div className="settings-row">
          <div className="settings-copy">
            <strong>静默启动</strong>
            <span>开机自启动时仅驻留系统托盘</span>
          </div>
          <Switch.Root
            className="toggle"
            checked={settings.silentStart}
            aria-label="静默启动"
            disabled={loading || saving || !settings.autostartEnabled}
            onCheckedChange={() => void updateSilentStart()}
          ><Switch.Thumb className="toggle-thumb" /></Switch.Root>
        </div>
        <UpdateSection />
      </section>
      {theme.themeError && <p className="error-message" role="alert">{theme.themeError}</p>}
      {settings.error && <p className="error-message">{settings.error}</p>}
    </main>
  );
}

export default function App() {
  const theme = useTheme();
  const [viewMode, setViewMode] = useState<ViewMode | null>(null);

  useEffect(() => {
    setViewMode(resolveViewMode(getCurrentWindow().label, window.location.search));
  }, []);

  if (viewMode === null) return <main className="loading-shell">正在打开…</main>;
  if (viewMode === "settings") return <SettingsWindow theme={theme} />;
  return viewMode === "history" ? <HistoryWindow /> : <TimerWindow />;
}
