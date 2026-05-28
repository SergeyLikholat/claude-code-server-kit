#!/usr/bin/env python3
"""
Nano Banana / Gemini Image Generation CLI wrapper.

Supports text-to-image, image-to-image, and multi-image composition via
Google AI Studio's Gemini image models.

Usage:
    generate.py --prompt "..." [--model flash|pro] [--aspect 16:9]
                [--size 2K] [--format png|jpeg|webp] [--output out.png]
                [--input ref1.jpg --input ref2.png ...]

Loads GEMINI_API_KEY from /root/.nanobanana.env or environment.
"""
import argparse
import base64
import json
import mimetypes
import os
import pathlib
import sys
import time
from io import BytesIO

import requests

# Model aliases → actual Google API model IDs
MODELS = {
    "flash": "gemini-3.1-flash-image-preview",  # Nano Banana 2 — fast, 4K, cheap
    "pro": "gemini-3-pro-image-preview",        # Nano Banana Pro — best quality
    "legacy": "gemini-2.5-flash-image",         # Old Nano Banana
}

VALID_ASPECTS = {
    "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4",
    "9:16", "16:9", "21:9", "1:4", "4:1", "1:8", "8:1",
}
VALID_SIZES = {"512", "1K", "2K", "4K"}
VALID_FORMATS = {"png", "jpeg", "webp"}

API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"

# Defaults per Sergey's preference
DEFAULT_ASPECT = "3:4"
DEFAULT_SIZE = "2K"
DEFAULT_FORMAT = "png"
DEFAULT_MODEL = "flash"


def load_api_key() -> str:
    """Load GEMINI_API_KEY from env file or environment."""
    env_file = pathlib.Path("/root/.nanobanana.env")
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line.startswith("GEMINI_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        print("ERROR: GEMINI_API_KEY not found in /root/.nanobanana.env or env", file=sys.stderr)
        sys.exit(2)
    return key


def image_to_part(path: str) -> dict:
    """Read image file and return a Gemini inline_data part."""
    p = pathlib.Path(path)
    if not p.exists():
        raise FileNotFoundError(f"input image not found: {path}")
    size_mb = p.stat().st_size / (1024 * 1024)
    if size_mb > 19:
        raise ValueError(
            f"input image {path} is {size_mb:.1f}MB — exceeds 20MB inline limit. "
            "Use the Files API for large inputs (not yet implemented)."
        )
    mime, _ = mimetypes.guess_type(str(p))
    if mime is None or not mime.startswith("image/"):
        # Fallback: assume PNG. Gemini accepts common image MIME types.
        mime = "image/png"
    data = base64.standard_b64encode(p.read_bytes()).decode()
    return {"inline_data": {"mime_type": mime, "data": data}}


def build_request(
    prompt: str,
    images: list[str],
    aspect: str,
    size: str,
) -> dict:
    """Construct the generateContent request body."""
    parts: list[dict] = []
    # Images first, then prompt — Google docs recommend this order for i2i
    for img in images:
        parts.append(image_to_part(img))
    parts.append({"text": prompt})

    return {
        "contents": [{"parts": parts}],
        "generationConfig": {
            "responseModalities": ["TEXT", "IMAGE"],
            "imageConfig": {
                "aspectRatio": aspect,
                "imageSize": size,
            },
        },
    }


def call_api(model_id: str, body: dict, api_key: str, timeout: int = 300) -> dict:
    """POST to generateContent and return parsed JSON."""
    url = f"{API_BASE}/{model_id}:generateContent"
    headers = {
        "x-goog-api-key": api_key,
        "Content-Type": "application/json",
    }
    resp = requests.post(url, headers=headers, data=json.dumps(body), timeout=timeout)
    if resp.status_code != 200:
        raise RuntimeError(
            f"API error {resp.status_code}: {resp.text[:500]}"
        )
    return resp.json()


def extract_image_bytes(response: dict) -> bytes:
    """Extract PNG bytes from the first image part in the response."""
    candidates = response.get("candidates", [])
    if not candidates:
        raise RuntimeError(f"no candidates in response: {json.dumps(response)[:300]}")
    parts = candidates[0].get("content", {}).get("parts", [])
    for part in parts:
        inline = part.get("inline_data") or part.get("inlineData")
        if inline and "data" in inline:
            return base64.b64decode(inline["data"])
    # No image — dump any text for debugging
    texts = [p.get("text", "") for p in parts if "text" in p]
    raise RuntimeError(
        f"no image in response. text parts: {' | '.join(texts) or '(none)'}"
    )


def convert_format(png_bytes: bytes, fmt: str) -> bytes:
    """Convert PNG bytes to requested format. PNG returns as-is."""
    if fmt == "png":
        return png_bytes
    try:
        from PIL import Image
    except ImportError:
        print("WARN: Pillow not installed — returning PNG", file=sys.stderr)
        return png_bytes
    img = Image.open(BytesIO(png_bytes))
    buf = BytesIO()
    if fmt == "jpeg":
        # JPEG doesn't support alpha
        if img.mode in ("RGBA", "LA", "P"):
            img = img.convert("RGB")
        img.save(buf, format="JPEG", quality=95)
    elif fmt == "webp":
        img.save(buf, format="WEBP", quality=95)
    else:
        raise ValueError(f"unsupported format: {fmt}")
    return buf.getvalue()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Nano Banana / Gemini image generation wrapper"
    )
    parser.add_argument("--prompt", required=True, help="generation prompt")
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        choices=list(MODELS.keys()),
        help=f"model alias (default: {DEFAULT_MODEL})",
    )
    parser.add_argument(
        "--aspect",
        default=DEFAULT_ASPECT,
        help=f"aspect ratio (default: {DEFAULT_ASPECT}). Valid: {sorted(VALID_ASPECTS)}",
    )
    parser.add_argument(
        "--size",
        default=DEFAULT_SIZE,
        help=f"image size (default: {DEFAULT_SIZE}). Valid: {sorted(VALID_SIZES)}",
    )
    parser.add_argument(
        "--format",
        default=DEFAULT_FORMAT,
        choices=sorted(VALID_FORMATS),
        help=f"output format (default: {DEFAULT_FORMAT})",
    )
    parser.add_argument(
        "--output",
        required=True,
        help="output file path (extension should match --format)",
    )
    parser.add_argument(
        "--input",
        action="append",
        default=[],
        help="input reference image path (can be repeated, up to 14)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=300,
        help="HTTP timeout in seconds (default: 300)",
    )

    args = parser.parse_args()

    if args.aspect not in VALID_ASPECTS:
        print(f"ERROR: invalid aspect {args.aspect!r}. Valid: {sorted(VALID_ASPECTS)}", file=sys.stderr)
        return 2
    if args.size not in VALID_SIZES:
        print(f"ERROR: invalid size {args.size!r}. Valid: {sorted(VALID_SIZES)}", file=sys.stderr)
        return 2
    if len(args.input) > 14:
        print(f"ERROR: too many input images ({len(args.input)}), max 14", file=sys.stderr)
        return 2

    model_id = MODELS[args.model]
    api_key = load_api_key()

    try:
        body = build_request(
            prompt=args.prompt,
            images=args.input,
            aspect=args.aspect,
            size=args.size,
        )
    except (FileNotFoundError, ValueError) as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 3

    t0 = time.time()
    try:
        response = call_api(model_id, body, api_key, timeout=args.timeout)
    except Exception as e:
        print(f"ERROR: API call failed: {e}", file=sys.stderr)
        return 4

    try:
        png_bytes = extract_image_bytes(response)
    except RuntimeError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 5

    out_bytes = convert_format(png_bytes, args.format)

    out_path = pathlib.Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(out_bytes)

    elapsed = time.time() - t0
    print(
        f"OK: {out_path} ({len(out_bytes)} bytes, {args.format}, "
        f"{args.aspect}, {args.size}, model={args.model}, {elapsed:.1f}s)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
