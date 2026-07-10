#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import process from 'process';

function parseArgs(argv) {
  const args = {
    sessions: 'sessions',
    scripts: 'generated-scripts',
    output: 'data/training/auratest-training-candidates.jsonl',
    summary: 'data/training/auratest-training-candidates-summary.json'
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--sessions') args.sessions = argv[++i];
    else if (arg === '--scripts') args.scripts = argv[++i];
    else if (arg === '--output') args.output = argv[++i];
    else if (arg === '--summary') args.summary = argv[++i];
    else if (arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node tools/llm-eval/extract-training-candidates.js
  node tools/llm-eval/extract-training-candidates.js --sessions sessions --scripts generated-scripts
`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function listFiles(dir, extension) {
  const absolute = path.resolve(dir);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute)
    .filter((name) => name.endsWith(extension))
    .sort()
    .map((name) => path.join(absolute, name));
}

function redactText(value) {
  if (value === null || value === undefined) return value;
  return String(value)
    .replace(/file:\/\/\/Users\/[^/\s]+\/[^\s"'`)]*/g, 'file:///[local-project]')
    .replace(/\/Users\/[^/\s]+\/[^\s"'`)]*/g, '/[local-project]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [token]')
    .replace(/(password|secret|token|api[_-]?key)(["'=:\s]+)[^"',\s]+/gi, '$1$2[redacted]');
}

function redactValue(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = /password|secret|token|credential|apiKey/i.test(key)
        ? '[redacted]'
        : redactValue(item);
    }
    return output;
  }
  return value;
}

function normalizeText(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

function actionKey(step) {
  return `${step.action}:${step.target === undefined ? 'undefined' : step.target}`;
}

function includesSameText(list, text) {
  if (!Array.isArray(list) || !text) return false;
  const normalized = normalizeText(text);
  return list.some((item) => normalizeText(item) === normalized);
}

function isFallbackReasoning(reasoning) {
  return /Ochrana|halucinace|smy[cč]ce|Ghostuji|záchrann/i.test(reasoning || '');
}

function isVagueReasoning(reasoning) {
  const text = normalizeText(reasoning);
  return /^Prvn[ií] krok je zjistit/i.test(text) ||
    /zda se na str[aá]nce nach[aá]z[ií] dal[sš][ií] tla[cč][ií]tka/i.test(text) ||
    /P[řr]ejd[eě]me na detailn[eě]j[sš][ií] anal[yý]zu/i.test(text);
}

function isEnglishReasoning(reasoning) {
  return /\b(the|provided|suggests|navigate|checkout|price|information|should)\b/i.test(reasoning || '');
}

function hasCleanRuntime(step) {
  const logs = Array.isArray(step.logs) ? step.logs : [];
  const hasErrorLog = logs.some((log) => {
    if (typeof log === 'string') return /\berror\b/i.test(log);
    return log?.type === 'error' || /\berror\b/i.test(log?.text || '');
  });
  return !hasErrorLog;
}

function buildSessionCandidate(session, step, failureMode, severity, notes, suggested = {}) {
  return redactValue({
    id: `${session.id || 'session'}-step-${step.step}-${failureMode}`,
    source: `sessions/${session.id || 'unknown'}.json`,
    kind: 'session-step',
    failureMode,
    severity,
    notes,
    original: {
      sessionId: session.id,
      goal: session.goal,
      url: step.url,
      title: step.title,
      step: step.step,
      reasoning: step.reasoning,
      action: step.action,
      target: step.target ?? null,
      value: step.value ?? null,
      bugs: step.bugs || [],
      logs: step.logs || []
    },
    suggested: {
      reasoning: suggested.reasoning || 'Nahradit konkrétní českou úvahou navázanou na dostupný prvek a historii.',
      action: suggested.action ?? step.action,
      target: suggested.target ?? step.target ?? null,
      value: suggested.value ?? step.value ?? null,
      detected_bugs: suggested.detected_bugs ?? []
    },
    reviewStatus: 'needs-human-review'
  });
}

function collectSessionCandidates(sessionFile) {
  const session = readJson(sessionFile);
  const candidates = [];
  const seenActions = new Map();
  const steps = Array.isArray(session.steps) ? session.steps : [];

  for (const step of steps) {
    const key = actionKey(step);
    const priorStep = seenActions.get(key);
    if (priorStep) {
      candidates.push(buildSessionCandidate(
        session,
        step,
        'loop_repeated_action_target',
        'high',
        `Repeated ${key}; first seen at step ${priorStep.step}.`,
        {
          reasoning: 'Tuto akci už historie obsahuje, proto je potřeba zvolit jiný neotestovaný prvek nebo dokončit test.',
          action: 'finish',
          target: null,
          value: null,
          detected_bugs: []
        }
      ));
    } else {
      seenActions.set(key, step);
    }

    if (includesSameText(step.bugs, step.reasoning) || includesSameText(session.bugs, step.reasoning)) {
      candidates.push(buildSessionCandidate(
        session,
        step,
        'reasoning_copied_to_detected_bugs',
        'high',
        'The step reasoning appears in the bug list despite no matching runtime error.',
        {
          reasoning: step.reasoning,
          detected_bugs: hasCleanRuntime(step) ? [] : undefined
        }
      ));
    }

    if (isFallbackReasoning(step.reasoning)) {
      candidates.push(buildSessionCandidate(
        session,
        step,
        'fallback_or_guardrail_step',
        'medium',
        'The backend guardrail forced a fallback action after the model looped or hallucinated.',
        {
          reasoning: 'Model se nemá spoléhat na záchranný krok; má vybrat konkrétní neotestovaný prvek podle historie.',
          detected_bugs: []
        }
      ));
    }

    if (isVagueReasoning(step.reasoning)) {
      candidates.push(buildSessionCandidate(
        session,
        step,
        'vague_repetitive_reasoning',
        'medium',
        'Reasoning is generic and repeated; this is weak supervision for the agent.',
        {
          reasoning: 'Úvaha má konkrétně popsat zvolený prvek a proč je po historii nejhodnotnější.',
          detected_bugs: hasCleanRuntime(step) ? [] : undefined
        }
      ));
    }

    if (isEnglishReasoning(step.reasoning)) {
      candidates.push(buildSessionCandidate(
        session,
        step,
        'non_czech_reasoning',
        'low',
        'Reasoning should be Czech because the runtime prompt requires Czech output values.',
        {
          reasoning: 'Přepsat úvahu česky a zachovat stejnou akci pouze pokud je validní.',
          detected_bugs: hasCleanRuntime(step) ? [] : undefined
        }
      ));
    }
  }

  return candidates;
}

function collectGeneratedScriptCandidates(scriptFile) {
  const content = fs.readFileSync(scriptFile, 'utf8');
  const lines = content.split(/\r?\n/);
  const candidates = [];
  let lastComment = '';

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const commentMatch = line.match(/^\s*\/\/\s*Step\s+\d+:\s*(.*)$/);
    if (commentMatch) {
      lastComment = commentMatch[1].trim();
      continue;
    }

    const gotoMatch = line.match(/await\s+page\.goto\(['"]([^'"]+)['"]\)/);
    if (!gotoMatch) continue;

    const target = gotoMatch[1];
    const source = path.relative(process.cwd(), scriptFile);

    if (/^\d+$/.test(target)) {
      candidates.push(redactValue({
        id: `${path.basename(scriptFile)}-line-${i + 1}-numeric-goto`,
        source,
        kind: 'generated-script',
        failureMode: 'generated_invalid_numeric_navigate',
        severity: 'high',
        notes: 'Generated Playwright script used page.goto with a numeric data-qa-id. The model should have emitted click with numeric target.',
        original: { line: i + 1, code: line.trim(), reasoning: lastComment, target },
        suggested: { action: 'click', target: Number(target), value: null, detected_bugs: [] },
        reviewStatus: 'needs-human-review'
      }));
    } else if (!/^https?:\/\//i.test(target)) {
      candidates.push(redactValue({
        id: `${path.basename(scriptFile)}-line-${i + 1}-relative-goto`,
        source,
        kind: 'generated-script',
        failureMode: 'generated_relative_navigate',
        severity: 'medium',
        notes: 'Generated Playwright script used page.goto with a relative URL. Agent JSON navigate targets must be full http(s) URLs.',
        original: { line: i + 1, code: line.trim(), reasoning: lastComment, target },
        suggested: { action: 'click', target: null, value: null, detected_bugs: [] },
        reviewStatus: 'needs-human-review'
      }));
    }
  }

  return candidates;
}

function summarize(candidates) {
  const summary = { total: candidates.length, byFailureMode: {}, bySeverity: {}, byKind: {} };
  for (const candidate of candidates) {
    summary.byFailureMode[candidate.failureMode] = (summary.byFailureMode[candidate.failureMode] || 0) + 1;
    summary.bySeverity[candidate.severity] = (summary.bySeverity[candidate.severity] || 0) + 1;
    summary.byKind[candidate.kind] = (summary.byKind[candidate.kind] || 0) + 1;
  }
  return summary;
}

function writeJsonl(outputPath, records) {
  const absolute = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
  return absolute;
}

function writeJson(outputPath, data) {
  const absolute = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return absolute;
}

function main() {
  const args = parseArgs(process.argv);
  const sessionFiles = listFiles(args.sessions, '.json');
  const scriptFiles = listFiles(args.scripts, '.ts');
  const candidates = [
    ...sessionFiles.flatMap(collectSessionCandidates),
    ...scriptFiles.flatMap(collectGeneratedScriptCandidates)
  ];
  const summary = summarize(candidates);
  const outputPath = writeJsonl(args.output, candidates);
  const summaryPath = writeJson(args.summary, summary);

  console.log(`Extracted ${candidates.length} training candidates to ${outputPath}`);
  console.log(`Wrote summary to ${summaryPath}`);
  console.log(JSON.stringify(summary, null, 2));
}

main();
