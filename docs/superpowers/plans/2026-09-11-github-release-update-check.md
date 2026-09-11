# GitHub Releases 更新检查 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在应用启动时与设置窗口手动操作时检查 GitHub Releases，并在发现新版本时引导用户到浏览器下载 Windows 安装包。

**Architecture:** 前端直接请求公开的 GitHub Releases REST API；`updateModel.ts` 处理 API 响应、标签校验与语义化版本比较，React 组件只负责加载、显示和打开下载页。GitHub Actions 在 `v*` 标签推送后校验版本、验证项目、构建 Windows 安装包并发布 Release；应用不下载、安装或执行远程资产。

**Tech Stack:** React 19、TypeScript、Vitest、Testing Library、Tauri 2、`@tauri-apps/plugin-opener`、GitHub Actions、GitHub Releases。

**Spec:** `docs/superpowers/specs/2026-09-11-github-release-update-check-design.md`

## Global Constraints

- 仅支持 Windows，发布渠道固定为 `fengyinxqy/time-record` 的 GitHub Releases。
- 使用 `GET https://api.github.com/repos/fengyinxqy/time-record/releases/latest`；不发送令牌或用户数据。
- 严格将三个数字版本逐段比较，支持单一的 `v` 标签前缀；仅严格更高版本可更新。
- 草稿与预发布版本不显示；不接入 Tauri Updater、签名更新清单、下载、安装、重启或更新渠道偏好。
- 自动检查完全静默且不阻塞计时；手动检查显示成功或可读错误。
- GitHub Release 说明只能当作纯文本显示，下载按钮必须调用系统浏览器打开 `html_url`。
- 发布版本必须让 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 与 `vX.Y.Z` 标签一致。

---

## File Structure

- Create: `src/updateModel.ts` — GitHub Release DTO 验证、标签解析、版本比较和可注入的查询函数。
- Create: `src/updateModel.test.ts` — 无 DOM 的版本与 API 查询单元测试。
- Create: `src/UpdateSection.tsx` — 设置窗口的软件更新区域、手动查询状态和浏览器跳转。
- Create: `src/UpdateSection.test.tsx` — 软件更新区域的 DOM 交互测试。
- Modify: `src/App.tsx` — 设置窗口嵌入更新区域；计时窗口在启动后发起静默查询并显示非阻塞提示。
- Modify: `src/App.css` — 更新区、状态文本和计时窗口更新提示的样式。
- Modify: `package.json` and `package-lock.json` — 加入仅用于组件测试的 Testing Library 与 jsdom 开发依赖。
- Modify: `vite.config.ts` — 为 Vitest 设置 jsdom 环境和测试 setup 文件。
- Create: `src/testSetup.ts` — 清理每个 DOM 测试后的挂载节点。
- Create: `.github/workflows/release.yml` — 标签校验、测试、Windows 打包与 GitHub Release 发布。
- Modify: `README.md` — 增加版本发布者如何更新三个版本文件、创建 `vX.Y.Z` 标签和准备 Release 说明的说明。

### Task 1: 更新检查领域模型

**Files:**
- Create: `src/updateModel.ts`
- Create: `src/updateModel.test.ts`

**Interfaces:**
- Produces: `ReleaseInfo`, `parseVersion(value)`, `compareVersions(left, right)`, `getLatestRelease(fetcher?)`, `isUpdateAvailable(currentVersion, release)`.
- Consumes: 运行时标准 `fetch`；调用者用 `getLatestRelease()` 取得 `ReleaseInfo`，用 `isUpdateAvailable()` 判断是否显示更新。

- [ ] **Step 1: 写入版本解析与比较的失败测试**

```ts
import { describe, expect, it } from "vitest";
import { compareVersions, parseVersion } from "./updateModel";

describe("parseVersion", () => {
  it("accepts an optional v prefix and exactly three numeric parts", () => {
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
  });

  it("rejects prerelease, missing and malformed tags", () => {
    expect(parseVersion("v1.2.3-beta.1")).toBeNull();
    expect(parseVersion("1.2")).toBeNull();
    expect(parseVersion("release-1.2.3")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("compares each numeric segment", () => {
    expect(compareVersions([1, 10, 0], [1, 2, 99])).toBeGreaterThan(0);
    expect(compareVersions([1, 2, 3], [1, 2, 3])).toBe(0);
    expect(compareVersions([0, 9, 9], [1, 0, 0])).toBeLessThan(0);
  });
});
```

- [ ] **Step 2: 运行测试，确认模型尚未存在**

Run: `npm test -- src/updateModel.test.ts`  
Expected: FAIL，报告找不到 `./updateModel`。

- [ ] **Step 3: 实现最小、严格的版本函数**

```ts
export type Version = readonly [number, number, number];

export function parseVersion(value: string): Version | null {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(left: Version, right: Version): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference;
  }
  return 0;
}
```

- [ ] **Step 4: 扩展失败测试，覆盖 GitHub 响应验证和 HTTP 错误**

```ts
import { getLatestRelease, isUpdateAvailable } from "./updateModel";

it("returns the normalized public fields from a valid latest release", async () => {
  const release = await getLatestRelease(async () => new Response(JSON.stringify({
    tag_name: "v0.2.0",
    name: "0.2.0",
    body: "修复计时显示",
    html_url: "https://github.com/fengyinxqy/time-record/releases/tag/v0.2.0",
    published_at: "2026-09-11T00:00:00Z",
  }), { status: 200 }));

  expect(release?.version).toBe("0.2.0");
  expect(isUpdateAvailable("0.1.0", release)).toBe(true);
});

it("rejects non-success, incomplete and invalid-tag responses", async () => {
  await expect(getLatestRelease(async () => new Response("", { status: 403 }))).rejects.toThrow();
  await expect(getLatestRelease(async () => new Response("{}"))).rejects.toThrow();
  await expect(getLatestRelease(async () => new Response(JSON.stringify({ tag_name: "v1.0" })))).rejects.toThrow();
});
```

- [ ] **Step 5: 实现查询函数与更新判断**

```ts
export type ReleaseInfo = {
  version: string;
  title: string;
  notes: string;
  releaseUrl: string;
  publishedAt: string;
};

const latestReleaseUrl = "https://api.github.com/repos/fengyinxqy/time-record/releases/latest";

export async function getLatestRelease(fetcher: typeof fetch = fetch): Promise<ReleaseInfo> {
  const response = await fetcher(latestReleaseUrl, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error("无法检查更新，请稍后重试");
  const payload: unknown = await response.json();
  if (typeof payload !== "object" || payload === null) throw new Error("更新信息格式无效");
  const value = payload as Record<string, unknown>;
  if (
    typeof value.tag_name !== "string" ||
    typeof value.html_url !== "string" ||
    typeof value.published_at !== "string" ||
    parseVersion(value.tag_name) === null ||
    !/^https:\/\/github\.com\/fengyinxqy\/time-record\/releases\//.test(value.html_url)
  ) throw new Error("更新信息格式无效");
  return {
    version: value.tag_name.replace(/^v/, ""),
    title: typeof value.name === "string" ? value.name : "",
    notes: typeof value.body === "string" ? value.body : "",
    releaseUrl: value.html_url,
    publishedAt: value.published_at,
  };
}

export function isUpdateAvailable(currentVersion: string, release: ReleaseInfo | null): boolean {
  const current = parseVersion(currentVersion);
  const latest = release && parseVersion(release.version);
  return current !== null && latest !== null && compareVersions(latest, current) > 0;
}
```

- [ ] **Step 6: 运行领域测试和完整前端测试**

Run: `npm test -- src/updateModel.test.ts`  
Expected: PASS。

Run: `npm test`  
Expected: PASS，现有业务模型测试不回归。

- [ ] **Step 7: 提交领域模型**

```bash
git add src/updateModel.ts src/updateModel.test.ts
git commit -m "feat: add GitHub release update model"
```

### Task 2: 可测试的软件更新设置区域

**Files:**
- Create: `src/UpdateSection.tsx`
- Create: `src/UpdateSection.test.tsx`
- Create: `src/testSetup.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `vite.config.ts`

**Interfaces:**
- Consumes: `getVersion` from `@tauri-apps/api/app`, `getLatestRelease` and `isUpdateAvailable` from `updateModel.ts`, `openUrl` from `@tauri-apps/plugin-opener`.
- Produces: `UpdateSection` React component, rendered in `SettingsWindow` without props.

- [ ] **Step 1: 安装 DOM 测试依赖并启用 jsdom**

Run: `npm install --save-dev @testing-library/jest-dom @testing-library/react @testing-library/user-event jsdom`  
Expected: `package.json` 与 `package-lock.json` 只新增开发依赖。

在 `vite.config.ts` 的 `defineConfig` 返回值加入：

```ts
test: {
  environment: "jsdom",
  setupFiles: ["./src/testSetup.ts"],
},
```

并建立：

```ts
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
```

- [ ] **Step 2: 编写组件的失败测试，并 mock Tauri 与网络边界**

```tsx
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn().mockResolvedValue("0.1.0") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

const validRelease = {
  tag_name: "v0.2.0",
  name: "0.2.0",
  body: "修复计时显示",
  html_url: "https://github.com/fengyinxqy/time-record/releases/tag/v0.2.0",
  published_at: "2026-09-11T00:00:00Z",
};

it("shows a newer release and opens its GitHub release page", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(validRelease))));
  render(<UpdateSection />);
  await userEvent.click(await screen.findByRole("button", { name: "检查更新" }));
  expect(await screen.findByText("发现新版本 v0.2.0")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "前往下载" }));
  expect(openUrl).toHaveBeenCalledWith(validRelease.html_url);
});

it("reports latest, disables while checking, and reports a manual network failure", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
    ...validRelease, tag_name: "v0.1.0",
  }))));
  render(<UpdateSection />);
  await userEvent.click(await screen.findByRole("button", { name: "检查更新" }));
  expect(await screen.findByText("已是最新版本")).toBeInTheDocument();

  let resolveFetch: ((response: Response) => void) | undefined;
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  })));
  await userEvent.click(screen.getByRole("button", { name: "检查更新" }));
  expect(screen.getByRole("button", { name: "检查中…" })).toBeDisabled();
  resolveFetch?.(new Response(JSON.stringify(validRelease)));
  await screen.findByText("发现新版本 v0.2.0");

  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
  await userEvent.click(screen.getByRole("button", { name: "检查更新" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("检查更新失败，请稍后重试");
});
```

- [ ] **Step 3: 运行组件测试，确认实现尚未存在**

Run: `npm test -- src/UpdateSection.test.tsx`  
Expected: FAIL，报告无法解析 `./UpdateSection`。

- [ ] **Step 4: 实现软件更新区域**

```tsx
import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getLatestRelease, isUpdateAvailable, type ReleaseInfo } from "./updateModel";

export function UpdateSection() {
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "checking" | "latest" | "error" | "available">("idle");
  const [release, setRelease] = useState<ReleaseInfo | null>(null);

  useEffect(() => { void getVersion().then(setCurrentVersion).catch(() => setCurrentVersion("未知")); }, []);

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
        >{status === "checking" ? "检查中…" : "检查更新"}</button>
      </div>
      {status === "latest" && <p className="update-status">已是最新版本</p>}
      {status === "error" && <p className="error-message" role="alert">检查更新失败，请稍后重试</p>}
      {status === "available" && release && <div className="update-status">
        <p>发现新版本 v{release.version}</p>
        {release.notes && <p>{release.notes}</p>}
        <button className="update-button" type="button" onClick={() => void openUrl(release.releaseUrl)}>
          前往下载
        </button>
      </div>}
    </section>
  );
}
```

错误状态文字固定为“检查更新失败，请稍后重试”；加载版本失败时展示“当前版本：未知”，但仍允许用户手动检查。给错误元素加 `role="alert"`，为检查按钮加 `aria-busy={status === "checking"}`，检查中显示“检查中…”。

- [ ] **Step 5: 运行组件测试与构建检查**

Run: `npm test -- src/UpdateSection.test.tsx`  
Expected: PASS。

Run: `npm run build`  
Expected: PASS，TypeScript 未出现未使用变量或 mock 类型错误。

- [ ] **Step 6: 提交可测试的设置组件**

```bash
git add package.json package-lock.json vite.config.ts src/testSetup.ts src/UpdateSection.tsx src/UpdateSection.test.tsx
git commit -m "feat: add manual update check section"
```

### Task 3: 将更新检查接入多窗口界面

**Files:**
- Modify: `src/App.tsx:1-30,79-140,459-580`
- Modify: `src/App.css:52-99,173-181`
- Test: `src/UpdateSection.test.tsx`
- Test: `src/updateModel.test.ts`

**Interfaces:**
- Consumes: `UpdateSection`、`getVersion`、`getLatestRelease`、`isUpdateAvailable` 和现有 `open_settings_window` command。
- Produces: TimerWindow 的自动检查与 `UpdateNotice` 状态；SettingsWindow 中的软件更新区域。

- [ ] **Step 1: 写入计时窗口静默检查的失败组件测试**

将 `TimerWindow` 导出为命名组件以便测试，并在一个新的 `src/App.test.tsx` 中 mock `@tauri-apps/api/core`、`@tauri-apps/api/window`、`@tauri-apps/api/app` 与 `fetch`。测试应等待启动 effect 完成后断言：

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { TimerWindow } from "./App";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((command: string) => {
    if (command === "list_projects" || command === "get_segments_for_date") return Promise.resolve([]);
    if (command === "get_timer_state") return Promise.resolve({
      activeProject: null, activeSegment: null, elapsedSeconds: 0,
    });
    return Promise.resolve(undefined);
  }),
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn().mockResolvedValue("0.1.0") }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "timer", onFocusChanged: vi.fn().mockResolvedValue(vi.fn()) }),
}));

describe("TimerWindow update checks", () => {
it("shows an update notice without blocking the timer and opens settings", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
    tag_name: "v0.2.0", name: "0.2.0", body: "修复计时显示",
    html_url: "https://github.com/fengyinxqy/time-record/releases/tag/v0.2.0",
    published_at: "2026-09-11T00:00:00Z",
  }))));
  render(<TimerWindow />);
  await screen.findByRole("button", { name: "查看更新" });
  expect(screen.getByRole("main")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "查看更新" })).toHaveTextContent("发现新版本 v0.2.0");
  await userEvent.click(screen.getByRole("button", { name: "查看更新" }));
  expect(invoke).toHaveBeenCalledWith("open_settings_window");
});

it("does not surface a network failure from the automatic check", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
  render(<TimerWindow />);
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: "查看更新" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});
});
```

- [ ] **Step 2: 运行计时窗口测试，确认自动检查尚未接入**

Run: `npm test -- src/App.test.tsx`  
Expected: FAIL，尚未导出 `TimerWindow` 或不存在更新提示。

- [ ] **Step 3: 在 TimerWindow 中实现非阻塞的自动检查**

在 `App.tsx` 顶部导入：

```ts
import { getVersion } from "@tauri-apps/api/app";
import { getLatestRelease, isUpdateAvailable, type ReleaseInfo } from "./updateModel";
import { UpdateSection } from "./UpdateSection";
```

在 `TimerWindow` 中加入 `updateRelease` state，并加入只运行一次的 effect：

```ts
useEffect(() => {
  let active = true;
  void Promise.all([getVersion(), getLatestRelease()])
    .then(([version, release]) => {
      if (active && isUpdateAvailable(version, release)) setUpdateRelease(release);
    })
    .catch(() => undefined);
  return () => { active = false; };
}, []);
```

将提示放在计时窗口标题下方：

```tsx
{updateRelease && (
  <button className="update-notice" onClick={() => void showSettings()}>
    发现新版本 v{updateRelease.version}，查看更新
  </button>
)}
```

这里不可等待网络请求、显示失败消息或修改计时 state。`SettingsWindow` 的现有 `<section className="settings-list">` 末尾加入 `<UpdateSection />`，使手动检查只在设置窗口中发生。

- [ ] **Step 4: 添加适配现有主题的样式**

在 `App.css` 增加：

```css
.update-section { padding: 16px; background: var(--surface); }
.update-section + .settings-row { border-top: 1px solid var(--border); }
.update-status { margin: 8px 0 0; color: var(--muted); font-size: 11px; line-height: 1.45; white-space: pre-wrap; }
.update-actions { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.update-button, .update-notice { border: 1px solid var(--border-strong); border-radius: 9px; background: var(--surface-raised); color: var(--text); padding: 7px 9px; font-size: 12px; }
.update-button:disabled { cursor: wait; opacity: .7; }
.update-notice { width: 100%; margin: 12px 0 0; text-align: left; }
```

确保 `UpdateSection` 的外层使用 `className="update-section"`，并将发布说明用 `className="update-status"` 的纯文本元素呈现；不使用 `dangerouslySetInnerHTML`。

- [ ] **Step 5: 运行相关测试和前端全量验证**

Run: `npm test -- src/updateModel.test.ts src/UpdateSection.test.tsx src/App.test.tsx`  
Expected: PASS。

Run: `npm test`  
Expected: PASS。

Run: `npm run build`  
Expected: PASS。

- [ ] **Step 6: 提交界面接入**

```bash
git add src/App.tsx src/App.css src/App.test.tsx
git commit -m "feat: notify users about GitHub releases"
```

### Task 4: 标签驱动的 Windows Release 工作流与发布说明

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: GitHub `contents: write` 权限、`GITHUB_TOKEN`、`vX.Y.Z` 标签、项目的三个版本文件与 `npm run tauri -- build`。
- Produces: 同名 GitHub Release，附带 Tauri 生成的 `.msi` 和 `.exe`/NSIS 安装包资产。

- [ ] **Step 1: 写入发布前版本一致性检查命令并在本机验证其失败条件**

在工作流中先提取标签版本并以 Node 读取 JSON 版本，以 PowerShell 读取 Cargo 版本。核心检查必须等价于：

```powershell
$tag = "${{ github.ref_name }}".Substring(1)
$packageVersion = node -p "require('./package.json').version"
$tauriVersion = node -p "require('./src-tauri/tauri.conf.json').version"
$cargoVersion = (Select-String -Path src-tauri/Cargo.toml -Pattern '^version = "([^"]+)"').Matches[0].Groups[1].Value
if ($tag -ne $packageVersion -or $tag -ne $tauriVersion -or $tag -ne $cargoVersion) {
  throw "Tag v$tag must match package.json, tauri.conf.json, and Cargo.toml versions."
}
```

不要为这项验证修改任何版本文件。复制相同的比较逻辑到 PowerShell，并将 `$tag` 固定为 `999.999.999`：

```powershell
$tag = "999.999.999"
$packageVersion = node -p "require('./package.json').version"
if ($tag -ne $packageVersion) { throw "Tag v$tag must match package.json, tauri.conf.json, and Cargo.toml versions." }
```

Run: `pwsh -NoProfile -Command "& { $tag = '999.999.999'; $packageVersion = node -p \"require('./package.json').version\"; if ($tag -ne $packageVersion) { throw \"Tag v$tag must match package.json, tauri.conf.json, and Cargo.toml versions.\" } }"`  
Expected: FAIL，输出版本一致性错误。

- [ ] **Step 2: 建立发布工作流**

```yaml
name: Release Windows application

on:
  push:
    tags: ["v*"]

permissions:
  contents: write

jobs:
  release:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - uses: dtolnay/rust-toolchain@stable
      - run: npm ci
      - name: Verify tag matches application versions
        shell: pwsh
        run: |
          $tag = "${{ github.ref_name }}".Substring(1)
          $packageVersion = node -p "require('./package.json').version"
          $tauriVersion = node -p "require('./src-tauri/tauri.conf.json').version"
          $cargoVersion = (Select-String -Path src-tauri/Cargo.toml -Pattern '^version = "([^"]+)"').Matches[0].Groups[1].Value
          if ($tag -ne $packageVersion -or $tag -ne $tauriVersion -or $tag -ne $cargoVersion) {
            throw "Tag v$tag must match package.json, tauri.conf.json, and Cargo.toml versions."
          }
      - run: npm test
      - run: cargo test --manifest-path src-tauri/Cargo.toml
      - run: npm run build
      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          tagName: ${{ github.ref_name }}
          releaseName: 时间记录 ${{ github.ref_name }}
          releaseBody: 请在此查看本版本的更新内容。
          releaseDraft: true
          prerelease: false
```

确保 `tauri-action` 负责 `tauri build` 与 Release 资产上传，且不要设置 `TAURI_SIGNING_PRIVATE_KEY` 或 updater JSON。

- [ ] **Step 3: 在 README 写明安全的发布流程**

增加“发布新版本”小节，包含：修改并提交三个版本文件为相同 `X.Y.Z`；确保本地运行 `npm test`、`cargo test --manifest-path src-tauri/Cargo.toml`、`npm run build`；推送 `vX.Y.Z` 标签；等待 Actions 创建 draft Release；编辑真实更新说明、确认 MSI/NSIS 资产后手动发布 draft。明确写出预发布应在 GitHub UI 创建并标记 prerelease，客户端不会显示它。

- [ ] **Step 4: 静态验证工作流与文档**

Run: `git diff --check`  
Expected: PASS。

Run: `npm test`  
Expected: PASS。

Run: `cargo test --manifest-path src-tauri/Cargo.toml`  
Expected: PASS。

Run: `npm run build`  
Expected: PASS。

检查 `.github/workflows/release.yml`：它只由 `v*` 标签触发、包含版本一致性检查、测试、Windows 打包和 `GITHUB_TOKEN`，并生成 draft 而非直接公开 Release。

- [ ] **Step 5: 提交发布自动化**

```bash
git add .github/workflows/release.yml README.md
git commit -m "ci: publish Windows releases from tags"
```

### Task 5: 端到端发布验收

**Files:**
- Modify: `README.md`（只在发现实际发布步骤与文档不一致时修正）

**Interfaces:**
- Consumes: 已合并的更新检查代码与 GitHub Actions 工作流。
- Produces: 对 Windows 打包、GitHub Release 和已安装旧版本检查行为的验收记录。

- [ ] **Step 1: 本地运行最终回归集**

Run: `npm test`  
Expected: PASS。

Run: `cargo test --manifest-path src-tauri/Cargo.toml`  
Expected: PASS。

Run: `cargo fmt --check --manifest-path src-tauri/Cargo.toml`  
Expected: PASS。

Run: `npm run build`  
Expected: PASS。

- [ ] **Step 2: 在 GitHub Actions 中验证一个测试标签的 draft Release**

按 README 的流程发布一个高于已安装版本的正式测试标签，等待工作流结束，并确认 draft Release 附带 Windows 安装包。不要在终端中存储或输出 GitHub 访问令牌。

- [ ] **Step 3: 在 Windows 上验证用户流程**

安装低于测试 Release 的应用版本，启动后确认计时窗口立刻可操作、出现不阻塞的“发现新版本”提示，并可打开设置。设置窗口中点击“检查更新”，确认版本与纯文本说明正确，点击“前往下载”会在系统浏览器打开 Release 页面。断网后重新启动确认没有报错；再手动检查确认有可读错误。

- [ ] **Step 4: 记录或修正验收差异后提交**

若 README 需要修正：

```bash
git add README.md
git commit -m "docs: clarify release verification"
```

若不需文档修正，不创建空提交；在 PR 描述中记录通过的命令与 Windows 手动验证结果。
