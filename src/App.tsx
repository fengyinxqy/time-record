import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";
import { elapsedSeconds, formatDuration, localDateKey } from "./timer";
import {
  initialTimerState,
  timerReducer,
  type TimeEntry,
} from "./appState";

type Preset = {
  id: number;
  title: string;
  project: string | null;
  category: string | null;
  color: string;
  sortOrder: number;
  createdAt: number;
};

type TimerSnapshot = {
  active: TimeEntry | null;
  elapsedSeconds: number;
};

type EntryInput = {
  title: string;
  project: string | null;
  category: string | null;
  color: string;
};

const DEFAULT_COLOR = "#7c6cf2";
const isHistoryWindow = new URLSearchParams(window.location.search).get("view") === "history";

function friendlyError(error: unknown): string {
  return typeof error === "string" ? error : "操作失败，请稍后重试";
}

function currentTimeSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function formatClock(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDateLabel(dateKey: string): string {
  const date = new Date(`${dateKey}T12:00:00`);
  return date.toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
  });
}

function dateWithOffset(dateKey: string, offset: number): string {
  const date = new Date(`${dateKey}T12:00:00`);
  date.setDate(date.getDate() + offset);
  return localDateKey(date);
}

function entryInputFromPreset(preset: Preset): EntryInput {
  return {
    title: preset.title,
    project: preset.project,
    category: preset.category,
    color: preset.color,
  };
}

function invokeEntries(date: string): Promise<TimeEntry[]> {
  return invoke<TimeEntry[]>("get_entries_for_date", {
    date,
    timezoneOffsetHours: -new Date().getTimezoneOffset() / 60,
  });
}

function TimerWindow() {
  const [timer, dispatch] = useReducer(timerReducer, initialTimerState);
  const [title, setTitle] = useState("");
  const [project, setProject] = useState("");
  const [category, setCategory] = useState("");
  const [presets, setPresets] = useState<Preset[]>([]);
  const [pinned, setPinned] = useState(false);

  const loadState = useCallback(async () => {
    try {
      const snapshot = await invoke<TimerSnapshot>("get_timer_state");
      dispatch({
        type: "hydrated",
        active: snapshot.active,
        elapsedSeconds: snapshot.elapsedSeconds,
      });
      if (snapshot.active) {
        setTitle(snapshot.active.title);
        setProject(snapshot.active.project ?? "");
        setCategory(snapshot.active.category ?? "");
      }
    } catch (error) {
      dispatch({ type: "error", message: friendlyError(error) });
    }
  }, []);

  useEffect(() => {
    void loadState();
    void invoke<Preset[]>("list_presets").then(setPresets).catch((error) => {
      dispatch({ type: "error", message: friendlyError(error) });
    });
    const interval = window.setInterval(() => {
      if (timer.active) {
        dispatch({
          type: "tick",
          elapsedSeconds: elapsedSeconds(timer.active.startedAt * 1000, Date.now()),
        });
        void invoke("heartbeat").catch(() => undefined);
      }
    }, 1000);
    return () => window.clearInterval(interval);
  }, [loadState, timer.active]);

  const togglePinned = async () => {
    const nextValue = !pinned;
    try {
      await invoke("set_always_on_top", { enabled: nextValue });
      setPinned(nextValue);
    } catch (error) {
      dispatch({ type: "error", message: friendlyError(error) });
    }
  };

  const start = async () => {
    const input: EntryInput = {
      title: title.trim(),
      project: project.trim() || null,
      category: category.trim() || null,
      color: timer.active?.color ?? DEFAULT_COLOR,
    };
    try {
      const entry = await invoke<TimeEntry>("start_timer", { input });
      dispatch({ type: "started", entry });
    } catch (error) {
      dispatch({ type: "error", message: friendlyError(error) });
    }
  };

  const pause = async () => {
    try {
      const entry = await invoke<TimeEntry | null>("pause_timer");
      dispatch({ type: "paused", entry });
    } catch (error) {
      dispatch({ type: "error", message: friendlyError(error) });
    }
  };

  const savePreset = async () => {
    if (!title.trim()) return;
    try {
      const preset = await invoke<Preset>("save_preset", {
        input: {
          title: title.trim(),
          project: project.trim() || null,
          category: category.trim() || null,
          color: DEFAULT_COLOR,
        },
      });
      setPresets((current) => [preset, ...current]);
    } catch (error) {
      dispatch({ type: "error", message: friendlyError(error) });
    }
  };

  const showHistory = async () => {
    try {
      await invoke("open_history_window");
    } catch (error) {
      dispatch({ type: "error", message: friendlyError(error) });
    }
  };

  const running = timer.active !== null;
  return (
    <main className="timer-shell">
      <header className="timer-header">
        <div>
          <p className="eyebrow">TIME RECORD</p>
          <h1>时间记录</h1>
        </div>
        <div className="header-actions">
          <button className={`icon-button ${pinned ? "selected" : ""}`} onClick={togglePinned} title="始终置顶">
            {pinned ? "置顶" : "普通"}
          </button>
          <button className="icon-button" onClick={showHistory}>历史</button>
        </div>
      </header>

      <section className={`timer-card ${running ? "is-running" : ""}`}>
        <div className="status-row">
          <span className={`status-dot ${running ? "active" : ""}`} />
          <span>{running ? "正在记录" : "未计时"}</span>
          {running && <span className="live-label">LIVE</span>}
        </div>
        <input
          className="title-input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="现在要做什么？"
          list="recent-presets"
          disabled={running}
          autoFocus
        />
        <datalist id="recent-presets">
          {presets.map((preset) => <option key={preset.id} value={preset.title} />)}
        </datalist>
        <div className="meta-fields">
          <input value={project} onChange={(event) => setProject(event.target.value)} placeholder="项目（可选）" disabled={running} />
          <input value={category} onChange={(event) => setCategory(event.target.value)} placeholder="分类（可选）" disabled={running} />
        </div>
        <div className="timer-readout">{formatDuration(timer.elapsedSeconds)}</div>
        <div className="timer-controls">
          <button className={`primary-button ${running ? "pause-button" : ""}`} onClick={running ? pause : start} disabled={!running && !title.trim()}>
            <span className="button-mark">{running ? "Ⅱ" : "▶"}</span>
            {running ? "暂停" : "开始"}
          </button>
          {!running && title.trim() && (
            <button className="secondary-button" onClick={savePreset}>保存预设</button>
          )}
        </div>
      </section>

      {presets.length > 0 && !running && (
        <section className="preset-section">
          <div className="section-label">最近使用</div>
          <div className="preset-list">
            {presets.slice(0, 4).map((preset) => (
              <button key={preset.id} className="preset-chip" onClick={() => {
                const input = entryInputFromPreset(preset);
                setTitle(input.title);
                setProject(input.project ?? "");
                setCategory(input.category ?? "");
              }}>
                <span className="chip-color" style={{ backgroundColor: preset.color }} />
                {preset.title}
              </button>
            ))}
          </div>
        </section>
      )}
      {timer.error && <p className="error-message">{timer.error}</p>}
    </main>
  );
}

function HistoryWindow() {
  const [date, setDate] = useState(() => localDateKey(new Date()));
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadEntries = useCallback(async () => {
    try {
      setEntries(await invokeEntries(date));
      setError(null);
    } catch (reason) {
      setError(friendlyError(reason));
    }
  }, [date]);

  useEffect(() => { void loadEntries(); }, [loadEntries]);

  const dayStart = new Date(`${date}T00:00:00`).getTime() / 1000;
  const dayEnd = dayStart + 24 * 60 * 60;
  const totalSeconds = useMemo(() => entries.reduce((total, entry) => {
    const start = Math.max(dayStart, entry.startedAt);
    const end = Math.min(dayEnd, entry.endedAt ?? currentTimeSeconds());
    return total + Math.max(0, end - start);
  }, 0), [dayEnd, dayStart, entries]);

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
        <button className="round-button" onClick={() => setDate(dateWithOffset(date, -1))}>‹</button>
        <div className="date-title">
          <strong>{formatDateLabel(date)}</strong>
          <span>{date}</span>
        </div>
        <button className="round-button" onClick={() => setDate(dateWithOffset(date, 1))}>›</button>
        <button className="today-button" onClick={() => setDate(localDateKey(new Date()))}>今天</button>
      </div>
      <section className="stats-row">
        <div><span>工作总计</span><strong>{formatDuration(totalSeconds)}</strong></div>
        <div><span>时间段</span><strong>{entries.length}</strong></div>
        <div><span>空闲时间</span><strong>{formatDuration(Math.max(0, 24 * 60 * 60 - totalSeconds))}</strong></div>
      </section>
      <section className="timeline-card">
        <div className="timeline-axis">
          {[0, 4, 8, 12, 16, 20, 24].map((hour) => <span key={hour} style={{ left: `${(hour / 24) * 100}%` }}>{String(hour).padStart(2, "0")}:00</span>)}
        </div>
        <div className="timeline-grid">
          {[0, 4, 8, 12, 16, 20].map((hour) => <div key={hour} className="grid-line" style={{ left: `${(hour / 24) * 100}%` }} />)}
          {entries.map((entry) => {
            const start = Math.max(dayStart, entry.startedAt);
            const end = Math.min(dayEnd, entry.endedAt ?? currentTimeSeconds());
            const left = Math.max(0, Math.min(100, ((start - dayStart) / (dayEnd - dayStart)) * 100));
            const width = Math.max(1.2, Math.min(100 - left, ((end - start) / (dayEnd - dayStart)) * 100));
            return (
              <div key={entry.id} className="timeline-entry" style={{ left: `${left}%`, width: `${width}%`, backgroundColor: entry.color }} title={`${entry.title} ${formatClock(start)} - ${formatClock(end)}`}>
                <strong>{entry.title}</strong>
                <span>{formatClock(start)} – {formatClock(end)}</span>
              </div>
            );
          })}
          {entries.length === 0 && <div className="empty-timeline">这一天还没有记录</div>}
        </div>
      </section>
      {entries.length > 0 && (
        <section className="entry-list">
          {entries.map((entry) => <div className="entry-row" key={entry.id}>
            <span className="entry-color" style={{ backgroundColor: entry.color }} />
            <div><strong>{entry.title}</strong><span>{entry.project || "未分类"}{entry.category ? ` · ${entry.category}` : ""}</span></div>
            <time>{formatDuration(Math.max(0, (entry.endedAt ?? currentTimeSeconds()) - entry.startedAt))}</time>
          </div>)}
        </section>
      )}
      {error && <p className="error-message">{error}</p>}
    </main>
  );
}

export default function App() {
  return isHistoryWindow ? <HistoryWindow /> : <TimerWindow />;
}
