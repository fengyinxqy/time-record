import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";
import { elapsedSeconds, formatDuration, localDateKey } from "./timer";
import { initialTimerState, timerReducer, type Project, type TimeSegment } from "./appState";
import { clipSegmentToDay, groupSegmentsByProject } from "./projectModel";

type TimerSnapshot = {
  activeProject: Project | null;
  activeSegment: TimeSegment | null;
  elapsedSeconds: number;
};

const COLORS = ["#7c6cf2", "#63c6a0", "#e39a62", "#d26378", "#5da6d8"];
const isHistoryWindow = new URLSearchParams(window.location.search).get("view") === "history";

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
    const interval = window.setInterval(() => {
      if (timer.activeSegment) {
        dispatch({
          type: "tick",
          elapsedSeconds: elapsedSeconds(timer.activeSegment.startedAt * 1000, Date.now()),
        });
        void invoke("heartbeat").catch(() => undefined);
      }
    }, 1000);
    return () => window.clearInterval(interval);
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
              <span className="project-dot" style={{ backgroundColor: project.color }} />
              <div className="project-copy">
                <strong>{project.name}</strong>
                <span>{active ? "正在计时" : ""}</span>
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
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => { void loadHistory(); }, [loadHistory]);

  const dayStart = new Date(`${date}T00:00:00`).getTime() / 1000;
  const dayEnd = dayStart + 24 * 60 * 60;
  const rows = useMemo(
    () => groupSegmentsByProject(projects, segments).filter((row) => row.segments.length > 0),
    [projects, segments],
  );
  const totalSeconds = useMemo(() => segments.reduce((total, segment) => {
    const clipped = clipSegmentToDay(segment, dayStart, dayEnd);
    return total + (clipped ? clipped.endedAt - clipped.startedAt : 0);
  }, 0), [dayEnd, dayStart, segments]);

  return (
    <main className="history-shell">
      <header className="history-header">
        <div>
          <p className="eyebrow">TIMELINE</p>
          <h1>历史记录</h1>
        </div>
        <button className="icon-button" onClick={() => void getCurrentWindow().close()}>关闭</button>
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
      <section className="gantt-card">
        <div className="gantt-axis"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>
        {rows.length === 0 && <div className="empty-gantt">这一天还没有记录</div>}
        {rows.map((row) => (
          <div className="gantt-row" key={row.project.id}>
            <div className="gantt-label"><span className="project-dot" style={{ backgroundColor: row.project.color }} /><strong>{row.project.name}</strong></div>
            <div className="gantt-lane">
              {[25, 50, 75].map((position) => <i key={position} className="gantt-line" style={{ left: `${position}%` }} />)}
              {row.segments.map((segment) => {
                const clipped = clipSegmentToDay(segment, dayStart, dayEnd);
                if (!clipped) return null;
                const left = ((clipped.startedAt - dayStart) / (dayEnd - dayStart)) * 100;
                const width = Math.max(1, ((clipped.endedAt - clipped.startedAt) / (dayEnd - dayStart)) * 100);
                return <div className="gantt-block" key={segment.id} style={{ left: `${left}%`, width: `${width}%`, backgroundColor: row.project.color }} title={`${formatClock(clipped.startedAt)} - ${formatClock(clipped.endedAt)}`} />;
              })}
            </div>
          </div>
        ))}
      </section>
      {rows.length > 0 && <section className="entry-list">
        {rows.flatMap((row) => row.segments.map((segment) => {
          const clipped = clipSegmentToDay(segment, dayStart, dayEnd);
          if (!clipped) return null;
          return <div className="entry-row" key={segment.id}>
            <span className="entry-color" style={{ backgroundColor: row.project.color }} />
            <div><strong>{row.project.name}</strong><span>{formatClock(clipped.startedAt)} – {formatClock(clipped.endedAt)}</span></div>
            <time>{formatDuration(clipped.endedAt - clipped.startedAt)}</time>
          </div>;
        }))}
      </section>}
      {error && <p className="error-message">{error}</p>}
    </main>
  );
}

export default function App() {
  return isHistoryWindow ? <HistoryWindow /> : <TimerWindow />;
}
