#!/usr/bin/env python3
"""Telegram MarkdownV2 safe formatter.

Takes source text with simple tags:
    [B]bold[/B]
    [I]italic[/I]
    [U]underline[/U]
    [S]strikethrough[/S]
    [C]inline code[/C]
    [PRE lang=python]code block[/PRE]
    [L href=https://example.com]link text[/L]

Escapes everything else per Telegram MarkdownV2 rules, so no character
leaks through unescaped. Emoji and plain text pass through unchanged.

Usage:
    echo "[B]Hello[/B], world! Price: 1.5 RUB." | python3 /opt/tg-md/format.py
    python3 /opt/tg-md/format.py --text "[B]Ok[/B]"
"""
import argparse, re, sys

SPECIALS = r"_*[]()~`>#+-=|{}.!\\"
_ESCAPE_RE = re.compile(r"([" + re.escape(SPECIALS) + r"])")

def esc(s: str) -> str:
    return _ESCAPE_RE.sub(r"\\\1", s)

def esc_code(s: str) -> str:
    return s.replace("\\", "\\\\").replace("`", "\\`")

def esc_link_url(s: str) -> str:
    return s.replace("\\", "\\\\").replace(")", "\\)")

_TAG_RE = re.compile(
    r"""
    \[ (?P<tag>B|I|U|S|C)  \] (?P<content>.*?) \[/ (?P=tag) \]
    |
    \[ PRE (?:\s+lang=(?P<lang>[A-Za-z0-9_+-]+))? \] (?P<pre>.*?) \[/PRE\]
    |
    \[ L \s+href=(?P<href>[^\]]+) \] (?P<link>.*?) \[/L\]
    """,
    re.VERBOSE | re.DOTALL,
)

def convert(src: str) -> str:
    out = []
    last = 0
    for m in _TAG_RE.finditer(src):
        out.append(esc(src[last:m.start()]))
        if m.group("tag"):
            tag = m.group("tag")
            content = m.group("content")
            if tag == "C":
                out.append("`" + esc_code(content) + "`")
            else:
                wrapped = {
                    "B": ("*", "*"),
                    "I": ("_", "_"),
                    "U": ("__", "__"),
                    "S": ("~", "~"),
                }[tag]
                # MarkdownV2: italics and bold can be nested; inside them, specials still need escaping.
                out.append(wrapped[0] + convert(content) + wrapped[1])
        elif m.group("pre") is not None:
            lang = m.group("lang") or ""
            body = esc_code(m.group("pre"))
            out.append("```" + lang + "\n" + body + "```")
        elif m.group("link") is not None:
            href = esc_link_url(m.group("href"))
            text = convert(m.group("link"))
            out.append("[" + text + "](" + href + ")")
        last = m.end()
    out.append(esc(src[last:]))
    return "".join(out)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", help="Source text (otherwise read stdin)")
    args = ap.parse_args()
    src = args.text if args.text is not None else sys.stdin.read()
    sys.stdout.write(convert(src))

if __name__ == "__main__":
    main()
