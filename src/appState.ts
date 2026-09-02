export interface TimeEntry {
  id: number;
  title: string;
  project: string | null;
  category: string | null;
  color: string;
  startedAt: number;
  endedAt: number | null;
  createdAt: number;
}

export interface TimerState {
  active: TimeEntry | null;
  elapsedSeconds: number;
  error: string | null;
}

export const initialTimerState: TimerState = {
  active: null,
  elapsedSeconds: 0,
  error: null,
};

type TimerAction =
  | { type: "hydrated"; active: TimeEntry | null; elapsedSeconds: number }
  | { type: "started"; entry: TimeEntry }
  | { type: "tick"; elapsedSeconds: number }
  | { type: "paused"; entry: TimeEntry | null }
  | { type: "error"; message: string }
  | { type: "clearError" };

export function timerReducer(state: TimerState, action: TimerAction): TimerState {
  switch (action.type) {
    case "hydrated":
      return {
        active: action.active,
        elapsedSeconds: Math.max(0, action.elapsedSeconds),
        error: null,
      };
    case "started":
      return { active: action.entry, elapsedSeconds: 0, error: null };
    case "tick":
      return { ...state, elapsedSeconds: Math.max(0, action.elapsedSeconds), error: null };
    case "paused": {
      const endedAt = action.entry?.endedAt;
      const elapsedSeconds = action.entry && endedAt !== null && endedAt !== undefined
        ? Math.max(0, endedAt - action.entry.startedAt)
        : state.elapsedSeconds;
      return { active: null, elapsedSeconds, error: null };
    }
    case "error":
      return { ...state, error: action.message };
    case "clearError":
      return { ...state, error: null };
  }
}
