/**
 * t3-patch: Babel-плагин русификации T3.
 *
 * Меняет английскую строку на русскую, только если строка стоит в позиции
 * надписи И есть в словаре. Позиции надписей:
 *   - текст внутри JSX-разметки;
 *   - строковые JSX-атрибуты из списка ATTRS (aria-label, title, placeholder…);
 *   - JSX-выражения среди детей элемента ({open ? "Hide" : "Show"});
 *   - значения свойств объектов с ключами из KEYS (title, description, label…),
 *     так устроены уведомления, пункты меню, разделы настроек.
 * В выражениях плагин спускается только в строки, шаблоны, `a ? b : c` и
 * правую часть `a || b` / `a ?? b` — логику, ключи и сравнения не трогает.
 *
 * Режим collect (для extract.mjs) ничего не меняет, а отдаёт найденные строки —
 * так каталог для перевода и замена при сборке не могут разойтись.
 *
 * Словарь: { strings: { "English": "Русский" },
 *            files: { "components/X.tsx": { "m": "мин" } } }   — привязка к файлу
 * Надписи-значения логики (статус "Working" — одновременно ключ таблицы приоритетов)
 * переводятся не в коде, а в момент показа: display: { "<файл>": ["status.label"] }
 * оборачивает {status.label} в __t3ruLabel(), который ищет перевод в labels: { "Working": "Работает" }.
 * Шаблоны: `${n} threads` → ключ "{0} threads"; в переводе {0} можно
 * переставлять, а {0|тред|треда|тредов} — русская форма числа по выражению 0.
 */
export const ATTRS = new Set([
  "aria-label", "aria-description", "aria-placeholder", "aria-roledescription", "aria-valuetext",
  "title", "placeholder", "alt", "label", "tooltip", "description", "heading", "subtitle",
  "emptyText", "emptyMessage", "emptyLabel", "confirmLabel", "cancelLabel", "actionLabel",
  "submitLabel", "helperText", "hint", "caption", "ariaLabel", "text",
  // React Native
  "accessibilityLabel", "accessibilityHint", "headerTitle", "headerBackTitle", "detail", "message",
]);
export const KEYS = new Set([
  "title", "description", "label", "placeholder", "tooltip", "heading", "subtitle", "hint",
  "helperText", "emptyText", "emptyMessage", "emptyLabel", "confirmLabel", "cancelLabel",
  "actionLabel", "submitLabel", "caption", "ariaLabel", "shortLabel", "longLabel", "summary",
  "hintText", "buttonLabel", "badge",
  // React Native: кнопки системных диалогов ({ text: "Cancel" }), подписи состояний
  "text", "confirmText", "cancelText", "destructiveText", "statusText", "statusLabel",
  "accessibilityLabel", "accessibilityHint", "headerTitle",
]);

const normalize = (s) => s.replace(/\s+/g, " ").trim();
const looksLikeText = (s) => /[A-Za-z]/.test(s) && !/^[a-z0-9_.:/#-]+$/.test(s) && !/^(https?:|mailto:|\/|\.\/)/.test(s);

// Надписи в таблицах и константах: { "/settings/general": "General" }, const PLACEHOLDER = "Ask…".
// Позиция значения шире позиции надписи, поэтому и фильтр строже: только «проза» с заглавной
// и не под структурными ключами.
const STRUCT_KEYS = new Set([
  "id", "key", "type", "kind", "_tag", "tag", "value", "name", "role", "method", "event", "path",
  "href", "to", "url", "src", "icon", "variant", "size", "color", "className", "mode", "status",
  "provider", "code", "format", "language", "lang", "locale", "testId", "slug", "scope", "group",
  "channel", "command", "shortcut", "keybinding", "field", "column", "target", "action",
  // HTTP-заголовки и прочие значения протокола
  "authorization", "Authorization", "cookie", "accept", "contentType", "mimeType", "userAgent",
  "deviceName", "platform", "reason", "operation",
]);
// Файлы, где «проза» в значениях — данные, а не надписи: шрифты и браузеры (уходят в CSS и на
// сервер), коды клавиш, лицензии, стадия сборки, промпты для агента (пусть остаются английскими).
// Надписи из них, если нужны, переводятся привязкой к файлу.
const VALUE_SKIP = [
  "terminal/", "appearanceFonts.ts", "connection/clientMetadata.ts", "keybindings.ts",
  "openVsxThemes.ts", "branding.ts", "components/pullRequest/pullRequestDetail.logic.ts",
  // Android-приложение: авторизация, разбор журнала сбоев, регистрация устройства, хранилище
  "mobile/features/cloud/linkEnvironment.ts", "mobile/features/diagnostics/crash-log-model.ts",
  "mobile/features/agent-awareness/", "mobile/persistence/", "mobile/connection/",
  "mobile/features/showcase/",
  "mobile/features/settings/appearance/components/AppearancePreviews.tsx", // образец кода в превью
  // текст, который уходит агенту вместе с сообщением (контекст поля ввода)
  "mobile/lib/composerContext.ts", "lib/composerContextReferences.ts", "lib/terminalContext.ts",
];
export const looksLikeProse = (s) =>
  /^[A-Z][a-z']/.test(s) && !/[_\/\\{}<>=|`@#$]|::|\.[A-Za-z]/.test(s.replace(/\{\d+\}/g, "")) &&
  !/^[A-Z][a-z]+[A-Z]\w*$/.test(s);

const PLURAL_HELPER = "__t3ruPlural";
const PLURAL_SOURCE = `function ${PLURAL_HELPER}(n, one, few, many) {
  const v = Math.abs(Math.trunc(Number(n))) % 100;
  const d = v % 10;
  if (!Number.isFinite(v)) return many;
  if (v > 10 && v < 20) return many;
  if (d === 1) return one;
  if (d > 1 && d < 5) return few;
  return many;
}`;

/** Разобрать перевод шаблона: литеральный текст, {i} и {i|форма|форма|форма}. */
export function parseTemplateTranslation(text) {
  const parts = [];
  const re = /\{(\d+)(?:\|([^|}]*)\|([^|}]*)\|([^|}]*))?\}/g;
  let last = 0;
  for (let m; (m = re.exec(text)); ) {
    parts.push({ kind: "text", value: text.slice(last, m.index) });
    parts.push(m[2] === undefined ? { kind: "expr", index: Number(m[1]) } : { kind: "plural", index: Number(m[1]), forms: [m[2], m[3], m[4]] });
    last = re.lastIndex;
  }
  parts.push({ kind: "text", value: text.slice(last) });
  return parts;
}

const LABEL_HELPER = "__t3ruLabel";
const labelSource = (labels) => `const ${LABEL_HELPER} = (() => {
  const m = new Map(Object.entries(${JSON.stringify(labels)}));
  return (v) => (typeof v === "string" && m.has(v) ? m.get(v) : v);
})();`;

/** a.b.c → "a.b.c"; всё прочее — null. */
function dottedName(t, n) {
  if (t.isIdentifier(n)) return n.name;
  if (t.isMemberExpression(n) && !n.computed && t.isIdentifier(n.property)) {
    const obj = dottedName(t, n.object);
    return obj ? `${obj}.${n.property.name}` : null;
  }
  if (t.isOptionalMemberExpression?.(n) && !n.computed && t.isIdentifier(n.property)) {
    const obj = dottedName(t, n.object);
    return obj ? `${obj}.${n.property.name}` : null;
  }
  return null;
}

const escapeRaw = (s) => s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

export default function t3patchRu(api, options = {}) {
  const t = api.types;
  const dict = options.dict ?? { strings: {}, files: {} };
  const collect = options.collect; // (entry) => void — режим сбора каталога
  const rootDir = options.rootDir ?? "";

  const relFile = (state) => {
    const f = state.file?.opts?.filename ?? "";
    const i = f.indexOf("/apps/web/src/");
    if (i >= 0) return f.slice(i + "/apps/web/src/".length);
    // Android-приложение: привязки к файлам в словаре — с префиксом mobile/
    const m = f.indexOf("/apps/mobile/src/");
    if (m >= 0) return "mobile/" + f.slice(m + "/apps/mobile/src/".length);
    // Общие пакеты монорепозитория (packages/shared, packages/client-runtime…) — от корня T3
    const pk = f.lastIndexOf("/packages/");
    if (pk >= 0 && !f.includes("/node_modules/")) return f.slice(pk + 1);
    return f.replace(rootDir, "");
  };
  const str = (value) => {
    const node = t.stringLiteral(value);
    node.extra = { raw: JSON.stringify(value), rawValue: value };
    return node;
  };
  const scoped = (state, key) => dict.files?.[relFile(state)]?.[key] !== undefined;
  const lookup = (state, key) =>
    dict.files?.[relFile(state)]?.[key] ?? (state.t3ruPkg ? undefined : dict.strings?.[key]);

  const uiNodes = new WeakSet();
  const found = (state, kind, key, node) => {
    uiNodes.add(node);
    if (collect) collect({ key, kind, file: relFile(state), line: node.loc?.start?.line ?? 0 });
  };
  // Строка, с которой в коде что-то сравнивают, — это ещё и значение логики:
  // переведёшь надпись — сломается сравнение. Такие ключи extract.mjs помечает и не переводит.
  const COMPARE_CALLS = new Set(["includes", "startsWith", "endsWith", "indexOf", "has", "match", "test", "replace", "replaceAll", "split", "localeCompare"]);
  function isComparison(path) {
    const parent = path.parentPath;
    if (!parent) return false;
    if (t.isBinaryExpression(parent.node) && ["===", "!==", "==", "!="].includes(parent.node.operator)) return true;
    if (t.isSwitchCase(parent.node) && parent.node.test === path.node) return true;
    if (t.isCallExpression(parent.node) && parent.node.arguments.includes(path.node)) {
      const callee = parent.node.callee;
      const method = t.isMemberExpression(callee) && t.isIdentifier(callee.property) ? callee.property.name : null;
      if (method && COMPARE_CALLS.has(method)) return true;
    }
    if (t.isObjectProperty(parent.node) && parent.node.key === path.node) return true;
    // Строка в типе (`label: "Working" | "Idle"`) — это значение, по которому код ветвится.
    if (t.isTSLiteralType(parent.node)) return true;
    return false;
  }

  /** Строка/шаблон стоит значением в таблице, константе, массиве или return. */
  function isValuePosition(path, state) {
    const file = relFile(state);
    if (VALUE_SKIP.some((f) => file.startsWith(f))) return false;
    let p = path;
    for (;;) {
      const parent = p.parentPath;
      if (!parent) return false;
      const n = parent.node;
      if (t.isConditionalExpression(n) && n.test !== p.node) { p = parent; continue; }
      if (t.isLogicalExpression(n) && (n.right === p.node || n.operator === "??")) { p = parent; continue; }
      if (t.isTSAsExpression(n) || t.isTSSatisfiesExpression(n) || t.isParenthesizedExpression?.(n)) { p = parent; continue; }
      if (t.isObjectProperty(n)) {
        if (n.value !== p.node || n.computed) return false;
        const k = n.key;
        const name = t.isIdentifier(k) ? k.name : t.isStringLiteral(k) ? k.value : null;
        return name !== null && !STRUCT_KEYS.has(name);
      }
      if (t.isVariableDeclarator(n)) return n.init === p.node;
      if (t.isArrayExpression(n) || t.isReturnStatement(n)) return true;
      if (t.isArrowFunctionExpression(n)) return n.body === p.node;
      return false;
    }
  }

  function translateString(path, state, kind, onlyScoped = false) {
    const node = path.node;
    const key = normalize(node.value);
    if (onlyScoped && !scoped(state, key)) return;
    if (!key || (!looksLikeText(key) && !scoped(state, key))) return;
    found(state, kind, key, node);
    const ru = lookup(state, key);
    if (typeof ru !== "string" || collect) return;
    path.replaceWith(str(ru));
    path.skip();
  }

  function translateTemplate(path, state, kind, onlyScoped = false) {
    const node = path.node;
    if (onlyScoped) {
      let k = "";
      node.quasis.forEach((q, i) => { k += q.value.cooked ?? ""; if (i < node.expressions.length) k += `{${i}}`; });
      if (!scoped(state, normalize(k))) return;
    }
    if (node.expressions.length === 0) {
      const key = normalize(node.quasis.map((q) => q.value.cooked ?? "").join(""));
      if (!key || !looksLikeText(key)) return;
      found(state, kind, key, node);
      const ru = lookup(state, key);
      if (typeof ru !== "string" || collect) return;
      path.replaceWith(t.templateLiteral([t.templateElement({ raw: escapeRaw(ru), cooked: ru }, true)], []));
      path.skip();
      return;
    }
    let key = "";
    node.quasis.forEach((q, i) => {
      key += q.value.cooked ?? "";
      if (i < node.expressions.length) key += `{${i}}`;
    });
    key = normalize(key);
    const textOnly = key.replace(/\{\d+\}/g, " ");
    if (!/[A-Za-z]{2,}/.test(textOnly) && !scoped(state, key)) return;
    found(state, kind, key, node);
    const ru = lookup(state, key);
    if (typeof ru !== "string" || collect) return;
    const quasis = [];
    const exprs = [];
    let pending = "";
    for (const part of parseTemplateTranslation(ru)) {
      if (part.kind === "text") { pending += part.value; continue; }
      const source = node.expressions[part.index];
      if (!source) { pending += `{${part.index}}`; continue; }
      quasis.push(t.templateElement({ raw: escapeRaw(pending), cooked: pending }, false));
      pending = "";
      if (part.kind === "expr") exprs.push(t.cloneNode(source, true));
      else {
        state.t3ruNeedPlural = true;
        exprs.push(t.callExpression(t.identifier(PLURAL_HELPER), [
          t.cloneNode(source, true), ...part.forms.map((f) => str(f)),
        ]));
      }
    }
    quasis.push(t.templateElement({ raw: escapeRaw(pending), cooked: pending }, true));
    // Без path.skip(): подстановки должны пройти остальные плагины той же сборки — в
    // Android-приложении TypeScript снимается в этом же проходе, и `a!.b` иначе останется в коде.
    // Повторного перевода не будет: русского ключа в словаре нет.
    path.replaceWith(t.templateLiteral(quasis, exprs));
  }

  function translateExpression(path, state, kind) {
    if (!path?.node) return;
    const n = path.node;
    if (t.isStringLiteral(n)) return translateString(path, state, kind);
    if (t.isTemplateLiteral(n)) return translateTemplate(path, state, kind);
    if (t.isConditionalExpression(n)) {
      translateExpression(path.get("consequent"), state, kind);
      translateExpression(path.get("alternate"), state, kind);
      return;
    }
    if (t.isLogicalExpression(n) && (n.operator === "||" || n.operator === "??")) {
      translateExpression(path.get("right"), state, kind);
      if (n.operator === "??") translateExpression(path.get("left"), state, kind);
      return;
    }
    if (t.isTSAsExpression(n) || t.isTSSatisfiesExpression(n) || t.isParenthesizedExpression?.(n)) {
      translateExpression(path.get("expression"), state, kind);
      return;
    }
    const name = dottedName(t, n);
    if (name && !collect && dict.display?.[relFile(state)]?.includes(name)) {
      state.t3ruNeedLabel = true;
      path.replaceWith(t.callExpression(t.identifier(LABEL_HELPER), [t.cloneNode(n, true)]));
      path.skip();
    }
  }

  return {
    name: "t3patch-ru",
    visitor: {
      Program: {
        enter(_path, state) {
          state.t3ruNeedPlural = false;
          state.t3ruNeedLabel = false;
          // Только код самих приложений. Библиотеки (node_modules) и общие пакеты тоже идут через
          // Babel в сборке Android-приложения — их строки служебные, перевод ломает запуск.
          // path.stop() здесь нельзя: он остановил бы и остальные плагины того же прохода.
          const file = state.file?.opts?.filename ?? "";
          // Общий пакет с привязанными к нему в словаре строками (files["packages/…"]) — переводим,
          // но только эти строки: общий словарь в пакетах не действует (state.t3ruPkg).
          const inApp = options.anyFile || /[\\/]apps[\\/](web|mobile)[\\/]src[\\/]/.test(file);
          state.t3ruPkg = !inApp && relFile(state).startsWith("packages/") && dict.files?.[relFile(state)] !== undefined;
          state.t3ruOff = !(inApp || state.t3ruPkg) || /[\\/]node_modules[\\/]/.test(file);
        },
        exit(path, state) {
          if (state.t3ruOff) return;
          if (state.t3ruNeedPlural) path.unshiftContainer("body", api.template.statement.ast(PLURAL_SOURCE));
          if (state.t3ruNeedLabel) path.unshiftContainer("body", api.template.statement.ast(labelSource(dict.labels ?? {})));
        },
      },
      JSXText(path, state) {
        if (state.t3ruOff) return;
        const raw = path.node.value;
        const key = normalize(raw);
        if (!key || !looksLikeText(key)) return;
        found(state, "jsx", key, path.node);
        const ru = lookup(state, key);
        if (typeof ru !== "string" || collect) return;
        // Пробелы по краям в JSX значимы, только если нет перевода строки.
        const lead = /^[ \t]+\S/.test(raw) ? " " : "";
        const trail = /\S[ \t]+$/.test(raw) ? " " : "";
        path.node.value = lead + ru + trail;
        delete path.node.extra;
      },
      JSXAttribute(path, state) {
        if (state.t3ruOff) return;
        const name = t.isJSXIdentifier(path.node.name) ? path.node.name.name : null;
        if (!name || !ATTRS.has(name) || !path.node.value) return;
        const value = path.get("value");
        if (t.isStringLiteral(value.node)) {
          const key = normalize(value.node.value);
          if (!key || !looksLikeText(key)) return;
          found(state, "attr", key, value.node);
          const ru = lookup(state, key);
          // В значении JSX-атрибута \uXXXX не раскрывается — отдаём перевод JS-выражением.
          if (typeof ru === "string" && !collect) value.replaceWith(t.jsxExpressionContainer(str(ru)));
          return;
        }
        if (t.isJSXExpressionContainer(value.node)) translateExpression(value.get("expression"), state, "attr");
      },
      // Alert.alert("Заголовок", "Текст", …) — первые два аргумента системного диалога.
      CallExpression(path, state) {
        if (state.t3ruOff) return;
        const callee = path.node.callee;
        if (
          t.isMemberExpression(callee) &&
          t.isIdentifier(callee.object, { name: "Alert" }) &&
          t.isIdentifier(callee.property) &&
          (callee.property.name === "alert" || callee.property.name === "prompt")
        ) {
          const args = path.get("arguments");
          for (const arg of args.slice(0, 2)) translateExpression(arg, state, "alert");
        }
      },
      JSXExpressionContainer(path, state) {
        if (state.t3ruOff) return;
        if (!t.isJSXElement(path.parent) && !t.isJSXFragment(path.parent)) return;
        translateExpression(path.get("expression"), state, "jsx-expr");
      },
      StringLiteral(path, state) {
        if (state.t3ruOff) return;
        if (uiNodes.has(path.node)) return;
        const key = normalize(path.node.value);
        // Одиночное слово — только значение в таблице со строковыми ключами ("/settings/general": "General"):
        // в списках, константах и return это часто имя экрана, вариант или ключ.
        const labelMapValue =
          t.isObjectProperty(path.parent) && path.parent.value === path.node && t.isStringLiteral(path.parent.key);
        if (
          key &&
          looksLikeProse(key) &&
          (/\s/.test(key) || labelMapValue) &&
          !isComparison(path) &&
          isValuePosition(path, state)
        ) {
          translateString(path, state, "value");
          return;
        }
        if (collect) {
          if (key && looksLikeText(key) && isComparison(path)) {
            collect({ key, kind: "compared", file: relFile(state), line: path.node.loc?.start?.line ?? 0 });
          }
          return;
        }
        // Привязанные к файлу строки переводятся в любой позиции, кроме сравнений и импортов.
        if (isComparison(path) || t.isImportDeclaration(path.parent) || t.isExportDeclaration(path.parent)) return;
        translateString(path, state, "scoped", true);
      },
      TemplateLiteral(path, state) {
        if (state.t3ruOff) return;
        if (uiNodes.has(path.node) || t.isTaggedTemplateExpression(path.parent) || isComparison(path)) return;
        const head = normalize(path.node.quasis[0]?.value.cooked ?? "");
        if (looksLikeProse(head) && isValuePosition(path, state)) {
          translateTemplate(path, state, "value");
          return;
        }
        if (collect) return;
        translateTemplate(path, state, "scoped", true);
      },
      ObjectProperty(path, state) {
        if (state.t3ruOff) return;
        if (VALUE_SKIP.some((f) => relFile(state).startsWith(f))) return;
        if (path.node.computed) return;
        const k = path.node.key;
        const name = t.isIdentifier(k) ? k.name : t.isStringLiteral(k) ? k.value : null;
        if (!name || !KEYS.has(name)) return;
        translateExpression(path.get("value"), state, "prop");
      },
    },
  };
}
