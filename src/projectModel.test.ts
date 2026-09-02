import { describe, expect, it } from "vitest";
import { clipSegmentToDay, groupSegmentsByProject, type Project, type TimeSegment } from "./projectModel";

const projects: Project[] = [
  { id: 1, name: "写代码", color: "#7c6cf2", sortOrder: 0, archived: false, createdAt: 1 },
  { id: 2, name: "上厕所", color: "#63c6a0", sortOrder: 1, archived: false, createdAt: 2 },
];

const segments: TimeSegment[] = [
  { id: 1, projectId: 1, startedAt: 100, endedAt: 150, createdAt: 100 },
  { id: 2, projectId: 1, startedAt: 200, endedAt: 240, createdAt: 200 },
  { id: 3, projectId: 2, startedAt: 160, endedAt: 170, createdAt: 160 },
];

describe("project timeline model", () => {
  it("groups multiple segments into one project row", () => {
    const rows = groupSegmentsByProject(projects, segments);

    expect(rows).toHaveLength(2);
    expect(rows[0].project.name).toBe("写代码");
    expect(rows[0].segments.map((segment) => segment.id)).toEqual([1, 2]);
    expect(rows[1].segments.map((segment) => segment.id)).toEqual([3]);
  });

  it("clips an active segment to now instead of midnight", () => {
    expect(clipSegmentToDay({ startedAt: 90, endedAt: null }, 100, 200, 130)).toEqual({
      startedAt: 100,
      endedAt: 130,
    });
  });
});
