import { describe, expect, it } from "vitest";
import { initialStartupSettings, startupSettingsReducer } from "./settingsModel";

describe("startupSettingsReducer", () => {
  it("uses the backend snapshot after loading", () => {
    expect(startupSettingsReducer(initialStartupSettings, {
      type: "loaded",
      settings: { autostartEnabled: true, silentStart: false },
    })).toEqual({ autostartEnabled: true, silentStart: false, error: null });
  });

  it("keeps the previous settings when an update fails", () => {
    const loaded = { autostartEnabled: true, silentStart: true, error: null };
    expect(startupSettingsReducer(loaded, { type: "failed", message: "注册表访问失败" }))
      .toEqual({ ...loaded, error: "注册表访问失败" });
  });
});
