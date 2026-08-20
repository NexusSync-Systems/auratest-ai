#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import process from 'process';

const ACTIONS = new Set(['click', 'type', 'scroll', 'navigate', 'wait', 'finish']);
const REQUIRED_KEYS = ['reasoning', 'action', 'target', 'value', 'detected_bugs'];

function parseArgs(argv) {
  const args = {
    cases: 'tools/llm-eval/eval-cases.jsonl',
    host: process.env.OLLAMA_HOST || 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL || 'auratest-gemma2',
    runModel: false,
    modelLabel: null,
    strict: false,
    verbose: false,
    tag: null,
    systemFile: null,
    timeoutMs: 60000,
    writeFailures: null,
    responses: null
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--run-model') args.runModel = true;
    else if (arg === '--strict') args.strict = true;
    else if (arg === '--cases') args.cases = argv[++i];
    else if (arg === '--verbose') args.verbose = true;
    else if (arg === '--tag') args.tag = argv[++i];
    else if (arg === '--system-file') args.systemFile = argv[++i];
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else if (arg === '--write-failures') args.writeFailures = argv[++i];
    else if (arg === '--responses') args.responses = argv[++i];
    else if (arg === '--host') args.host = argv[++i];
    else if (arg === '--model') args.model = argv[++i];
    else if (arg === '--model-label') args.modelLabel = argv[++i];
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
  node tools/llm-eval/run-eval.js
  node tools/llm-eval/run-eval.js --run-model --model auratest-gemma2

Options:
  --run-model       Query Ollama. Without this flag, expected outputs are validated.
  --model NAME      Ollama model name. Default: auratest-gemma2
  --host URL        Ollama host. Default: http://localhost:11434
  --model-label NAME
                    Label stored in failure records. Useful with --responses.
  --cases PATH      JSONL case file. Default: tools/llm-eval/eval-cases.jsonl
  --tag TAG         Run only cases containing this tag.
  --system-file PATH
                    Use a system prompt from a text file for model runs.
  --timeout-ms MS   Per-case Ollama timeout. Default: 60000.
  --write-failures PATH
                    Append failed model responses to a JSONL failure file.
  --responses PATH  Score pre-generated JSONL responses with {id,response}.
  --strict          Exit 1 unless all checks pass.
  --verbose         Print raw model responses for failed cases.
`);
}

function loadResponses(filePath) {
  const absolute = path.resolve(filePath);
  const raw = fs.readFileSync(absolute, 'utf8');
  const responses = new Map();
  raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line, index) => {
      let item;
      try {
        item = JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid response JSONL at ${absolute}:${index + 1}: ${error.message}`);
      }
      if (!item.id || typeof item.response !== 'string') {
        throw new Error(`Response JSONL at ${absolute}:${index + 1} must contain id and response string`);
      }
      responses.set(item.id, item.response);
    });
  return responses;
}

function loadCases(filePath) {
  const absolute = path.resolve(filePath);
  const raw = fs.readFileSync(absolute, 'utf8');
  return raw
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

function filterCases(cases, args) {
  if (!args.tag) return cases;
  return cases.filter((testCase) => Array.isArray(testCase.tags) && testCase.tags.includes(args.tag));
}

function stripCodeFences(text) {
  return String(text || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function parseModelJson(text) {
  const cleaned = stripCodeFences(text);
  try {
    return { value: JSON.parse(cleaned), error: null, cleaned };
  } catch (error) {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first >= 0 && last > first) {
      const candidate = cleaned.slice(first, last + 1);
      try {
        return { value: JSON.parse(candidate), error: null, cleaned: candidate };
      } catch (innerError) {
        return { value: null, error: innerError, cleaned };
      }
    }
    return { value: null, error, cleaned };
  }
}

function extractInteractiveIds(prompt) {
  const ids = new Set();
  const idRegex = /"id"\s*:\s*(\d+)/g;
  let match;
  while ((match = idRegex.exec(prompt)) !== null) {
    ids.add(Number(match[1]));
  }
  return ids;
}

function extractPreviousActionTargets(prompt) {
  const seen = new Set();
  const historyRegex = /\b(click|type|scroll|navigate|wait|finish)\s+target=([^,\s]+)/gi;
  let match;
  while ((match = historyRegex.exec(prompt)) !== null) {
    seen.add(`${match[1].toLowerCase()}:${normalizeTarget(match[2])}`);
  }

  const failedRegex = /Action:\s*(click|type|scroll|navigate|wait|finish),\s*Target:\s*([^\s-]+)/gi;
  while ((match = failedRegex.exec(prompt)) !== null) {
    seen.add(`${match[1].toLowerCase()}:${normalizeTarget(match[2])}`);
  }
  return seen;
}

function normalizeTarget(target) {
  if (target === null || target === undefined) return 'null';
  const raw = String(target).trim().replace(/^"|"$/g, '');
  if (raw === 'null' || raw === 'page') return 'null';
  return raw;
}

function hasCleanLogs(prompt) {
  return /Recent console logs:\s*(No errors\.|No console errors\.)/i.test(prompt) &&
    /Recent network errors:\s*No network errors\./i.test(prompt);
}

function validateSchema(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['response is not an object'];
  }

  for (const key of REQUIRED_KEYS) {
    if (!(key in value)) errors.push(`missing key: ${key}`);
  }

  if (typeof value.reasoning !== 'string' || value.reasoning.trim() === '') {
    errors.push('reasoning must be a non-empty string');
  }
  if (!ACTIONS.has(value.action)) {
    errors.push(`action must be one of: ${Array.from(ACTIONS).join(', ')}`);
  }
  if (value.value !== null && typeof value.value !== 'string') {
    errors.push('value must be string or null');
  }
  if (!Array.isArray(value.detected_bugs) || value.detected_bugs.some((bug) => typeof bug !== 'string')) {
    errors.push('detected_bugs must be an array of strings');
  }
  return errors;
}

function validateTarget(value, prompt) {
  const errors = [];
  const ids = extractInteractiveIds(prompt);

  if (value.action === 'click' || value.action === 'type') {
    if (typeof value.target !== 'number') {
      errors.push(`${value.action} target must be a data-qa-id number`);
    } else if (!ids.has(value.target)) {
      errors.push(`${value.action} target ${value.target} is not in interactive elements`);
    }
  }

  if (value.action === 'navigate') {
    if (typeof value.target !== 'string' || !/^https?:\/\//i.test(value.target)) {
      errors.push('navigate target must be a full http(s) URL string');
    }
  }

  if (value.action === 'scroll') {
    if (value.target !== null) errors.push('scroll target must be null');
    if (value.value !== 'down' && value.value !== 'up') errors.push('scroll value must be down or up');
  }

  if (value.action === 'wait' || value.action === 'finish') {
    if (value.target !== null) errors.push(`${value.action} target must be null`);
  }

  return errors;
}

function validateAssertions(value, testCase) {
  const errors = [];
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
        errors.push(`disallowed repeated action ${item.action} target=${item.target}`);
      }
    }
  }
  if (assertions.detectedBugsMustBeEmpty && value.detected_bugs.length !== 0) {
    errors.push('detected_bugs must be empty for clean logs/network');
  }
  if (assertions.detectedBugsMustNotBeEmpty && value.detected_bugs.length === 0) {
    errors.push('detected_bugs must not be empty');
  }
  if (assertions.detectedBugsMustNotEqualReasoning && value.detected_bugs.includes(value.reasoning)) {
    errors.push('detected_bugs must not copy reasoning');
  }
  if (assertions.disallowInvalidNavigate && value.action === 'navigate' && !/^https?:\/\//i.test(String(value.target))) {
    errors.push('invalid navigate target');
  }
  return errors;
}

function scoreCase(testCase, responseText) {
  const parsed = parseModelJson(responseText);
  const result = {
    id: testCase.id,
    valid_json: !parsed.error,
    schema_ok: false,
    target_ok: false,
    no_repeat: false,
    bug_precision: false,
    assertions_ok: false,
    errors: []
  };

  if (parsed.error) {
    result.errors.push(`invalid JSON: ${parsed.error.message}`);
    return result;
  }

  const value = parsed.value;
  const schemaErrors = validateSchema(value);
  result.schema_ok = schemaErrors.length === 0;
  result.errors.push(...schemaErrors);

  if (result.schema_ok) {
    const targetErrors = validateTarget(value, testCase.prompt);
    result.target_ok = targetErrors.length === 0;
    result.errors.push(...targetErrors);

    const previous = extractPreviousActionTargets(testCase.prompt);
    const actionTarget = `${value.action}:${normalizeTarget(value.target)}`;
    result.no_repeat = !previous.has(actionTarget);
    if (!result.no_repeat) {
      result.errors.push(`repeated previous or failed action: ${actionTarget}`);
    }

    result.bug_precision = !(hasCleanLogs(testCase.prompt) && value.detected_bugs.length > 0);
    if (!result.bug_precision) {
      result.errors.push('reported bugs despite clean console and network context');
    }

    const assertionErrors = validateAssertions(value, testCase);
    result.assertions_ok = assertionErrors.length === 0;
    result.errors.push(...assertionErrors);
  }

  return result;
}

async function queryOllama(testCase, args) {
  const systemContent = args.systemFile
    ? fs.readFileSync(path.resolve(args.systemFile), 'utf8').trim()
    : 'You are AuraTest AI. Reply only with one valid JSON object: {"reasoning":"string","action":"click|type|scroll|navigate|wait|finish","target":null,"value":null,"detected_bugs":[]}.';
  const url = args.host.includes('/api/chat')
    ? args.host
    : `${args.host.replace(/\/$/, '')}/api/chat`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
  let response;
  try {
  response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal,
    body: JSON.stringify({
      model: args.model,
      messages: [
        {
          role: 'system',
          content: systemContent
        },
        { role: 'user', content: testCase.prompt }
      ],
      stream: false,
      format: 'json',
      options: {
        temperature: 0,
        top_p: 0.9,
        top_k: 20,
        num_predict: 384
      }
    })
  });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Ollama timeout after ${args.timeoutMs}ms for case ${testCase.id}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama error ${response.status}: ${text}`);
  }

  const data = await response.json();
  return data.message?.content || '';
}

function summarize(results) {
  const metrics = ['valid_json', 'schema_ok', 'target_ok', 'no_repeat', 'bug_precision', 'assertions_ok'];
  const summary = {};
  for (const metric of metrics) {
    const passed = results.filter((result) => result[metric]).length;
    summary[metric] = {
      passed,
      total: results.length,
      rate: results.length ? passed / results.length : 0
    };
  }
  return summary;
}

function printResults(results, summary, args, responsesById) {
  const label = args.responses ? `responses from ${args.responses}` : (args.runModel ? args.model : 'offline expected outputs');
  console.log(`\nAuraTest Gemma Eval (${label})`);
  console.log('='.repeat(72));
  for (const result of results) {
    const ok = result.valid_json && result.schema_ok && result.target_ok &&
      result.no_repeat && result.bug_precision && result.assertions_ok;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${result.id}`);
    for (const error of result.errors) {
      console.log(`  - ${error}`);
    }
    if (!ok && args.verbose && responsesById.has(result.id)) {
      console.log('  response:');
      console.log(`  ${responsesById.get(result.id).replace(/\n/g, '\n  ')}`);
    }
  }

  console.log('\nMetrics');
  for (const [name, value] of Object.entries(summary)) {
    const pct = Math.round(value.rate * 100);
    console.log(`  ${name.padEnd(14)} ${String(value.passed).padStart(2)}/${value.total} (${pct}%)`);
  }
}

function inferFailureMode(result) {
  const text = result.errors.join(' | ');
  if (/expected target 2, got 1|home|generic/i.test(text)) return 'generic_home_over_specific_content';
  if (/action must be one of|missing key|value must be string|target must be a data-qa-id/i.test(text)) return 'schema_or_shape_error';
  if (/detected_bugs must not be empty/i.test(text)) return 'missed_real_runtime_bug';
  if (/detected_bugs must be empty|reported bugs despite clean/i.test(text)) return 'false_positive_bug_report';
  if (/repeated previous|disallowed repeated/i.test(text)) return 'repeat_previous_or_failed_action';
  if (/navigate target|invalid navigate/i.test(text)) return 'invalid_navigate_target';
  if (/expected action type, got click/i.test(text)) return 'clicked_before_required_input';
  return 'eval_assertion_failure';
}

function loadExistingFailureKeys(filePath) {
  const keys = new Set();
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) return keys;
  const lines = fs.readFileSync(absolute, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      keys.add(`${item.caseId}|${item.failureMode}|${JSON.stringify(item.rejected)}`);
    } catch (error) {
      // Ignore malformed historical lines; export-preferences will catch them when used.
    }
  }
  return keys;
}

function failureModelLabel(args) {
  if (args.modelLabel) return args.modelLabel;
  if (args.runModel) return args.model;
  if (args.responses) return `responses:${path.basename(args.responses)}`;
  return 'offline-expected';
}

function appendFailureRecords(results, cases, responsesById, args) {
  if (!args.writeFailures || (!args.runModel && !args.responses)) return 0;
  const caseById = new Map(cases.map((testCase) => [testCase.id, testCase]));
  const existing = loadExistingFailureKeys(args.writeFailures);
  const model = failureModelLabel(args);
  const records = [];

  for (const result of results) {
    const ok = result.valid_json && result.schema_ok && result.target_ok &&
      result.no_repeat && result.bug_precision && result.assertions_ok;
    if (ok) continue;

    const testCase = caseById.get(result.id);
    const raw = responsesById.get(result.id) || '';
    const parsed = parseModelJson(raw);
    const rejected = parsed.value || { raw_response: raw };
    const failureMode = inferFailureMode(result);
    const record = {
      caseId: result.id,
      model,
      failureMode,
      rejected,
      notes: result.errors.join('; '),
      tags: testCase?.tags || []
    };
    const key = `${record.caseId}|${record.failureMode}|${JSON.stringify(record.rejected)}`;
    if (!existing.has(key)) {
      records.push(record);
      existing.add(key);
    }
  }

  if (records.length === 0) return 0;
  const absolute = path.resolve(args.writeFailures);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.appendFileSync(absolute, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
  return records.length;
}

async function main() {
  const args = parseArgs(process.argv);
  const cases = filterCases(loadCases(args.cases), args);
  if (cases.length === 0) {
    throw new Error(`No eval cases matched${args.tag ? ` tag "${args.tag}"` : ''}.`);
  }
  const results = [];
  const responsesById = args.responses ? loadResponses(args.responses) : new Map();

  for (const testCase of cases) {
    let responseText;
    if (args.responses) {
      if (!responsesById.has(testCase.id)) {
        throw new Error(`Missing pre-generated response for case ${testCase.id}`);
      }
      responseText = responsesById.get(testCase.id);
    } else {
      responseText = args.runModel
        ? await queryOllama(testCase, args)
        : JSON.stringify(testCase.expected);
      responsesById.set(testCase.id, responseText);
    }
    results.push(scoreCase(testCase, responseText));
  }

  const summary = summarize(results);
  printResults(results, summary, args, responsesById);
  const writtenFailures = appendFailureRecords(results, cases, responsesById, args);
  if (writtenFailures > 0) {
    console.log(`\nWrote ${writtenFailures} new failure records to ${args.writeFailures}`);
  }

  const allPassed = Object.values(summary).every((metric) => metric.passed === metric.total);
  if (args.strict && !allPassed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
