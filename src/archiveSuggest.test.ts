import { describe, expect, it } from "vitest";
import { archivedQuickSelects } from "./archiveSuggest";
import type { Project } from "./projectModel";

function archived(name: string, id = 0): Project {
  return { id, name, color: "#7c6cf2", sortOrder: 0, archived: true, createdAt: 0 };
}

describe("archivedQuickSelects", () => {
  it("returns an empty list when there are no archived projects", () => {
    expect(archivedQuickSelects([], "")).toEqual([]);
  });

  it("filters by a case-insensitive substring while typing", () => {
    const projects = [archived("写代码"), archived("写周报"), archived("GitHub 维护")];
    expect(archivedQuickSelects(projects, "写").map((p) => p.name)).toEqual(["写代码", "写周报"]);
    expect(archivedQuickSelects(projects, "gith").map((p) => p.name)).toEqual(["GitHub 维护"]);
  });

  it("shows every archived project when the query is empty", () => {
    const projects = [archived("写代码"), archived("阅读")];
    expect(archivedQuickSelects(projects, "").map((p) => p.name)).toEqual(["写代码", "阅读"]);
  });

  it("never emits duplicate names", () => {
    const projects = [archived("阅读"), archived("阅读", 1), archived("写代码")];
    expect(archivedQuickSelects(projects, "").map((p) => p.name)).toEqual(["阅读", "写代码"]);
  });

  it("skips names already used by an active project to avoid duplicating it", () => {
    const projects = [archived("写代码"), archived("阅读")];
    expect(archivedQuickSelects(projects, "写", ["写代码"]).map((p) => p.name)).toEqual([]);
  });

  it("skips an active project name regardless of letter casing", () => {
    const projects = [archived("GitHub 维护"), archived("阅读")];
    expect(archivedQuickSelects(projects, "git", ["github 维护"]).map((p) => p.name)).toEqual([]);
  });
});