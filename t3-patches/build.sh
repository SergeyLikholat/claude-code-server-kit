#!/usr/bin/env bash
# Собрать T3 из официального тега + серии патчей.
#
#   build.sh <тег> [--stock | --no-i18n]
#
#   <тег>       официальный тег, например v0.0.42
#   --stock     собрать без патчей (проверка, что сборка совпадает со штатной)
#   --no-i18n   с патчами, но без русификации (каталог получит суффикс -en)
#
# Результат: /root/.cache/t3-build/out/<версия>[-sN] — раскладка как у
# /root/.t3/runtime/versions/<версия>: t3, client/, node_modules/, resource-monitor/.
# Ничего не устанавливает — это делает install.sh.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK=/root/.cache/t3-build
SRC=$WORK/src
RUNTIME=/root/.t3/runtime/versions
REPO=https://github.com/pingdotgg/t3code.git

TAG="${1:?укажи тег, например v0.0.42}"
STOCK=""; I18N=1
for arg in "${@:2}"; do
  case "$arg" in
    --stock) STOCK=--stock; I18N=0 ;;
    --no-i18n) I18N=0 ;;
    *) echo "неизвестный флаг: $arg" >&2; exit 2 ;;
  esac
done
VERSION="${TAG#v}"

log() { printf '\n== %s\n' "$*"; }

# официальный каталог той же версии: из него берём node_modules, resource-monitor
# и публичные облачные настройки
OFFICIAL="$RUNTIME/$VERSION"
if [ ! -x "$OFFICIAL/t3" ]; then
  echo "нет официальной установки $OFFICIAL — сначала поставь её штатно (t3 update), потом собирай патч" >&2
  exit 1
fi

log "исходники $TAG"
[ -d "$SRC/.git" ] || git clone -q "$REPO" "$SRC"
# тег уже есть — сеть не нужна (и параллельные сборки не спорят за ссылки git)
git -C "$SRC" rev-parse -q --verify "refs/tags/$TAG" >/dev/null || git -C "$SRC" fetch -q --tags origin
git -C "$SRC" checkout -q -f "$TAG"
git -C "$SRC" clean -q -fd -e node_modules
BRANCH="sergey/$VERSION"
git -C "$SRC" branch -q -f "$BRANCH" "$TAG"
git -C "$SRC" checkout -q "$BRANCH"

SUFFIX=""
if [ "$STOCK" != "--stock" ]; then
  log "накатываю патчи"
  N=0
  while read -r p; do
    [ -z "$p" ] || [ "${p#\#}" != "$p" ] && continue
    N=$((N + 1))
    if ! git -C "$SRC" -c user.email=t3-patch@local -c user.name=t3-patch am -q --3way "$HERE/patches/$p"; then
      git -C "$SRC" am --abort || true
      echo "КОНФЛИКТ: патч $p не лёг на $TAG — сборка остановлена, ничего не установлено" >&2
      exit 3
    fi
    echo "  ok  $p"
  done < "$HERE/series"
  SUFFIX="-s$N"
  [ "$I18N" = 1 ] || SUFFIX="$SUFFIX-en"
fi
OUT="$WORK/out/$VERSION$SUFFIX"

log "зависимости"
# shellcheck disable=SC1091
source "$WORK/env.sh"
eval "$(python3 "$HERE/lib/official_config.py" "$OFFICIAL")"
# на теге в package.json стоит прошлая версия — релиз проставляет её отдельным шагом, повторяем
( cd "$SRC" && node scripts/update-release-package-versions.ts "$VERSION" ) >/dev/null
export APP_VERSION="$VERSION"
( cd "$SRC" && pnpm install --frozen-lockfile --reporter=silent )

log "веб-клиент"
if [ "$I18N" = 1 ]; then
  # русификация: плагин и словарь подхватывает apps/web/t3patch-i18n (патч 0008)
  export T3PATCH_I18N_DIR="$HERE/i18n"
  echo "  русификация: $(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(len(d["strings"]), "строк")' "$HERE/i18n/ru.json")"
else
  unset T3PATCH_I18N_DIR
fi
( cd "$SRC" && pnpm --filter @t3tools/web build ) > "$WORK/build-web.log" 2>&1 \
  || { tail -30 "$WORK/build-web.log"; exit 4; }

log "серверный бинарник"
( cd "$SRC/apps/server" && node scripts/cli.ts build-exe ) > "$WORK/build-exe.log" 2>&1 \
  || { tail -30 "$WORK/build-exe.log"; exit 5; }

log "сборка раскладки $OUT"
rm -rf "$OUT"; mkdir -p "$OUT"
cp "$SRC/apps/server/dist-exe/t3" "$OUT/t3"
cp -r "$SRC/apps/web/dist" "$OUT/client"
find "$OUT/client" -name '*.map' -delete
if [ "$STOCK" != "--stock" ]; then
  # браузерные сборки SheetJS и mammoth для просмотра xlsx/docx (патч 0003)
  ( cd "$HERE/vendor" && sha256sum -c --quiet SHA256SUMS ) || { echo "vendor: контрольные суммы не сошлись" >&2; exit 6; }
  mkdir -p "$OUT/client/t3patch-vendor"
  # + страница просмотра офисных файлов для Android-приложения (office-view.*)
  cp "$HERE/vendor/"*.js "$HERE/vendor/"*.html "$HERE/vendor/"*.css "$OUT/client/t3patch-vendor/"
fi
cp -a "$OFFICIAL/node_modules" "$OUT/node_modules"
cp -a "$OFFICIAL/resource-monitor" "$OUT/resource-monitor"
python3 - "$OUT" "$TAG" "$HERE" "$STOCK" "$I18N" <<'PY'
import json, sys, datetime, hashlib, pathlib
out, tag, here, stock, i18n = sys.argv[1:6]
patches = [] if stock == "--stock" else [
    {"file": p, "sha256": hashlib.sha256((pathlib.Path(here) / "patches" / p).read_bytes()).hexdigest()[:12]}
    for p in pathlib.Path(here, "series").read_text().split() if not p.startswith("#")
]
ru = pathlib.Path(here, "i18n", "ru.json")
json.dump({"base": tag, "patches": patches,
           "i18n": {"ru.json": hashlib.sha256(ru.read_bytes()).hexdigest()[:12]} if i18n == "1" else None,
           "built": datetime.datetime.now().isoformat(timespec="seconds")},
          open(pathlib.Path(out) / "PATCHED.json", "w"), ensure_ascii=False, indent=2)
PY
log "готово: $OUT"
du -sh "$OUT" | cut -f1
