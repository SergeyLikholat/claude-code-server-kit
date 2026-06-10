#!/usr/bin/env python3
"""Parakeet-TDT 0.6B v3 int8 ONNX voice transcription (standalone CLI).

Usage: python3 transcribe.py <audio_file>

The HTTP server in parakeet-server/ loads the model once at startup
and reuses it — this CLI is for ad-hoc invocations and tests.
"""
import os
import sys
import subprocess
import tempfile

MODEL_DIR = os.environ.get("PARAKEET_MODEL_DIR", "/opt/parakeet")
SAMPLE_RATE = 16000


def convert_to_wav(input_path: str) -> str:
    """Convert any audio format to 16kHz mono PCM16 WAV via ffmpeg."""
    tmp = tempfile.mktemp(suffix=".wav")
    subprocess.run(
        [
            "ffmpeg", "-y", "-i", input_path,
            "-ar", str(SAMPLE_RATE), "-ac", "1",
            "-acodec", "pcm_s16le",
            tmp,
        ],
        capture_output=True, check=True,
    )
    return tmp


def load_model():
    """Load the Parakeet-TDT v3 int8 ONNX model. Returns onnx_asr model handle."""
    import onnx_asr
    return onnx_asr.load_model(
        "nemo-parakeet-tdt-0.6b-v3",
        path=MODEL_DIR,
        quantization="int8",
    )


def transcribe(audio_path: str, model=None) -> str:
    if model is None:
        model = load_model()
    wav_path = convert_to_wav(audio_path)
    try:
        return model.recognize(wav_path)
    finally:
        try:
            os.unlink(wav_path)
        except OSError:
            pass


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 transcribe.py <audio_file>", file=sys.stderr)
        sys.exit(1)
    print(transcribe(sys.argv[1]))
