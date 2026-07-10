#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import process from 'process';

function parseArgs(argv) {
  const args = {
    failures: 'adapters/auauratesting-gemma/model-failures.jsonl',
    output: 'adapters/auauratesting-gemma/data/failure-report.md'
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--failures') args.failures = argv[++i];
    else if (arg === '--output') args.output = argv[++i];
    else if (arg === '--help') {
      console.log('Usage: node tools/llm-eval/report-failures.js --failures adapters/auauratesting-gemma/model-failures.jsonl --output adapters/auauratesting-gemma/data/failure-report.md');
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

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) || 0) + amount);
}

function sortedEntries(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

function markdownTable(headers, rows) {
  if (rows.length === 0) return '_No records._\n';
  const header = `| ${headers.join(' |')} |`;
  const divider = `| ${headers.map(() => '---').join(' |')} |`;
  const body = rows.map((row) => `| ${row.map((cell) => String(cell).replace(/\|/g, '\\|')).join(' |')} |`);
  return [header, divider, ...body].join('\n') + '\n';
}

function summarize(records) {
  const byMode = new Map();
  const byCase = new Map();
  const byTag = new Map();
  const schemaMissingKeys = new Map();

  for (const record of records) {
    increment(byMode, record.failureMode || 'unknown');
    increment(byCase, record.caseId || 'unknown');
    for (const tag of record.tags || []) increment(byTag, tag);

    const notes = String(record.notes || '');
    for (const match of notes.matchAll(/missing key: ([a-z_]+)/gi)) {
      increment(schemaMissingKeys, match[1]);
    }
  }

  return { byMode, byCase, byTag, schemaMissingKeys };
}

function recommendationForMode(mode) {
  const recommendations = {
    schema_or_shape_error: 'Add short JSON-shape examples and keep eval temperature at 0.',
    generic_home_over_specific_content: 'Add hard negatives where home/back/dashboard loses to specific content.',
    clicked_before_required_input: 'Prefer empty required inputs and disabled-button unlock paths before submit.',
    submit_or_wrong_click_before_inputs: 'Add multi-step form cases showing one action per turn.',
    repeat_previous_or_failed_action: 'Keep FAILED ACTIONS MEMORY visible and add older-history repeats.',
    repeat_older_action: 'Train against repeats from any previous step, not only the last step.',
    missed_real_runtime_bug: 'Pair each real console/network error with a concise detected_bugs item.',
    missed_real_network_bug: 'Add more HTTP 4xx/5xx and net::ERR_FAILED examples.',
    invalid_navigate_target: 'Use click for data-qa-id/href; navigate only for full http(s) URLs.',
    false_positive_bug_report: 'Add clean-log examples with detected_bugs=[].',
    eval_assertion_failure: 'Review case-specific prompt wording and add one focused counterexample.'
  };
  return recommendations[mode] || 'Review examples for this mode and add one focused canonical case.';
}

function buildReport(records) {
  const summary = summarize(records);
  const generatedAt = new Date().toISOString();
  const modeRows = sortedEntries(summary.byMode).map(([mode, count]) => [mode, count, recommendationForMode(mode)]);
  const caseRows = sortedEntries(summary.byCase).slice(0, 12).map(([caseId, count]) => [caseId, count]);
  const tagRows = sortedEntries(summary.byTag).map(([tag, count]) => [tag, count]);
  const missingKeyRows = sortedEntries(summary.schemaMissingKeys).map(([key, count]) => [key, count]);

  return [
    '# AuraTesting Gemma Failure Report',
    '',
    `Generated: ${generatedAt}`,
    `Total unique failures: ${records.length}`,
    '',
    '## Failure Modes',
    '',
    markdownTable(['Failure mode', 'Count', 'Next action'], modeRows),
    '## Top Cases',
    '',
    markdownTable(['Case', 'Count'], caseRows),
    '## Tags',
    '',
    markdownTable(['Tag', 'Count'], tagRows),
    '## Missing Schema Keys',
    '',
    markdownTable(['Missing key', 'Count'], missingKeyRows),
    '## Low-RAM Guidance',
    '',
    '- Keep `gemma2:2b`, `num_ctx 4096`, and deterministic eval settings.',
    '- Prefer compact hard-negative preference pairs over a larger model.',
    '- Re-run `eval:llm:capture`, `dataset:failures:normalize`, `dataset:preferences`, and this report after each prompt/data iteration.',
    ''
  ].join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  const records = loadJsonl(args.failures);
  const report = buildReport(records);
  const outputPath = path.resolve(args.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, report, 'utf8');
  console.log(`Wrote failure report for ${records.length} records to ${outputPath}`);
}

main();
