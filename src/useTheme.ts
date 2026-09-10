import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { parseThemeMode, resolveTheme, type ThemeMode } from "./themeModel";

const STORAGE_KEY = "time-record.theme";

export function useTheme() {
  const [mode, setMode] = useState(() => parseThemeMode(localStorage.getItem(STORAGE_KEY)));
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  const [themeError, setThemeError] = useState<string | null>(null);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const onSystemChange = () => setSystemDark(media.matches);
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) {
        setMode(parseThemeMode(localStorage.getItem(STORAGE_KEY)));
      }
    };
    media.addEventListener("change", onSystemChange);
    window.addEventListener("storage", onStorage);
    return () => {
      media.removeEventListener("change", onSystemChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const resolved = resolveTheme(mode, systemDark);
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    let disposed = false;
    void invoke("set_window_theme", { dark: resolved === "dark" }).then(() => {
      if (!disposed) setThemeError(null);
    }).catch(() => {
      if (!disposed) setThemeError("标题栏主题更新失败，请重新打开应用");
    });
    return () => { disposed = true; };
  }, [resolved]);

  const updateTheme = (next: ThemeMode) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
      setMode(next);
      setThemeError(null);
    } catch {
      setThemeError("主题偏好保存失败，请重试");
    }
  };
  return { mode, updateTheme, themeError };
}
