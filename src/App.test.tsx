import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
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

describe("TimerWindow update checks", () => {
  it("shows an update notice without blocking the timer and opens settings", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      tag_name: "v0.2.0",
      name: "0.2.0",
      body: "修复计时显示",
      html_url: "https://github.com/fengyinxqy/time-record/releases/tag/v0.2.0",
      published_at: "2026-09-11T00:00:00Z",
    }))));

    render(<TimerWindow />);

    await screen.findByRole("button", { name: "查看更新" });
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看更新" })).toHaveTextContent("发现新版本 v0.2.0");

    await userEvent.click(screen.getByRole("button", { name: "查看更新" }));

    expect(invoke).toHaveBeenCalledWith("open_settings_window");
  });

  it("does not surface a network failure from the automatic check", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));

    render(<TimerWindow />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "查看更新" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
