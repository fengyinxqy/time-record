export type Version = readonly [number, number, number];

export type ReleaseInfo = {
  version: string;
  title: string;
  notes: string;
  releaseUrl: string;
  publishedAt: string;
};

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

const latestReleaseUrl = "https://api.github.com/repos/fengyinxqy/time-record/releases/latest";

export async function getLatestRelease(fetcher: typeof fetch = fetch): Promise<ReleaseInfo> {
  const response = await fetcher(latestReleaseUrl, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error("Unable to check for updates");
  const payload: unknown = await response.json();
  if (typeof payload !== "object" || payload === null) throw new Error("Invalid update information");
  const value = payload as Record<string, unknown>;
  if (
    typeof value.tag_name !== "string" ||
    typeof value.html_url !== "string" ||
    typeof value.published_at !== "string" ||
    parseVersion(value.tag_name) === null ||
    !/^https:\/\/github\.com\/fengyinxqy\/time-record\/releases\//.test(value.html_url)
  ) throw new Error("Invalid update information");
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
