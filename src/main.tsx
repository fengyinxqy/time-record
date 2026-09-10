import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { parseThemeMode, resolveTheme } from "./themeModel";

document.documentElement.dataset.theme = resolveTheme(
  parseThemeMode(localStorage.getItem("time-record.theme")),
  matchMedia("(prefers-color-scheme: dark)").matches,
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
