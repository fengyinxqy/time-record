import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getLatestRelease, isUpdateAvailable, type ReleaseInfo } from "./updateModel";

type UpdateStatus = "idle" | "checking" | "latest" | "error" | "available";

export function UpdateSection() {
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [release, setRelease] = useState<ReleaseInfo | null>(null);

  useEffect(() => {
    void getVersion().then(setCurrentVersion).catch(() => setCurrentVersion("未知"));
  }, []);

  const checkForUpdate = async () => {
    setStatus("checking");
    try {
      const version = currentVersion === null || currentVersion === "未知"
        ? await getVersion()
        : currentVersion;
      const latest = await getLatestRelease();
      setRelease(latest);
      setStatus(isUpdateAvailable(version, latest) ? "available" : "latest");
    } catch {
      setStatus("error");
    }
  };

  return (
    <section className="update-section" aria-label="软件更新">
      <div className="settings-copy">
        <strong>软件更新</strong>
        <span>当前版本：{currentVersion ?? "加载中…"}</span>
      </div>
      <div className="update-actions">
        <button
          className="update-button"
          type="button"
          disabled={status === "checking"}
          aria-busy={status === "checking"}
          onClick={() => void checkForUpdate()}
        >
          {status === "checking" ? "检查中…" : "检查更新"}
        </button>
      </div>
      {status === "latest" && <p className="update-status">已是最新版本</p>}
      {status === "error" && <p className="error-message" role="alert">检查更新失败，请稍后重试</p>}
      {status === "available" && release && (
        <div className="update-status">
          <p>发现新版本 v{release.version}</p>
          {release.notes && <p>{release.notes}</p>}
          <button className="update-button" type="button" onClick={() => void openUrl(release.releaseUrl)}>
            前往下载
          </button>
        </div>
      )}
    </section>
  );
}
