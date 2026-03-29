#!/usr/bin/env python3

import argparse
import json
import sys
from pathlib import Path

import torch
from transformers import pipeline


def parse_args():
    parser = argparse.ArgumentParser(description="Transcribe audio with a local Whisper model.")
    parser.add_argument("--audio-path")
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--language", default="zh")
    parser.add_argument("--worker", action="store_true")
    return parser.parse_args()


def ensure_model_path(model_path: Path):
    if not model_path.exists():
        raise FileNotFoundError(f"whisper model path not found: {model_path}")


def ensure_audio_path(audio_path: Path):
    if not audio_path.exists():
        raise FileNotFoundError(f"audio file not found: {audio_path}")


def create_pipeline(model_path: Path):
    ensure_model_path(model_path)
    device = 0 if torch.cuda.is_available() else -1
    dtype = torch.float16 if torch.cuda.is_available() else torch.float32
    pipe = pipeline(
        "automatic-speech-recognition",
        model=str(model_path),
        torch_dtype=dtype,
        device=device
    )
    return pipe, device, dtype


def transcribe(pipe, audio_path: Path, language: str):
    ensure_audio_path(audio_path)
    result = pipe(
        str(audio_path),
        generate_kwargs={
            "language": language,
            "task": "transcribe"
        },
        return_timestamps=False
    )
    return str(result.get("text", "")).strip()


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def run_once(args):
    if not args.audio_path:
        raise ValueError("--audio-path is required unless --worker is set")

    pipe, _device, _dtype = create_pipeline(Path(args.model_path))
    text = transcribe(pipe, Path(args.audio_path), args.language)
    emit({
        "ok": True,
        "text": text
    })


def run_worker(args):
    pipe, device, dtype = create_pipeline(Path(args.model_path))
    emit({
        "event": "ready",
        "ok": True,
        "device": "cuda" if device == 0 else "cpu",
        "dtype": str(dtype)
    })

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        request_id = ""
        try:
            payload = json.loads(line)
            request_id = str(payload.get("id", "")).strip()
            if not request_id:
                raise ValueError("missing request id")

            audio_path = Path(str(payload.get("audio_path", "")).strip())
            language = str(payload.get("language") or "zh").strip() or "zh"
            text = transcribe(pipe, audio_path, language)
            emit({
                "id": request_id,
                "ok": True,
                "text": text
            })
        except Exception as error:
            emit({
                "id": request_id,
                "ok": False,
                "error": str(error)
            })


def main():
    args = parse_args()
    if args.worker:
        run_worker(args)
        return

    run_once(args)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({
            "ok": False,
            "error": str(error)
        })
        raise SystemExit(1)
