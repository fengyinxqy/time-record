export type ThemeMode = "auto" | "light" | "dark";

export function parseThemeMode(value: string | null): ThemeMode {
  return value === "light" || value === "dark" ? value : "auto";
}

export function resolveTheme(mode: ThemeMode, systemDark: boolean): "light" | "dark" {
  return mode === "auto" ? (systemDark ? "dark" : "light") : mode;
}
