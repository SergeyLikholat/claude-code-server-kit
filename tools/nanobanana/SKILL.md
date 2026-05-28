---
name: nanobanana
description: Generate and edit images via Google AI Studio's Nano Banana (Gemini 3 image models). Supports text-to-image, image-to-image, and multi-image composition (up to 14 reference images). Use when the user asks to generate, edit, combine, or create images.
---

# Nano Banana image generation skill

Wraps Google's Gemini 3 image generation models via a local Python CLI at
`/opt/nanobanana/generate.py`. Invoke it from Bash — do not re-implement the
HTTP call inline.

## When to use

- User asks to generate a new image from a text description
- User asks to edit, modify, or restyle an existing image
- User asks to combine, blend, or mix multiple reference images
- User wants avatar, illustration, concept art, product mockup, etc.

## Models

| Alias | API model id | Use case | Speed | Cost |
|-------|-------------|----------|-------|------|
| `flash` (default) | `gemini-3.1-flash-image-preview` | Nano Banana 2 — fast, iteration, 4K support | Fast | ~$0.045/img |
| `pro` | `gemini-3-pro-image-preview` | Best quality, text rendering, character consistency | Slower | ~$0.134/img |
| `legacy` | `gemini-2.5-flash-image` | Previous generation Nano Banana | — | — |

## Defaults (set by user)

- `--aspect 3:4` (vertical portrait)
- `--size 2K`
- `--format png`
- `--model flash`

Do not override defaults unless the user specifies different values.

## CLI usage

```bash
python3 /opt/nanobanana/generate.py \
  --prompt "..." \
  --output /path/to/out.png \
  [--model flash|pro|legacy] \
  [--aspect 1:1|16:9|9:16|3:4|...] \
  [--size 512|1K|2K|4K] \
  [--format png|jpeg|webp] \
  [--input ref1.jpg --input ref2.png ...]
```

### Text-to-image (no references)
```bash
python3 /opt/nanobanana/generate.py \
  --prompt "brutalist concrete museum at golden hour, dramatic shadows" \
  --aspect 16:9 --size 2K \
  --output /tmp/museum.png
```

### Image-to-image (one reference)
```bash
python3 /opt/nanobanana/generate.py \
  --prompt "make it winter, heavy snow, keep composition and colors" \
  --input /tmp/source.jpg \
  --output /tmp/winter.png
```

### Multi-image composition (up to 14 references)
```bash
python3 /opt/nanobanana/generate.py \
  --prompt "place the subject from image 1 into the environment of image 2, cinematic lighting" \
  --input /tmp/subject.png \
  --input /tmp/env.jpg \
  --model pro \
  --aspect 16:9 --size 4K \
  --output /tmp/composite.png
```

## Valid parameter values

**Aspect ratios:** `1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9, 1:4, 4:1, 1:8, 8:1`

**Sizes:** `512, 1K, 2K, 4K` (4K only on `flash` and `pro`)

**Formats:** `png, jpeg, webp` (API returns PNG, conversion done client-side via Pillow)

## Telegram multi-image workflow

When the user sends images via Telegram without a text prompt, the assistant
should buffer them (record downloaded paths) and wait for a trigger message.
Generation triggers when the user:
- Sends a text message with a generation prompt, OR
- Sends an image with a caption containing a prompt, OR
- Writes an explicit command ("генерируй", "старт", "go")

Parameters are parsed from the trigger message in free form:
- `16:9`, `9:16`, etc. → aspect
- `4k`, `2k`, `1k`, `512` → size
- `jpeg`, `png`, `webp` → format
- `pro` → model=pro
- Otherwise defaults apply

Reset buffer on user commands: "очисти", "сброс", "новая генерация".

## Limits

- Max 14 reference images per request
- Max 20 MB per inline input image (larger requires Files API — not implemented)
- API timeout: 300s default
- All outputs carry Google's SynthID watermark (invisible)
- No explicit `seed` parameter in the current preview models

## Environment

API key loaded from `/root/.nanobanana.env`:
```
GEMINI_API_KEY=...
```
File is `chmod 600`. Never echo or log the key.

## Error handling

- Exit code 2: invalid arguments or params
- Exit code 3: input image missing or too large
- Exit code 4: API call failed (network, auth, quota)
- Exit code 5: API returned no image part (safety block, bad prompt)

## Prompt engineering tips

- Be specific about style, lighting, composition, mood
- For avatars: specify "centered composition for profile avatar"
- For i2i edits: explicitly say what to keep ("keep composition and pose")
- For multi-image: reference images by order ("image 1", "image 2")
- Use `pro` model when text rendering or character consistency matters
- Use `flash` model for fast iteration and when 4K is needed
