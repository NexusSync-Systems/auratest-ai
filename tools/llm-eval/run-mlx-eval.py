#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

from mlx_lm import generate, load
from mlx_lm.sample_utils import make_sampler


DEFAULT_SYSTEM = (
    'You are AuraTest AI. Reply only with one valid JSON object: '
    '{"reasoning":"string","action":"click|type|scroll|navigate|wait|finish",'
    '"target":null,"value":null,"detected_bugs":[]}.'
)


def parse_args():
    parser = argparse.ArgumentParser(description='Generate AuraTest eval responses with an MLX LoRA adapter.')
    parser.add_argument('--cases', default='adapters/auauratesting-gemma/eval-cases.jsonl')
    parser.add_argument('--system-file', default='adapters/auauratesting-gemma/system-prompt.txt')
    parser.add_argument('--model', default='mlx-community/gemma-2-2b-it-4bit')
    parser.add_argument('--adapter-path', default='adapters/auauratesting-gemma/finetune/output/lowram-lora')
    parser.add_argument('--output', default='adapters/auauratesting-gemma/finetune/mlx-responses.jsonl')
    parser.add_argument('--max-tokens', type=int, default=384)
    parser.add_argument('--limit', type=int, default=0)
    return parser.parse_args()


def load_jsonl(path):
    records = []
    with Path(path).open('r', encoding='utf-8') as handle:
        for index, line in enumerate(handle, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as error:
                raise ValueError(f'Invalid JSONL at {path}:{index}: {error}') from error
    return records


def render_prompt(tokenizer, system_content, user_content):
    content = f'{system_content.strip()}\n\n{user_content.strip()}'
    messages = [{'role': 'user', 'content': content}]
    return tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)


def first_json_object(text):
    start = text.find('{')
    if start < 0:
        return text.strip()

    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if escaped:
            escaped = False
            continue
        if char == '\\':
            escaped = True
            continue
        if char == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if char == '{':
            depth += 1
        elif char == '}':
            depth -= 1
            if depth == 0:
                return text[start:index + 1].strip()

    return text.strip()


def main():
    args = parse_args()
    system_content = Path(args.system_file).read_text(encoding='utf-8').strip() if args.system_file else DEFAULT_SYSTEM
    cases = load_jsonl(args.cases)
    if args.limit > 0:
        cases = cases[:args.limit]

    model, tokenizer = load(args.model, adapter_path=args.adapter_path)
    sampler = make_sampler(temp=0.0)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with output_path.open('w', encoding='utf-8') as handle:
        for index, case in enumerate(cases, start=1):
            prompt = render_prompt(tokenizer, system_content, case['prompt'])
            response = generate(
                model,
                tokenizer,
                prompt=prompt,
                max_tokens=args.max_tokens,
                sampler=sampler,
                verbose=False,
            ).strip()
            response = first_json_object(response)
            handle.write(json.dumps({'id': case['id'], 'response': response}, ensure_ascii=False) + '\n')
            handle.flush()
            print(f'{index}/{len(cases)} {case["id"]}', flush=True)

    print(f'Wrote MLX responses to {output_path}')


if __name__ == '__main__':
    main()
