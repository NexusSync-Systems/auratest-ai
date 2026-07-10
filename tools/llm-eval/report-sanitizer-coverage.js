#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import process from 'process';
import { sanitizeActionResponse } from '../../agent.js';

const ACTIONS = new Set(['click', 'type', 'scroll', 'navigate', 'wait', 'finish']);

function parseArgs(argv) {
  const args = {
    cases: 'adapters/auauratesting-gemma/eval-cases.jsonl',
    failures: 'adapters/auauratesting-gemma/model-failures.jsonl',
    output: 'adapters/auauratesting-gemma/data/sanitizer-coverage.md'
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cases') args.cases = argv[++i];
    else if (arg === '--failures') args.failures = argv[++i];
    else if (arg === '--output') args.output = argv[++i];
    else if (arg === '--help') {
      console.log('Usage: node tools/llm-eval/report-sanitizer-coverage.js --cases adapters/auauratesting-gemma/eval-cases.jsonl --failures adapters/auauratesting-gemma/model-failures.jsonl --output adapters/auauratesting-gemma/data/sanitizer-coverage.md');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function loadJsonl(filePath) {
  const absolute = path.resolve(filePath);
  return fs.readFileSync(absolute, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at ${absolute}:${index + 1}: ${error.message}`);
      }
    });
}

function parseInteractiveElements(prompt) {
  const match = prompt.match(/Interactive elements(?: on page)?:\s*\n(\[[\s\S]*?\])\s*\n(?:Test goal:|Visible state:|SUGGESTED VALUES|Recent console logs:|History|Reply|Choose)/i);
  if (!match) return [];
  try {
    return JSON.parse(match[1]).map((el) => ({
      ...el,
      tagName: el.tagName || el.tag
    }));
  } catch {
    return [];
  }
}

function parseCurrentUrl(prompt) {
  return prompt.match(/Current URL:\s*([^\n]+)/i)?.[1]?.trim() || 'http://localhost:3000/';
}

function parsePageTitle(prompt) {
  return prompt.match(/Page Title:\s*([^\n]+)/i)?.[1]?.trim() || '';
}

function parseGoal(prompt) {
  return prompt.match(/Test goal:\s*([^\n]+)/i)?.[1]?.trim() || '';
}

function extractSection(prompt, startLabel, endLabels) {
  const start = prompt.search(new RegExp(`${startLabel}:`, 'i'));
  if (start < 0) return '';
  const afterStart = prompt.slice(start).replace(new RegExp(`^${startLabel}:\\s*`, 'i'), '');
  const endIndexes = endLabels
    .map((label) => afterStart.search(new RegExp(`\\n${label}:`, 'i')))
    .filter((index) => index >= 0);
  const end = endIndexes.length ? Math.min(...endIndexes) : afterStart.length;
  return afterStart.slice(0, end).trim();
}

function parseConsoleLogs(prompt) {
  const section = extractSection(prompt, 'Recent console logs', ['Recent network errors', 'History of previous steps', 'History', 'Reply']);
  if (!section || /No errors\.|No console errors\./i.test(section)) return [];
  return section.split(/\r?\n/).filter(Boolean).map((line) => ({
    type: /\[error\]|\berror\b|ReferenceError|TypeError/i.test(line) ? 'error' : 'log',
    text: line
  }));
}

function parseNetworkErrors(prompt) {
  const section = extractSection(prompt, 'Recent network errors', ['History of previous steps', 'History', 'Reply', 'Choose']);
  if (!section || /No network errors\./i.test(section)) return [];
  return section.split(/\r?\n/).filter(Boolean).map((line) => ({ url: line, error: line }));
}

function parseSteps(prompt) {
  const steps = [];
  const historyRegex = /Step\s+(\d+)[^\n]*?:\s*(click|type|scroll|navigate|wait|finish)\s+target=([^,\s]+)(?:\s+value=("[^"]*"|[^\s|]+))?/gi;
  let match;
  while ((match = historyRegex.exec(prompt)) !== null) {
    steps.push({
      step: Number(match[1]),
      action: match[2].toLowerCase(),
      target: normalizeTarget(match[3]),
      value: match[4] ? String(match[4]).replace(/^"|"$/g, '') : null
    });
  }

  const failedRegex = /Action:\s*(click|type|scroll|navigate|wait|finish),\s*Target:\s*([^\s-]+)/gi;
  while ((match = failedRegex.exec(prompt)) !== null) {
    steps.push({
      step: steps.length + 1,
      action: match[1].toLowerCase(),
      target: normalizeTarget(match[2]),
      failedMemory: true
    });
  }
  return steps;
}

function normalizeTarget(target) {
  if (target === null || target === undefined) return null;
  const raw = String(target).trim().replace(/^"|"$/g, '');
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === 'null') return null;
  return raw;
}

function contextFromCase(testCase) {
  return {
    currentUrl: parseCurrentUrl(testCase.prompt),
    title: parsePageTitle(testCase.prompt),
    goal: parseGoal(testCase.prompt),
    interactiveElements: parseInteractiveElements(testCase.prompt),
    consoleLogs: parseConsoleLogs(testCase.prompt),
    networkErrors: parseNetworkErrors(testCase.prompt),
    steps: parseSteps(testCase.prompt)
  };
}

function validateSanitized(value, testCase) {
  const errors = [];
  if (!value || typeof value !== 'object') return ['sanitized response is not an object'];
  if (!ACTIONS.has(value.action)) errors.push(`invalid action ${value.action}`);

  const assertions = testCase.assertions || {};
  if (assertions.expectedAction && value.action !== assertions.expectedAction) {
    errors.push(`expected action ${assertions.expectedAction}, got ${value.action}`);
  }
  if ('expectedTarget' in assertions && value.target !== assertions.expectedTarget) {
    errors.push(`expected target ${assertions.expectedTarget}, got ${value.target}`);
  }
  if (Array.isArray(assertions.expectedTargets) && !assertions.expectedTargets.includes(value.target)) {
    errors.push(`expected one of targets ${assertions.expectedTargets.join(', ')}, got ${value.target}`);
  }
  if (Array.isArray(assertions.disallowActionTargets)) {
    for (const item of assertions.disallowActionTargets) {
      if (value.action === item.action && value.target === item.target) {
        errors.push(`disallowed action ${item.action} target=${item.target}`);
      }
    }
  }
  if (assertions.detectedBugsMustBeEmpty && value.detected_bugs?.length !== 0) {
    errors.push('detected_bugs must be empty');
  }
  if (assertions.detectedBugsMustNotBeEmpty && (!Array.isArray(value.detected_bugs) || value.detected_bugs.length === 0)) {
    errors.push('detected_bugs must not be empty');
  }
  return errors;
}

function increment(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function table(headers, rows) {
  if (rows.length === 0) return '_No records._\n';
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map((cell) => String(cell).replace(/\|/g, '\\|')).join(' | ')} |`)
  ].join('\n') + '\n';
}

function buildReport(results) {
  const recovered = results.filter((result) => result.recovered);
  const byMode = new Map();
  const unrecoveredRows = [];

  for (const result of results) {
    const key = `${result.failureMode} ${result.recovered ? 'recovered' : 'open'}`;
    increment(byMode, key);
    if (!result.recovered) {
      unrecoveredRows.push([
        result.caseId,
        result.failureMode,
        result.sanitized.action,
        result.sanitized.target,
        result.errors.join('; ')
      ]);
    }
  }

  const modeRows = [...byMode.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([mode, count]) => [mode, count]);

  return [
    '# AuraTesting Gemma Sanitizer Coverage',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Failures checked: ${results.length}`,
    `Recovered by sanitizer: ${recovered.length}/${results.length} (${Math.round((recovered.length / Math.max(results.length, 1)) * 100)}%)`,
    '',
    '## Recovery By Mode',
    '',
    table(['Mode status', 'Count'], modeRows),
    '## Still Open After Sanitizer',
    '',
    table(['Case', 'Failure mode', 'Sanitized action', 'Sanitized target', 'Reason'], unrecoveredRows),
    ''
  ].join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  const cases = new Map(loadJsonl(args.cases).map((testCase) => [testCase.id, testCase]));
  const failures = loadJsonl(args.failures);
  const results = failures.map((failure) => {
    const testCase = cases.get(failure.caseId);
    if (!testCase) throw new Error(`Missing eval case for failure: ${failure.caseId}`);
    const sanitized = sanitizeActionResponse(failure.rejected, contextFromCase(testCase));
    const errors = validateSanitized(sanitized, testCase);
    return {
      caseId: failure.caseId,
      failureMode: failure.failureMode,
      recovered: errors.length === 0,
      sanitized,
      errors
    };
  });

  const outputPath = path.resolve(args.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buildReport(results), 'utf8');
  console.log(`Wrote sanitizer coverage report for ${results.length} failures to ${outputPath}`);
}

main();
