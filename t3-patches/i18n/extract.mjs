#!/usr/bin/env node
/**
 * t3-patch: каталог строк интерфейса T3 для перевода.
 *
 *   node extract.mjs <корень исходников t3> [--report]
 *
 * Прогоняет все файлы apps/web/src и apps/mobile/src (Android-приложение) тем же
 * плагином, что и сборка, в режиме
 * сбора. Пишет catalog.json (строка → где встречается) и, с --report,
 * untranslated.md — что в каталоге есть, а в ru.json нет. Строки, которые
 * где-то в коде сравниваются, помечаются compared и в перевод не идут.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import t3patchRu from "./plugin.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = process.argv[2] ?? "/root/.cache/t3-build/src";
const REPORT = process.argv.includes("--report");
// @babel/core — тот же, что использует сборка через @rolldown/plugin-babel
const webRequire = createRequire(join(SRC, "apps/web/package.json"));
const babel = createRequire(webRequire.resolve("@rolldown/plugin-babel"))("@babel/core");

const ROOTS = [join(SRC, "apps/web/src"), join(SRC, "apps/mobile/src")].filter((dir) => existsSync(dir));
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "sergey" && name !== "t3patch-i18n") walk(p); }
    else if (/\.tsx?$/.test(name) && !/\.(test|bench|stories)\.tsx?$/.test(name)) files.push(p);
  }
};
ROOTS.forEach(walk);

const ui = new Map(); // ключ → { kinds:Set, where:[] }
const compared = new Map();
for (const file of files) {
  const code = readFileSync(file, "utf8");
  babel.transformSync(code, {
    filename: file, babelrc: false, configFile: false, code: false,
    parserOpts: { plugins: ["typescript", "jsx"] },
    plugins: [[t3patchRu, { collect: (e) => {
      const map = e.kind === "compared" ? compared : ui;
      const item = map.get(e.key) ?? { kinds: new Set(), where: [] };
      item.kinds.add(e.kind); item.where.push(`${e.file}:${e.line}`); map.set(e.key, item);
    } }]],
  });
}
const risky = [...ui.keys()].filter((k) => compared.has(k));
const catalog = {};
for (const [key, v] of [...ui].sort((a, b) => a[0].localeCompare(b[0]))) {
  catalog[key] = { kinds: [...v.kinds], where: v.where.slice(0, 6), count: v.where.length, ...(compared.has(key) ? { compared: compared.get(key).where.slice(0, 4) } : {}) };
}
writeFileSync(join(HERE, "catalog.json"), JSON.stringify(catalog, null, 1));
console.log(`файлов: ${files.length}, строк интерфейса: ${ui.size}, из них сравниваются в логике (не переводим): ${risky.length}`);

if (REPORT) {
  const dictPath = join(HERE, "ru.json");
  const dict = existsSync(dictPath) ? JSON.parse(readFileSync(dictPath, "utf8")) : { strings: {}, files: {} };
  const missing = Object.keys(catalog).filter((k) => !catalog[k].compared && !(k in (dict.strings ?? {})) && !Object.values(dict.files ?? {}).some((f) => k in f));
  const unused = Object.keys(dict.strings ?? {}).filter((k) => !(k in catalog));
  const lines = [`# Непереведённые строки T3`, ``, `Всего в интерфейсе: ${ui.size}. Без перевода: ${missing.length}. В словаре, но уже нет в коде: ${unused.length}.`, ``];
  for (const k of missing) lines.push(`- \`${k.replace(/`/g, "'")}\` — ${catalog[k].where[0]}`);
  writeFileSync(join(HERE, "untranslated.md"), lines.join("\n") + "\n");
  console.log(`без перевода: ${missing.length}; в словаре, но исчезли из кода: ${unused.length} → ${join(HERE, "untranslated.md")}`);
}
