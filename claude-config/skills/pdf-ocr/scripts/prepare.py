#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Подготовка PDF к распознаванию: разбор по страницам, текстовый слой, картинки сканов.

Каждая страница получает один из видов:
  text  — есть нормальный текстовый слой. Текст берётся из PDF как есть
          (точно, без распознавания). Файл page-NNN.txt.
  scan  — слоя нет, он испорчен или страница — картинка во весь лист
          (скан, фото, скан со «слоем» от сканера). Страница режется на
          фрагменты page-NNN-tK.png для визуального чтения.
Испорченная кодировка CP1251 (типичная для PDF из AutoCAD: «Õîëîäèëüíàÿ»)
исправляется автоматически — такая страница остаётся text.

Нужен только poppler-utils (pdfinfo, pdftotext, pdfimages, pdftoppm).

Запуск:
  python3 prepare.py файл.pdf [--out каталог] [--pages 1-5] [--dpi 200] [--render-all]
  python3 prepare.py файл.pdf --zoom 3 0.5 0.6 0.5 0.4 [--dpi 400]
      — увеличенный фрагмент страницы 3: x, y, ширина, высота в долях листа (0…1).
        Для контрольной проверки мелких цифр, печатей, текста под штампом.
Итог — manifest.json в каталоге результата и сводка в stdout.
"""
import argparse
import json
import math
import pathlib
import re
import subprocess
import sys

MIN_TEXT_CHARS = 40        # меньше — считаем, что текста на странице нет
MIN_GOOD_RATIO = 0.90      # доля «нормальных» символов в слое
SCAN_COVERAGE = 0.5        # картинка закрывает больше половины листа — это скан
TILE_MAX_PX = 1800         # предел стороны фрагмента: крупнее модель сама уменьшит и потеряет мелкий текст
TILE_OVERLAP_PX = 50       # заход фрагмента на соседа с каждой стороны; общее перекрытие ~100 px
GOOD_CHARS = re.compile(r"[0-9A-Za-zА-Яа-яЁё\s.,;:!?()\[\]{}«»\"'\-–—+=*/\\%№#&@<>|_~^°±×÷²³µ$€₽…]")


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, errors="replace").stdout


def page_count(pdf):
    m = re.search(r"Pages:\s+(\d+)", run(["pdfinfo", str(pdf)]))
    if not m:
        sys.exit(f"Не удалось открыть PDF: {pdf}")
    return int(m.group(1))


def page_size_pt(pdf, page):
    out = run(["pdfinfo", "-f", str(page), "-l", str(page), str(pdf)])
    m = re.search(r"Page\s+\d+\s+size:\s+([\d.]+)\s+x\s+([\d.]+)", out) or \
        re.search(r"Page size:\s+([\d.]+)\s+x\s+([\d.]+)", out)
    return (float(m.group(1)), float(m.group(2))) if m else (595.0, 842.0)


def page_sizes(pdf, n_pages):
    out = run(["pdfinfo", "-f", "1", "-l", str(n_pages), str(pdf)])
    return {int(m.group(1)): (float(m.group(2)), float(m.group(3)))
            for m in re.finditer(r"Page\s+(\d+)\s+size:\s+([\d.]+)\s+x\s+([\d.]+)", out)}


def has_fonts(pdf, page):
    return len(run(["pdffonts", "-f", str(page), "-l", str(page), str(pdf)]).splitlines()) > 2


def image_coverage(pdf, n_pages, sizes):
    """Доля листа, закрытая самой крупной картинкой, по страницам."""
    cover = {p: 0.0 for p in range(1, n_pages + 1)}
    for line in run(["pdfimages", "-list", str(pdf)]).splitlines()[2:]:
        f = line.split()
        if len(f) < 14 or f[2] in ("smask", "stencil"):
            continue
        try:
            page, w, h, xppi, yppi = int(f[0]), int(f[3]), int(f[4]), float(f[12]), float(f[13])
        except ValueError:
            continue
        if xppi <= 0 or yppi <= 0:
            continue
        pw, ph = sizes.get(page, (595.0, 842.0))
        area = (w / xppi * 72) * (h / yppi * 72) / (pw * ph)
        cover[page] = max(cover.get(page, 0.0), min(area, 1.0))
    return cover


def fix_cp1251(text):
    """«Õîëîäèëüíàÿ» → «Холодильная»: байты CP1251, прочитанные как Latin-1."""
    latin = sum(1 for c in text if "À" <= c <= "ÿ")
    cyr = sum(1 for c in text if "Ѐ" <= c <= "ӿ")
    if latin < 20 or latin <= cyr:
        return text, False
    out = []
    for c in text:
        if "\u0080" <= c <= "ÿ":
            try:
                c = c.encode("latin-1").decode("cp1251")
            except UnicodeDecodeError:
                pass
        out.append(c)
    return "".join(out), True


def text_quality(text):
    chars = [c for c in text if not c.isspace()]
    if not chars:
        return 0, 0.0
    good = sum(1 for c in chars if GOOD_CHARS.match(c))
    return len(chars), good / len(chars)


def render_tiles(pdf, page, dpi, out_dir):
    """Страница → фрагменты не крупнее TILE_MAX_PX, с перекрытием."""
    pw, ph = page_size_pt(pdf, page)
    W, H = math.ceil(pw / 72 * dpi), math.ceil(ph / 72 * dpi)
    nx, ny = math.ceil(W / TILE_MAX_PX), math.ceil(H / TILE_MAX_PX)
    tw, th = math.ceil(W / nx), math.ceil(H / ny)
    files, k = [], 0
    for iy in range(ny):
        for ix in range(nx):
            k += 1
            x = max(ix * tw - (TILE_OVERLAP_PX if ix else 0), 0)
            y = max(iy * th - (TILE_OVERLAP_PX if iy else 0), 0)
            w = min(tw + (TILE_OVERLAP_PX if ix else 0) + (TILE_OVERLAP_PX if ix < nx - 1 else 0), W - x)
            h = min(th + (TILE_OVERLAP_PX if iy else 0) + (TILE_OVERLAP_PX if iy < ny - 1 else 0), H - y)
            base = out_dir / f"page-{page:03d}-t{k}"
            subprocess.run(["pdftoppm", "-r", str(dpi), "-f", str(page), "-l", str(page), "-singlefile",
                            "-x", str(x), "-y", str(y), "-W", str(w), "-H", str(h), "-png",
                            str(pdf), str(base)], check=True)
            files.append(base.with_suffix(".png").name)
    return files, f"{ny}×{nx}"


def parse_pages(spec, n):
    if not spec:
        return list(range(1, n + 1))
    pages = set()
    for part in spec.replace(" ", "").split(","):
        m = re.fullmatch(r"(\d+)(?:-(\d*))?", part)
        if not m:
            sys.exit(f"Не понял страницы «{part}». Пример: --pages 1-5,8 или --pages 3-")
        lo = int(m.group(1))
        hi = lo if m.group(2) is None else int(m.group(2) or n)
        pages.update(range(lo, hi + 1))
    return [p for p in sorted(pages) if 1 <= p <= n]


def zoom(pdf, page, frac, dpi, out_dir):
    pw, ph = page_size_pt(pdf, page)
    W, H = pw / 72 * dpi, ph / 72 * dpi
    fx, fy, fw, fh = frac
    if not all(0 <= v <= 1 for v in frac) or fw <= 0 or fh <= 0:
        sys.exit("--zoom: x y w h — доли листа от 0 до 1")
    # Доли — в процентах: точка в имени сбила бы суффикс .png
    base = out_dir / f"zoom-p{page:03d}-x{fx * 100:.0f}-y{fy * 100:.0f}-w{fw * 100:.0f}-h{fh * 100:.0f}"
    subprocess.run(["pdftoppm", "-r", str(dpi), "-f", str(page), "-l", str(page), "-singlefile",
                    "-x", str(int(fx * W)), "-y", str(int(fy * H)), "-W", str(int(fw * W)),
                    "-H", str(int(fh * H)), "-png", str(pdf), str(base)], check=True)
    print(base.with_suffix(".png"))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf")
    ap.add_argument("--out", help="каталог результата (по умолчанию ./pdf-ocr/<имя файла>)")
    ap.add_argument("--pages", help="страницы: 1-5,8")
    ap.add_argument("--dpi", type=int, help="разрешение: 200 для страниц, 400 для --zoom")
    ap.add_argument("--zoom", nargs=5, type=float, metavar=("СТР", "X", "Y", "W", "H"),
                    help="увеличенный фрагмент страницы, координаты в долях листа")
    ap.add_argument("--render-all", action="store_true",
                    help="рендерить и страницы с текстовым слоем (нужно, если важны зачёркивания, печати, рукописные пометки)")
    a = ap.parse_args()

    pdf = pathlib.Path(a.pdf).resolve()
    if not pdf.is_file():
        sys.exit(f"Нет файла: {pdf}")
    out = pathlib.Path(a.out) if a.out else pathlib.Path.cwd() / "pdf-ocr" / pdf.stem
    out.mkdir(parents=True, exist_ok=True)

    if a.zoom:
        zoom(pdf, int(a.zoom[0]), a.zoom[1:], a.dpi or 400, out)
        return
    a.dpi = a.dpi or 200

    n = page_count(pdf)
    sizes = page_sizes(pdf, n)
    cover = image_coverage(pdf, n, sizes)
    pages = []
    for p in parse_pages(a.pages, n):
        raw = run(["pdftotext", "-layout", "-enc", "UTF-8", "-f", str(p), "-l", str(p), str(pdf), "-"])
        text, fixed = fix_cp1251(raw)
        chars, ratio = text_quality(text)
        cov = round(cover.get(p, 0.0), 2)
        if chars >= MIN_TEXT_CHARS and ratio >= MIN_GOOD_RATIO and cov < SCAN_COVERAGE:
            kind, why = "text", "текстовый слой" + (" (исправлена кодировка CP1251)" if fixed else "")
        elif cov >= SCAN_COVERAGE:
            kind = "scan"
            why = "картинка во весь лист" + (" (слой текста от сканера не используется)" if chars >= MIN_TEXT_CHARS else "")
        elif chars >= MIN_TEXT_CHARS:
            kind, why = "scan", f"текстовый слой испорчен (нормальных символов {ratio:.0%})"
        elif not has_fonts(pdf, p):
            # «Печать в PDF» с текстом в кривых: буквы нарисованы линиями, слоя нет
            kind, why = "scan", "текст переведён в кривые (в PDF нет шрифтов) — читать глазами"
        else:
            kind, why = "scan", "текстового слоя нет или почти нет"
        rec = {"page": p, "kind": kind, "why": why, "chars": chars, "image_cover": cov}
        if kind == "text":
            (out / f"page-{p:03d}.txt").write_text(text, encoding="utf-8")
            rec["text_file"] = f"page-{p:03d}.txt"
        if kind == "scan" or a.render_all:
            rec["tiles"], rec["grid"] = render_tiles(pdf, p, a.dpi, out)
        pages.append(rec)

    manifest = {"pdf": str(pdf), "pages_total": n, "out": str(out), "dpi": a.dpi, "pages": pages}
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")

    t = [r["page"] for r in pages if r["kind"] == "text"]
    s = [r["page"] for r in pages if r["kind"] == "scan"]
    print(f"PDF: {pdf.name}, страниц {n}, обработано {len(pages)}")
    print(f"Каталог: {out}")
    print(f"Текстовый слой (точно): {len(t)} стр. {compact(t)}")
    print(f"Читать глазами (скан):  {len(s)} стр. {compact(s)}")
    for r in pages:
        files = r.get("text_file") or ""
        if r.get("tiles"):
            files = (files + " " if files else "") + f"фрагменты {r['grid']}: " + ", ".join(r["tiles"])
        print(f"  стр.{r['page']:>3}: {r['kind']:<5} {r['why']} → {files}")


def compact(nums):
    if not nums:
        return ""
    parts, start = [], nums[0]
    for a, b in zip(nums, nums[1:] + [None]):
        if b != a + 1:
            parts.append(f"{start}" if start == a else f"{start}-{a}")
            start = b
    return "(" + ", ".join(parts) + ")"


if __name__ == "__main__":
    main()
