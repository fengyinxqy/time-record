import { describe, expect, it } from "vitest";
import { segmentEndLabel } from "./historyModel";

describe("history segment labels", () => {
  it("labels an open segment as in progress", () => {
    expect(segmentEndLabel({ endedAt: null })).toBe("计时中");
  });

  it("labels a closed segment with its end time", () => {
    expect(segmentEndLabel({ endedAt: 1_757_000_000 })).toBe("已结束");
  });
});
