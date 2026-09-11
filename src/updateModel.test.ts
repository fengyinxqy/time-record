import { describe, expect, it } from "vitest";
import { compareVersions, getLatestRelease, isUpdateAvailable, parseVersion } from "./updateModel";

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

describe("getLatestRelease", () => {
  it("returns normalized public fields from a valid latest release", async () => {
    const release = await getLatestRelease(async () =>
      new Response(JSON.stringify({
        tag_name: "v0.2.0",
        name: "0.2.0",
        body: "修复计时显示",
        html_url: "https://github.com/fengyinxqy/time-record/releases/tag/v0.2.0",
        published_at: "2026-09-11T00:00:00Z",
      }), { status: 200 }),
    );

    expect(release).toEqual({
      version: "0.2.0",
      title: "0.2.0",
      notes: "修复计时显示",
      releaseUrl: "https://github.com/fengyinxqy/time-record/releases/tag/v0.2.0",
      publishedAt: "2026-09-11T00:00:00Z",
    });
    expect(isUpdateAvailable("0.1.0", release)).toBe(true);
  });

  it("normalizes absent non-string name and body to empty text", async () => {
    const release = await getLatestRelease(async () =>
      new Response(JSON.stringify({
        tag_name: "1.0.0",
        name: null,
        body: 123,
        html_url: "https://github.com/fengyinxqy/time-record/releases/tag/1.0.0",
        published_at: "2026-09-11T00:00:00Z",
      })),
    );

    expect(release.title).toBe("");
    expect(release.notes).toBe("");
  });

  it("rejects non-success, incomplete and invalid-tag responses", async () => {
    await expect(getLatestRelease(async () => new Response("", { status: 403 }))).rejects.toThrow();
    await expect(getLatestRelease(async () => new Response("{}"))).rejects.toThrow();
    await expect(
      getLatestRelease(async () => new Response(JSON.stringify({ tag_name: "v1.0" }))),
    ).rejects.toThrow();
  });
});

describe("isUpdateAvailable", () => {
  it("returns false when release state is absent or not newer", () => {
    expect(isUpdateAvailable("1.0.0", null)).toBe(false);
    expect(isUpdateAvailable("1.0.0", {
      version: "1.0.0",
      title: "",
      notes: "",
      releaseUrl: "https://github.com/fengyinxqy/time-record/releases/tag/v1.0.0",
      publishedAt: "2026-09-11T00:00:00Z",
    })).toBe(false);
  });
});
