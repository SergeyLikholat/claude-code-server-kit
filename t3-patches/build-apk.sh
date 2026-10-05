#!/usr/bin/env bash
# Собрать Android-приложение T3 из официального тега + мобильной серии патчей.
#
#   build-apk.sh <тег> [--no-i18n]
#
#   <тег>       официальный тег, например v0.0.42 — тот же, что у сервера
#   --no-i18n   без русификации
#
# Результат: /root/projects/claude-code-server-kit/t3-patches/apk/T3-Sergey-<версия>-<сборка>.apk
# Скачать на телефон — из проводника T3 (кабинет «Сервер · Claude», меню файла «Скачать»)
# и поставить поверх прошлой версии: данные приложения сохраняются.
#
# Ставится РЯДОМ с официальным приложением: своё имя пакета и своя подпись.
# Ключ подписи — /root/.config/t3patch/android-release.jks (в ночном бэкапе). Потеряешь
# ключ — новую сборку поверх старой не поставить, придётся удалить приложение с данными.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK=/root/.cache/t3-build
SRC=$WORK/src               # основная рабочая копия (веб-сборка) — отсюда git-объекты
MSRC=$WORK/src-mobile       # отдельная рабочая копия под Android, чтобы не мешать веб-сборке
RUNTIME=/root/.t3/runtime/versions
OUTDIR=$HERE/apk
KEYENV=/root/.config/t3patch/android-keystore.env

TAG="${1:?укажи тег, например v0.0.42}"
I18N=1
for arg in "${@:2}"; do
  case "$arg" in
    --no-i18n) I18N=0 ;;
    *) echo "неизвестный флаг: $arg" >&2; exit 2 ;;
  esac
done
VERSION="${TAG#v}"
log() { printf '\n== %s\n' "$*"; }

OFFICIAL="$RUNTIME/$VERSION"
[ -x "$OFFICIAL/t3" ] || { echo "нет официальной установки $OFFICIAL — сначала t3 update" >&2; exit 1; }
[ -f "$KEYENV" ] || { echo "нет ключа подписи $KEYENV" >&2; exit 1; }
[ -d /opt/android-sdk/platforms ] || { echo "нет Android SDK в /opt/android-sdk" >&2; exit 1; }

log "исходники $TAG"
# тег уже есть — сеть не нужна (и параллельные сборки не спорят за ссылки git)
git -C "$SRC" rev-parse -q --verify "refs/tags/$TAG" >/dev/null || git -C "$SRC" fetch -q --tags origin
BRANCH="sergey-mobile/$VERSION"
if [ ! -d "$MSRC/.git" ] && [ ! -f "$MSRC/.git" ]; then
  git -C "$SRC" worktree add -q -f -B "$BRANCH" "$MSRC" "$TAG"
else
  git -C "$MSRC" checkout -q -f -B "$BRANCH" "$TAG"
  git -C "$MSRC" clean -q -fdx -e node_modules
fi

log "накатываю мобильные патчи"
N=0
while read -r p; do
  [ -z "$p" ] || [ "${p#\#}" != "$p" ] && continue
  N=$((N + 1))
  if ! git -C "$MSRC" -c user.email=t3-patch@local -c user.name=t3-patch am -q --3way "$HERE/mobile/patches/$p"; then
    git -C "$MSRC" am --abort || true
    echo "КОНФЛИКТ: патч $p не лёг на $TAG — сборка остановлена" >&2
    exit 3
  fi
  echo "  ok  $p"
done < "$HERE/mobile/series"

log "зависимости"
# shellcheck disable=SC1091
source "$WORK/env.sh"
export ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/build-tools/36.0.0:$PATH"
( cd "$MSRC" && pnpm install --frozen-lockfile --reporter=silent )
( cd "$MSRC" && node scripts/update-release-package-versions.ts "$VERSION" ) >/dev/null

# публичные облачные настройки (Clerk, relay) — из официальной версии, как у веб-сборки
eval "$(python3 "$HERE/lib/official_config.py" "$OFFICIAL")"
BUILD_NO=$(date +%y%j%H%M)   # год, день года, часы, минуты: растёт с каждой сборкой, влезает в int
export APP_VARIANT=production EXPO_NO_GIT_STATUS=1 EXPO_NO_TELEMETRY=1 CI=1
export T3CODE_MOBILE_UPDATES_ENABLED=0        # без обновлений «по воздуху» от разработчиков
export T3PATCH_ANDROID_PACKAGE=com.t3tools.t3code.sergey
export T3PATCH_APP_NAME="T3 Biz"           # своя редакция T3 Biz (с 2026-10-04); пакет прежний — ставится поверх
export T3PATCH_APP_SCHEME=t3code           # штатная схема ссылок t3code:// — теперь это единственное приложение
export T3PATCH_ANDROID_VERSION_CODE=$BUILD_NO
if [ "$I18N" = 1 ]; then export T3PATCH_I18N_DIR="$HERE/i18n"; else unset T3PATCH_I18N_DIR; fi
# кэш Metro хранит уже переведённый код — после правки словаря он должен собраться заново
rm -rf "${TMPDIR:-/tmp}"/metro-* "${TMPDIR:-/tmp}"/haste-map-* "$MSRC/apps/mobile/node_modules/.cache"

log "Android-проект"
( cd "$MSRC/apps/mobile" && pnpm exec expo prebuild --clean --platform android --no-install ) \
  > "$WORK/build-apk-prebuild.log" 2>&1 || { tail -30 "$WORK/build-apk-prebuild.log"; exit 4; }

log "сборка (Gradle, 10–20 минут)"
( cd "$MSRC/apps/mobile/android" && ./gradlew assembleRelease --no-daemon -PreactNativeArchitectures=arm64-v8a ) \
  > "$WORK/build-apk-gradle.log" 2>&1 || { grep -A12 "What went wrong" "$WORK/build-apk-gradle.log" | head -30; exit 5; }

log "подпись"
UNSIGNED="$MSRC/apps/mobile/android/app/build/outputs/apk/release/app-release.apk"
mkdir -p "$OUTDIR"
OUT="$OUTDIR/T3-Sergey-$VERSION-$BUILD_NO.apk"
# shellcheck disable=SC1090
set -a; source "$KEYENV"; set +a
apksigner sign --ks "$T3PATCH_KEYSTORE" --ks-key-alias "$T3PATCH_KEY_ALIAS" \
  --ks-pass env:T3PATCH_KEYSTORE_PASSWORD --key-pass env:T3PATCH_KEYSTORE_PASSWORD \
  --out "$OUT" "$UNSIGNED"
apksigner verify "$OUT"
rm -f "$OUT.idsig"
# держим две последние сборки
for old in $(ls -1t "$OUTDIR"/T3-Sergey-*.apk | tail -n +3); do rm -f "$old" "${old%.apk}.json"; done

python3 - "$OUT" "$TAG" "$HERE" "$I18N" "$BUILD_NO" <<'PY'
import hashlib, json, pathlib, sys, datetime
out, tag, here, i18n, build = sys.argv[1:6]
patches = [p for p in pathlib.Path(here, "mobile", "series").read_text().split() if not p.startswith("#")]
meta = {"base": tag, "build": int(build), "package": "com.t3tools.t3code.sergey",
        "patches": patches, "i18n": i18n == "1",
        "sha256": hashlib.sha256(pathlib.Path(out).read_bytes()).hexdigest(),
        "built": datetime.datetime.now().isoformat(timespec="seconds")}
pathlib.Path(out).with_suffix(".json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))
PY
log "готово: $OUT"
du -h "$OUT" | cut -f1
