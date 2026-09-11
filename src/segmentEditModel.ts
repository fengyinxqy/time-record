const DEFAULT_DURATION_MINUTES = 60;
const DATETIME_LOCAL_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function toDateTimeLocal(epochSeconds: number): string {
  const date = new Date(epochSeconds * MILLISECONDS_PER_SECOND);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function isSegmentDraftValid(start: string, end: string): boolean {
  if (!DATETIME_LOCAL_PATTERN.test(start) || !DATETIME_LOCAL_PATTERN.test(end)) {
    return false;
  }
  return start < end;
}

export function defaultSegmentDraft(
  dateKey: string,
  nowSeconds: number,
): { start: string; end: string } {
  const preferred = { start: `${dateKey}T09:00`, end: `${dateKey}T10:00` };
  const nowLocal = toDateTimeLocal(nowSeconds);
  const todayKey = nowLocal.slice(0, 10);
  if (dateKey !== todayKey || preferred.end <= nowLocal) {
    return preferred;
  }
  const endMillis =
    Math.floor(nowSeconds / SECONDS_PER_MINUTE) *
    SECONDS_PER_MINUTE *
    MILLISECONDS_PER_SECOND;
  const startMillis =
    endMillis -
    DEFAULT_DURATION_MINUTES * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
  return {
    start: toDateTimeLocal(startMillis / MILLISECONDS_PER_SECOND),
    end: toDateTimeLocal(endMillis / MILLISECONDS_PER_SECOND),
  };
}

const ERROR_MESSAGES: Record<string, string> = {
  segment_datetime_invalid: "时间格式不正确",
  segment_range_invalid: "开始时间必须早于结束时间",
  segment_in_future: "不能补录尚未发生的时间",
  project_not_found: "所选项目不存在",
  segment_not_found: "这段记录已不存在，请刷新后重试",
  segment_active: "请先暂停计时，再编辑这段记录",
  segment_overlap: "该时段与已有记录重叠",
};

export function segmentEditErrorMessage(error: unknown): string {
  if (typeof error !== "string") return "操作失败，请稍后重试";
  return ERROR_MESSAGES[error] ?? error;
}
