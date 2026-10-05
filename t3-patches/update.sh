#!/usr/bin/env bash
# Собрать патченую T3 для тега, проверить тестами и поставить.
#
#   update.sh <тег>          например v0.0.43
#
# Порядок при выходе новой версии T3:
#   1. t3 update                — ставит официальную версию (доработки временно пропадут)
#   2. update.sh v<новая>       — накатывает патчи на неё, тесты, APK, установка, переключение
# Если патч не лёг — сборка останавливается, ничего не ставится, штатная версия работает.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TAG="${1:?укажи тег, например v0.0.43}"
VERSION="${TAG#v}"
N=$(grep -cvE '^\s*(#|$)' "$HERE/series")

"$HERE/build.sh" "$TAG"

echo; echo "== тесты патча"
# shellcheck disable=SC1091
source /root/.cache/t3-build/env.sh
SRC=/root/.cache/t3-build/src
( cd "$SRC/apps/web" && pnpm exec vp test run --project unit src/components/sergey src/components/files src/components/Sidebar ) \
  | grep -E "Test Files|Tests " || { echo "тесты веб-клиента упали — не ставлю" >&2; exit 7; }
( cd "$SRC/apps/server" && pnpm exec vp test run src/sergey src/workspace src/http ) \
  | grep -E "Test Files|Tests " || { echo "тесты сервера упали — не ставлю" >&2; exit 7; }

echo; echo "== русификация"
I18N_TESTS=$(cd "$HERE/i18n" && node --test plugin.test.mjs 2>&1) \
  || { echo "$I18N_TESTS" | tail -30; echo "тесты плагина русификации упали — не ставлю" >&2; exit 7; }
echo "$I18N_TESTS" | grep -E "^ℹ (pass|fail)"
# новые строки этой версии остаются английскими, пока их нет в ru.json, — сборку это не ломает
node "$HERE/i18n/extract.mjs" "$SRC" --report

# Android-приложение той же версии — не обязательно: если не собралось, сервер всё равно ставим
echo; echo "== Android-приложение"
if "$HERE/build-apk.sh" "$TAG" > /root/.cache/t3-build/build-apk.log 2>&1; then
  tail -2 /root/.cache/t3-build/build-apk.log
  echo "APK: $(ls -1t "$HERE"/apk/T3-Sergey-*.apk | head -1) — поставить на телефон поверх прошлого"
else
  echo "APK не собрался (журнал: /root/.cache/t3-build/build-apk.log) — сервер ставлю, приложение остаётся прежним" >&2
fi

"$HERE/install.sh" "$VERSION-s$N"
