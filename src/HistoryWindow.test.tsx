import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { HistoryWindow } from "./App";

vi.mock("@tauri-apps/api/core", () => {
  // 时间段必须落在「今天」内，否则历史窗口按当天裁剪后不会渲染明细行。
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const dayStartSeconds = midnight.getTime() / 1000;
  return {
    invoke: vi.fn((command: string) => {
      if (command === "list_projects") {
        return Promise.resolve([
          { id: 1, name: "写代码", color: "#a69bd6", sortOrder: 0, archived: false, createdAt: 0 },
        ]);
      }
      if (command === "get_segments_for_date") {
        return Promise.resolve([
          {
            id: 1,
            projectId: 1,
            startedAt: dayStartSeconds + 3600,
            endedAt: dayStartSeconds + 7200,
            createdAt: dayStartSeconds,
          },
        ]);
      }
      return Promise.resolve(undefined);
    }),
  };
});

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("0.1.2"),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "history",
    onFocusChanged: vi.fn().mockResolvedValue(vi.fn()),
  }),
}));

describe("HistoryWindow segment editing", () => {
  it("creates a segment from the backfill dialog", async () => {
    render(
      <StrictMode>
        <HistoryWindow />
      </StrictMode>,
    );

    await screen.findByRole("button", { name: "编辑" });
    await userEvent.click(screen.getByRole("button", { name: "补录" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "create_segment",
        expect.objectContaining({ projectId: 1 }),
      );
    });
  });

  it("deletes a segment after confirmation", async () => {
    render(
      <StrictMode>
        <HistoryWindow />
      </StrictMode>,
    );

    await screen.findByRole("button", { name: "删除" });
    await userEvent.click(screen.getByRole("button", { name: "删除" }));
    await userEvent.click(await screen.findByRole("button", { name: "确认删除" }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("delete_segment", { segmentId: 1 });
    });
  });

  it("disables the backfill entry for a future date", async () => {
    render(
      <StrictMode>
        <HistoryWindow />
      </StrictMode>,
    );

    await screen.findByRole("button", { name: "编辑" });
    expect(screen.getByRole("button", { name: "补录" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "›" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "补录" })).toBeDisabled();
    });
  });
});
