// Regression tests for the record-keeping boundaries (snapshots, restores, evaluation labels, blind
// review). Everything runs in temporary git repositories and a temporary JEVCODE_HOME, so real A0
// records are never touched. Run: node --test --test-force-exit "a0/tests/*.test.mjs"
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `jevcode-${name}-`));
const home = tmp('home');
process.env.JEVCODE_HOME = home;
process.env.JEVCODE_UI_NO_OPEN = '1';

const { snapshotTree, restoreToTree } = await import('../tree.mjs');
const { splitTask } = await import('../taskfile.mjs');
const { evaluate, QUESTIONS_VERSION } = await import('../decisions.mjs');

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' }).trim();
}
function repoWith(files) {
  const repo = tmp('repo');
  git(repo, 'init', '-q');
  // The code under test calls git without -c overrides; keep line endings out of these tests.
  git(repo, 'config', 'core.autocrlf', 'false');
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), c);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}
const show = (repo, tree, file) => git(repo, 'show', `${tree}:${file}`);

test('snapshot keeps a tracked file that .gitignore now matches', () => {
  const repo = repoWith({ 'keep.txt': 'v1\n', 'other.txt': 'x\n' });
  const runDir = tmp('run');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'keep.txt\n');
  fs.writeFileSync(path.join(repo, 'keep.txt'), 'v2\n');
  const tree = snapshotTree(repo, runDir);
  assert.equal(show(repo, tree, 'keep.txt'), 'v2');
});

test('snapshot still records new untracked files and ignores ignored new files', () => {
  const repo = repoWith({ '.gitignore': 'build/\n', 'a.txt': 'a\n' });
  const runDir = tmp('run');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'n\n');
  fs.mkdirSync(path.join(repo, 'build'));
  fs.writeFileSync(path.join(repo, 'build', 'out.bin'), 'o\n');
  const tree = snapshotTree(repo, runDir);
  assert.equal(show(repo, tree, 'new.txt'), 'n');
  assert.throws(() => show(repo, tree, 'build/out.bin'));
});

test('snapshot does not touch the real index', () => {
  const repo = repoWith({ 'a.txt': 'a\n' });
  const before = git(repo, 'ls-files', '--stage');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  snapshotTree(repo, tmp('run'));
  assert.equal(git(repo, 'ls-files', '--stage'), before);
});

test('automatic restore keeps a copy of every file it overwrites or deletes', () => {
  const repo = repoWith({ 'a.txt': 'start\n', 'b.txt': 'start\n' });
  const runDir = tmp('run');
  const start = snapshotTree(repo, runDir);
  // During the run: the agent edits a.txt, a person edits b.txt and creates note.txt.
  fs.writeFileSync(path.join(repo, 'a.txt'), 'agent\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'person\n');
  fs.writeFileSync(path.join(repo, 'note.txt'), 'person note\n');
  const out = restoreToTree(repo, runDir, start);
  assert.ok(out, 'restore matched the start tree');
  assert.equal(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8'), 'start\n');
  assert.equal(fs.existsSync(path.join(repo, 'note.txt')), false);
  assert.equal(fs.readFileSync(path.join(out.backup, 'b.txt'), 'utf8'), 'person\n');
  assert.equal(fs.readFileSync(path.join(out.backup, 'note.txt'), 'utf8'), 'person note\n');
  assert.equal(fs.readFileSync(path.join(out.backup, 'a.txt'), 'utf8'), 'agent\n');
});

test('restore with nothing to undo makes no backup', () => {
  const repo = repoWith({ 'a.txt': 'a\n' });
  const runDir = tmp('run');
  const start = snapshotTree(repo, runDir);
  const out = restoreToTree(repo, runDir, start);
  assert.deepEqual(out, { restored: [], removed: [] });
});

test('evaluation ignores automatic reviews', () => {
  const runs = ['r1', 'r2', 'r3'].map((id) => ({ id, repo: 'C:/x', tag: 'feature', startedAt: `2026-10-05T00:00:0${id[1]}Z`, delta: [] }));
  const reviews = [
    { id: 'r1', decision: 'accepted', cause: 'none' },
    { id: 'r2', decision: 'rejected', cause: 'verification_failed' },
    { id: 'r3', decision: 'rejected', cause: 'quota_or_rate_limit', source: 'auto' },
  ];
  const decisions = runs.map((r) => ({ runId: r.id, provider: 'rules', questionsVersion: QUESTIONS_VERSION,
    answers: { completion: { value: 0.5 }, review_priority: { value: 1 }, failure_cause: { value: 'none' } } }));
  assert.equal(evaluate(runs, reviews, decisions).rules.reviewed, 2);
});

test('review points are split off a task file', () => {
  assert.deepEqual(splitTask('본문\n\n## 리뷰 포인트\n- 하나\n  이어짐\n- 둘\n'), { task: '본문\n', reviewPoints: ['하나 이어짐', '둘'] });
  assert.deepEqual(splitTask('본문\n리뷰 포인트: 한 줄\n'), { task: '본문\n', reviewPoints: ['한 줄'] });
  const plain = '이 줄은 리뷰 포인트를 언급만 한다\n';
  assert.deepEqual(splitTask(plain), { task: plain, reviewPoints: [] });
});

test('review screen API hides shadow answers until the run is reviewed', async () => {
  const a0 = path.join(home, 'a0');
  fs.mkdirSync(path.join(a0, 'runs', 'r1'), { recursive: true });
  fs.writeFileSync(path.join(a0, 'runs.jsonl'), JSON.stringify({ id: 'r1', repo: 'C:/x/repo', tag: null, task: 't\n',
    startedAt: '2026-10-05T00:00:00Z', executionOutcome: 'completed', verificationStatus: 'passed', policyStatus: 'clean',
    acceptanceStatus: 'needs_review', durations: {}, delta: [], commands: [], denials: [], errors: [], verification: [], lastMessage: '' }) + '\n');
  fs.writeFileSync(path.join(a0, 'decisions.jsonl'), JSON.stringify({ runId: 'r1', provider: 'rules', questionsVersion: QUESTIONS_VERSION,
    answers: { completion: { value: 0.9 }, review_priority: { value: 2 }, failure_cause: { value: 'none' } } }) + '\n');
  const logs = [];
  const log = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  const ui = await import('../ui.mjs');
  const server = await ui.start();
  console.log = log;
  const link = new URL(logs.join(' ').match(/http:\/\/\S+/)[0]);
  const headers = { 'x-jevcode-token': link.searchParams.get('t'), 'content-type': 'application/json' };
  const get = async (p) => (await fetch(link.origin + p, { headers })).json();
  try {
    const before = await get('/api/runs/r1');
    assert.deepEqual(before.decisions, []);
    assert.equal(before.decisionCount, 1);
    assert.deepEqual((await get('/api/runs')).find((r) => r.id === 'r1').shadow, {});
    await fetch(`${link.origin}/api/runs/r1/review`, { method: 'POST', headers,
      body: JSON.stringify({ decision: 'accepted', cause: 'none', explainable: true, note: '', viewedMs: 1 }) });
    assert.equal((await get('/api/runs/r1')).decisions.length, 1);
    assert.ok((await get('/api/runs')).find((r) => r.id === 'r1').shadow.rules);
  } finally {
    server?.close?.();
  }
});

test('run environment passes only needed names and never credentials', async () => {
  const { runEnv } = await import('../env.mjs');
  const source = { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\u', TYPESAFE_API_KEY: 'k1',
    GEMINI_API_KEY: 'k2', GIT_ASKPASS: 'x', DOTNET_ROOT: 'C:\\dotnet', DOTNET_API_TOKEN: 't', RANDOM_VAR: 'r', TEMP: 'C:\\old' };
  const env = runEnv(source, { TEMP: 'C:\\run', TMP: 'C:\\run' });
  assert.deepEqual(Object.keys(env).sort(), ['DOTNET_ROOT', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']);
  assert.equal(env.TEMP, 'C:\\run');
  const opted = runEnv({ ...source, JEVCODE_ENV_PASS: 'OPENAI_API_KEY, random_var', OPENAI_API_KEY: 'o' });
  assert.equal(opted.OPENAI_API_KEY, 'o');
  assert.equal(opted.RANDOM_VAR, 'r');
  assert.equal(opted.TYPESAFE_API_KEY, undefined);
});

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
