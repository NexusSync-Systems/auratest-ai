#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import process from 'process';

function parseArgs(argv) {
  const args = {
    cases: 'adapters/auauratesting-gemma/eval-cases.jsonl',
    failures: 'adapters/auauratesting-gemma/model-failures.jsonl',
    output: 'adapters/auauratesting-gemma/data/auratest-gemma-preferences.jsonl'
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cases') args.cases = argv[++i];
    else if (arg === '--failures') args.failures = argv[++i];
    else if (arg === '--output') args.output = argv[++i];
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
  node tools/llm-eval/export-preferences.js
  node tools/llm-eval/export-preferences.js --cases adapters/auauratesting-gemma/eval-cases.jsonl --failures adapters/auauratesting-gemma/model-failures.jsonl
`);
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

function loadSystemPrompt() {
  const adapterPrompt = path.resolve('adapters/auauratesting-gemma/system-prompt.txt');
  if (fs.existsSync(adapterPrompt)) {
    return fs.readFileSync(adapterPrompt, 'utf8').trim();
  }
  return [
    'You are AuraTest AI, a JSON-only QA testing agent.',
    'Reply with exactly one valid JSON object.',
    'Use click/type with numeric data-qa-id targets.',
    'Never repeat actions from History or FAILED ACTIONS MEMORY.'
  ].join(' ');
}

function normalizeAssistantContent(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function indexCases(cases) {
  return new Map(cases.map((testCase) => [testCase.id, testCase]));
}

function toPreferenceRecord(failure, testCase, systemPrompt) {
  return {
    id: `${failure.caseId}-${failure.failureMode}`,
    source: {
      caseId: failure.caseId,
      model: failure.model || 'unknown',
      failureMode: failure.failureMode,
      notes: failure.notes || ''
    },
    tags: Array.isArray(testCase.tags) ? testCase.tags : [],
    prompt: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: testCase.prompt }
    ],
    chosen: {
      role: 'assistant',
      content: normalizeAssistantContent(testCase.expected)
    },
    rejected: {
      role: 'assistant',
      content: normalizeAssistantContent(failure.rejected)
    }
  };
}

function writeJsonl(outputPath, records) {
  const absolute = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
  return absolute;
}

function main() {
  const args = parseArgs(process.argv);
  const cases = indexCases(loadJsonl(args.cases));
  const failures = loadJsonl(args.failures);
  const systemPrompt = loadSystemPrompt();
  const records = failures.map((failure) => {
    const testCase = cases.get(failure.caseId);
    if (!testCase) {
      throw new Error(`Failure references missing eval case: ${failure.caseId}`);
    }
    return toPreferenceRecord(failure, testCase, systemPrompt);
  });
  const outputPath = writeJsonl(args.output, records);

  console.log(`Exported ${records.length} preference records to ${outputPath}`);
}

main();
