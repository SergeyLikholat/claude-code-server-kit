#!/usr/bin/env bash
# Упаковать собранную версию T3 в архив для других серверов (модуль t3 и t3-update).
#
#   package.sh <сборка> [каталог-назначения]
#
#   <сборка>   каталог из $T3_BUILD_DIR/out, например 0.0.42-s18 (его делает build.sh)
#   каталог    куда положить архив; по умолчанию t3-patches/dist/
#
# Результат: t3-<сборка>-linux-x64.tar.gz + .sha256 рядом. Внутри — один каталог <сборка>/
# с той же раскладкой, что у ~/.t3/runtime/versions/<версия>: t3, client/, node_modules/,
# resource-monitor/, PATCHED.json. На целевом сервере ничего не компилируется.
#
# Отдать архив: выложить на https (релиз GitHub, свой сервер) или скопировать scp и указать
# путь в T3_TARBALL файла secrets.env. Ключ подписи Android и прочие секреты в архив не входят.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="${T3_BUILD_DIR:-$HOME/.cache/t3-build}"
NAME="${1:?укажи сборку, например 0.0.42-s18 (ls $BUILD_DIR/out)}"
DEST="${2:-$HERE/dist}"
SRC="$BUILD_DIR/out/$NAME"

[[ "$NAME" =~ ^[0-9A-Za-z._-]+$ ]] || { echo "странное имя сборки: $NAME" >&2; exit 2; }
[ -x "$SRC/t3" ] || { echo "нет сборки $SRC — сначала build.sh" >&2; exit 1; }
[ -f "$SRC/PATCHED.json" ] || echo "внимание: в $SRC нет PATCHED.json — это штатная сборка без патчей?" >&2
case "$(file -b "$SRC/t3" 2>/dev/null)" in
  *x86-64*) ARCH=linux-x64 ;;
  *aarch64*) ARCH=linux-arm64 ;;
  *) ARCH=linux-unknown ;;
esac

mkdir -p "$DEST"
OUT="$DEST/t3-$NAME-$ARCH.tar.gz"
# Без владельцев и групп сервера сборки; порядок файлов стабильный — архив воспроизводим
tar -C "$BUILD_DIR/out" --owner=0 --group=0 --numeric-owner --sort=name \
    --exclude='.install-complete' -czf "$OUT.part" "$NAME"
mv -f "$OUT.part" "$OUT"
( cd "$DEST" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256" )

echo "архив: $OUT ($(du -h "$OUT" | cut -f1))"
echo "сумма: $(cut -d' ' -f1 "$OUT.sha256")"
echo
echo "Дальше: выложить оба файла по https (или scp на сервер) и указать в secrets.env"
echo "  T3_TARBALL=<ссылка или путь>"
echo "Обновить уже работающий сервер:  t3-update <ссылка или путь>"
