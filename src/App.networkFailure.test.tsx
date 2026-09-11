import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TimerWindow } from "./App";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((command: string) => {
    if (command === "list_projects" || command === "get_segments_for_date") {
      return Promise.resolve([]);
    }
    if (command === "get_timer_state") {
      return Promise.resolve({
        activeProject: null,
        activeSegment: null,
        elapsedSeconds: 0,
      });
    }
    return Promise.resolve(undefined);
  }),
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("0.1.0"),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "timer",
    onFocusChanged: vi.fn().mockResolvedValue(vi.fn()),
  }),
}));

describe("TimerWindow failed update checks", () => {
  it("does not surface a network failure from the automatic check", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));

    render(<TimerWindow />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "查看更新" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
