// Runs whose task text equals an earlier run rejected for the agent's work: usually an old command
// pasted again. Shared by `jevcode run` (stops before launching) and the review screen (shows it).
// Nothing here is ever passed to the agent.
import fs from 'node:fs';
import path from 'node:path';

// Rejections for these causes are expected to be rerun with the same command.
export const RERUNNABLE_CAUSES = new Set(['quota_or_rate_limit', 'timeout_or_cancel', 'sandbox_denial', 'environment_or_tooling']);

export const normalizeTask = (text) => (text || '').replace(/\s+/g, ' ').trim();

// Full task text: prompt.txt when kept, else the (possibly truncated) task in the record.
export function taskText(root, run) {
  const file = path.join(root, 'runs', run.id, 'prompt.txt');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : run.task;
}

// `beforeId` limits the search to runs started earlier (ids sort by start time).
export function rejectedTwins({ root, runs, reviews, repo, task, beforeId = null }) {
  const want = normalizeTask(task);
  const twins = [];
  for (const r of runs) {
    if (r.repo !== repo || (beforeId && r.id >= beforeId)) continue;
    const review = reviews.get(r.id);
    if (review?.decision !== 'rejected' || RERUNNABLE_CAUSES.has(review.cause)) continue;
    if (normalizeTask(taskText(root, r)) === want) twins.push({ id: r.id, cause: review.cause, reason: review.reason || '' });
  }
  return twins;
}
