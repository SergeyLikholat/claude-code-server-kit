/**
 * t3-patch: просмотр офисных файлов для Android-приложения T3 (office-view.html).
 *
 * Адрес: office-view.html#src=<подписанная ссылка /api/assets/…>
 * Листы — сеткой как в Excel (буквы столбцов, номера строк, строка с полным текстом ячейки),
 * docx — через mammoth, .doc/.rtf/.odt — сервер сначала конвертирует в docx.
 * Та же логика, что в веб-клиенте (components/sergey/officeFiles.ts, SheetGrid.tsx).
 */
(function () {
  "use strict";

  var MAX_BYTES = 20 * 1024 * 1024;
  var MAX_ROWS = 5000;
  var ROWS_STEP = 300;
  var MAX_COLUMNS = 200;
  var SHEET_EXT = [".xlsx", ".xlsm", ".xlsb", ".xls", ".ods"];
  var DOC_EXT = [".docx"];
  var CONVERTED_EXT = [".doc", ".rtf", ".odt"];

  var statusEl = document.getElementById("status");
  var tabsEl = document.getElementById("tabs");
  var cellbarEl = document.getElementById("cellbar");
  var addressEl = document.getElementById("address");
  var cellTextEl = document.getElementById("celltext");
  var contentEl = document.getElementById("content");

  function setStatus(text, isError) {
    statusEl.textContent = text || "";
    statusEl.className = isError ? "status error" : "status";
  }

  function kindOf(path) {
    var lower = path.toLowerCase();
    var has = function (list) {
      return list.some(function (ext) {
        return lower.endsWith(ext);
      });
    };
    if (has(SHEET_EXT)) return "sheet";
    if (has(DOC_EXT)) return "doc";
    if (has(CONVERTED_EXT)) return "converted-doc";
    return null;
  }

  /** Принимаем только подписанные ссылки своего сервера — чужой адрес страница не загрузит. */
  function readSource() {
    var params = new URLSearchParams(location.hash.slice(1));
    var raw = params.get("src");
    if (!raw) return null;
    var url;
    try {
      url = new URL(raw, location.origin);
    } catch (error) {
      return null;
    }
    if (url.origin !== location.origin || url.pathname.indexOf("/api/assets/") !== 0) return null;
    return url;
  }

  function loadScript(file) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      script.src = file;
      // SheetJS выбирает декодер по не-ASCII пробе внутри себя — кодировку задаём явно.
      script.charset = "utf-8";
      script.onload = function () {
        resolve();
      };
      script.onerror = function () {
        reject(new Error("Не загрузилась библиотека " + file));
      };
      document.head.appendChild(script);
    });
  }

  function fetchBytes(url) {
    return fetch(url, { credentials: "omit" }).then(function (response) {
      if (!response.ok) {
        throw new Error(
          response.status === 404
            ? "Ссылка на файл устарела — откройте файл заново."
            : "Сервер ответил " + response.status + ".",
        );
      }
      var length = Number(response.headers.get("content-length") || 0);
      if (length > MAX_BYTES) throw new Error("Файл больше 20 МБ — просмотр отключён.");
      return response.arrayBuffer();
    });
  }

  function columnLetter(index) {
    var n = index + 1;
    var out = "";
    while (n > 0) {
      var rest = (n - 1) % 26;
      out = String.fromCharCode(65 + rest) + out;
      n = Math.floor((n - 1) / 26);
    }
    return out;
  }

  // ---------- листы ----------

  function readSheets(data) {
    var XLSX = window.XLSX;
    var book = XLSX.read(data, { type: "array" });
    return book.SheetNames.map(function (name) {
      var sheet = book.Sheets[name] || {};
      var ref = typeof sheet["!ref"] === "string" ? sheet["!ref"] : null;
      if (!ref) return { name: name, rows: [], firstRow: 0, firstColumn: 0, totalRows: 0, truncated: false };
      var range = XLSX.utils.decode_range(ref);
      var totalRows = range.e.r - range.s.r + 1;
      var truncated = totalRows > MAX_ROWS;
      var limited = sheet;
      if (truncated) {
        limited = Object.assign({}, sheet, {
          "!ref": XLSX.utils.encode_range({ s: range.s, e: { r: range.s.r + MAX_ROWS - 1, c: range.e.c } }),
        });
      }
      // Пустые строки не выбрасываем: номера строк должны совпадать с Excel.
      var rows = XLSX.utils
        .sheet_to_json(limited, { header: 1, raw: false, defval: "", blankrows: true })
        .map(function (row) {
          return row.map(function (cell) {
            return cell == null ? "" : String(cell);
          });
        });
      return {
        name: name,
        rows: rows,
        firstRow: range.s.r,
        firstColumn: range.s.c,
        totalRows: totalRows,
        truncated: truncated,
      };
    });
  }

  function renderSheets(sheets) {
    if (sheets.length === 0) {
      setStatus("В книге нет листов.");
      return;
    }
    tabsEl.hidden = sheets.length < 2;
    cellbarEl.hidden = false;
    tabsEl.textContent = "";
    sheets.forEach(function (sheet, index) {
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = sheet.name;
      button.setAttribute("role", "tab");
      button.addEventListener("click", function () {
        showSheet(sheets, index);
      });
      tabsEl.appendChild(button);
    });
    showSheet(sheets, 0);
  }

  function showSheet(sheets, index) {
    var sheet = sheets[index];
    Array.prototype.forEach.call(tabsEl.children, function (button, i) {
      button.setAttribute("aria-selected", String(i === index));
    });
    addressEl.textContent = "—";
    cellTextEl.textContent = "Нажми на ячейку, чтобы увидеть текст целиком";
    cellTextEl.className = "celltext muted";
    contentEl.textContent = "";
    contentEl.scrollTo(0, 0);

    if (sheet.rows.length === 0) {
      var empty = document.createElement("div");
      empty.className = "note";
      empty.textContent = "Лист пустой.";
      contentEl.appendChild(empty);
      return;
    }

    var columnCount = Math.min(
      MAX_COLUMNS,
      sheet.rows.reduce(function (max, row) {
        return Math.max(max, row.length);
      }, 0),
    );
    var table = document.createElement("table");
    table.className = "grid";
    var head = table.createTHead().insertRow();
    var corner = document.createElement("th");
    corner.className = "corner";
    head.appendChild(corner);
    for (var c = 0; c < columnCount; c++) {
      var th = document.createElement("th");
      th.scope = "col";
      th.textContent = columnLetter(sheet.firstColumn + c);
      head.appendChild(th);
    }
    var body = table.createTBody();
    contentEl.appendChild(table);

    var selected = null;
    table.addEventListener("click", function (event) {
      var cell = event.target.closest("td");
      if (!cell) return;
      if (selected) selected.classList.remove("selected");
      selected = cell;
      cell.classList.add("selected");
      var r = Number(cell.dataset.r);
      var col = Number(cell.dataset.c);
      addressEl.textContent = columnLetter(sheet.firstColumn + col) + (sheet.firstRow + r + 1);
      var text = (sheet.rows[r] && sheet.rows[r][col]) || "";
      cellTextEl.textContent = text || "пусто";
      cellTextEl.className = text ? "celltext" : "celltext muted";
    });

    var shown = 0;
    var more = document.createElement("button");
    more.type = "button";
    more.className = "more";
    function appendRows() {
      var end = Math.min(sheet.rows.length, shown + ROWS_STEP);
      var fragment = document.createDocumentFragment();
      for (var r = shown; r < end; r++) {
        var tr = document.createElement("tr");
        var rowHead = document.createElement("th");
        rowHead.scope = "row";
        rowHead.textContent = String(sheet.firstRow + r + 1);
        tr.appendChild(rowHead);
        var row = sheet.rows[r];
        for (var col = 0; col < columnCount; col++) {
          var td = document.createElement("td");
          td.dataset.r = String(r);
          td.dataset.c = String(col);
          td.textContent = row[col] || "";
          tr.appendChild(td);
        }
        fragment.appendChild(tr);
      }
      body.appendChild(fragment);
      shown = end;
      var rest = sheet.rows.length - shown;
      if (rest > 0) {
        more.textContent =
          "Показать ещё " + Math.min(ROWS_STEP, rest) + " строк (показано " + shown + " из " + sheet.rows.length + ")";
        if (!more.isConnected) contentEl.appendChild(more);
      } else if (more.isConnected) {
        more.remove();
      }
    }
    more.addEventListener("click", appendRows);
    appendRows();

    if (sheet.truncated) {
      var note = document.createElement("div");
      note.className = "note";
      note.textContent = "Показаны первые " + MAX_ROWS + " строк из " + sheet.totalRows + ".";
      contentEl.appendChild(note);
    }
  }

  // ---------- документы ----------

  var ALLOWED_TAGS = [
    "P", "H1", "H2", "H3", "H4", "H5", "H6", "STRONG", "B", "EM", "I", "U", "S", "SUP", "SUB",
    "UL", "OL", "LI", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH", "BR", "A", "IMG", "BLOCKQUOTE",
  ];

  /** Белый список тегов и атрибутов: документ — чужие данные, скрипты и javascript:-ссылки не проходят. */
  function sanitizeInto(html, target) {
    var source = new DOMParser().parseFromString("<body>" + html + "</body>", "text/html");
    (function copy(node, into) {
      Array.prototype.forEach.call(node.childNodes, function (child) {
        if (child.nodeType === Node.TEXT_NODE) {
          into.appendChild(document.createTextNode(child.textContent || ""));
          return;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) return;
        if (["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].indexOf(child.tagName) >= 0) return;
        if (ALLOWED_TAGS.indexOf(child.tagName) < 0) {
          copy(child, into);
          return;
        }
        var element = document.createElement(child.tagName.toLowerCase());
        if (child.tagName === "A") {
          var href = child.getAttribute("href") || "";
          if (/^(https?:|mailto:)/i.test(href)) {
            element.setAttribute("href", href);
            element.setAttribute("target", "_blank");
            element.setAttribute("rel", "noopener noreferrer");
          }
        }
        if (child.tagName === "IMG") {
          var src = child.getAttribute("src") || "";
          if (!/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(src)) return;
          element.setAttribute("src", src);
          element.setAttribute("alt", child.getAttribute("alt") || "");
        }
        ["colspan", "rowspan"].forEach(function (name) {
          var value = child.getAttribute(name);
          if (value && /^\d{1,3}$/.test(value)) element.setAttribute(name, value);
        });
        into.appendChild(element);
        copy(child, element);
      });
    })(source.body, target);
  }

  function renderDoc(data) {
    return window.mammoth.convertToHtml({ arrayBuffer: data }).then(function (result) {
      var article = document.createElement("article");
      article.className = "doc";
      sanitizeInto(result.value, article);
      contentEl.textContent = "";
      contentEl.appendChild(article);
    });
  }

  // ---------- запуск ----------

  function main() {
    var src = readSource();
    if (!src) {
      setStatus("Нет ссылки на файл.", true);
      return;
    }
    var name = decodeURIComponent(src.pathname.split("/").pop() || "");
    document.title = name || "Просмотр файла";
    var kind = kindOf(name);
    if (!kind) {
      setStatus("Этот формат страница не показывает.", true);
      return;
    }
    var job;
    if (kind === "sheet") {
      job = Promise.all([loadScript("xlsx.full.min.js"), fetchBytes(src.href)]).then(function (parts) {
        renderSheets(readSheets(parts[1]));
      });
    } else {
      var dataUrl =
        kind === "converted-doc" ? src.href.replace("/api/assets/", "/api/t3patch/asset-docx/") : src.href;
      if (kind === "converted-doc") setStatus("Конвертирую документ…");
      job = Promise.all([loadScript("mammoth.browser.min.js"), fetchBytes(dataUrl)]).then(function (parts) {
        return renderDoc(parts[1]);
      });
    }
    job.then(
      function () {
        setStatus("");
      },
      function (error) {
        setStatus((error && error.message) || "Не удалось открыть файл.", true);
      },
    );
  }

  main();
})();
