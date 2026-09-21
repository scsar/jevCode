// `jevcode ui`: local review screen for A0 (design v0.5, section 12.A0).
//
// Serves ui.html on 127.0.0.1 with a per-launch token, reads the same JSONL files as the CLI and
// appends reviews / bypasses in the same format, plus two measurement fields the CLI cannot
// capture well: `explainable` (could the cause be understood from this screen alone) and
// `viewedMs` (time from opening a run to submitting its review).

import { exec } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAUSES, QUESTIONS, evaluate } from './decisions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(process.env.LOCALAPPDATA, 'JevCode', 'a0');
const FILES = {
  runs: path.join(ROOT, 'runs.jsonl'),
  reviews: path.join(ROOT, 'reviews.jsonl'),
  bypasses: path.join(ROOT, 'bypasses.jsonl'),
  decisions: path.join(ROOT, 'decisions.jsonl'),
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

function listRuns() {
  const reviews = latestReviews();
  const decisions = latestDecisions();
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
