#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import process from 'process';

const MODE_PRIORITY = [
  'schema_or_shape_error',
  'combined_or_wrong_form_action',
  'missed_real_runtime_bug',
  'missed_real_network_bug',
  'generic_home_over_specific_content',
  'clicked_before_required_input',
  'submit_or_wrong_click_before_inputs',
  'repeat_previous_or_failed_action',
  'repeat_older_action',
  'invalid_navigate_target',
  'false_positive_bug_report',
  'eval_assertion_failure'
];

function parseArgs(argv) {
  const args = { input: 'adapters/auauratesting-gemma/model-failures.jsonl' };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') args.input = argv[++i];
    else if (arg === '--help') {
      console.log('Usage: node tools/llm-eval/normalize-failures.js --input adapters/auauratesting-gemma/model-failures.jsonl');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function modeRank(mode) {
  const index = MODE_PRIORITY.indexOf(mode);
  return index === -1 ? MODE_PRIORITY.length : index;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const body = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

function canonicalRejected(value) {
  return stableStringify(value);
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

function main() {
  const args = parseArgs(process.argv);
  const absolute = path.resolve(args.input);
  const records = loadJsonl(absolute);
  const byKey = new Map();

  for (const record of records) {
    const key = `${record.caseId}|${canonicalRejected(record.rejected)}`;
    const existing = byKey.get(key);
    if (!existing || modeRank(record.failureMode) < modeRank(existing.failureMode)) {
      byKey.set(key, record);
    }
  }

  const normalized = [...byKey.values()].sort((a, b) => {
    const caseOrder = String(a.caseId).localeCompare(String(b.caseId));
    if (caseOrder !== 0) return caseOrder;
    return modeRank(a.failureMode) - modeRank(b.failureMode);
  });

  fs.writeFileSync(absolute, normalized.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
  console.log(`Normalized ${records.length} failure records to ${normalized.length} unique records in ${absolute}`);
}

main();
