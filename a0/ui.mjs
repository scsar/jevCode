// `jevcode ui`: local review screen for A0 (design v0.5, section 12.A0).
//
// Serves ui.html on 127.0.0.1 with a per-launch token, reads the same JSONL files as the CLI and
// appends reviews / bypasses in the same format, plus two measurement fields the CLI cannot
// capture well: `explainable` (could the cause be understood from this screen alone) and
// `viewedMs` (time from opening a run to submitting its review).

import { exec, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAUSES, QUESTIONS, evaluate } from './decisions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(process.env.JEVCODE_HOME || path.join(process.env.LOCALAPPDATA, 'JevCode'), 'a0');
const FILES = {
  runs: path.join(ROOT, 'runs.jsonl'),
  reviews: path.join(ROOT, 'reviews.jsonl'),
  bypasses: path.join(ROOT, 'bypasses.jsonl'),
  decisions: path.join(ROOT, 'decisions.jsonl'),
  commits: path.join(ROOT, 'commits.jsonl'),
  reverts: path.join(ROOT, 'reverts.jsonl'),
};
const FAILED = new Set(['failed', 'timed_out', 'unknown']);

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function append(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

function latestReviews() {
  return new Map(readJsonl(FILES.reviews).map((r) => [r.id, r]));
}

function latestDecisions() {
  const byRun = new Map();
  for (const d of readJsonl(FILES.decisions)) {
    if (!byRun.has(d.runId)) byRun.set(d.runId, {});
    byRun.get(d.runId)[d.provider] = d;
  }
  return byRun;
}

// Verification output is split into .out/.err files; failures usually land on stderr.
function readTail(outFile, lines) {
  const text = [outFile, outFile.replace('.out.', '.err.')]
    .filter((f) => fs.existsSync(f))
    .map((f) => fs.readFileSync(f, 'utf8').trimEnd())
    .filter(Boolean)
    .join('\n');
  return text ? text.split(/\r?\n/).slice(-lines).join('\n') : null;
}

// ---------------------------------------------------------------- accept-and-commit
//
// A commit happens only when the user presses the button after reviewing, and only for the files
// this run changed, and only if each file still has exactly the content the run left (so what gets
// committed is what was reviewed). Files that already had uncommitted edits before the run are
// refused, because committing them would sweep those unrelated edits in. Nothing is ever pushed.

function git(repo, args, input) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' },
  }).trim();
}

function tryGit(repo, args) {
  try { return git(repo, args); } catch { return null; }
}

// Blob id of `file` in `treeish`, or null when absent.
function blobIn(repo, treeish, file) {
  const out = tryGit(repo, ['ls-tree', '-r', treeish, '--', file]);
  const m = out && out.match(/^\d+ blob ([0-9a-f]+)\t/);
  return m ? m[1] : null;
}

// Blob id the working-tree file would get if added now (same clean filters as the snapshot).
function worktreeBlob(repo, file) {
  return fs.existsSync(path.join(repo, file)) ? tryGit(repo, ['hash-object', '--', file]) : null;
}

function commitRecord(runId) {
  return readJsonl(FILES.commits).find((c) => c.runId === runId) || null;
}

function revertRecord(runId) {
  return readJsonl(FILES.reverts).find((r) => r.runId === runId) || null;
}

const isTracked = (repo, file) => tryGit(repo, ['ls-files', '--error-unmatch', '--', file]) !== null;
const isIgnored = (repo, file) => tryGit(repo, ['check-ignore', '-q', '--', file]) !== null;

// Unity writes a .meta next to every new file and folder after the run. They belong with the run's
// files: for each added file, its own .meta and the .meta of every newly created parent folder,
// when present on disk and not yet tracked.
function unityMetas(repo, addedFiles) {
  const metas = new Set();
  const consider = (p) => {
    const meta = `${p}.meta`;
    if (fs.existsSync(path.join(repo, meta)) && !isTracked(repo, meta) && !isIgnored(repo, meta)) metas.add(meta);
  };
  for (const file of addedFiles) {
    consider(file);
    for (let dir = path.posix.dirname(file); dir && dir !== '.'; dir = path.posix.dirname(dir)) {
      if (tryGit(repo, ['ls-tree', '-d', 'HEAD', '--', dir])) break; // folder already existed in HEAD
      consider(dir);
    }
  }
  return [...metas];
}

function suggestedMessage(run) {
  const m = (run.lastMessage || '').match(/^[\s>*`-]*Commit:\s*`?([^`\r\n]+?)`?\s*$/im);
  if (m) return m[1].trim();
  const type = run.tag === 'fix' ? 'fix' : run.tag === 'refactor' ? 'refactor' : 'feat';
  return `${type}: ${run.task.split('\n')[0].slice(0, 60)}`;
}

export function commitCheck(run) {
  const result = { ok: false, files: [], problems: [], committed: commitRecord(run.id), suggestedMessage: suggestedMessage(run) };
  if (result.committed) return { ...result, problems: ['이미 커밋한 실행입니다.'] };
  if (!fs.existsSync(run.repo)) return { ...result, problems: ['저장소 경로가 없습니다.'] };
  if (run.startTree === run.endTree) return { ...result, problems: ['이 실행에는 변경이 없습니다.'] };
  for (const tree of [run.startTree, run.endTree]) {
    if (tryGit(run.repo, ['cat-file', '-e', tree]) === null) return { ...result, problems: ['스냅샷이 Git에서 정리되어 확인할 수 없습니다.'] };
  }
  const gitDir = git(run.repo, ['rev-parse', '--absolute-git-dir']);
  for (const marker of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'rebase-merge', 'rebase-apply']) {
    if (fs.existsSync(path.join(gitDir, marker))) result.problems.push(`진행 중인 Git 작업이 있습니다 (${marker}).`);
  }
  const paths = git(run.repo, ['diff', '--name-only', '--no-renames', run.startTree, run.endTree]).split('\n').filter(Boolean);
  for (const file of paths) {
    const want = blobIn(run.repo, run.endTree, file);
    const start = blobIn(run.repo, run.startTree, file);
    const head = blobIn(run.repo, 'HEAD', file);
    const issue = worktreeBlob(run.repo, file) !== want ? '리뷰 이후 파일이 바뀌었습니다'
      : head === want ? '이미 커밋된 상태입니다'
        : start !== head ? 'run 전부터 커밋 안 된 변경이 있던 파일입니다'
          : null;
    result.files.push({ path: file, status: want === null ? 'D' : start === null ? 'A' : 'M', issue });
  }
  const blocked = result.files.filter((f) => f.issue);
  if (blocked.length) result.problems.push(`${blocked.length}개 파일을 커밋할 수 없습니다. 터미널에서 직접 정리하세요.`);
  if (blocked.some((f) => f.issue.startsWith('run 전부터'))) {
    const earlier = pendingOwners(run, blocked.map((f) => f.path));
    if (earlier.length) result.problems.push(`원인: 이전 run ${earlier.join(', ')}의 변경이 커밋되거나 되돌려지지 않은 채 남아 있습니다. 그 run을 먼저 처리하세요.`);
  }
  result.metas = unityMetas(run.repo, result.files.filter((f) => f.status === 'A').map((f) => f.path));
  result.ok = result.problems.length === 0;
  return result;
}

// Earlier runs in the same repo that touched these files and were neither committed nor reverted.
function pendingOwners(run, files) {
  const set = new Set(files);
  return readJsonl(FILES.runs)
    .filter((r) => r.repo === run.repo && r.startedAt < run.startedAt && !commitRecord(r.id) && !revertRecord(r.id))
    .filter((r) => r.delta.some((d) => set.has(d.path)))
    .map((r) => r.id);
}

// ---------------------------------------------------------------- reject-and-revert
//
// Reverts exactly what the run changed: modified/deleted files go back to the run's start snapshot
// (worktree only, index untouched), files the run added are removed together with the .meta Unity
// made for them and any folder the run created that is now empty. A file edited after the run is
// never touched. Nothing is committed.

export function revertCheck(run) {
  const result = { ok: false, files: [], problems: [], reverted: revertRecord(run.id) };
  if (result.reverted) return { ...result, problems: ['이미 되돌린 실행입니다.'] };
  if (commitRecord(run.id)) return { ...result, problems: ['이미 커밋한 실행입니다. 되돌리려면 git revert를 쓰세요.'] };
  if (!fs.existsSync(run.repo)) return { ...result, problems: ['저장소 경로가 없습니다.'] };
  if (run.startTree === run.endTree) return { ...result, problems: ['이 실행에는 변경이 없습니다.'] };
  for (const tree of [run.startTree, run.endTree]) {
    if (tryGit(run.repo, ['cat-file', '-e', tree]) === null) return { ...result, problems: ['스냅샷이 Git에서 정리되어 확인할 수 없습니다.'] };
  }
  const paths = git(run.repo, ['diff', '--name-only', '--no-renames', run.startTree, run.endTree]).split('\n').filter(Boolean);
  for (const file of paths) {
    const want = blobIn(run.repo, run.endTree, file);
    const start = blobIn(run.repo, run.startTree, file);
    const now = worktreeBlob(run.repo, file);
    const action = start === null ? 'delete' : want === null ? 'recreate' : 'restore';
    const issue = now === start ? '이미 run 전 상태입니다' : now !== want ? '리뷰 이후 파일이 바뀌어 건드리지 않습니다' : null;
    result.files.push({ path: file, action, issue });
  }
  const blocked = result.files.filter((f) => f.issue && !f.issue.startsWith('이미'));
  if (blocked.length) result.problems.push(`${blocked.length}개 파일이 리뷰 이후 바뀌었습니다. 터미널에서 직접 정리하세요.`);
  result.metas = unityMetas(run.repo, result.files.filter((f) => f.action === 'delete' && !f.issue).map((f) => f.path));
  result.ok = result.problems.length === 0;
  return result;
}

function revertRun(run) {
  const check = revertCheck(run);
  if (!check.ok) return { ok: false, check };
  const review = latestReviews().get(run.id);
  if (review?.decision !== 'rejected') return { ok: false, check: { ...check, problems: ['거절한 실행만 되돌릴 수 있습니다.'] } };
  const todo = check.files.filter((f) => !f.issue);
  const restore = todo.filter((f) => f.action !== 'delete').map((f) => f.path);
  const removed = [];
  try {
    // Modified files: write the start blob keeping the file's current line endings. Letting git
    // check it out would apply core.autocrlf and turn an LF file into CRLF, which then shows up as a
    // phantom modification. Files the run deleted have no current EOL, so git recreates them.
    for (const f of todo.filter((x) => x.action === 'restore')) {
      const full = path.join(run.repo, f.path);
      const blob = execFileSync('git', ['-C', run.repo, 'cat-file', 'blob', `${run.startTree}:${f.path}`], { maxBuffer: 256 * 1024 * 1024 });
      const current = fs.readFileSync(full);
      const binary = blob.includes(0);
      const crlf = !binary && current.includes('\r\n');
      fs.writeFileSync(full, crlf ? Buffer.from(blob.toString('latin1').replace(/\r?\n/g, '\r\n'), 'latin1') : blob);
    }
    // Files the run deleted: no current file to copy line endings from, but the index remembers the
    // size the file had on disk. Match it against the LF and CRLF renderings of the blob.
    for (const f of todo.filter((x) => x.action === 'recreate')) {
      const full = path.join(run.repo, f.path);
      const blob = execFileSync('git', ['-C', run.repo, 'cat-file', 'blob', `${run.startTree}:${f.path}`], { maxBuffer: 256 * 1024 * 1024 });
      const crlfBlob = blob.includes(0) ? blob : Buffer.from(blob.toString('latin1').replace(/\r?\n/g, '\r\n'), 'latin1');
      const size = Number((tryGit(run.repo, ['ls-files', '--debug', '--', f.path]) || '').match(/size:\s*(\d+)/)?.[1]);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      if (size === crlfBlob.length && size !== blob.length) fs.writeFileSync(full, crlfBlob);
      else if (size === blob.length) fs.writeFileSync(full, blob);
      else git(run.repo, ['restore', `--source=${run.startTree}`, '--worktree', '--', f.path]);
    }
    for (const f of todo.filter((x) => x.action === 'delete')) { fs.rmSync(path.join(run.repo, f.path), { force: true }); removed.push(f.path); }
    for (const meta of check.metas) {
      const target = meta.slice(0, -'.meta'.length);
      const full = path.join(run.repo, target);
      // A folder .meta goes only when the folder itself is gone or left empty.
      if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
        if (fs.readdirSync(full).length) continue;
        fs.rmdirSync(full);
      }
      fs.rmSync(path.join(run.repo, meta), { force: true });
      removed.push(meta);
    }
    // Remove folders the run created that are now empty.
    for (const f of todo.filter((x) => x.action === 'delete')) {
      for (let dir = path.posix.dirname(f.path); dir && dir !== '.'; dir = path.posix.dirname(dir)) {
        const full = path.join(run.repo, dir);
        if (!fs.existsSync(full) || fs.readdirSync(full).length || isTracked(run.repo, dir)) break;
        fs.rmdirSync(full);
      }
    }
  } catch (e) {
    return { ok: false, check: { ...check, problems: [`되돌리기 실패: ${String(e.stderr || e.message).trim().slice(0, 500)}`] } };
  }
  const record = { runId: run.id, restored: restore, removed, at: new Date().toISOString() };
  append(FILES.reverts, record);
  return { ok: true, revert: record };
}

function commitRun(run, message) {
  const check = commitCheck(run);
  if (!check.ok) return { ok: false, check };
  const review = latestReviews().get(run.id);
  if (review?.decision !== 'accepted') return { ok: false, check: { ...check, problems: ['수락한 실행만 커밋할 수 있습니다.'] } };
  const paths = [...check.files.map((f) => f.path), ...(check.metas || [])];
  try {
    git(run.repo, ['add', '-A', '--', ...paths]);
    git(run.repo, ['commit', '-q', '-F', '-', '--', ...paths], `${message.trim()}\n\nJevcode-Run: ${run.id}\n`);
  } catch (e) {
    return { ok: false, check: { ...check, problems: [`git commit 실패: ${String(e.stderr || e.message).trim().slice(0, 500)}`] } };
  }
  const record = { runId: run.id, sha: git(run.repo, ['rev-parse', 'HEAD']), message: message.trim(), files: paths, at: new Date().toISOString() };
  append(FILES.commits, record);
  return { ok: true, commit: record };
}

function listRuns() {
  const reviews = latestReviews();
  const decisions = latestDecisions();
  const commits = new Map(readJsonl(FILES.commits).map((c) => [c.runId, c]));
  return readJsonl(FILES.runs).reverse().map((r) => ({
    id: r.id,
    repo: path.basename(r.repo),
    tag: r.tag,
    task: r.task.split('\n')[0].slice(0, 140),
    startedAt: r.startedAt,
    executionOutcome: r.executionOutcome,
    verificationStatus: r.verificationStatus,
    policyStatus: r.policyStatus,
    files: r.delta.length,
    denials: r.denials.length,
    usage: r.usage,
    review: reviews.get(r.id) || null,
    commit: commits.get(r.id) || null,
    reverted: !!revertRecord(r.id),
    humanTasks: /사람이 할 일/.test(r.lastMessage || ''),
    shadow: decisions.get(r.id) || {},
  }));
}

function runDetail(id) {
  const run = readJsonl(FILES.runs).find((r) => r.id === id);
  if (!run) return null;
  const dir = path.join(ROOT, 'runs', id);
  const patchFile = path.join(dir, 'diff.patch');
  const patch = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : null;
  return {
    run,
    review: latestReviews().get(id) || null,
    decisions: readJsonl(FILES.decisions).filter((d) => d.runId === id),
    verificationTails: run.verification.map((_, i) => readTail(path.join(dir, `verify-${i}.out.txt`), 60)),
    patch: patch && patch.length > 400_000 ? `${patch.slice(0, 400_000)}\n[truncated in UI]` : patch,
    hasRawEvents: fs.existsSync(path.join(dir, 'events.jsonl')),
    dir,
  };
}

function stats() {
  const runs = readJsonl(FILES.runs);
  const reviews = latestReviews();
  const bypasses = readJsonl(FILES.bypasses).length;
  // A0 metric 2: failed/timed-out/unknown or rejected runs whose cause was explainable from the record.
  const troubled = runs.filter((r) => FAILED.has(r.executionOutcome) || reviews.get(r.id)?.decision === 'rejected');
  const judged = troubled.filter((r) => typeof reviews.get(r.id)?.explainable === 'boolean');
  const explainable = judged.filter((r) => reviews.get(r.id).explainable).length;
  const viewed = [...reviews.values()].map((v) => v.viewedMs).filter((ms) => typeof ms === 'number');
  const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  return {
    runs: runs.length,
    reviewed: runs.filter((r) => reviews.has(r.id)).length,
    bypasses,
    bypassRatio: runs.length + bypasses ? bypasses / (runs.length + bypasses) : null,
    troubled: troubled.length,
    explainableJudged: judged.length,
    explainableRatio: judged.length ? explainable / judged.length : null,
    medianReviewMs: median(viewed),
    reviewTimeSamples: viewed.length,
    eval: evaluate(runs, [...reviews.values()], readJsonl(FILES.decisions)),
  };
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 100_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); }
    });
  });
}

export async function start() {
  const token = crypto.randomBytes(18).toString('base64url');
  const html = fs.readFileSync(path.join(HERE, 'ui.html'), 'utf8');
  let origin = '';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    // Only this launch's page may talk to the server: exact Host (no DNS rebinding) + token.
    if (req.headers.host !== new URL(origin).host) return send(res, 403, { error: 'bad host' });
    if (url.pathname === '/') {
      if (url.searchParams.get('t') !== token) return send(res, 403, 'forbidden', 'text/plain');
      return send(res, 200, html, 'text/html; charset=utf-8');
    }
    if (req.headers['x-jevcode-token'] !== token) return send(res, 403, { error: 'bad token' });
    try {
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'GET' && url.pathname === '/api/meta') return send(res, 200, { causes: CAUSES, causeText: QUESTIONS.failure_cause.criteria });
      if (req.method === 'GET' && url.pathname === '/api/runs') return send(res, 200, listRuns());
      if (req.method === 'GET' && url.pathname === '/api/stats') return send(res, 200, stats());
      const findRun = (id) => readJsonl(FILES.runs).find((r) => r.id === id);
      if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'runs' && parts[3] === 'commit-check') {
        const run = findRun(parts[2]);
        return run ? send(res, 200, commitCheck(run)) : send(res, 404, { error: 'no run' });
      }
      if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'runs' && parts[3] === 'revert-check') {
        const run = findRun(parts[2]);
        return run ? send(res, 200, revertCheck(run)) : send(res, 404, { error: 'no run' });
      }
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'runs' && parts[3] === 'revert') {
        const run = findRun(parts[2]);
        return run ? send(res, 200, revertRun(run)) : send(res, 404, { error: 'no run' });
      }
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'runs' && parts[3] === 'commit') {
        const run = findRun(parts[2]);
        if (!run) return send(res, 404, { error: 'no run' });
        const body = await readBody(req);
        const message = String(body.message || '').trim();
        if (!message || message.length > 500) return send(res, 400, { error: '커밋 메시지가 비었거나 너무 깁니다.' });
        return send(res, 200, commitRun(run, message));
      }
      if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'runs' && parts[2]) {
        const detail = runDetail(parts[2]);
        return detail ? send(res, 200, detail) : send(res, 404, { error: 'no run' });
      }
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'runs' && parts[3] === 'review') {
        const body = await readBody(req);
        if (!['accepted', 'rejected'].includes(body.decision)) return send(res, 400, { error: 'decision' });
        if (body.cause && !CAUSES.includes(body.cause)) return send(res, 400, { error: 'cause' });
        if (!readJsonl(FILES.runs).some((r) => r.id === parts[2])) return send(res, 404, { error: 'no run' });
        const review = {
          id: parts[2], decision: body.decision, cause: body.cause || null,
          explainable: typeof body.explainable === 'boolean' ? body.explainable : null,
          reason: String(body.note || '').slice(0, 2000) || null,
          viewedMs: Number.isFinite(body.viewedMs) ? Math.round(body.viewedMs) : null,
          source: 'ui', at: new Date().toISOString(),
        };
        append(FILES.reviews, review);
        return send(res, 200, review);
      }
      if (req.method === 'POST' && url.pathname === '/api/bypass') {
        const body = await readBody(req);
        append(FILES.bypasses, { at: new Date().toISOString(), cwd: null, note: String(body.note || '').slice(0, 500) || null, source: 'ui' });
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, 500, { error: String(e.message || e) });
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const link = `${origin}/?t=${token}`;
  console.log(`jevcode ui: ${link}\n(Ctrl+C to stop)`);
  if (!process.env.JEVCODE_UI_NO_OPEN) exec(`start "" "${link}"`);
}
