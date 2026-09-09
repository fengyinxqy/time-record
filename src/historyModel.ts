export function segmentEndLabel(segment: { endedAt: number | null }): string {
  return segment.endedAt === null ? "计时中" : "已结束";
}

/** True when both date or datetime-local values are valid and start is not after end. */
export function isExportRangeValid(start: string, end: string): boolean {
  const date = "\\d{4}-\\d{2}-\\d{2}";
  const pattern = new RegExp(`^${date}(?:T\\d{2}:\\d{2})?$`);
  if (!pattern.test(start) || !pattern.test(end)) return false;
  if (start.includes("T") !== end.includes("T")) return false;
  return start <= end;
}