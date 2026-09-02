export type Project = {
  id: number;
  name: string;
  color: string;
  sortOrder: number;
  archived: boolean;
  createdAt: number;
};

export type TimeSegment = {
  id: number;
  projectId: number;
  startedAt: number;
  endedAt: number | null;
  createdAt: number;
};

export type ProjectTimelineRow = {
  project: Project;
  segments: TimeSegment[];
};

export function groupSegmentsByProject(
  projects: Project[],
  segments: TimeSegment[],
): ProjectTimelineRow[] {
  return projects.map((project) => ({
    project,
    segments: segments.filter((segment) => segment.projectId === project.id),
  }));
}

export function clipSegmentToDay(
  segment: Pick<TimeSegment, "startedAt" | "endedAt">,
  dayStart: number,
  dayEnd: number,
  now = dayEnd,
): { startedAt: number; endedAt: number } | null {
  const startedAt = Math.max(segment.startedAt, dayStart);
  const endedAt = Math.min(segment.endedAt ?? now, dayEnd);
  if (startedAt >= endedAt) return null;
  return { startedAt, endedAt };
}
