import { describe, expect, it } from "vitest";
import { initialTimerState, timerReducer, type TimeEntry } from "./appState";

const entry: TimeEntry = {
  id: 1,
  title: "写代码",
  project: "个人",
  category: "开发",
  color: "#7c6cf2",
  startedAt: 100,
  endedAt: null,
  createdAt: 100,
};

describe("timerReducer", () => {
  it("hydrates an active timer from the backend", () => {
    const state = timerReducer(initialTimerState, {
      type: "hydrated",
      active: entry,
      elapsedSeconds: 12,
    });

    expect(state.active).toEqual(entry);
    expect(state.elapsedSeconds).toBe(12);
    expect(state.error).toBeNull();
  });

  it("updates elapsed time without changing the active entry", () => {
    const running = timerReducer(initialTimerState, {
      type: "hydrated",
      active: entry,
      elapsedSeconds: 0,
    });

    const state = timerReducer(running, { type: "tick", elapsedSeconds: 42 });
    expect(state.active).toEqual(entry);
    expect(state.elapsedSeconds).toBe(42);
  });

  it("clears the active timer when paused", () => {
    const running = timerReducer(initialTimerState, {
      type: "hydrated",
      active: entry,
      elapsedSeconds: 10,
    });

    const state = timerReducer(running, {
      type: "paused",
      entry: { ...entry, endedAt: 125 },
    });
    expect(state.active).toBeNull();
    expect(state.elapsedSeconds).toBe(25);
  });
});
