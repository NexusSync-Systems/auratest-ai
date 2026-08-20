#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import process from 'process';

function parseArgs(argv) {
  const args = {
    cases: 'adapters/auauratesting-gemma/eval-cases.jsonl',
    failures: 'adapters/auauratesting-gemma/model-failures-v3.jsonl',
    output: 'adapters/auauratesting-gemma/data/auratest-gemma-sft-v3-repair.jsonl',
    repeat: 2,
    includeAll: false
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cases') args.cases = argv[++i];
    else if (arg === '--failures') args.failures = argv[++i];
    else if (arg === '--output') args.output = argv[++i];
    else if (arg === '--repeat') args.repeat = Number(argv[++i]);
    else if (arg === '--include-all') args.includeAll = true;
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
  node tools/llm-eval/export-repair-sft.js
  node tools/llm-eval/export-repair-sft.js --failures adapters/auauratesting-gemma/model-failures-v3.jsonl --repeat 2 --include-all

Options:
  --cases PATH      Eval cases JSONL.
  --failures PATH   Failure JSONL whose caseId values should be emphasized.
  --output PATH     Output SFT JSONL.
  --repeat N        Extra copies for failed cases. Default: 2.
  --include-all     Include every eval case once before failed-case repeats.
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

function assistantContent(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function toSftRecord(testCase, systemPrompt, source, copyIndex) {
  return {
    id: copyIndex === 0 ? testCase.id : `${testCase.id}-repair-${copyIndex}`,
    source,
    tags: Array.isArray(testCase.tags) ? testCase.tags : [],
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: testCase.prompt },
      { role: 'assistant', content: assistantContent(testCase.expected) }
    ]
  };
}

function uniqueFailureCaseIds(failures) {
  const ids = [];
  const seen = new Set();
  for (const failure of failures) {
    if (!failure.caseId || seen.has(failure.caseId)) continue;
    seen.add(failure.caseId);
    ids.push(failure.caseId);
  }
  return ids;
}

function buildRecords(cases, failures, args) {
  const systemPrompt = loadSystemPrompt();
  const caseById = new Map(cases.map((testCase) => [testCase.id, testCase]));
  const records = [];

  if (args.includeAll) {
    for (const testCase of cases) {
      records.push(toSftRecord(testCase, systemPrompt, 'eval-case', 0));
    }
  }

  for (const caseId of uniqueFailureCaseIds(failures)) {
    const testCase = caseById.get(caseId);
    if (!testCase) {
      throw new Error(`Failure references missing eval case: ${caseId}`);
    }
    for (let copyIndex = 1; copyIndex <= args.repeat; copyIndex += 1) {
      records.push(toSftRecord(testCase, systemPrompt, 'v3-repair', copyIndex));
    }
  }

  return records;
}

function writeJsonl(outputPath, records) {
  const absolute = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
  return absolute;
}

function main() {
  const args = parseArgs(process.argv);
  if (!Number.isInteger(args.repeat) || args.repeat < 1 || args.repeat > 5) {
    throw new Error('--repeat must be an integer from 1 to 5');
  }
  const cases = loadJsonl(args.cases);
  const failures = loadJsonl(args.failures);
  const records = buildRecords(cases, failures, args);
  const outputPath = writeJsonl(args.output, records);

  console.log(`Exported ${records.length} repair SFT records to ${outputPath}`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
