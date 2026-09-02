export function segmentEndLabel(segment: { endedAt: number | null }): string {
  return segment.endedAt === null ? "计时中" : "已结束";
}
