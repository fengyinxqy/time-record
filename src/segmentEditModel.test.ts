import { describe, expect, it } from "vitest";
import {
  defaultSegmentDraft,
  isSegmentDraftValid,
  segmentEditErrorMessage,
  toDateTimeLocal,
} from "./segmentEditModel";

describe("toDateTimeLocal", () => {
  it("formats epoch seconds as a zero-padded local datetime", () => {
    const date = new Date(2026, 8, 2, 9, 5, 0);
    expect(toDateTimeLocal(date.getTime() / 1000)).toBe("2026-09-02T09:05");
  });

  it("keeps the local date when the time crosses midnight", () => {
    const date = new Date(2026, 8, 11, 23, 0, 0);
    expect(toDateTimeLocal(date.getTime() / 1000)).toBe("2026-09-11T23:00");
  });

  it("formats the unix epoch as a valid local datetime", () => {
    expect(toDateTimeLocal(0)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
});

describe("isSegmentDraftValid", () => {
  it("accepts a start strictly before the end", () => {
    expect(isSegmentDraftValid("2026-09-02T09:00", "2026-09-02T10:00")).toBe(true);
  });

  it("rejects equal or reversed bounds", () => {
    expect(isSegmentDraftValid("2026-09-02T10:00", "2026-09-02T10:00")).toBe(false);
    expect(isSegmentDraftValid("2026-09-02T11:00", "2026-09-02T10:00")).toBe(false);
  });

  it("rejects malformed values", () => {
    expect(isSegmentDraftValid("", "2026-09-02T10:00")).toBe(false);
    expect(isSegmentDraftValid("2026-09-02T09:00", "2026-09-02")).toBe(false);
  });

  it("accepts values that carry seconds", () => {
    expect(isSegmentDraftValid("2026-09-02T09:00:00", "2026-09-02T10:00:30")).toBe(true);
  });
});

describe("defaultSegmentDraft", () => {
  it("uses the morning hour for a past date", () => {
    const now = new Date(2026, 8, 11, 15, 0, 0).getTime() / 1000;
    expect(defaultSegmentDraft("2026-09-02", now)).toEqual({
      start: "2026-09-02T09:00",
      end: "2026-09-02T10:00",
    });
  });

  it("clamps to a one hour window ending now when today is early", () => {
    const now = new Date(2026, 8, 11, 8, 30, 0).getTime() / 1000;
    expect(defaultSegmentDraft("2026-09-11", now)).toEqual({
      start: "2026-09-11T07:30",
      end: "2026-09-11T08:30",
    });
  });

  it("keeps the morning hour later in the day", () => {
    const now = new Date(2026, 8, 11, 15, 0, 0).getTime() / 1000;
    expect(defaultSegmentDraft("2026-09-11", now)).toEqual({
      start: "2026-09-11T09:00",
      end: "2026-09-11T10:00",
    });
  });

  it("clamps the default window to the selected day when today is very early", () => {
    const now = new Date(2026, 8, 11, 0, 30, 0).getTime() / 1000;
    expect(defaultSegmentDraft("2026-09-11", now)).toEqual({
      start: "2026-09-11T00:00",
      end: "2026-09-11T00:30",
    });
  });

  it("keeps the morning hour exactly at 10:00", () => {
    const now = new Date(2026, 8, 11, 10, 0, 0).getTime() / 1000;
    expect(defaultSegmentDraft("2026-09-11", now)).toEqual({
      start: "2026-09-11T09:00",
      end: "2026-09-11T10:00",
    });
  });

  it("truncates seconds from now when clamping", () => {
    const now = new Date(2026, 8, 11, 8, 30, 45).getTime() / 1000;
    expect(defaultSegmentDraft("2026-09-11", now)).toEqual({
      start: "2026-09-11T07:30",
      end: "2026-09-11T08:30",
    });
  });

  it("returns the morning hour for a future date, leaving gating to the caller", () => {
    const now = new Date(2026, 8, 11, 15, 0, 0).getTime() / 1000;
    expect(defaultSegmentDraft("2026-09-12", now)).toEqual({
      start: "2026-09-12T09:00",
      end: "2026-09-12T10:00",
    });
  });
});

describe("segmentEditErrorMessage", () => {
  it("maps known error codes to Chinese", () => {
    expect(segmentEditErrorMessage("segment_datetime_invalid")).toBe("时间格式不正确");
    expect(segmentEditErrorMessage("segment_range_invalid")).toBe("开始时间必须早于结束时间");
    expect(segmentEditErrorMessage("segment_in_future")).toBe("不能补录尚未发生的时间");
    expect(segmentEditErrorMessage("project_not_found")).toBe("所选项目不存在");
    expect(segmentEditErrorMessage("segment_not_found")).toBe("这段记录已不存在，请刷新后重试");
    expect(segmentEditErrorMessage("segment_active")).toBe("请先暂停计时，再编辑这段记录");
    expect(segmentEditErrorMessage("segment_overlap")).toBe("该时段与已有记录重叠");
  });

  it("falls back to the raw string then a generic message", () => {
    expect(segmentEditErrorMessage("boom")).toBe("boom");
    expect(segmentEditErrorMessage(new Error("x"))).toBe("操作失败，请稍后重试");
  });

  it("does not fall through to Object.prototype members", () => {
    expect(segmentEditErrorMessage("toString")).toBe("toString");
    expect(segmentEditErrorMessage("constructor")).toBe("constructor");
  });
});
