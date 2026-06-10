"""HTTP-сервер вокруг Parakeet-TDT v3 (int8 ONNX).

Модель грузится ОДИН раз при старте сервера и переиспользуется
для всех запросов — это во много раз быстрее, чем поднимать
интерпретатор и модель на каждый POST через subprocess.

Слушает на 127.0.0.1:8002 (порт по умолчанию, можно переопределить
через --port).

Endpoints:
  GET  /health     → {"status": "ok"}
  POST /transcribe → multipart/form-data, поле "audio" — возвращает {"text": "..."}
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import tempfile
from pathlib import Path

# Дать импортировать соседний transcribe.py из /opt/parakeet/
THIS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(THIS_DIR.parent / "parakeet"))
sys.path.insert(0, "/opt/parakeet")

from fastapi import FastAPI, File, HTTPException, UploadFile  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402

import transcribe  # noqa: E402

app = FastAPI(title="parakeet-server", version="1.0.0")
_model = None


@app.on_event("startup")
async def _load_model() -> None:
    """Загрузить модель один раз при старте процесса."""
    global _model
    _model = transcribe.load_model()


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "model_loaded": str(_model is not None)}


@app.post("/transcribe")
async def transcribe_endpoint(audio: UploadFile = File(...)) -> JSONResponse:
    if _model is None:
        raise HTTPException(status_code=503, detail="model not loaded yet")
    suffix = os.path.splitext(audio.filename or "audio.ogg")[1] or ".ogg"
    tmp_path = tempfile.mktemp(suffix=suffix)
    try:
        with open(tmp_path, "wb") as fh:
            shutil.copyfileobj(audio.file, fh)
        text = transcribe.transcribe(tmp_path, model=_model)
        return JSONResponse({"text": text.strip()})
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=500, detail=f"transcribe failed: {exc}")
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8002)
    args = parser.parse_args()
    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port)
