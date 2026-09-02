import { describe, expect, it } from "vitest";
import { elapsedSeconds, formatDuration, localDateKey } from "./timer";

describe("timer helpers", () => {
  it("formats elapsed seconds as HH:MM:SS", () => {
    expect(formatDuration(0)).toBe("00:00:00");
    expect(formatDuration(65)).toBe("00:01:05");
    expect(formatDuration(3661)).toBe("01:01:01");
  });

  it("calculates active and completed durations from timestamps", () => {
    expect(elapsedSeconds(1_000, 66_500)).toBe(65);
    expect(elapsedSeconds(1_000, 66_500, 31_000)).toBe(30);
  });

  it("uses the local calendar date", () => {
    expect(localDateKey(new Date(2026, 8, 2, 9, 30))).toBe("2026-09-02");
  });
});
