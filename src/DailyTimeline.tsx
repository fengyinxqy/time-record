import type { CSSProperties } from "react";
import { clipSegmentToDay, type ProjectTimelineRow } from "./projectModel";
import { formatDuration } from "./timer";

type DailyTimelineProps = {
  rows: ProjectTimelineRow[];
  dayStart: number;
  dayEnd: number;
  now: number;
};

const AXIS_HOURS = [0, 6, 12, 18, 24];

function formatClock(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function placement(startedAt: number, endedAt: number, dayStart: number, dayEnd: number): CSSProperties {
  const dayDuration = dayEnd - dayStart;
  const start = ((startedAt - dayStart) / dayDuration) * 100;
  const width = ((endedAt - startedAt) / dayDuration) * 100;

  return {
    "--segment-start": `${Math.max(0, Math.min(100, start))}%`,
    "--segment-width": `${Math.max(0.35, width)}%`,
  } as CSSProperties;
}

export function DailyTimeline({ rows, dayStart, dayEnd, now }: DailyTimelineProps) {
  return (
    <section className="timeline-card" aria-label="当天项目时间线">
      <div className="timeline-heading">
        <div>
          <h2>时间轴</h2>
          <span>当天记录按实际时间排列</span>
        </div>
        <span className="timeline-range">00:00 — 24:00</span>
      </div>

      <div className="timeline-axis" aria-hidden="true">
        <span className="timeline-axis-spacer" />
        <div className="timeline-axis-labels">
          {AXIS_HOURS.map((hour) => <span key={hour}>{String(hour).padStart(2, "0")}:00</span>)}
        </div>
      </div>

      <div className="timeline-rows">
        {rows.map((row) => {
          const segments = row.segments
            .map((segment) => ({ segment, clipped: clipSegmentToDay(segment, dayStart, dayEnd, now) }))
            .filter((item): item is { segment: typeof row.segments[number]; clipped: { startedAt: number; endedAt: number } } => item.clipped !== null);
          const total = segments.reduce((sum, item) => sum + item.clipped.endedAt - item.clipped.startedAt, 0);

          return (
            <div className="timeline-row" key={row.project.id}>
              <div className="timeline-project">
                <span className="timeline-project-dot" style={{ backgroundColor: row.project.color }} />
                <div>
                  <strong>{row.project.name}</strong>
                  <span>{formatDuration(total)}</span>
                </div>
              </div>
              <div className="timeline-track">
                {AXIS_HOURS.slice(1, -1).map((hour) => (
                  <span className="timeline-gridline" key={hour} style={{ left: `${(hour / 24) * 100}%` }} />
                ))}
                {segments.map(({ segment, clipped }) => {
                  const running = segment.endedAt === null;
                  const label = `${row.project.name}：${formatClock(clipped.startedAt)} – ${running ? "计时中" : formatClock(clipped.endedAt)}，${formatDuration(clipped.endedAt - clipped.startedAt)}`;
                  return (
                    <span
                      aria-label={label}
                      className={`timeline-segment ${running ? "is-running" : ""}`}
                      key={segment.id}
                      style={{ ...placement(clipped.startedAt, clipped.endedAt, dayStart, dayEnd), backgroundColor: row.project.color }}
                      title={label}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
