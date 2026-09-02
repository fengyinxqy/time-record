export type ViewMode = "timer" | "history";

export function resolveViewMode(windowLabel: string, search: string): ViewMode {
  if (windowLabel === "history") return "history";
  if (windowLabel === "timer") return "timer";
  return new URLSearchParams(search).get("view") === "history" ? "history" : "timer";
}
