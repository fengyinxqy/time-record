import type { Project, TimeSegment } from "./projectModel";

export type { Project, TimeSegment } from "./projectModel";

export interface TimerState {
  activeProject: Project | null;
  activeSegment: TimeSegment | null;
  elapsedSeconds: number;
  error: string | null;
}

export const initialTimerState: TimerState = {
  activeProject: null,
  activeSegment: null,
  elapsedSeconds: 0,
  error: null,
};

type TimerAction =
  | { type: "hydrated"; activeProject: Project | null; activeSegment: TimeSegment | null; elapsedSeconds: number }
  | { type: "started"; project: Project; segment: TimeSegment }
  | { type: "tick"; elapsedSeconds: number }
  | { type: "paused"; segment: TimeSegment | null }
  | { type: "error"; message: string }
  | { type: "clearError" };

export function timerReducer(state: TimerState, action: TimerAction): TimerState {
  switch (action.type) {
    case "hydrated":
      return {
        activeProject: action.activeProject,
        activeSegment: action.activeSegment,
        elapsedSeconds: Math.max(0, action.elapsedSeconds),
        error: null,
      };
    case "started":
      return {
        activeProject: action.project,
        activeSegment: action.segment,
        elapsedSeconds: 0,
        error: null,
      };
    case "tick":
      return { ...state, elapsedSeconds: Math.max(0, action.elapsedSeconds), error: null };
    case "paused": {
      const endedAt = action.segment?.endedAt;
      const elapsedSeconds = action.segment && endedAt !== null && endedAt !== undefined
        ? Math.max(0, endedAt - action.segment.startedAt)
        : state.elapsedSeconds;
      return {
        activeProject: null,
        activeSegment: null,
        elapsedSeconds,
        error: null,
      };
    }
    case "error":
      return { ...state, error: action.message };
    case "clearError":
      return { ...state, error: null };
  }
}
