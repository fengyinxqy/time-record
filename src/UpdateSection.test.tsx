import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { UpdateSection } from "./UpdateSection";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("0.1.0"),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

const validRelease = {
  tag_name: "v0.2.0",
  name: "0.2.0",
  body: "修复计时显示",
  html_url: "https://github.com/fengyinxqy/time-record/releases/tag/v0.2.0",
  published_at: "2026-09-11T00:00:00Z",
};

it("shows a newer release and opens its GitHub release page", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(validRelease))));
  const user = userEvent.setup();
  render(<UpdateSection />);

  await user.click(await screen.findByRole("button", { name: "检查更新" }));

  expect(await screen.findByText("发现新版本 v0.2.0")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "前往下载" }));
  expect(openUrl).toHaveBeenCalledWith(validRelease.html_url);
});

it("reports latest, disables while checking, and reports a manual network failure", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
    ...validRelease,
    tag_name: "v0.1.0",
  }))));
  const user = userEvent.setup();
  render(<UpdateSection />);

  await user.click(await screen.findByRole("button", { name: "检查更新" }));
  expect(await screen.findByText("已是最新版本")).toBeInTheDocument();

  let resolveFetch: ((response: Response) => void) | undefined;
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  })));
  await user.click(screen.getByRole("button", { name: "检查更新" }));
  expect(screen.getByRole("button", { name: "检查中…" })).toBeDisabled();
  resolveFetch?.(new Response(JSON.stringify(validRelease)));
  await screen.findByText("发现新版本 v0.2.0");

  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
  await user.click(screen.getByRole("button", { name: "检查更新" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("检查更新失败，请稍后重试");
});
