#!/usr/bin/env python3
import argparse
import json
import os
import time
from pathlib import Path

from faster_whisper import WhisperModel


def main() -> int:
    parser = argparse.ArgumentParser(description="Transcribe one audio file with faster-whisper")
    parser.add_argument("audio", type=Path)
    parser.add_argument("--model", default=os.getenv("FASTER_WHISPER_MODEL", "medium"))
    parser.add_argument("--compute-type", default=os.getenv("FASTER_WHISPER_COMPUTE_TYPE", "int8"))
    parser.add_argument("--threads", type=int, default=int(os.getenv("FASTER_WHISPER_THREADS", "2")))
    parser.add_argument("--language", default=os.getenv("FASTER_WHISPER_LANGUAGE", "auto"))
    parser.add_argument(
        "--model-dir",
        default=os.getenv(
            "FASTER_WHISPER_MODEL_DIR",
            str(Path.home() / ".cache" / "cody-tgbot" / "faster-whisper"),
        ),
    )
    args = parser.parse_args()

    language = args.language.strip() or "auto"
    language_arg = None if language.lower() == "auto" else language

    started = time.perf_counter()
    model = WhisperModel(
        args.model,
        device="cpu",
        compute_type=args.compute_type,
        cpu_threads=args.threads,
        num_workers=1,
        download_root=str(Path(args.model_dir).expanduser()),
    )

    segments, info = model.transcribe(
        str(args.audio),
        language=language_arg,
        beam_size=5,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    text = " ".join(segment.text.strip() for segment in segments).strip()
    duration_ms = int((time.perf_counter() - started) * 1000)

    print(
        json.dumps(
            {
                "text": text,
                "durationMs": duration_ms,
                "model": args.model,
                "computeType": args.compute_type,
                "language": language_arg or getattr(info, "language", None),
                "languageProbability": getattr(info, "language_probability", None),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
