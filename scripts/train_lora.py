import os
import json
import torch
from datasets import Dataset
from transformers import AutoTokenizer, AutoModelForCausalLM, TrainingArguments
from peft import LoraConfig, get_peft_model
from trl import SFTTrainer

# Cesty k datasetu a výstupnímu modelu
DATASET_CLEANED = "auratest_dataset_cleaned.jsonl"
DATASET_RAW = "auratest_dataset.jsonl"
BASE_MODEL = "google/gemma-2-2b-it"  # Můžete změnit např. na "google/gemma-2-2b"
OUTPUT_DIR = "./gemma-2-2b-auratest-lora"

def load_data():
    dataset_path = DATASET_CLEANED if os.path.exists(DATASET_CLEANED) else DATASET_RAW
    if not os.path.exists(dataset_path):
        raise FileNotFoundError(f"Dataset nenalezen v {dataset_path}. Nahrajte prosím nejprve nějaká data v UI.")

    print(f"📖 Načítám dataset ze souboru: {dataset_path}...")
    formatted_texts = []
    
    # Šablona pro model Gemma-2-it:
    # <start_of_turn>user
    # {system_prompt}\n\n{user_prompt}<end_of_turn>
    # <start_of_turn>model
    # {assistant_response}<end_of_turn>
    
    with open(dataset_path, "r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            item = json.loads(line)
            messages = item.get("messages", [])
            
            system_content = ""
            user_content = ""
            assistant_content = ""
            
            for m in messages:
                if m["role"] == "system":
                    system_content = m["content"]
                elif m["role"] == "user":
                    user_content = m["content"]
                elif m["role"] == "assistant":
                    assistant_content = m["content"]
            
            # Sestavení zpráv do Gemma-2 formátu
            prompt = f"{system_content}\n\n{user_content}" if system_content else user_content
            formatted_text = (
                f"<start_of_turn>user\n{prompt}<end_of_turn>\n"
                f"<start_of_turn>model\n{assistant_content}<end_of_turn>\n"
            )
            formatted_texts.append({"text": formatted_text})
            
    print(f"📊 Načteno {len(formatted_texts)} tréninkových příkladů.")
    return Dataset.from_list(formatted_texts)

def main():
    # Načtení dat
    train_dataset = load_data()

    # Určení hardware akcelerace (CUDA pro Nvidia, MPS pro Apple Silicon, CPU jako fallback)
    device = "cpu"
    if torch.cuda.is_available():
        device = "cuda"
    elif torch.backends.mps.is_available():
        device = "mps"
    print(f"💻 Trénink poběží na zařízení: {device.upper()}")

    # Načtení tokenizeru
    print(f"📥 Stahuji tokenizer pro {BASE_MODEL}...")
    tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL)
    tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "right"

    # Načtení základního modelu
    print(f"📥 Stahuji a načítám základní model {BASE_MODEL}...")
    
    # Pro úsporu VRAM/RAM načteme model s bfloat16 (nebo float16 na starších kartách)
    torch_dtype = torch.bfloat16 if device != "cpu" else torch.float32
    
    model = AutoModelForCausalLM.from_pretrained(
        BASE_MODEL,
        torch_dtype=torch_dtype,
        device_map="auto" if device == "cuda" else None
    )
    
    if device == "mps":
        model = model.to("mps")

    # Konfigurace LoRA (Low-Rank Adaptation)
    print("🧠 Konfiguruji LoRA adaptér...")
    lora_config = LoraConfig(
        r=8,
        lora_alpha=16,
        target_modules=["q_proj", "o_proj", "k_proj", "v_proj", "gate_proj", "up_proj", "down_proj"],
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM"
    )

    # Konfigurace trénovacích parametrů
    training_args = TrainingArguments(
        output_dir=OUTPUT_DIR,
        per_device_train_batch_size=1,
        gradient_accumulation_steps=4,
        learning_rate=2e-4,
        logging_steps=10,
        num_train_epochs=3,
        weight_decay=0.01,
        warmup_ratio=0.03,
        lr_scheduler_type="cosine",
        save_strategy="epoch",
        fp16=(device == "cuda"),  # Použít float16 pouze na CUDA GPU
        use_mps_device=(device == "mps"),
        report_to="none"
    )

    # Trénink pomocí SFTTrainer
    print("🚀 Spouštím trénování...")
    trainer = SFTTrainer(
        model=model,
        train_dataset=train_dataset,
        peft_config=lora_config,
        dataset_text_field="text",
        max_seq_length=1024,
        tokenizer=tokenizer,
        args=training_args,
    )

    trainer.train()

    # Uložení vytrénovaného adaptéru
    print(f"💾 Ukládám vytrénované váhy adaptéru do: {OUTPUT_DIR}...")
    trainer.model.save_pretrained(OUTPUT_DIR)
    tokenizer.save_pretrained(OUTPUT_DIR)
    
    print("\n🎉 FINE-TUNING BYL DOKONČEN ÚSPĚŠNĚ!")
    print("--------------------------------------------------")
    print("Nyní můžete tento adaptér připojit přímo do vašeho Ollama Modelfilu:")
    print(f"1. Zkopírujte složku '{OUTPUT_DIR}' do vašeho projektu.")
    print("2. Do vašeho Modelfilu přidejte řádek:")
    print(f"   ADAPTER {os.path.abspath(OUTPUT_DIR)}")
    print("3. Spusťte: ollama create auratest-gemma2 -f <cesta-k-modelfilu>")
    print("--------------------------------------------------")

if __name__ == "__main__":
    main()
