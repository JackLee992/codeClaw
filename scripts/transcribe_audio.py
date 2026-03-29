#!/usr/bin/env python3

import argparse
import json
from pathlib import Path

import torch
from transformers import pipeline


def parse_args():
    parser = argparse.ArgumentParser(description="Transcribe audio with a local Whisper model.")
    parser.add_argument("--audio-path", required=True)
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--language", default="zh")
    return parser.parse_args()


def main():
    args = parse_args()
    audio_path = Path(args.audio_path)
    model_path = Path(args.model_path)

    if not audio_path.exists():
        raise SystemExit(json.dumps({"ok": False, "error": f"audio file not found: {audio_path}"}, ensure_ascii=False))

    if not model_path.exists():
        raise SystemExit(json.dumps({"ok": False, "error": f"whisper model path not found: {model_path}"}, ensure_ascii=False))

    device = 0 if torch.cuda.is_available() else -1
    dtype = torch.float16 if torch.cuda.is_available() else torch.float32

    pipe = pipeline(
        "automatic-speech-recognition",
        model=str(model_path),
        torch_dtype=dtype,
        device=device
    )
    result = pipe(
        str(audio_path),
        generate_kwargs={
            "language": args.language,
            "task": "transcribe"
        },
        return_timestamps=False
    )

    payload = {
        "ok": True,
        "text": str(result.get("text", "")).strip()
    }
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
