"""
Лёгкий HTTP-сервер вокруг /opt/parakeet/transcribe.py.

Слушает на 127.0.0.1:8002 (доступен из Docker через host.docker.internal).
Принимает multipart/form-data с файлом audio, возвращает JSON {"text": "..."}.

Использует системный /usr/bin/python3 для transcribe.py (там стоит onnx-asr).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse

PARAKEET_SCRIPT = "/opt/parakeet/transcribe.py"

app = FastAPI(title="parakeet-server", version="0.1.0")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)) -> JSONResponse:
    suffix = os.path.splitext(audio.filename or "audio.ogg")[1] or ".ogg"
    tmp_path = tempfile.mktemp(suffix=suffix)
    try:
        with open(tmp_path, "wb") as fh:
            shutil.copyfileobj(audio.file, fh)

        result = subprocess.run(
            ["python3", PARAKEET_SCRIPT, tmp_path],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail=f"parakeet failed: {result.stderr.strip()[:500]}",
            )
        return JSONResponse({"text": result.stdout.strip()})
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
