# Telegram VS Code Live Bridge — Session Recovery Doc

> **Назначение:** если потеряется доступ к Telegram-сессии «General», по этому документу можно подхватить контекст работы в VS Code и быстро продолжить.
> **Дата документа:** 2026-06-13
> **Источник:** TG-сессия General `b0129d2f-6953-4233-aad9-d9e92227c5ac`

## Что мы строим

Внутри forum-группы владельца `<CHAT_ID>` есть топик «VS Code Live» (thread_id=2723). В нём через Telegram bot daemon можно подключаться к любым Claude Code сессиям на сервере и общаться с ними как через VS Code. Кнопки в UI: список, выбор номера, новая сессия, свежий ответ, статус, отвязка.

Цель — не зависеть от физического присутствия за компом: начал работу в VS Code → отошёл → продолжил в TG → вернулся к компу → история сохранилась.

## Архитектура

**Daemon:** Node.js процесс под systemd, `/opt/claude-telegram-router/`, service `tg-router.service`.
**Polling клиент:** grammy SDK (Bot API).
**State:** `/root/.claude/channels/telegram/vscode_bridge.json` — связь `chat_id:thread_id → session_id+project_dir+last_pulled_uuid+last_panel_message_id`.
**Sessions storage:** `~/.claude/projects/<slug>/<uuid>.jsonl` — файлы создаёт claude CLI; daemon только читает для list/pull.
**Routing:** `/root/.claude/channels/telegram/routing.json` содержит запись для thread_id=2723 с `mode: "vscode_bridge"` и placeholder session_id.

## Файлы под изменением

| Файл | Что делает |
|---|---|
| `/opt/claude-telegram-router/bridge.js` | Sessions scanner, state mgmt, keyboards, markdown→HTML, UUID generator для новых сессий, emoji rules. ~700 строк после всех правок. |
| `/opt/claude-telegram-router/commands.js` | Slash-команды `/list`, `/connect`, `/disconnect`, `/status`. |
| `/opt/claude-telegram-router/index.js` | Main dispatch + callback_query handlers (`con:`, `quick:list/status/disconnect/pull/new`, `list:page=N`). Floating control panel после каждого assistant-turn. Markdown→HTML отправка. |
| `/opt/claude-telegram-router/dispatch.js` | runClaudeWorker — spawn claude binary. Тут было неудачное pre-create header (откатили). |
| `/root/.claude/channels/telegram/routing.json` | Топики → session_id mappings. Топик 2723 = vscode_bridge mode. |
| `/root/.claude/channels/telegram/vscode_bridge.json` | Live state какой топик подключён к какой сессии. |

## Список изменений (chronological)

1. **Базовый bridge** (10 июня) — добавление кнопок `/list`, `/connect`, `/disconnect`, `/status`. Скан JSONL файлов в `~/.claude/projects/`. routing.json расширен под mode=vscode_bridge.
2. **HTML форматирование** — `parse_mode: 'HTML'` для slash-команд, fallback на plain.
3. **Фильтр TG-routed sessions** — скрываем из /list сессии владельца/user2 которые в routing.json (общие BG/Бизнес/N8N/Психолог/ТК-вектор/...).
4. **Пагинация** — 10 на страницу, нав-кнопки `« ‹ N/M › »`.
5. **Фильтр observer-sessions** от claude-mem (`/.claude-mem/observer-sessions`) — было 500 сессий, после фильтра 53.
6. **ai-title из JSONL** — поле `aiTitle` в JSONL-записи `{"type":"ai-title"}`. Сканируем последние 256 КБ JSONL чтобы найти свежий. Совпадает с VS Code Sidebar.
7. **Кнопки 1-10 над навигацией** — 2 ряда по 5, callback `con:<session_id>`.
8. **Эмодзи по entrypoint+cwd** — 🖥 для VS Code, 🎨 для /root/open-design, ✉️ для sdk-cli с cwd=/root (TG worker).
9. **Quick-action кнопки на «🟢 Подключено» / «⚪ Отключено»** — Сменить/Статус/Отвязать.
10. **Pull-кнопка «📥 Свежий ответ»** с идемпотентностью — отслеживание `last_pulled_uuid` в state. 3 исхода: новый ответ / сессия работает / ничего нового.
11. **Markdown → HTML конвертер** — `**bold**` → `<b>`, `## headers` → `▎ заголовок`, code blocks, ссылки. Корректная обработка inline-кода внутри bold.
12. **Заголовки A-стиля** — `# H1` → `━━━ HEADER ━━━`, `## H2` → `▎ Header`, `### H3` → `▸ Header`.
13. **Плавающая control panel** — после каждого turn'а в bridged-топик daemon отправляет компактное сообщение с двумя кнопками, удаляя предыдущее (`last_panel_message_id`).
14. **Кнопка «➕ Новая сессия»** — генерирует UUID v4 в bridge.js функция `createBridgeSession()`. Кнопка в `/list` и под «⚪ Отключено».
15. **Фильтр context-mgr** background sessions — `/_infra/context-mgr/`, `/context-mgr` cwd-suffix.
16. **TG-created session display name** — `📱 Новая (TG)` вместо «home».
17. **Pre-create JSONL header (вариант B v1) — НЕ СРАБОТАЛ.** Claude отказался делать `--resume` если JSONL содержит только attachment record. Откатили.
18. **Post-patch entrypoint (вариант B v2) — РАБОТАЕТ.** В `dispatch.js` после успешного `claude --print` для новой сессии (resumes=false, code=0) daemon переписывает все записи JSONL: `"entrypoint":"sdk-cli"` → `"claude-vscode"` + добавляет синтетическую запись `{"type":"ai-title","aiTitle":"<первое user-сообщение>","sessionId":"..."}`. Проверено на `1137ff68` — после Reload Window сессия появилась в VS Code Sidebar с правильным title.

## Известные ограничения

- **Существующие TG-сессии** (включая General `b0129d2f`) имеют `entrypoint: "sdk-cli"` и нет `ai-title` записей. Patch применяется **только** для новых сессий. Чтобы сделать существующую сессию видимой — запустить retroactive patch вручную (см. ниже).

## Восстановление работы в VS Code

Если потерял доступ к TG-сессии и нужно продолжить в VS Code:

1. Открой эту TG-сессию (General `b0129d2f-6953-4233-aad9-d9e92227c5ac`) через VS Code Sidebar (но она там не появится из-за entrypoint=sdk-cli — придётся открыть JSONL вручную или через `claude --resume b0129d2f-6953-4233-aad9-d9e92227c5ac` в terminal).
2. Прочти этот файл (`/root/projects/agentic-rollout/SESSION-RECOVERY.md`) для контекста.
3. Текущая нерешённая задача — **post-patch entrypoint** в `dispatch.js` после `claude --print` завершил (см. ниже).
4. Все бэкапы файлов — `/opt/claude-telegram-router/*.bak.<timestamp>` (откат через `cp ... <orig>` + `systemctl restart tg-router.service`).

## Решение для VS Code Sidebar (реализовано)

В `dispatch.js` функция `patchFirstEntrypointToVscode(projectDir, sessionId)` — вызывается после успешного `claude --print` для новых сессий. Делает два действия:

1. Сканирует JSONL построчно, заменяет `"entrypoint":"sdk-cli"` → `"claude-vscode"` во всех записях.
2. Если в JSONL нет ни одной записи `{"type":"ai-title"}` — собирает первое user-сообщение (с очисткой channel-тегов и system-reminder'ов), обрезает до 60 символов, добавляет в конец JSONL запись `{"type":"ai-title","aiTitle":"<text>","sessionId":"<id>"}`.

Вызов в `runClaudeWorker`:
```js
if (!resumes && code === 0) {
  try {
    patchFirstEntrypointToVscode(project_dir, session_id)
  } catch (err) {
    console.error('tg-router: entrypoint patch failed:', err.message)
  }
}
```

После этого Sidebar при следующем сканировании (или Reload Window) видит сессию с правильным entrypoint и title.

### Retroactive patch для существующих TG-сессий

Если нужно сделать **уже существующую** TG-сессию видимой в Sidebar (например мою General `b0129d2f`):

```bash
cd /opt/claude-telegram-router && node -e "
const fs = require('fs');
const path = '/root/.claude/projects/-root/<SESSION_UUID>.jsonl';
const content = fs.readFileSync(path, 'utf8');
const lines = content.split('\n');
let firstUserText = null;
let hasAiTitle = false;
let modified = false;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('\"type\":\"ai-title\"')) hasAiTitle = true;
  if (lines[i].includes('\"entrypoint\":\"sdk-cli\"')) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj.entrypoint === 'sdk-cli') {
        obj.entrypoint = 'claude-vscode';
        lines[i] = JSON.stringify(obj);
        modified = true;
      }
    } catch {}
  }
  if (!firstUserText && lines[i].includes('\"type\":\"user\"')) {
    try {
      const obj = JSON.parse(lines[i]);
      const c = obj.message && obj.message.content;
      let txt = '';
      if (Array.isArray(c)) for (const p of c) if (p.text) txt += p.text + ' ';
      txt = txt.replace(/<channel[^>]*>/g, '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/\s+/g, ' ').trim();
      if (txt) firstUserText = txt;
    } catch {}
  }
}
if (!hasAiTitle && firstUserText) {
  const title = firstUserText.length > 60 ? firstUserText.slice(0,57)+'...' : firstUserText;
  lines.push(JSON.stringify({type:'ai-title', aiTitle:title, sessionId:'<SESSION_UUID>'}));
  modified = true;
}
if (modified) fs.writeFileSync(path, lines.join('\n'));
console.log('done, modified=', modified);
"
```

Замени `<SESSION_UUID>` на нужный UUID. Потом Reload Window в VS Code.

## Команды для быстрого восстановления

```bash
# Проверить что daemon работает
systemctl status tg-router.service

# Логи
journalctl -u tg-router.service -n 100

# Откатить последнее изменение
ls /opt/claude-telegram-router/*.bak.* | tail -5  # видим бэкапы
cp /opt/claude-telegram-router/<file>.js.bak.<ts> /opt/claude-telegram-router/<file>.js
systemctl restart tg-router.service

# Удалить битый pre-create файл (если ещё есть)
rm /root/.claude/projects/-root/c55498eb-971c-4068-b73e-ec534bff9b41.jsonl

# Bridge state
cat /root/.claude/channels/telegram/vscode_bridge.json

# Routing
cat /root/.claude/channels/telegram/routing.json
```
