// A task file (`jevcode run --prompt-file f`) may end with a "리뷰 포인트" section: the reviewer's
// checklist for this run. It is split off here, kept in the run record and shown on the review
// screen. It is never sent to the agent, and the shadow state is built from the task alone, so the
// providers see the same kind of input as before.

const HEADING = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?리뷰 포인트(?:\*\*)?[ \t]*:?[ \t]*(.*)$/m;
const BULLET = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/;
const MAX_POINTS = 30;
const MAX_POINT_CHARS = 500;

export function splitTask(text) {
  const m = HEADING.exec(text);
  if (!m) return { task: text, reviewPoints: [] };
  const task = text.slice(0, m.index).replace(/\s+$/, '') + '\n';
  const lines = [m[1], ...text.slice(m.index + m[0].length).split(/\r?\n/)];
  const points = [];
  let continuing = false;
  for (const line of lines) {
    const bullet = BULLET.exec(line);
    if (bullet) { points.push(bullet[1].trim()); continuing = true; }
    else if (!line.trim()) continuing = false;
    // A wrapped bullet continues the previous point; any other paragraph is a point of its own.
    else if (continuing) points[points.length - 1] += ` ${line.trim()}`;
    else { points.push(line.trim()); continuing = true; }
  }
  return { task, reviewPoints: points.filter(Boolean).slice(0, MAX_POINTS).map((p) => p.slice(0, MAX_POINT_CHARS)) };
}
