import { describe, expect, it } from "vitest";
import { isExportRangeValid, segmentEndLabel } from "./historyModel";

describe("history segment labels", () => {
  it("labels an open segment as in progress", () => {
    expect(segmentEndLabel({ endedAt: null })).toBe("计时中");
  });

  it("labels a closed segment with its end time", () => {
    expect(segmentEndLabel({ endedAt: 1_757_000_000 })).toBe("已结束");
  });
});

describe("export range validation", () => {
  it("accepts a same-day range", () => {
    expect(isExportRangeValid("2026-09-02", "2026-09-02")).toBe(true);
  });

  it("accepts a forward multi-day range", () => {
    expect(isExportRangeValid("2026-09-02", "2026-09-09")).toBe(true);
  });

  it("accepts datetime-local values", () => {
    expect(isExportRangeValid("2026-09-02T09:30", "2026-09-02T10:15")).toBe(true);
  });

  it("rejects a reversed range", () => {
    expect(isExportRangeValid("2026-09-09", "2026-09-02")).toBe(false);
  });

  it("rejects malformed date keys", () => {
    expect(isExportRangeValid("", "")).toBe(false);
    expect(isExportRangeValid("2026/09/02", "2026-09-09")).toBe(false);
    expect(isExportRangeValid("September", "2026-09-09")).toBe(false);
  });
});