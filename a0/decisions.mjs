// Shadow decision providers (design v0.5, section 10).
//
// The goal is to validate the *method* - a fast typed-decision model judging coding-agent runs -
// independently of any one API. Every provider answers the same versioned question set about the
// same bounded run state, answers are only recorded (they never change a run), and `eval` compares
// providers against the user's own reviews. `rules` is the baseline a model has to beat.

import crypto from 'node:crypto';
import fs from 'node:fs';

export const QUESTIONS_VERSION = 1;

export const QUESTIONS = {
  review_priority: {
    type: 'score',
    instructions: 'How carefully should a human review this coding-agent run before accepting it?',
    criteria: [
      'Routine: low risk, a quick glance is enough',
      'Normal: worth a regular review',
      'Risky: likely problems, inspect carefully',
    ],
  },
  completion: {
    type: 'noul',
    instructions: "Did this run fully accomplish the requested task, judging by the observed changes and verification rather than the agent's own claims?",
  },
  failure_cause: {
    type: 'choice',
    instructions: 'What is the main reason this run did not succeed? Choose none if it succeeded.',
    criteria: {
      none: 'The run succeeded',
      verification_failed: 'Changes were made but required verification failed',
      sandbox_denial: 'The agent was blocked by sandbox or approval restrictions',
      timeout_or_cancel: 'The run timed out or was cancelled',
      quota_or_rate_limit: 'The provider stopped because of usage or rate limits',
      misunderstood_task: 'The agent changed the wrong thing or misread the task',
      environment_or_tooling: 'Missing tools, dependencies, or environment problems',
    },
  },
};

export const CAUSES = Object.keys(QUESTIONS.failure_cause.criteria);

// Everything that leaves the machine is in this list and nothing else (design 5.6).
export const FIELDS_SENT = [
  'task (<=1500 chars)', 'execution outcome', 'verification status + failed-command output tail (<=15 lines)',
  'policy status', 'changed file paths + line counts (no file contents)', 'agent commands (<=15) + exit codes',
  'denials (<=5)', 'errors (<=3)', 'agent final message, marked as unverified claim (<=800 chars)',
];

const clip = (text, n) => (text && text.length > n ? `${text.slice(0, n)}...[truncated]` : text || '');

export function buildState(record, verificationWithTail) {
  const lines = [
    `TASK: ${clip(record.task, 1500)}`,
    `EXECUTION: outcome=${record.executionOutcome}; main exit=${record.launcher?.mainExitCode ?? 'n/a'}; terminated by=${record.launcher?.terminatedBy ?? 'n/a'}`,
    `VERIFICATION: ${record.verificationStatus}`,
  ];
  for (const v of verificationWithTail) {
    lines.push(`  ${v.command} -> ${v.status} (exit ${v.exitCode ?? 'n/a'})`);
    if (v.status !== 'passed' && v.tail) lines.push(...v.tail.split('\n').slice(-15).map((l) => `    | ${l}`));
  }
  lines.push(`POLICY: ${record.policyStatus}`);
  const add = record.delta.reduce((n, d) => n + (d.add || 0), 0);
  const del = record.delta.reduce((n, d) => n + (d.del || 0), 0);
  lines.push(`CHANGED FILES: ${record.delta.length} (+${add} -${del})`);
  for (const d of record.delta.slice(0, 30)) lines.push(`  ${d.status} ${d.path} (+${d.add ?? '?'} -${d.del ?? '?'})`);
  lines.push(`COMMANDS RUN BY AGENT: ${record.commands.length}`);
  for (const c of record.commands.slice(0, 15)) lines.push(`  ${clip(c.command, 200)} -> exit ${c.exit}`);
  lines.push(`DENIALS: ${record.denials.length}`);
  for (const d of record.denials.slice(0, 5)) lines.push(`  ${d.via}: ${clip(d.detail, 200)}`);
  if (record.errors.length) lines.push(`ERRORS: ${record.errors.slice(0, 3).map((e) => clip(e, 200)).join(' | ')}`);
  lines.push(`AGENT FINAL MESSAGE (unverified claim): ${clip(record.lastMessage, 800)}`);
  return lines.join('\n');
}

// Baseline: what JevCode already knows, turned into answers with fixed rules.
const rules = {
  name: 'rules',
  model: 'rules-v1',
  async decide({ record }) {
    const done = record.executionOutcome === 'completed';
    const risky = !done || record.verificationStatus === 'failed' || record.policyStatus === 'violated' || record.denials.length > 0;
    const priority = risky ? 2 : record.verificationStatus !== 'passed' || record.delta.length > 5 ? 1 : 0;
    const completion = !done || record.verificationStatus === 'failed' ? 0.1
      : record.delta.length === 0 ? 0.3 : record.verificationStatus === 'passed' ? 0.8 : 0.6;
    const cause = ['timed_out', 'cancelled'].includes(record.executionOutcome) ? 'timeout_or_cancel'
      : record.quotaSignalCandidates?.length ? 'quota_or_rate_limit'
        : record.verificationStatus === 'failed' ? 'verification_failed'
          : !done && record.denials.length ? 'sandbox_denial'
            : !done ? 'environment_or_tooling' : 'none';
    return {
      review_priority: { value: priority },
      completion: { value: completion },
      failure_cause: { value: cause },
    };
  },
};

// TypeSafe Jev (https://docs.typesafe.ai). Criteria shapes follow the quick start; verify on first use.
const jev = {
  name: 'jev',
  model: 'jev-latest',
  async decide({ state }) {
    const res = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, model: 'jev-latest', questions: QUESTIONS }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = await res.json();
    const answers = {};
    for (const [id, a] of Object.entries(body.answers || {})) {
      answers[id] = {
        value: a.type === 'choice' ? a.choice : a.type === 'score' ? a.score : a.noul,
        confidence: a.confidence ?? null,
        probabilities: a.probabilities ?? null,
      };
    }
    this.model = body.model || this.model;
    return answers;
  },
};

export function providers(only) {
  const all = [rules];
  if (process.env.TYPESAFE_API_KEY) all.push(jev);
  return only ? all.filter((p) => p.name === only) : all;
}

// Never throws: a provider failure is recorded as data, and the run is unaffected.
export async function runShadow({ record, state, decisionsFile, only }) {
  const stateHash = crypto.createHash('sha1').update(state).digest('hex').slice(0, 16);
  const out = [];
  for (const p of providers(only)) {
    const started = Date.now();
    let answers = null;
    let error = null;
    try { answers = await p.decide({ record, state }); } catch (e) { error = String(e.message || e); }
    const entry = {
      runId: record.id, provider: p.name, model: p.model, questionsVersion: QUESTIONS_VERSION,
      stateHash, stateChars: state.length, latencyMs: Date.now() - started, at: new Date().toISOString(),
      answers, error,
    };
    fs.appendFileSync(decisionsFile, JSON.stringify(entry) + '\n');
    out.push(entry);
  }
  return out;
}

export function formatDecision(d) {
  if (d.error) return `${d.provider}: error ${d.error}`;
  const a = d.answers;
  const pct = (x) => (typeof x === 'number' ? `${Math.round(x * 100)}%` : '-');
  return `${d.provider}: priority=${a.review_priority?.value ?? '-'} completion=${pct(a.completion?.value)} cause=${a.failure_cause?.value ?? '-'}${d.provider === 'rules' ? '' : ` (${d.latencyMs}ms)`}`;
}

// Compares each provider's latest answers with the user's reviews (accepted=1, rejected=0).
export function evaluate(runs, reviews, decisions) {
  const reviewById = new Map(reviews.map((r) => [r.id, r]));
  const latest = new Map();
  for (const d of decisions) {
    if (d.questionsVersion !== QUESTIONS_VERSION || d.error) continue;
    latest.set(`${d.provider}|${d.runId}`, d);
  }
  const report = {};
  for (const name of new Set(decisions.map((d) => d.provider))) {
    const rows = runs
      .map((r) => ({ run: r, review: reviewById.get(r.id), d: latest.get(`${name}|${r.id}`) }))
      .filter((x) => x.review && x.d);
    const y = (x) => (x.review.decision === 'accepted' ? 1 : 0);
    const withP = rows.filter((x) => typeof x.d.answers.completion?.value === 'number');
    const brier = withP.length ? withP.reduce((s, x) => s + (x.d.answers.completion.value - y(x)) ** 2, 0) / withP.length : null;
    const accuracy = withP.length ? withP.filter((x) => (x.d.answers.completion.value >= 0.5 ? 1 : 0) === y(x)).length / withP.length : null;
    const byPriority = {};
    for (const x of rows) {
      const level = Math.round(x.d.answers.review_priority?.value ?? -1);
      byPriority[level] ||= { n: 0, rejected: 0 };
      byPriority[level].n++;
      byPriority[level].rejected += 1 - y(x);
    }
    const labeled = rows.filter((x) => x.review.cause);
    const causeAgreement = labeled.length ? labeled.filter((x) => x.d.answers.failure_cause?.value === x.review.cause).length / labeled.length : null;
    report[name] = { reviewed: rows.length, brier, accuracy, byPriority, causeLabeled: labeled.length, causeAgreement };
  }
  return report;
}
