// Working-tree snapshots and the automatic restore used when Codex stops on its usage limit.
// Kept apart from jevcode.mjs (which runs the CLI on import) so tests can drive them directly.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function git(repo, args, env = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tryGit(repo, args) {
  try { return git(repo, args); } catch { return ''; }
}

export function snapshotTree(repo, runDir) {
  const index = path.join(runDir, 'snapshot.index');
  fs.rmSync(index, { force: true });
  // Start from a copy of the real index: from an empty index every file counts as untracked, so a
  // tracked file that .gitignore now matches would silently drop out of the snapshot.
  const realIndex = path.resolve(repo, git(repo, ['rev-parse', '--git-path', 'index']));
  if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, index);
  git(repo, ['add', '-A'], { GIT_INDEX_FILE: index });
  const tree = git(repo, ['write-tree'], { GIT_INDEX_FILE: index });
  fs.rmSync(index, { force: true });
  return tree;
}

// Undo a run that stopped on a usage limit so the fallback run starts from the same tree. The lock
// is still held, so nothing else changed the files. Returns null when the tree could not be matched.
export function restoreToTree(repo, runDir, tree) {
  const now = snapshotTree(repo, runDir);
  const lines = tryGit(repo, ['-c', 'core.quotepath=false', 'diff', '--name-status', '--no-renames', tree, now]).split('\n').filter(Boolean);
  const restored = [];
  const removed = [];
  // The delta cannot tell the agent's edits from a person's edits made during the run, so every
  // file is copied aside before it is deleted or overwritten: nothing is lost, only moved.
  const backup = path.join(runDir, 'restore-backup');
  for (const line of lines) {
    const file = line.split('\t')[1];
    const src = path.join(repo, file);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(backup, file), { recursive: true });
  }
  if (lines.length) console.log(`  되돌리기 전 현재 파일을 보관했습니다: ${backup}`);
  for (const line of lines) {
    const [status, file] = line.split('\t');
    if (status === 'A') { fs.rmSync(path.join(repo, file), { force: true }); removed.push(file); continue; }
    git(repo, ['restore', `--source=${tree}`, '--worktree', '--', file], { GIT_LITERAL_PATHSPECS: '1' });
    restored.push(file);
  }
  // Same index-stat refresh as the UI revert: only for files whose content matches the index blob.
  for (const file of restored) {
    const staged = tryGit(repo, ['ls-files', '-s', '--', file]).split(/\s+/)[1];
    if (staged && staged === tryGit(repo, ['hash-object', '--', file])) tryGit(repo, ['update-index', '--', file]);
  }
  return snapshotTree(repo, runDir) === tree ? { restored, removed, ...(fs.existsSync(backup) ? { backup } : {}) } : null;
}
