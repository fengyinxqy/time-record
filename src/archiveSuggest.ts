import type { Project } from "./projectModel";

/**
 * Returns archived projects to show as quick-select options for the
 * new-work-item input, filtered by the current query and de-duplicated.
 *
 * - Every result is unique by name (archived entries with a duplicate name
 *   collapse to the first one encountered).
 * - Results whose name already belongs to a currently active project are
 *   skipped, so the popup never duplicates an existing project.
 */
export function archivedQuickSelects(
  archivedProjects: Project[],
  query: string,
  activeNames: Iterable<string> = [],
): Project[] {
  const normalized = query.trim().toLowerCase();
  const excluded = new Set(
    Array.from(activeNames, (name) => name.trim().toLowerCase()),
  );
  const seen = new Set<string>();
  const matches: Project[] = [];

  for (const project of archivedProjects) {
    const name = project.name.trim();
    const normalizedName = name.toLowerCase();
    if (name === "" || seen.has(normalizedName)) continue;
    if (excluded.has(normalizedName)) continue;
    if (normalized !== "" && !normalizedName.includes(normalized)) continue;
    seen.add(normalizedName);
    matches.push(project);
  }
  return matches;
}