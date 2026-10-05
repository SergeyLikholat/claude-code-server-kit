// Тесты плагина русификации: node --test plugin.test.mjs (babel берётся из исходников T3)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import t3patchRu, { parseTemplateTranslation } from "./plugin.mjs";

const SRC = process.env.T3_SRC ?? "/root/.cache/t3-build/src";
const web = createRequire(`${SRC}/apps/web/package.json`);
const babelRequire = createRequire(web.resolve("@rolldown/plugin-babel"));
const babel = babelRequire("@babel/core");
// TypeScript-плагин — тот, что снимает типы в сборке Android-приложения (через babel-preset-expo)
const expoPreset = createRequire(`${SRC}/apps/mobile/package.json`).resolve("babel-preset-expo");
const typescriptPlugin = createRequire(expoPreset).resolve("@babel/plugin-transform-typescript");

const dict = {
  strings: {
    "Close": "Закрыть", "Open file": "Открыть файл", "Show": "Показать", "Hide": "Скрыть",
    "{0} (Local)": "{0} (локально)", "Moved {0} to {1}": "{1}: перемещено {0}",
    "{0} thread{1}": "{0} {0|тред|треда|тредов}", "Settings": "Настройки",
    "General": "Общие", "Ask for changes": "Попросите изменения", "Arial": "Ариал",
    "Reconnecting to {0}": "Переподключение к {0}",
  },
  files: { "components/Sidebar.logic.ts": { "{0}m": "{0} мин" } },
  display: { "components/Pill.tsx": ["status.label"] },
  labels: { "Working": "Работает" },
};
const run = (code, filename = "/x/apps/web/src/components/A.tsx") =>
  babel.transformSync(code, { filename, babelrc: false, configFile: false,
    parserOpts: { plugins: ["typescript", "jsx"] }, plugins: [[t3patchRu, { dict }]] }).code;

test("текст в разметке и пробелы по краям", () => {
  const out = run("const a = <b> Close </b>; const c = <b>\n  Close\n</b>;");
  assert.match(out, /<b> Закрыть <\/b>/);
  assert.match(out, /<b>Закрыть<\/b>/);
});

test("атрибут-надпись и условие", () => {
  const out = run('const a = <X aria-label="Open file" title={on ? "Hide" : "Show"} id="Close" />;');
  assert.match(out, /aria-label=\{"Открыть файл"\}/);
  assert.match(out, /on \? "Скрыть" : "Показать"/);
  assert.match(out, /id="Close"/, "id — не надпись, не трогаем");
});

test("свойство объекта-надписи, но не сравнение и не ключ", () => {
  const out = run('toast({ title: "Close" }); if (x === "Close") y(); const m = { Close: 1 };');
  assert.match(out, /title: "Закрыть"/);
  assert.match(out, /x === "Close"/);
  assert.match(out, /Close: 1/);
});

test("шаблон: перестановка подстановок и форма числа", () => {
  const out = run("const a = <p title={`Moved ${a} to ${b}`}>{`${n} thread${n === 1 ? '' : 's'}`}</p>;");
  assert.match(out, /`\$\{b\}: перемещено \$\{a\}`/);
  assert.match(out, /__t3ruPlural\(n, "тред", "треда", "тредов"\)/);
  const helper = new Function(out.match(/function __t3ruPlural[\s\S]*?\n\}/)[0] + "; return __t3ruPlural;")();
  assert.deepEqual([1, 2, 5, 11, 21, 22, 25, 111, 0].map((n) => helper(n, "тред", "треда", "тредов")),
    ["тред", "треда", "тредов", "тредов", "тред", "треда", "тредов", "тредов", "тредов"]);
});

test("привязка к файлу: m — минуты только в своём файле", () => {
  assert.match(run("const x = { label: `${m}m` };", "/x/apps/web/src/components/Sidebar.logic.ts"), /`\$\{m\} мин`/);
  assert.match(run("const x = { label: `${m}m` };", "/x/apps/web/src/lib/contextWindow.ts"), /`\$\{m\}m`/);
});

test("строки без перевода остаются как есть", () => {
  const out = run('const a = <b title="Unknown thing">Nothing here</b>;');
  assert.match(out, /title="Unknown thing"/);
  assert.match(out, /Nothing here/);
});

test("разбор перевода шаблона", () => {
  assert.deepEqual(parseTemplateTranslation("{0} {0|a|b|c}!").map((p) => p.kind), ["text", "expr", "text", "plural", "text"]);
});

test("привязка к файлу работает и вне позиций надписей, но не в сравнениях", () => {
  const f = "/x/apps/web/src/components/Sidebar.logic.ts";
  const out = run('function a(m){ if (x === `${m}m`) return 1; return `${m}m`; }', f);
  assert.match(out, /x === `\$\{m\}m`/);
  assert.match(out, /return `\$\{m\} мин`/);
});

test("строка в типе — значение логики, в каталоге помечается compared", () => {
  const seen = [];
  babel.transformSync('type P = { label: "Working" | "Idle" };', { filename: "/x/apps/web/src/components/A.ts",
    babelrc: false, configFile: false, parserOpts: { plugins: ["typescript"] },
    plugins: [[t3patchRu, { dict, collect: (e) => seen.push(e) }]] });
  assert.deepEqual(seen.filter((e) => e.kind === "compared").map((e) => e.key), ["Working", "Idle"]);
});

test("надпись-значение переводится в момент показа, логика не трогается", () => {
  const out = run('const a = <span aria-label={status.label}>{status.label}{other.label}</span>; const p = { Working: 4 }[status.label];',
    "/x/apps/web/src/components/Pill.tsx");
  assert.match(out, /aria-label=\{__t3ruLabel\(status\.label\)\}>\{__t3ruLabel\(status\.label\)\}\{other\.label\}/);
  assert.match(out, /\[status\.label\]/);
  const helper = new Function(out.match(/const __t3ruLabel[\s\S]*?\}\)\(\);/)[0] + "; return __t3ruLabel;")();
  assert.equal(helper("Working"), "Работает");
  assert.equal(helper("Nope"), "Nope");
  assert.equal(helper(undefined), undefined);
  assert.doesNotMatch(run("const a = <b>{status.label}</b>;"), /__t3ruLabel/);
});

test("надписи в таблицах и константах; структурные ключи и данные не трогаются", () => {
  const out = run('const L = { "/settings/general": "General", id: "General" }; const P = "Ask for changes"; const f = () => "Ask for changes"; if (x === "General") y();');
  assert.match(out, /"\/settings\/general": "Общие"/);
  assert.match(out, /id: "General"/);
  assert.match(out, /const P = "Попросите изменения"/);
  assert.match(out, /=> "Попросите изменения"/);
  assert.match(out, /x === "General"/);
  assert.match(run('const FONTS = ["Arial"];', "/x/apps/web/src/appearanceFonts.ts"), /"Arial"/);
});

test("подстановки перевода проходят остальные плагины сборки (TypeScript `!` снимается)", () => {
  const out = babel.transformSync("function f(s: any) { return `Reconnecting to ${s.list[0]!.label}`; }", {
    filename: "/x/apps/mobile/src/a.ts", babelrc: false, configFile: false,
    plugins: [[t3patchRu, { dict }], typescriptPlugin],
  }).code;
  assert.match(out, /`Переподключение к \$\{s\.list\[0\]\.label\}`/);
});

test("вне кода приложений (библиотеки, общие пакеты) ничего не переводится", () => {
  const code = 'const a = <b title="Close">Close</b>; const P = "Ask for changes";';
  assert.match(run(code, "/x/node_modules/lib/index.js"), /title="Close">Close</);
  assert.match(run(code, "/x/packages/shared/src/a.tsx"), /const P = "Ask for changes"/);
  assert.match(run(code, "/x/apps/mobile/node_modules/x/a.tsx"), /Close/);
});

test("одиночные слова в значениях не переводятся — это часто имена экранов и ключи", () => {
  const out = run('const ROUTES = new Set(["General", "Settings"]); const L = { tab: "General" };');
  assert.match(out, /new Set\(\["General", "Settings"\]\)/);
  assert.match(out, /tab: "General"/);
});

test("React Native: Alert.alert и кнопки диалогов", () => {
  const out = run('Alert.alert("Settings", "Close"); const b = [{ text: "Close", style: "cancel" }];',
    "/x/apps/mobile/src/a.tsx");
  assert.match(out, /Alert\.alert\("Настройки", "Закрыть"\)/);
  assert.match(out, /text: "Закрыть"/);
});

test("общие пакеты: только привязанные к файлу строки, общий словарь не действует", () => {
  const scopedDict = { strings: { "Close": "Закрыть", "Ready": "Готово" },
    files: { "packages/shared/src/timing.ts": { "{0}s": "{0} с", "and": " и " } } };
  const code = 'export const a = (n) => `${n}s`; const b = { label: "Close" }; const c = ["x"].join(" and "); const d = "Ready";';
  const t = (filename) => babel.transformSync(code, { filename, babelrc: false, configFile: false,
    parserOpts: { plugins: ["typescript"] }, plugins: [[t3patchRu, { dict: scopedDict }]] }).code;
  const out = t("/x/packages/shared/src/timing.ts");
  assert.match(out, /`\$\{n\} с`/);
  assert.match(out, /join\(" и "\)/);
  assert.match(out, /label: "Close"/);
  assert.match(out, /"Ready"/);
  // пакет без записей в словаре не трогается вовсе
  const other = t("/x/packages/shared/src/other.ts");
  assert.match(other, /`\$\{n\}s`/);
});
