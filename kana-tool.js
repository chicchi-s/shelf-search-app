"use strict";

// products.csv の product_kana 空欄を、商品名ベースで補完してダウンロードする。

var KanaTool = (function () {
  var REQUIRED_COLUMNS = [
    "jan_code",
    "product_code",
    "product_name",
    "product_kana",
    "maker",
    "package",
    "shelf_no",
    "search_words"
  ];

  var KANJI_READINGS = {
    "配合": "ハイゴウ",
    "錠": "ジョウ",
    "散": "サン",
    "細粒": "サイリュウ",
    "顆粒": "カリュウ",
    "粉末": "フンマツ",
    "液": "エキ",
    "注射": "チュウシャ",
    "静注": "ジョウチュウ",
    "点滴": "テンテキ",
    "注": "チュウ",
    "内服": "ナイフク",
    "外用": "ガイヨウ",
    "軟膏": "ナンコウ",
    "坐剤": "ザザイ",
    "貼付": "チョウフ",
    "徐放": "ジョホウ",
    "口腔": "コウクウ",
    "崩壊": "ホウカイ",
    "水和物": "スイワブツ",
    "後発": "コウハツ",
    "般": "ハン"
  };

  var state = {
    fieldnames: [],
    records: [],
    outputBytes: null
  };

  var elements = {};

  function init() {
    elements.csvFile = document.getElementById("csvFile");
    elements.downloadButton = document.getElementById("downloadButton");
    elements.statusText = document.getElementById("statusText");
    elements.rowCount = document.getElementById("rowCount");
    elements.updatedCount = document.getElementById("updatedCount");
    elements.previewBody = document.getElementById("previewBody");

    elements.csvFile.addEventListener("change", handleFileChange);
    elements.downloadButton.addEventListener("click", downloadCsv);
  }

  function handleFileChange(event) {
    var file = event.target.files[0];
    if (!file) {
      setStatus("CSVを選択してください。");
      return;
    }

    file.arrayBuffer()
      .then(decodeCsvBuffer)
      .then(processCsv)
      .catch(function (error) {
        elements.downloadButton.disabled = true;
        setStatus("処理エラー: " + error.message);
      });
  }

  function decodeCsvBuffer(buffer) {
    var bytes = new Uint8Array(buffer);

    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
      return new TextDecoder("utf-16le", { fatal: false }).decode(buffer);
    }

    var utf8Text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
    if (utf8Text.indexOf("\uFFFD") === -1) {
      return utf8Text;
    }
    return new TextDecoder("shift_jis", { fatal: false }).decode(buffer);
  }

  function processCsv(csvText) {
    var rows = parseCsv(csvText);
    var header;
    var updatedCount = 0;

    if (rows.length < 2) {
      throw new Error("データ行がありません。");
    }

    header = rows[0].map(function (cell) { return cell.trim(); }).filter(Boolean);
    validateHeader(header);

    state.fieldnames = header;
    state.records = rows.slice(1).filter(function (row) {
      return row.some(function (cell) { return String(cell || "").trim() !== ""; });
    }).map(function (row) {
      var record = {};
      header.forEach(function (fieldname, index) {
        record[fieldname] = String(row[index] || "").trim();
      });

      if (!record.product_kana && record.product_name) {
        record.product_kana = makeKana(record.product_name);
        updatedCount += 1;
      }

      return record;
    });

    state.outputBytes = buildExcelCsvBytes(header, state.records);
    elements.rowCount.textContent = String(state.records.length);
    elements.updatedCount.textContent = String(updatedCount);
    elements.downloadButton.disabled = false;
    setStatus("補完が完了しました。ダウンロード前にプレビューを確認してください。");
    renderPreview(state.records);
  }

  function validateHeader(header) {
    var missing = REQUIRED_COLUMNS.filter(function (column) {
      return header.indexOf(column) === -1;
    });
    if (missing.length > 0) {
      throw new Error("必要な列がありません: " + missing.join(", "));
    }
  }

  function makeKana(productName) {
    var text = normalizeName(productName);
    Object.keys(KANJI_READINGS).sort(function (a, b) {
      return b.length - a.length;
    }).forEach(function (kanji) {
      text = text.split(kanji).join(KANJI_READINGS[kanji]);
    });

    text = hiraToKata(text);
    text = text.replace(/[一-龯々〆ヵヶ]+/g, "");
    text = text.normalize("NFKC").toUpperCase();
    text = text.replace(/[「」『』【】\[\]（）()]/g, " ");
    text = text.replace(/[,，、。/／・]+/g, " ");
    text = text.replace(/\s+/g, " ");
    return text.trim();
  }

  function normalizeName(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/\u3000/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function hiraToKata(value) {
    return String(value || "").replace(/[\u3041-\u3096]/g, function (char) {
      return String.fromCharCode(char.charCodeAt(0) + 0x60);
    });
  }

  function parseCsv(text) {
    var firstLine = String(text || "").split(/\r\n|\n|\r/, 1)[0] || "";
    var delimiter = countText(firstLine, "\t") > countText(firstLine, ",") ? "\t" : ",";
    var rows = [];
    var row = [];
    var value = "";
    var inQuotes = false;
    var i;
    var char;
    var nextChar;

    for (i = 0; i < text.length; i += 1) {
      char = text.charAt(i);
      nextChar = text.charAt(i + 1);

      if (char === "\"") {
        if (inQuotes && nextChar === "\"") {
          value += "\"";
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === delimiter && !inQuotes) {
        row.push(value);
        value = "";
      } else if ((char === "\n" || char === "\r") && !inQuotes) {
        if (char === "\r" && nextChar === "\n") {
          i += 1;
        }
        row.push(value);
        rows.push(row);
        row = [];
        value = "";
      } else {
        value += char;
      }
    }

    if (value !== "" || row.length > 0) {
      row.push(value);
      rows.push(row);
    }

    return rows;
  }

  function countText(text, needle) {
    return String(text || "").split(needle).length - 1;
  }

  function buildExcelCsvBytes(header, records) {
    var lines = [];
    var text;

    lines.push(header.map(escapeTsv).join("\t"));
    records.forEach(function (record) {
      lines.push(header.map(function (fieldname) {
        return escapeTsv(record[fieldname] || "");
      }).join("\t"));
    });

    text = "\uFEFF" + lines.join("\r\n");
    return encodeUtf16Le(text);
  }

  function escapeTsv(value) {
    var text = String(value || "");
    text = text.replace(/\t/g, " ");
    if (/["\r\n]/.test(text)) {
      return "\"" + text.replace(/"/g, "\"\"") + "\"";
    }
    return text;
  }

  function encodeUtf16Le(text) {
    var bytes = new Uint8Array(text.length * 2);
    var i;
    var code;

    for (i = 0; i < text.length; i += 1) {
      code = text.charCodeAt(i);
      bytes[i * 2] = code & 0xFF;
      bytes[i * 2 + 1] = code >> 8;
    }

    return bytes;
  }

  function renderPreview(records) {
    elements.previewBody.innerHTML = "";
    records.slice(0, 30).forEach(function (record) {
      var row = document.createElement("tr");
      ["product_code", "product_name", "product_kana", "shelf_no"].forEach(function (fieldname) {
        var cell = document.createElement("td");
        cell.textContent = record[fieldname] || "";
        row.appendChild(cell);
      });
      elements.previewBody.appendChild(row);
    });
  }

  function downloadCsv() {
    var blob = new Blob([state.outputBytes], { type: "text/csv;charset=utf-16le" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = "products.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setStatus("products_kana_completed.csv をダウンロードしました。");
  }

  function setStatus(message) {
    elements.statusText.textContent = message;
  }

  return {
    init: init
  };
}());

document.addEventListener("DOMContentLoaded", KanaTool.init);
