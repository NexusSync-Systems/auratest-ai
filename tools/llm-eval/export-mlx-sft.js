#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import process from 'process';

function parseArgs(argv) {
  const args = {
    input: 'adapters/auauratesting-gemma/data/auratest-gemma-sft.jsonl',
    outputDir: 'adapters/auauratesting-gemma/finetune/mlx-data',
    trainRatio: 0.8,
    validRatio: 0.1
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') args.input = argv[++i];
    else if (arg === '--output-dir') args.outputDir = argv[++i];
    else if (arg === '--train-ratio') args.trainRatio = Number(argv[++i]);
    else if (arg === '--valid-ratio') args.validRatio = Number(argv[++i]);
    else if (arg === '--help') {
      console.log('Usage: node tools/llm-eval/export-mlx-sft.js --input adapters/auauratesting-gemma/data/auratest-gemma-sft.jsonl --output-dir adapters/auauratesting-gemma/finetune/mlx-data');
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

function normalizeRecord(record) {
  if (!Array.isArray(record.messages)) {
    throw new Error(`SFT record ${record.id || '<unknown>'} does not contain messages[]`);
  }
  const messages = record.messages.map((message) => ({
    role: message.role,
    content: String(message.content || '')
  }));
  const systemContent = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join('\n\n');
  const chatMessages = messages.filter((message) => message.role !== 'system');

  if (systemContent) {
    const firstUserIndex = chatMessages.findIndex((message) => message.role === 'user');
    if (firstUserIndex === -1) {
      throw new Error(`SFT record ${record.id || '<unknown>'} has system content but no user message`);
    }
    chatMessages[firstUserIndex] = {
      ...chatMessages[firstUserIndex],
      content: `${systemContent}\n\n${chatMessages[firstUserIndex].content}`.trim()
    };
  }

  return {
    messages: chatMessages
  };
}

function stableShuffle(records) {
  return [...records].sort((a, b) => {
    const aKey = JSON.stringify(a.messages);
    const bKey = JSON.stringify(b.messages);
    return aKey.localeCompare(bKey);
  });
}

function splitRecords(records, trainRatio, validRatio) {
  const trainCount = Math.max(1, Math.floor(records.length * trainRatio));
  const validCount = Math.max(1, Math.floor(records.length * validRatio));
  return {
    train: records.slice(0, trainCount),
    valid: records.slice(trainCount, trainCount + validCount),
    test: records.slice(trainCount + validCount)
  };
}

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
}

function main() {
  const args = parseArgs(process.argv);
  const records = stableShuffle(loadJsonl(args.input).map(normalizeRecord));
  const split = splitRecords(records, args.trainRatio, args.validRatio);
  const outputDir = path.resolve(args.outputDir);

  writeJsonl(path.join(outputDir, 'train.jsonl'), split.train);
  writeJsonl(path.join(outputDir, 'valid.jsonl'), split.valid);
  writeJsonl(path.join(outputDir, 'test.jsonl'), split.test);

  console.log(`Exported MLX SFT data to ${outputDir}`);
  console.log(`  train: ${split.train.length}`);
  console.log(`  valid: ${split.valid.length}`);
  console.log(`  test:  ${split.test.length}`);
}

main();
