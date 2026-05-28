#!/usr/bin/env python3
"""Gemini TTS CLI — wraps gemini-2.5-flash-preview-tts.

Usage:
    python3 /opt/gemini-tts/tts.py --text "..." --output /tmp/out.ogg [--voice Kore] [--model gemini-2.5-flash-preview-tts]

Env: GEMINI_API_KEY loaded from /root/.nanobanana.env (same key).
Output: OGG Opus (Telegram voice format). Intermediate WAV via in-memory PCM wrap.
Voices: Kore, Puck, Charon, Zephyr, Aoede, Fenrir, Leda, Orus ...
"""
import argparse, base64, json, os, struct, subprocess, sys, tempfile, urllib.request

def load_key():
    env = "/root/.nanobanana.env"
    if os.path.exists(env):
        for line in open(env):
            if line.strip().startswith("GEMINI_API_KEY="):
                return line.split("=", 1)[1].strip()
    return os.environ.get("GEMINI_API_KEY", "")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--voice", default="Algenib")
    ap.add_argument("--model", default="gemini-2.5-flash-preview-tts")
    args = ap.parse_args()

    key = load_key()
    if not key:
        print("ERROR: GEMINI_API_KEY not set", file=sys.stderr); sys.exit(2)

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{args.model}:generateContent?key={key}"
    body = {
        "contents": [{"parts": [{"text": args.text}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": args.voice}}},
        },
    }
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        resp = urllib.request.urlopen(req, timeout=300).read()
    except Exception as e:
        print(f"ERROR: API call failed: {e}", file=sys.stderr); sys.exit(4)

    data = json.loads(resp)
    try:
        inline = data["candidates"][0]["content"]["parts"][0]["inlineData"]
        pcm = base64.b64decode(inline["data"])
        mime = inline.get("mimeType", "")
    except Exception:
        print(f"ERROR: unexpected response: {json.dumps(data)[:500]}", file=sys.stderr); sys.exit(5)

    sr = 24000
    for tok in mime.split(";"):
        if tok.strip().startswith("rate="):
            sr = int(tok.split("=")[1])

    hdr = (b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVE" +
           b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, sr, sr * 2, 2, 16) +
           b"data" + struct.pack("<I", len(pcm)))

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as wf:
        wf.write(hdr + pcm)
        wav_path = wf.name

    try:
        r = subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", wav_path,
             "-c:a", "libopus", "-b:a", "48k", args.output],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            print(f"ERROR: ffmpeg failed: {r.stderr}", file=sys.stderr); sys.exit(6)
    finally:
        os.unlink(wav_path)

    dur = (len(pcm) // 2) / sr
    print(f"OK: {args.output} ({os.path.getsize(args.output)} bytes, voice={args.voice}, {dur:.1f}s)")

if __name__ == "__main__":
    main()
