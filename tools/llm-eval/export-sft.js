#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import process from 'process';

function parseArgs(argv) {
  const args = {
    cases: 'tools/llm-eval/eval-cases.jsonl',
    output: 'data/training/auratest-gemma-sft.jsonl'
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cases') args.cases = argv[++i];
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
  node tools/llm-eval/export-sft.js
  node tools/llm-eval/export-sft.js --cases tools/llm-eval/eval-cases.jsonl --output data/training/auratest-gemma-sft.jsonl
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

function toTrainingRecord(testCase) {
  const tags = Array.isArray(testCase.tags) ? testCase.tags : [];
  return {
    id: testCase.id,
    source: 'tools/llm-eval/eval-cases.jsonl',
    tags,
    messages: [
      {
        role: 'system',
        content: [
          'You are AuraTest AI, a JSON-only QA testing agent.',
          'Reply only with one valid JSON object containing reasoning, action, target, value, and detected_bugs.',
          'Use click/type with numeric data-qa-id targets.',
          'Use navigate only with full http(s) URLs.',
          'Do not repeat actions from History or FAILED ACTIONS MEMORY.',
          'If logs and network errors are clean, detected_bugs must be [].'
        ].join(' ')
      },
      {
        role: 'user',
        content: testCase.prompt
      },
      {
        role: 'assistant',
        content: JSON.stringify(testCase.expected)
      }
    ]
  };
}

function writeJsonl(outputPath, records) {
  const absolute = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const body = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  fs.writeFileSync(absolute, body, 'utf8');
  return absolute;
}

function main() {
  const args = parseArgs(process.argv);
  const cases = loadJsonl(args.cases);
  const records = cases.map(toTrainingRecord);
  const outputPath = writeJsonl(args.output, records);

  console.log(`Exported ${records.length} SFT records to ${outputPath}`);
}

main();
