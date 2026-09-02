import { describe, expect, it } from "vitest";
import { initialTimerState, timerReducer, type Project, type TimeSegment } from "./appState";

const project: Project = {
  id: 1,
  name: "写代码",
  color: "#7c6cf2",
  sortOrder: 0,
  archived: false,
  createdAt: 1,
};
const segment: TimeSegment = {
  id: 1,
  projectId: 1,
  startedAt: 100,
  endedAt: null,
  createdAt: 100,
};

describe("timerReducer", () => {
  it("hydrates one active project from the backend", () => {
    const state = timerReducer(initialTimerState, {
      type: "hydrated",
      activeProject: project,
      activeSegment: segment,
      elapsedSeconds: 12,
    });

    expect(state.activeProject).toEqual(project);
    expect(state.activeSegment).toEqual(segment);
    expect(state.elapsedSeconds).toBe(12);
    expect(state.error).toBeNull();
  });

  it("keeps only one active project after switching", () => {
    const running = timerReducer(initialTimerState, {
      type: "started",
      project,
      segment,
    });
    const secondProject = { ...project, id: 2, name: "上厕所" };
    const secondSegment = { ...segment, id: 2, projectId: 2, startedAt: 200 };
    const state = timerReducer(running, {
      type: "started",
      project: secondProject,
      segment: secondSegment,
    });

    expect(state.activeProject?.name).toBe("上厕所");
    expect(state.activeSegment?.projectId).toBe(2);
  });

  it("clears the active project when paused", () => {
    const running = timerReducer(initialTimerState, {
      type: "started",
      project,
      segment,
    });

    const state = timerReducer(running, {
      type: "paused",
      segment: { ...segment, endedAt: 125 },
    });
    expect(state.activeProject).toBeNull();
    expect(state.activeSegment).toBeNull();
    expect(state.elapsedSeconds).toBe(25);
  });
});
