import { describe, expect, it } from "vitest";
import { parseThemeMode, resolveTheme } from "./themeModel";

describe("theme preference", () => {
  it("defaults missing or invalid saved values to automatic", () => {
    expect(parseThemeMode(null)).toBe("auto");
    expect(parseThemeMode("broken")).toBe("auto");
  });
  it("follows system changes only in automatic mode", () => {
    expect(resolveTheme("auto", false)).toBe("light");
    expect(resolveTheme("auto", true)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
  it("restores explicit preferences", () => {
    expect(parseThemeMode("light")).toBe("light");
    expect(parseThemeMode("dark")).toBe("dark");
  });
});
