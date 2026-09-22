#!/usr/bin/env node
// JevCode A0 minimal wrapper (design v0.5, section 12.A0).
//
// Runs Codex under the A-gate-verified isolation (JobLauncher + hermetic `codex exec` +
// jevcode-run permission profile), records snapshot delta, commands, denials, token usage
// and runtime-run verification as one JSON line per run, then asks the shadow decision
// providers (decisions.mjs) about the run. No dependencies, Windows only.
//
//   jevcode init --verify "npm test" [--verify ...] [--timeout-min 30]
//   jevcode run [--tag t] [--model m] [--timeout-min n] [--prompt-file f] "task"
//   jevcode log [n] | show <id> | stats | eval
//   jevcode review <id> accept|reject [--cause <cause>] [--explainable yes|no] [reason]
//   jevcode ui                      (local review screen, see ui.mjs)
//   jevcode init ... --unity        (after each run: host-side Unity recompile + console check)
//   jevcode check-unity             (run that Unity check once, now)
//   jevcode decide <id>|--all [--provider rules|jev]
//   jevcode bypass [note]

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAUSES, FIELDS_SENT, buildState, evaluate, formatDecision, providers, runShadow } from './decisions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// JEVCODE_HOME relocates all control data; tests must set it so real A0 records are never touched.
const HOME = process.env.JEVCODE_HOME || path.join(process.env.LOCALAPPDATA, 'JevCode');
const ROOT = path.join(HOME, 'a0');
const RUNS = path.join(ROOT, 'runs.jsonl');
const REVIEWS = path.join(ROOT, 'reviews.jsonl');
const BYPASSES = path.join(ROOT, 'bypasses.jsonl');
const DECISIONS = path.join(ROOT, 'decisions.jsonl');
const CONFIG = path.join(ROOT, 'repos.json');
const TEMP_ROOT = path.join(HOME, 'tmp');
const LAUNCHER_SRC = path.join(HERE, '..', 'spikes', 'a-gate', 'launcher', 'JobLauncher.cs');
const LAUNCHER = path.join(HERE, 'out', 'JobLauncher.exe');
const SANDBOX_MODE = 'unelevated';
const LINGER_MS = 5000;
const QUOTA_HINT = /usage limit|rate.?limit|quota|too many requests|\b429\b|limit reached/i;
const DENIAL_HINT = /access to the path .* is denied|permission denied|액세스가 거부|patch rejected/i;

// ---------------------------------------------------------------- small helpers

function die(msg) {
  console.error(`jevcode: ${msg}`);
  process.exit(1);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

function readConfig() {
  return fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, 'utf8')) : {};
}

function git(repo, args, env = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tryGit(repo, args) {
  try { return git(repo, args); } catch { return ''; }
}

function sha1(data) {
  return crypto.createHash('sha1').update(data).digest('hex');
}

function fmtMs(ms) {
  if (ms == null) return '-';
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}

function fmtN(n) {
  return n == null ? '-' : n.toLocaleString('en-US');
}

function parseArgs(argv, flags) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].startsWith('--') ? argv[i].slice(2) : null;
    if (name && flags[name] === 'bool') {
      opts[name] = true;
    } else if (name && name in flags) {
      const value = argv[++i];
      if (value === undefined) die(`--${name} needs a value`);
      if (flags[name] === 'list') (opts[name] ||= []).push(value);
      else opts[name] = value;
    } else {
      rest.push(argv[i]);
    }
  }
  return { opts, rest };
}

// ---------------------------------------------------------------- repo identity, lock, snapshot

function repoRoot() {
  try { return fs.realpathSync.native(git(process.cwd(), ['rev-parse', '--show-toplevel'])); }
  catch { die('not inside a git repository'); }
}

// Lock key: real path + file identity; never case-folded (design 6.1).
function repoKey(repo) {
  const st = fs.statSync(repo, { bigint: true });
  return sha1(`${repo}|${st.dev}|${st.ino}`).slice(0, 16);
}

function acquireLock(repo, runId) {
  const lock = path.join(ROOT, 'locks', `${repoKey(repo)}.lock`);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, runId, repo }), { flag: 'wx' });
      return () => fs.rmSync(lock, { force: true });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const holder = JSON.parse(fs.readFileSync(lock, 'utf8'));
      let alive = true;
      try { process.kill(holder.pid, 0); } catch { alive = false; }
      if (alive) die(`repository is locked by run ${holder.runId} (pid ${holder.pid})`);
      fs.rmSync(lock, { force: true });
    }
  }
  die('could not acquire lock');
}

// Tree of tracked + untracked (non-ignored) files via a throwaway index; the user's index is untouched.
function snapshotTree(repo, runDir) {
  const index = path.join(runDir, 'snapshot.index');
  fs.rmSync(index, { force: true });
  git(repo, ['add', '-A'], { GIT_INDEX_FILE: index });
  const tree = git(repo, ['write-tree'], { GIT_INDEX_FILE: index });
  fs.rmSync(index, { force: true });
  return tree;
}

// Index *entries* (mode, blob, stage, path), not the index file's bytes: `git status` from the user
// or an editor rewrites cached stat data in .git/index without changing anything, which made runs
// look like policy violations.
function gitFingerprint(repo) {
  const gitDir = git(repo, ['rev-parse', '--absolute-git-dir']);
  const hash = (f) => (fs.existsSync(f) ? sha1(fs.readFileSync(f)) : 'none');
  return sha1([
    tryGit(repo, ['rev-parse', 'HEAD']),
    tryGit(repo, ['for-each-ref', '--format=%(refname) %(objectname)']),
    hash(path.join(gitDir, 'HEAD')),
    sha1(tryGit(repo, ['ls-files', '--stage']) ?? 'none'),
    hash(path.join(gitDir, 'config')),
  ].join('|'));
}

function treeDelta(repo, from, to) {
  if (from === to) return [];
  const stats = new Map();
  // core.quotepath=false keeps non-ASCII (e.g. Korean) paths readable and identical across outputs.
  for (const line of git(repo, ['-c', 'core.quotepath=false', 'diff', '--numstat', from, to]).split('\n').filter(Boolean)) {
    const [add, del, file] = line.split('\t');
    stats.set(file, { add: add === '-' ? null : +add, del: del === '-' ? null : +del });
  }
  return git(repo, ['-c', 'core.quotepath=false', 'diff', '--name-status', from, to]).split('\n').filter(Boolean).map((line) => {
    const [status, ...files] = line.split('\t');
    const file = files[files.length - 1];
    return { status, path: file, ...(stats.get(file) || {}) };
  });
}

// ---------------------------------------------------------------- launcher + codex

function ensureLauncher() {
  if (fs.existsSync(LAUNCHER) && fs.statSync(LAUNCHER).mtimeMs >= fs.statSync(LAUNCHER_SRC).mtimeMs) return;
  fs.mkdirSync(path.dirname(LAUNCHER), { recursive: true });
  const csc = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const r = spawnSync(csc, ['-nologo', '-optimize', `-out:${LAUNCHER}`, LAUNCHER_SRC], { encoding: 'utf8' });
  if (r.status !== 0) die(`launcher build failed:\n${r.stdout}${r.stderr}`);
}

function codexExe() {
  const r = spawnSync('where.exe', ['codex'], { encoding: 'utf8' });
  const exe = (r.stdout || '').split(/\r?\n/).find((l) => l.toLowerCase().endsWith('.exe'));
  if (!exe) die('codex.exe not found on PATH');
  return exe;
}

// jevcode-run (design 5.2): TOML literal strings keep backslashes; read denies need elevated.
function permArg(runTemp) {
  return `permissions={jevcode-run={extends=':workspace',filesystem={':tmpdir'='read','${runTemp}'='write'}}}`;
}

// `--ignore-user-config` does not stop user/system skills from loading, and there is no global
// switch; each SKILL.md has to be disabled by path. Repo-level skills stay enabled.
function skillsOffArg() {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 3 || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name === 'SKILL.md') found.push(full);
    }
  };
  for (const root of [path.join(process.env.USERPROFILE, '.agents', 'skills'), path.join(process.env.USERPROFILE, '.codex', 'skills')]) {
    walk(root, 0);
  }
  return `skills.config=[${found.map((f) => `{path='${f}',enabled=false}`).join(',')}]`;
}

// Tool surfaces that the permission profile does not govern (design 5.4).
const HERMETIC = [
  '-c', 'approval_policy=never', '-c', 'web_search=disabled', '-c', 'history.persistence=none',
  '-c', 'features.memories=false', '-c', 'apps._default.enabled=false',
  '-c', 'agents.enabled=false', '-c', 'features.multi_agent=false', '-c', 'features.remote_plugin=false',
  '-c', 'features.hooks=false', '-c', 'features.skill_mcp_dependency_install=false',
];

// Runs `command` inside a fresh Job Object; resolves with the launcher's final state.
function launch({ stateFile, timeoutMs, command, stdinFile, stdoutFile, stderrFile, env, onSpawn }) {
  const stdio = [
    stdinFile ? fs.openSync(stdinFile, 'r') : 'ignore',
    fs.openSync(stdoutFile, 'w'),
    fs.openSync(stderrFile, 'w'),
  ];
  const child = spawn(LAUNCHER, [stateFile, String(timeoutMs), String(LINGER_MS), '--', ...command], {
    stdio, env, windowsHide: true,
  });
  onSpawn?.(child);
  return new Promise((resolve) => {
    child.on('exit', (code) => {
      for (const fd of stdio) if (typeof fd === 'number') fs.closeSync(fd);
      let state = null;
      try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* launcher killed before writing */ }
      resolve({ launcherExit: code, state });
    });
  });
}

function shortCommand(cmd) {
  return String(cmd).replace(/^"?[^"]*powershell\.exe"?\s+-Command\s+/i, '').replace(/^["']|["']$/g, '');
}

// Summarizes codex `--json` events. Rejected apply_patch calls only show up on stderr (A-gate M1b).
function summarizeEvents(eventsText, stderrText) {
  const s = { turnCompleted: false, usage: null, commands: [], messages: [], errors: [], denials: [], quotaCandidates: [] };
  for (const line of eventsText.split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'turn.completed') {
      s.turnCompleted = true;
      if (e.usage) {
        s.usage ||= { input: 0, cachedInput: 0, output: 0, reasoningOutput: 0 };
        s.usage.input += e.usage.input_tokens || 0;
        s.usage.cachedInput += e.usage.cached_input_tokens || 0;
        s.usage.output += e.usage.output_tokens || 0;
        s.usage.reasoningOutput += e.usage.reasoning_output_tokens || 0;
      }
    }
    if (e.type === 'error' || e.type === 'turn.failed') {
      const msg = e.message || e.error?.message || JSON.stringify(e).slice(0, 300);
      s.errors.push(msg);
      if (QUOTA_HINT.test(msg)) s.quotaCandidates.push(msg);
    }
    const item = e.item;
    if (e.type !== 'item.completed' || !item) continue;
    if (item.type === 'command_execution') {
      const output = item.aggregated_output || '';
      s.commands.push({ command: shortCommand(item.command).slice(0, 300), exit: item.exit_code });
      const denied = output.split('\n').find((l) => DENIAL_HINT.test(l));
      if (denied) s.denials.push({ via: 'shell', detail: denied.trim().slice(0, 300) });
    } else if (item.type === 'agent_message') {
      s.messages.push(item.text || '');
    }
  }
  for (const line of stderrText.split('\n')) {
    const rejected = line.match(/patch rejected[^\r\n]*/);
    if (rejected) s.denials.push({ via: 'apply_patch', detail: rejected[0].slice(0, 300) });
    if (QUOTA_HINT.test(line) && s.quotaCandidates.length < 5) s.quotaCandidates.push(line.trim().slice(0, 300));
  }
  return s;
}

// Live progress: tail the events file and print completed commands / messages.
function followEvents(file) {
  let offset = 0;
  let partial = '';
  const tick = () => {
    if (!fs.existsSync(file)) return;
    const size = fs.statSync(file).size;
    if (size <= offset) return;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    offset = size;
    const lines = (partial + buf.toString('utf8')).split('\n');
    partial = lines.pop();
    for (const line of lines) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type !== 'item.completed' || !e.item) continue;
      if (e.item.type === 'command_execution') {
        console.log(`  $ ${shortCommand(e.item.command).slice(0, 110)}  -> exit ${e.item.exit_code}`);
      } else if (e.item.type === 'agent_message') {
        console.log(`  > ${(e.item.text || '').split('\n')[0].slice(0, 110)}`);
      } else {
        console.log(`  · ${e.item.type}`);
      }
    }
  };
  const timer = setInterval(tick, 500);
  return () => { clearInterval(timer); tick(); };
}

async function runVerification({ repo, runDir, runTemp, env, commands, timeoutMs, codex }) {
  const results = [];
  for (const [i, command] of commands.entries()) {
    // Propagate native exit codes; powershell -Command alone only reports $? of the last pipeline.
    // UTF-8 output keeps localized tool messages readable in tails and shadow state; progress
    // records would otherwise be serialized into stdout as CLIXML.
    const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'; `
      + `$global:LASTEXITCODE = 0; ${command}; $ok = $?; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; if (-not $ok) { exit 1 }; exit 0`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const out = path.join(runDir, `verify-${i}.out.txt`);
    const started = Date.now();
    const { state } = await launch({
      stateFile: path.join(runDir, `verify-${i}.launcher.json`),
      timeoutMs,
      command: [codex, 'sandbox', '-c', permArg(runTemp), '-c', `windows.sandbox=${SANDBOX_MODE}`,
        '-P', 'jevcode-run', '-C', repo, '--', 'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      stdoutFile: out,
      stderrFile: out.replace('.out.', '.err.'),
      env,
    });
    const status = !state || state.activeProcesses > 0 ? 'unknown'
      : state.terminatedBy === 'timeout' ? 'timed_out'
        : state.mainExitCode === 0 ? 'passed' : 'failed';
    // Test runners often report failures on stderr (e.g. node assert), so the tail covers both.
    const tail = [out, out.replace('.out.', '.err.')]
      .flatMap((f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split(/\r?\n/) : []))
      .filter(Boolean).slice(-15).join('\n');
    results.push({ command, status, exitCode: state?.mainExitCode ?? null, durationMs: Date.now() - started, tail });
  }
  return results;
}

// ---------------------------------------------------------------- local servers + Unity check

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Local agent servers the sandbox does NOT isolate: commands inside it can still reach 127.0.0.1
// ports (found 2026-09-22 with MCP for Unity on 8080). Warn only; the user decides.
const WATCHED_LOCAL_PORTS = [{ port: 8080, label: 'MCP for Unity' }];

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (open) => { socket.destroy(); resolve(open); };
    socket.setTimeout(400, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function localServerWarnings() {
  const warnings = [];
  for (const { port, label } of WATCHED_LOCAL_PORTS) {
    if (await portOpen(port)) warnings.push(`${label} 서버가 127.0.0.1:${port}에서 실행 중입니다. 샌드박스 안의 명령도 접속할 수 있으니 run 중에는 꺼 두세요.`);
  }
  return warnings;
}

function unityExe() {
  const r = spawnSync('where.exe', ['unity'], { encoding: 'utf8' });
  return (r.stdout || '').split(/\r?\n/).find((l) => /\.(exe|cmd)$/i.test(l)) || null;
}

// Host-side Unity check (not sandboxed, fixed commands only): recompile, wait, read the Editor's
// compile-failure flag and console errors through the Unity CLI + Pipeline package.
async function unityCheck({ repo, runDir, index }) {
  const started = Date.now();
  const log = [];
  const finish = (status, reason) => {
    if (runDir) fs.writeFileSync(path.join(runDir, `verify-${index}.out.txt`), log.join('\n'));
    return { command: 'unity: recompile + console errors (host)', status, exitCode: null, durationMs: Date.now() - started, reason: reason || null, tail: log.slice(-15).join('\n') };
  };
  const exe = unityExe();
  if (!exe) { log.push('Unity CLI를 찾지 못했습니다.'); return finish('unknown', 'unity CLI 없음'); }
  const call = (args) => {
    const r = spawnSync(exe, [...args, '--project-path', repo, '--format', 'json', '--no-banner', '--non-interactive'], {
      encoding: 'utf8', timeout: 60000, env: { ...process.env, UNITY_NO_UPDATE_CHECK: '1', UNITY_NO_CONSENT_PROMPT: '1' },
    });
    try { return JSON.parse(r.stdout || 'null'); } catch { return null; }
  };
  // Results sometimes arrive as a JSON string inside the envelope; during a domain reload data is null.
  const payload = (j) => {
    let r = j?.data?.result;
    if (typeof r === 'string') { try { r = JSON.parse(r); } catch { /* keep string */ } }
    return r ?? null;
  };
  // Remember the console cursor so only errors logged by this compile are reported, not stale buffer entries.
  const before = payload(call(['command', 'console_status']));
  const rc = payload(call(['command', 'recompile']));
  if (!rc) { log.push('Unity 에디터에 연결하지 못했습니다(에디터가 꺼져 있거나 Pipeline 서버 없음).'); return finish('unknown', '에디터 연결 안 됨'); }
  log.push(`recompile: ${rc.status ?? JSON.stringify(rc)}`);
  await sleep(1500);
  let gt = null;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    gt = payload(call(['command', 'console_status']))?.groundTruth ?? null;
    if (gt && !gt.compiling) {
      const rs = payload(call(['command', 'recompile_status']));
      if (rs && !['compiling', 'triggered'].includes(rs.status)) break;
    }
    await sleep(2000);
  }
  if (!gt || gt.compiling) { log.push('제한 시간 안에 컴파일 완료를 확인하지 못했습니다.'); return finish('unknown', '컴파일 대기 시간 초과'); }
  const since = before && typeof before.cursor === 'number'
    ? ['--since', String(before.cursor), '--since_session', String(before.session)] : [];
  let entries = payload(call(['command', 'console', '--level', 'error', '--tail', '20', ...since]))?.entries || [];
  // Already failing with nothing recompiled: the errors were logged earlier, so fall back to the recent tail.
  if (gt.compilationFailed && !entries.length) entries = payload(call(['command', 'console', '--level', 'error', '--tail', '20']))?.entries || [];
  for (const e of entries) log.push(String(e.message ?? e.condition ?? JSON.stringify(e)).split('\n')[0].slice(0, 300));
  log.push(`compilationFailed=${gt.compilationFailed} consoleErrors=${gt.consoleErrors} consoleWarnings=${gt.consoleWarnings}`);
  return finish(gt.compilationFailed ? 'failed' : 'passed');
}

// ---------------------------------------------------------------- commands

async function cmdCheckUnity() {
  const repo = repoRoot();
  console.log(`unity check in ${repo} ...`);
  const r = await unityCheck({ repo, runDir: null, index: 0 });
  console.log(`[${r.status}]${r.reason ? ` ${r.reason}` : ''} (${fmtMs(r.durationMs)})\n${r.tail}`);
  process.exitCode = r.status === 'passed' ? 0 : 1;
}

function cmdInit(argv) {
  const { opts } = parseArgs(argv, { verify: 'list', 'timeout-min': 'value', unity: 'bool' });
  const repo = repoRoot();
  const config = readConfig();
  config[repoKey(repo)] = { repo, verify: opts.verify || [], timeoutMin: +(opts['timeout-min'] || 30), unity: !!opts.unity };
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2));
  console.log(`configured ${repo}\n  verify: ${(opts.verify || []).join(' | ') || '(none)'}\n  unity check: ${opts.unity ? 'on (host-side recompile + console after each run)' : 'off'}\n  timeout: ${config[repoKey(repo)].timeoutMin} min`);
}

async function cmdRun(argv) {
  const { opts, rest } = parseArgs(argv, { tag: 'value', model: 'value', 'timeout-min': 'value', 'prompt-file': 'value' });
  const task = opts['prompt-file'] ? fs.readFileSync(opts['prompt-file'], 'utf8') : rest.join(' ');
  if (!task.trim()) die('usage: jevcode run [--tag t] [--model m] [--timeout-min n] [--prompt-file f] "task"');

  const repo = repoRoot();
  const cfg = readConfig()[repoKey(repo)] || { verify: [], timeoutMin: 30 };
  const timeoutMs = +(opts['timeout-min'] || cfg.timeoutMin) * 60000;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const id = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
  const runDir = path.join(ROOT, 'runs', id);
  const runTemp = path.join(TEMP_ROOT, id);
  const stateDir = path.join(runDir, 'codex-state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(runTemp, { recursive: true });

  ensureLauncher();
  const codex = codexExe();
  const release = acquireLock(repo, id);
  const env = { ...process.env, TEMP: runTemp, TMP: runTemp };
  const t0 = Date.now();

  try {
    const startTree = snapshotTree(repo, runDir);
    const fp0 = gitFingerprint(repo);
    const promptFile = path.join(runDir, 'prompt.txt');
    fs.writeFileSync(promptFile, task);
    const eventsFile = path.join(runDir, 'events.jsonl');
    const stderrFile = path.join(runDir, 'stderr.txt');
    const lastMessageFile = path.join(runDir, 'last-message.txt');

    console.log(`run ${id} in ${repo}${opts.tag ? ` [${opts.tag}]` : ''}`);
    // Echo what actually arrived: cmd.exe silently drops everything after the first line break.
    const tail = task.trim().slice(-50).replace(/\s+/g, ' ');
    console.log(`  task: ${task.length}자, ${task.split('\n').length}줄, 끝: "...${tail}"`);
    const localServers = await localServerWarnings();
    for (const w of localServers) console.log(`  ! ${w}`);
    let cancelled = false;
    let child = null;
    const onSigint = () => { cancelled = true; console.log('\n  cancelling...'); child?.kill(); };
    process.on('SIGINT', onSigint);
    const stopFollow = followEvents(eventsFile);
    const tExec = Date.now();
    const { state } = await launch({
      stateFile: path.join(runDir, 'launcher.json'),
      timeoutMs,
      command: [codex, 'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
        '--json', '--color', 'never', '-C', repo,
        '-c', permArg(runTemp), '-c', 'default_permissions=jevcode-run', '-c', `windows.sandbox=${SANDBOX_MODE}`,
        ...HERMETIC, '-c', skillsOffArg(),
        '-c', `sqlite_home=${stateDir}`, '-c', `log_dir=${stateDir}`,
        '-o', lastMessageFile, ...(opts.model ? ['-m', opts.model] : []), '-'],
      stdinFile: promptFile,
      stdoutFile: eventsFile,
      stderrFile,
      env,
      onSpawn: (c) => { child = c; },
    });
    const execMs = Date.now() - tExec;
    stopFollow();
    process.off('SIGINT', onSigint);

    const ev = summarizeEvents(fs.readFileSync(eventsFile, 'utf8'), fs.readFileSync(stderrFile, 'utf8'));
    // quota_exhausted stays reserved until the provider signal is verified (design 6.2); candidates are recorded.
    const executionOutcome = cancelled ? 'cancelled'
      : state?.terminatedBy === 'timeout' ? 'timed_out'
        : !state || state.activeProcesses > 0 ? 'unknown'
          : ev.turnCompleted && state.mainExitCode === 0 ? 'completed' : 'failed';

    const endTree = snapshotTree(repo, runDir);
    const policyStatus = gitFingerprint(repo) === fp0 ? 'clean' : 'violated';
    const delta = treeDelta(repo, startTree, endTree);
    // Snapshot trees are unreachable objects that `git gc` may prune, so keep the patch itself.
    if (startTree !== endTree) {
      const patch = execFileSync('git', ['-C', repo, '-c', 'core.quotepath=false', 'diff', startTree, endTree], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      fs.writeFileSync(path.join(runDir, 'diff.patch'), patch.length > 2_000_000 ? `${patch.slice(0, 2_000_000)}\n[truncated]\n` : patch);
    }

    const tVerify = Date.now();
    let verification = [];
    let verificationStatus = 'skipped';
    let verifiedTreeChanged = false;
    if (cfg.verify.length && !cancelled && executionOutcome !== 'unknown') {
      console.log(`  verifying (${cfg.verify.length} command${cfg.verify.length > 1 ? 's' : ''})...`);
      verification = await runVerification({ repo, runDir, runTemp, env, commands: cfg.verify, timeoutMs, codex });
      verificationStatus = verification.every((v) => v.status === 'passed') ? 'passed'
        : verification.some((v) => v.status === 'unknown') ? 'unknown' : 'failed';
      verifiedTreeChanged = snapshotTree(repo, runDir) !== endTree;
    }
    // Host-side Unity check after the sandboxed commands. It may make Unity write .meta files, which
    // the user commits separately, so it runs after the tree-change check above.
    if (cfg.unity && !cancelled && executionOutcome !== 'unknown') {
      console.log('  unity check (host: recompile + console)...');
      verification.push(await unityCheck({ repo, runDir, index: verification.length }));
      verificationStatus = verification.every((v) => v.status === 'passed') ? 'passed'
        : verification.some((v) => v.status === 'failed') ? 'failed' : 'unknown';
    }
    const verifyMs = Date.now() - tVerify;

    const lastMessage = fs.existsSync(lastMessageFile) ? fs.readFileSync(lastMessageFile, 'utf8') : ev.messages.at(-1) || '';
    const record = {
      id, repo, tag: opts.tag || null, task: task.slice(0, 2000), model: opts.model || null,
      startedAt: new Date(t0).toISOString(),
      executionOutcome, verificationStatus, policyStatus, acceptanceStatus: 'needs_review',
      durations: { execMs, verifyMs, totalMs: Date.now() - t0, overheadMs: Date.now() - t0 - execMs - verifyMs },
      startTree, endTree, delta,
      commands: ev.commands, denials: ev.denials, errors: ev.errors.slice(0, 5),
      usage: ev.usage, quotaSignalCandidates: ev.quotaCandidates,
      verification: verification.map(({ tail, ...v }) => v), verifiedTreeChanged,
      launcher: state && { terminatedBy: state.terminatedBy, activeProcesses: state.activeProcesses, mainExitCode: state.mainExitCode },
      lastMessage: lastMessage.slice(0, 4000),
      localServerWarnings: localServers,
    };
    appendJsonl(RUNS, record);

    // Raw provider output is kept only for runs that did not complete cleanly (design 5.6).
    if (executionOutcome === 'completed') fs.rmSync(eventsFile, { force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    printRun(record, verification);

    // Shadow decisions: recorded only. The bounded state is kept so providers added later
    // (e.g. once a Jev key exists) can be backfilled with `jevcode decide`.
    const shadowState = buildState(record, verification);
    fs.writeFileSync(path.join(runDir, 'state.txt'), shadowState);
    const shadow = await runShadow({ record, state: shadowState, decisionsFile: DECISIONS });
    // Blind review: the user's review is the ground truth for evaluating providers, so answers stay
    // hidden until the run is reviewed (design 10.2). Errors are shown because they need fixing.
    const failed = shadow.filter((d) => d.error);
    console.log(` shadow: ${shadow.length - failed.length}/${shadow.length} recorded (hidden until reviewed)${failed.length ? `  ! ${failed.map(formatDecision).join(' | ')}` : ''}`);
    if (failed.some((d) => /HTTP 401/.test(d.error))) {
      console.log('   ! jev 인증 실패: TYPESAFE_API_KEY를 확인하세요. 키를 바꿨다면 새 터미널에서 실행해야 적용됩니다.'
        + ` 이 run은 나중에 jevcode decide ${id} --provider jev로 채울 수 있습니다.`);
    }
  } finally {
    release();
    fs.rmSync(runTemp, { recursive: true, force: true });
  }
}

function printRun(r, verificationWithTail) {
  const add = r.delta.reduce((n, d) => n + (d.add || 0), 0);
  const del = r.delta.reduce((n, d) => n + (d.del || 0), 0);
  const failedCmds = r.commands.filter((c) => c.exit !== 0).length;
  console.log(`\nRun ${r.id}  [${r.executionOutcome}]  verify: ${r.verificationStatus}  policy: ${r.policyStatus}  review: ${r.acceptanceStatus}`);
  console.log(` files: ${r.delta.length} changed (+${add} -${del})`);
  for (const d of r.delta.slice(0, 20)) console.log(`   ${d.status.padEnd(4)} ${d.path} (+${d.add ?? '?'} -${d.del ?? '?'})`);
  console.log(` commands: ${r.commands.length}${failedCmds ? ` (${failedCmds} non-zero)` : ''}   denials: ${r.denials.length}`);
  for (const d of r.denials.slice(0, 5)) console.log(`   ! ${d.via}: ${d.detail}`);
  if (r.usage) console.log(` tokens: in ${fmtN(r.usage.input)} (cached ${fmtN(r.usage.cachedInput)}) out ${fmtN(r.usage.output)}`);
  console.log(` time: exec ${fmtMs(r.durations.execMs)}, verify ${fmtMs(r.durations.verifyMs)}, overhead ${fmtMs(r.durations.overheadMs)}`);
  for (const v of verificationWithTail || r.verification) {
    console.log(` verify [${v.status}] ${v.command} (exit ${v.exitCode ?? '-'}, ${fmtMs(v.durationMs)})`);
    if (v.tail && v.status !== 'passed') console.log(v.tail.split('\n').map((l) => `   | ${l}`).join('\n'));
  }
  if (r.verifiedTreeChanged) console.log(' ! verification modified the tree; results describe the pre-verification state');
  if (r.quotaSignalCandidates?.length) console.log(` ? quota signal candidates: ${r.quotaSignalCandidates.length} (see show)`);
  if (r.lastMessage) console.log(`\n${r.lastMessage.trim().split('\n').slice(0, 12).join('\n')}`);
  console.log(`\n review: jevcode review ${r.id} accept|reject [--cause <cause>] [reason]`);
}

function withReviews(runs) {
  const reviews = new Map(readJsonl(REVIEWS).map((v) => [v.id, v]));
  return runs.map((r) => (reviews.has(r.id) ? { ...r, acceptanceStatus: reviews.get(r.id).decision, review: reviews.get(r.id) } : r));
}

function findRun(id) {
  const matches = withReviews(readJsonl(RUNS)).filter((r) => r.id.startsWith(id));
  if (matches.length !== 1) die(matches.length ? `ambiguous id ${id}` : `no run ${id}`);
  return matches[0];
}

function cmdLog(argv) {
  const n = +(argv[0] || 15);
  const runs = withReviews(readJsonl(RUNS)).slice(-n);
  for (const r of runs) {
    const tokens = r.usage ? `${fmtN(r.usage.input)}/${fmtN(r.usage.output)}` : '-';
    console.log([
      r.id, path.basename(r.repo).padEnd(14).slice(0, 14), (r.tag || '').padEnd(10).slice(0, 10),
      r.executionOutcome.padEnd(9), r.verificationStatus.padEnd(8), r.policyStatus.padEnd(8),
      `${r.delta.length}f`.padStart(4), tokens.padStart(15), r.acceptanceStatus,
    ].join('  '));
  }
}

function cmdShow(argv) {
  const r = findRun(argv[0] || die('usage: jevcode show <id>'));
  printRun(r);
  console.log(`\n task: ${r.task.split('\n')[0].slice(0, 200)}`);
  for (const c of r.commands) console.log(`   $ ${c.command.slice(0, 140)} -> exit ${c.exit}`);
  for (const q of r.quotaSignalCandidates || []) console.log(`   ? ${q}`);
  const decisions = readJsonl(DECISIONS).filter((x) => x.runId === r.id);
  if (r.review) for (const d of decisions) console.log(`   ~ ${formatDecision(d)}`);
  else if (decisions.length) console.log(`   ~ shadow: ${decisions.length} recorded (hidden until reviewed)`);
  if (r.review) console.log(` reviewed: ${r.review.decision}${r.review.cause ? ` (cause: ${r.review.cause})` : ''}${r.review.reason ? ` - ${r.review.reason}` : ''}`);
  const raw = path.join(ROOT, 'runs', r.id);
  console.log(`\n artifacts: ${raw}`);
}

function cmdReview(argv) {
  const { opts, rest } = parseArgs(argv, { cause: 'value', explainable: 'value' });
  const [id, decision, ...reason] = rest;
  if (!['accept', 'reject'].includes(decision)) die(`usage: jevcode review <id> accept|reject [--cause <${CAUSES.join('|')}>] [--explainable yes|no] [reason]`);
  if (opts.cause && !CAUSES.includes(opts.cause)) die(`unknown cause ${opts.cause}; one of ${CAUSES.join(', ')}`);
  if (opts.explainable && !['yes', 'no'].includes(opts.explainable)) die('--explainable takes yes or no');
  const r = findRun(id);
  appendJsonl(REVIEWS, {
    id: r.id, decision: decision === 'accept' ? 'accepted' : 'rejected', cause: opts.cause || null,
    explainable: opts.explainable ? opts.explainable === 'yes' : null,
    reason: reason.join(' ') || null, source: 'cli', at: new Date().toISOString(),
  });
  console.log(`${r.id}: ${decision}ed`);
}

async function cmdDecide(argv) {
  const { opts, rest } = parseArgs(argv, { provider: 'value' });
  const runs = readJsonl(RUNS);
  const targets = rest[0] === '--all' ? runs : [findRun(rest[0] || die('usage: jevcode decide <id>|--all [--provider rules|jev]'))];
  const active = providers(opts.provider);
  if (!active.length) die(opts.provider === 'jev' ? 'set TYPESAFE_API_KEY to use the jev provider' : `no provider ${opts.provider}`);
  if (active.some((p) => p.name !== 'rules')) console.log(`sending to TypeSafe per run: ${FIELDS_SENT.join('; ')}`);
  for (const r of targets) {
    const file = path.join(ROOT, 'runs', r.id, 'state.txt');
    if (!fs.existsSync(file)) { console.log(`${r.id}: no stored state, skipped`); continue; }
    const out = await runShadow({ record: r, state: fs.readFileSync(file, 'utf8'), decisionsFile: DECISIONS, only: opts.provider });
    console.log(`${r.id}: ${out.map(formatDecision).join('  |  ')}`);
  }
}

function cmdEval() {
  const report = evaluate(readJsonl(RUNS), [...new Map(readJsonl(REVIEWS).map((v) => [v.id, v])).values()], readJsonl(DECISIONS));
  const pct = (x) => (x == null ? '-' : `${Math.round(x * 100)}%`);
  for (const [name, r] of Object.entries(report)) {
    console.log(`${name}: reviewed runs ${r.reviewed}`);
    console.log(`  completion  brier ${r.brier == null ? '-' : r.brier.toFixed(3)} (lower is better), accuracy@0.5 ${pct(r.accuracy)}`);
    console.log(`  priority    ${Object.entries(r.byPriority).sort().map(([lvl, v]) => `L${lvl}: ${v.rejected}/${v.n} rejected`).join(', ') || '-'}`);
    console.log(`  care (참고) ${Object.entries(r.careByPriority || {}).sort().map(([lvl, v]) => `L${lvl}: ${v.needCare}/${v.n} needed care`).join(', ') || '-'}`);
    console.log(`  cause       agreement ${pct(r.causeAgreement)} on ${r.causeLabeled} labeled`);
  }
  if (!Object.keys(report).length) console.log('no decisions yet');
  console.log('\nSmall samples: treat as direction only (design 10.2).');
}

function cmdBypass(argv) {
  appendJsonl(BYPASSES, { at: new Date().toISOString(), cwd: process.cwd(), note: argv.join(' ') || null });
  console.log('bypass recorded');
}

function cmdStats() {
  const runs = withReviews(readJsonl(RUNS));
  const bypasses = readJsonl(BYPASSES).length;
  const count = (key) => runs.reduce((m, r) => ((m[r[key]] = (m[r[key]] || 0) + 1), m), {});
  const withUsage = runs.filter((r) => r.usage);
  const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  console.log(`runs: ${runs.length}   bypasses: ${bypasses}   bypass ratio: ${runs.length + bypasses ? Math.round((100 * bypasses) / (runs.length + bypasses)) : 0}%`);
  console.log(`execution:    ${JSON.stringify(count('executionOutcome'))}`);
  console.log(`verification: ${JSON.stringify(count('verificationStatus'))}`);
  console.log(`policy:       ${JSON.stringify(count('policyStatus'))}`);
  console.log(`acceptance:   ${JSON.stringify(count('acceptanceStatus'))}`);
  console.log(`avg tokens:   in ${fmtN(avg(withUsage.map((r) => r.usage.input)))}, cached ${fmtN(avg(withUsage.map((r) => r.usage.cachedInput)))}, out ${fmtN(avg(withUsage.map((r) => r.usage.output)))}`);
  console.log(`avg time:     exec ${fmtMs(avg(runs.map((r) => r.durations.execMs)))}, verify ${fmtMs(avg(runs.map((r) => r.durations.verifyMs)))}, overhead ${fmtMs(avg(runs.map((r) => r.durations.overheadMs)))}`);
  const tags = [...new Set(runs.map((r) => r.tag).filter(Boolean))];
  for (const tag of tags) {
    const t = withUsage.filter((r) => r.tag === tag);
    console.log(`tag ${tag}: ${runs.filter((r) => r.tag === tag).length} runs, avg in ${fmtN(avg(t.map((r) => r.usage.input)))} out ${fmtN(avg(t.map((r) => r.usage.output)))}`);
  }
}

// ---------------------------------------------------------------- main

const [command, ...argv] = process.argv.slice(2);
const commands = {
  init: cmdInit, run: cmdRun, log: cmdLog, show: cmdShow, review: cmdReview, bypass: cmdBypass,
  stats: cmdStats, decide: cmdDecide, eval: cmdEval,
  ui: async () => (await import('./ui.mjs')).start(),
  'check-unity': cmdCheckUnity,
};
if (!commands[command]) {
  console.log('usage: jevcode init|run|log|show|review|decide|eval|bypass|stats|ui|check-unity  (see header of jevcode.mjs)');
  process.exit(command ? 1 : 0);
}
await commands[command](argv);
