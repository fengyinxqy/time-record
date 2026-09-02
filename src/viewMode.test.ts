import { describe, expect, it } from "vitest";
import { resolveViewMode } from "./viewMode";

describe("view mode resolution", () => {
  it("uses the history window label for the history page", () => {
    expect(resolveViewMode("history", "")).toBe("history");
  });

  it("uses the timer window label for the main page", () => {
    expect(resolveViewMode("timer", "?view=history")).toBe("timer");
  });

  it("falls back to the query only outside Tauri windows", () => {
    expect(resolveViewMode("", "?view=history")).toBe("history");
    expect(resolveViewMode("", "")).toBe("timer");
  });
});
