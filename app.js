"use strict";

// 医薬品卸倉庫向け棚検索アプリ
// products.csv を固定の商品マスターとして読み込み、JAN/GS1コードとあいまい検索に対応する。

var App = (function () {
  var CSV_PATH = "products.csv";
  var MAX_RESULTS = 50;
  var SCAN_INTERVAL_MS = 280;
  var BARCODE_FORMAT_CANDIDATES = ["ean_13", "ean_8", "code_128", "data_matrix", "qr_code"];

  var products = [];
  var currentStream = null;
  var scanTimer = null;
  var barcodeDetector = null;
  var elements = {};

  function init() {
    elements.searchInput = document.getElementById("searchInput");
    elements.clearButton = document.getElementById("clearButton");
    elements.reloadButton = document.getElementById("reloadButton");
    elements.scanButton = document.getElementById("scanButton");
    elements.manualJanButton = document.getElementById("manualJanButton");
    elements.selectCsvButton = document.getElementById("selectCsvButton");
    elements.csvFileInput = document.getElementById("csvFileInput");
    elements.stopScanButton = document.getElementById("stopScanButton");
    elements.cameraPanel = document.getElementById("cameraPanel");
    elements.cameraPreview = document.getElementById("cameraPreview");
    elements.statusText = document.getElementById("statusText");
    elements.deployInfo = document.getElementById("deployInfo");
    elements.productCount = document.getElementById("productCount");
    elements.resultCount = document.getElementById("resultCount");
    elements.results = document.getElementById("results");
    elements.emptyMessage = document.getElementById("emptyMessage");
    elements.logList = document.getElementById("logList");
    elements.template = document.getElementById("resultTemplate");
    elements.cameraPreview.setAttribute("autoplay", "autoplay");
    elements.cameraPreview.setAttribute("playsinline", "playsinline");
    elements.cameraPreview.setAttribute("webkit-playsinline", "webkit-playsinline");
    elements.cameraPreview.muted = true;

    elements.searchInput.addEventListener("input", function () {
      runSearch(elements.searchInput.value);
    });
    elements.clearButton.addEventListener("click", clearSearch);
    elements.reloadButton.addEventListener("click", loadProducts);
    elements.scanButton.addEventListener("click", startScanner);
    elements.stopScanButton.addEventListener("click", stopScanner);
    elements.manualJanButton.addEventListener("click", askManualCode);
    elements.selectCsvButton.addEventListener("click", function () {
      elements.csvFileInput.click();
    });
    elements.csvFileInput.addEventListener("change", handleCsvFileSelect);

    setupPwa();
    showDeployInfo();
    loadProducts();
  }

  function showDeployInfo() {
    var mode = window.SINGLE_FILE_APP ? "単体HTML" : "分割ファイル";
    var embeddedSize = window.EMBEDDED_PRODUCTS_CSV_BASE64 ? window.EMBEDDED_PRODUCTS_CSV_BASE64.length : 0;
    var cameraContext = isCameraAllowedContext() ? "カメラ可" : "カメラ不可";

    if (elements.deployInfo) {
      elements.deployInfo.textContent =
        "配信状態: " + mode +
        " / 埋込CSV: " + embeddedSize +
        " / " + cameraContext +
        " / " + location.protocol;
    }

    writeLog(
      "配信状態: mode=" + mode +
      " embeddedCsvBase64Length=" + embeddedSize +
      " cameraContext=" + cameraContext +
      " protocol=" + location.protocol +
      " origin=" + location.origin
    );
  }

  function setupPwa() {
    if (window.SINGLE_FILE_APP) {
      return;
    }

    if (
      "serviceWorker" in navigator &&
      (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")
    ) {
      navigator.serviceWorker.register("sw.js").catch(function (error) {
        writeLog("PWA登録エラー: " + error.message);
      });
    }
  }

  function loadProducts() {
    stopScanner();
    setStatus("商品マスターを読み込み中です。");
    writeLog("商品マスター読込開始");

    if (window.EMBEDDED_PRODUCTS_CSV_BASE64) {
      try {
        writeLog("埋込CSV検出: base64 length=" + window.EMBEDDED_PRODUCTS_CSV_BASE64.length);
        applyProductsCsv(
          decodeCsvBuffer(base64ToArrayBuffer(window.EMBEDDED_PRODUCTS_CSV_BASE64)),
          "埋込商品マスター読込成功"
        );
      } catch (error) {
        resetProducts();
        setStatus("埋込商品マスター読込に失敗しました。ログを確認してください。");
        writeLog("埋込商品マスター読込エラー: " + error.message);
      }
      return;
    }

    if (location.protocol === "file:") {
      setStatus("直接開いているため自動読込できません。CSV選択から products.csv を選択してください。");
      writeLog("自動読込スキップ: file://で起動");
      return;
    }

    fetch(CSV_PATH + "?v=" + Date.now(), { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("products.csv を取得できません。HTTP " + response.status);
        }
        return response.arrayBuffer();
      })
      .then(decodeCsvBuffer)
      .then(function (csvText) {
        applyProductsCsv(csvText, "商品マスター読込成功");
      })
      .catch(function (error) {
        resetProducts();
        setStatus("商品マスター読込に失敗しました。ログを確認してください。");
        writeLog("商品マスター読込エラー: " + error.message);
      });
  }

  function handleCsvFileSelect(event) {
    var file = event.target.files[0];
    if (!file) {
      return;
    }

    setStatus("選択したCSVを読み込み中です。");
    writeLog("CSV手動選択: " + file.name);

    file.arrayBuffer()
      .then(decodeCsvBuffer)
      .then(function (csvText) {
        applyProductsCsv(csvText, "CSV手動読込成功");
      })
      .catch(function (error) {
        resetProducts();
        setStatus("選択したCSVを読み込めませんでした。ログを確認してください。");
        writeLog("CSV手動読込エラー: " + error.message);
      });
  }

  function applyProductsCsv(csvText, logLabel) {
    products = buildProducts(parseDelimitedText(csvText));
    elements.productCount.textContent = String(products.length);
    setStatus("商品マスターを読み込みました。");
    writeLog(logLabel + ": " + products.length + "件");
    runSearch(elements.searchInput.value);
  }

  function resetProducts() {
    products = [];
    elements.productCount.textContent = "0";
    elements.resultCount.textContent = "0";
    renderResults([]);
  }

  function decodeCsvBuffer(buffer) {
    var bytes = new Uint8Array(buffer);
    var utf8Text;

    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
      return new TextDecoder("utf-16le", { fatal: false }).decode(buffer);
    }

    utf8Text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
    if (utf8Text.indexOf("\uFFFD") === -1) {
      return utf8Text;
    }

    try {
      return new TextDecoder("shift_jis", { fatal: false }).decode(buffer);
    } catch (error) {
      writeLog("Shift-JIS変換エラー: " + error.message);
      return utf8Text;
    }
  }

  function base64ToArrayBuffer(base64Text) {
    var binary = atob(base64Text);
    var bytes = new Uint8Array(binary.length);
    var i;

    for (i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }

    return bytes.buffer;
  }

  function parseDelimitedText(text) {
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
        if (row.some(function (cell) { return String(cell || "").trim() !== ""; })) {
          rows.push(row);
        }
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

  function buildProducts(rows) {
    var headers;
    var headerMap = {};

    if (rows.length < 2) {
      throw new Error("CSVにデータ行がありません。");
    }

    headers = rows[0].map(function (header) { return String(header || "").trim(); });
    headers.forEach(function (header, index) {
      headerMap[header] = index;
    });

    requireColumns(headerMap, [
      "jan_code",
      "product_code",
      "product_name",
      "product_kana",
      "maker",
      "package",
      "shelf_no",
      "search_words"
    ]);

    return rows.slice(1).map(function (row, index) {
      var product = {
        id: index + 1,
        janCode: getCell(row, headerMap.jan_code),
        productCode: getCell(row, headerMap.product_code),
        productName: getCell(row, headerMap.product_name),
        productKana: getCell(row, headerMap.product_kana),
        maker: getCell(row, headerMap.maker),
        package: getCell(row, headerMap.package),
        shelfNo: getCell(row, headerMap.shelf_no),
        searchWords: getCell(row, headerMap.search_words)
      };

      product.normalizedJan = normalizeDigits(product.janCode);
      product.gtin14 = toGtin14(product.normalizedJan);
      product.searchText = normalizeSearchText([
        product.janCode,
        product.productCode,
        product.productName,
        product.productKana,
        product.maker,
        product.package,
        product.shelfNo,
        product.searchWords
      ].join(" "));
      product.compactSearchText = compactSearchText(product.searchText);

      return product;
    }).filter(function (product) {
      return product.productName !== "" || product.janCode !== "" || product.productCode !== "";
    });
  }

  function requireColumns(headerMap, requiredColumns) {
    var missing = requiredColumns.filter(function (column) {
      return typeof headerMap[column] !== "number";
    });

    if (missing.length > 0) {
      throw new Error("CSV列不足: " + missing.join(", "));
    }
  }

  function getCell(row, index) {
    return String(row[index] || "").trim();
  }

  function runSearch(rawQuery) {
    var extractedCode = extractSearchCode(rawQuery);
    var queryForText = extractedCode || rawQuery;
    var query = normalizeSearchText(queryForText);
    var codeQuery = normalizeDigits(extractedCode || rawQuery);
    var gtin14Query = toGtin14(codeQuery);
    var results;

    if (query === "" && codeQuery === "") {
      elements.resultCount.textContent = "0";
      renderResults([]);
      elements.emptyMessage.hidden = true;
      setStatus("JAN/GS1コードまたは商品名を入力してください。");
      return;
    }

    results = products.map(function (product) {
      return {
        product: product,
        score: scoreProduct(product, query, codeQuery, gtin14Query)
      };
    }).filter(function (item) {
      return item.score > 0;
    }).sort(function (a, b) {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.product.shelfNo.localeCompare(b.product.shelfNo, "ja");
    }).slice(0, MAX_RESULTS).map(function (item) {
      return item.product;
    });

    elements.resultCount.textContent = String(results.length);
    renderResults(results);
    elements.emptyMessage.hidden = results.length > 0;
    setStatus(results.length + "件見つかりました。");
    writeLog("検索: " + rawQuery + " / 抽出コード: " + (extractedCode || "-") + " / " + results.length + "件");
  }

  function scoreProduct(product, query, codeQuery, gtin14Query) {
    var score = 0;
    var words;
    var matchedWords;
    var compactQuery = compactSearchText(query);

    if (codeQuery !== "" && product.normalizedJan === codeQuery) {
      return 1200;
    }
    if (gtin14Query !== "" && product.gtin14 === gtin14Query) {
      return 1150;
    }
    if (codeQuery.length === 14 && codeQuery.charAt(0) === "0" && product.normalizedJan === codeQuery.slice(1)) {
      return 1100;
    }
    if (codeQuery !== "" && product.normalizedJan.indexOf(codeQuery) !== -1) {
      score += 500;
    }
    if (normalizeSearchText(product.productCode) === query) {
      score += 420;
    }
    if (normalizeSearchText(product.productName).indexOf(query) !== -1) {
      score += 320;
    }
    if (product.searchText.indexOf(query) !== -1) {
      score += 180;
    }
    if (compactQuery !== "" && product.compactSearchText.indexOf(compactQuery) !== -1) {
      score += 120;
    }

    words = query.split(" ").filter(Boolean);
    if (words.length > 1) {
      matchedWords = words.filter(function (word) {
        return product.searchText.indexOf(word) !== -1;
      });
      if (matchedWords.length === words.length) {
        score += 140;
      }
    }

    return score;
  }

  function renderResults(items) {
    elements.results.innerHTML = "";

    items.forEach(function (product) {
      var node = elements.template.content.firstElementChild.cloneNode(true);
      node.querySelector(".shelf-no").textContent = product.shelfNo || "未登録";
      node.querySelector(".product-name").textContent = product.productName || "商品名未登録";
      node.querySelector(".product-code").textContent = product.productCode || "-";
      node.querySelector(".jan-code").textContent = product.janCode || "-";
      node.querySelector(".maker").textContent = product.maker || "-";
      node.querySelector(".package").textContent = product.package || "-";
      elements.results.appendChild(node);
    });
  }

  function normalizeSearchText(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/[\u3041-\u3096]/g, function (char) {
        return String.fromCharCode(char.charCodeAt(0) + 0x60);
      })
      .toLowerCase()
      .replace(/[‐‑‒–—―ーｰ]/g, "-")
      .replace(/\s+/g, " ")
      .trim();
  }

  function compactSearchText(value) {
    return normalizeSearchText(value).replace(/[\s-]/g, "");
  }

  function normalizeDigits(value) {
    return String(value || "").normalize("NFKC").replace(/\D/g, "");
  }

  function toGtin14(digits) {
    var value = normalizeDigits(digits);
    if (value.length === 14) {
      return value;
    }
    if (value.length === 13) {
      return "0" + value;
    }
    if (value.length === 8) {
      return "000000" + value;
    }
    return "";
  }

  function extractSearchCode(rawValue) {
    var raw = String(rawValue || "").normalize("NFKC");
    var digits = normalizeDigits(raw);
    var match;

    // 表示形式: (01)04987128297405(17)...
    match = raw.match(/\(01\)\s*(\d{14})/);
    if (match) {
      return normalizeGtinForSearch(match[1]);
    }

    // FNC1/GS区切り形式: ]d2010498712829740517... または 010498...
    match = raw.match(/(?:^|[\x1D\]\w])01(\d{14})/);
    if (match) {
      return normalizeGtinForSearch(match[1]);
    }

    // 数字のみのGS1。先頭AI 01 + GTIN14 を優先して抜き出す。
    if (digits.length > 14) {
      match = digits.match(/01(\d{14})/);
      if (match) {
        return normalizeGtinForSearch(match[1]);
      }
    }

    if (digits.length === 8 || digits.length === 12 || digits.length === 13 || digits.length === 14) {
      return normalizeGtinForSearch(digits);
    }

    return "";
  }

  function normalizeGtinForSearch(digits) {
    var value = normalizeDigits(digits);
    if (value.length === 14 && value.charAt(0) === "0") {
      return value.slice(1);
    }
    return value;
  }

  function clearSearch() {
    elements.searchInput.value = "";
    runSearch("");
    elements.searchInput.focus();
  }

  function askManualCode() {
    var code = window.prompt("JANコードまたはGS1コードを入力してください。");
    var extracted;
    if (code === null) {
      return;
    }
    extracted = extractSearchCode(code) || normalizeDigits(code);
    elements.searchInput.value = extracted || code;
    runSearch(code);
  }

  function startScanner() {
    if (!isCameraAllowedContext()) {
      setStatus("この開き方ではカメラを使用できません。HTTPS配信されたURLで開いてください。");
      writeLog("カメラ不可: 安全なHTTPSページではありません。protocol=" + location.protocol + " origin=" + location.origin);
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus("このブラウザではカメラを利用できません。コード手入力を使ってください。");
      writeLog("カメラ非対応: mediaDevicesなし");
      return;
    }

    if (!("BarcodeDetector" in window)) {
      setStatus("このブラウザはバーコード自動読取に未対応です。コード手入力を使ってください。");
      writeLog("バーコード検出非対応: BarcodeDetectorなし");
      return;
    }

    stopScanner();
    setStatus("カメラを起動しています。");
    writeLog("カメラ起動開始");

    createBarcodeDetector().then(function (detector) {
      barcodeDetector = detector;
      return openCameraStream();
    }).then(function (stream) {
      return attachCameraStream(stream);
    }).then(function () {
      setStatus("JANまたはGS1コードを枠内に入れてください。");
      scanTimer = window.setInterval(detectBarcode, SCAN_INTERVAL_MS);
      writeLog("カメラ起動成功");
    }).catch(function (error) {
      stopScanner();
      setStatus("カメラを起動できません。権限、HTTPS配信、対応ブラウザを確認してください。");
      writeLog("カメラ起動エラー: " + error.message);
    });
  }

  function isCameraAllowedContext() {
    if (location.protocol === "https:") {
      return true;
    }
    if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
      return true;
    }
    return false;
  }

  function openCameraStream() {
    var rearCamera = {
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    };

    return navigator.mediaDevices.getUserMedia(rearCamera).catch(function (error) {
      writeLog("背面カメラ指定で起動できません。通常カメラで再試行: " + error.message);
      return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    });
  }

  function attachCameraStream(stream) {
    currentStream = stream;
    elements.cameraPanel.hidden = false;
    elements.cameraPreview.srcObject = stream;
    elements.cameraPreview.load();

    return elements.cameraPreview.play().then(function () {
      return waitForVideoReady();
    });
  }

  function waitForVideoReady() {
    return new Promise(function (resolve) {
      var startedAt = Date.now();

      function checkVideo() {
        if (elements.cameraPreview.videoWidth > 0 && elements.cameraPreview.videoHeight > 0) {
          writeLog(
            "カメラ映像表示: " +
            elements.cameraPreview.videoWidth + "x" + elements.cameraPreview.videoHeight
          );
          resolve();
          return;
        }

        if (Date.now() - startedAt > 3000) {
          writeLog("カメラ映像が黒画面の可能性: videoWidth=0。ブラウザ、添付HTML、HTTPS配信を確認してください。");
          setStatus("カメラ映像が表示されません。別ブラウザ、HTTPS配信、端末のカメラ権限を確認してください。");
          resolve();
          return;
        }

        window.setTimeout(checkVideo, 150);
      }

      checkVideo();
    });
  }

  function createBarcodeDetector() {
    if (BarcodeDetector.getSupportedFormats) {
      return BarcodeDetector.getSupportedFormats().then(function (supportedFormats) {
        var formats = BARCODE_FORMAT_CANDIDATES.filter(function (format) {
          return supportedFormats.indexOf(format) !== -1;
        });
        if (formats.length === 0) {
          throw new Error("対応バーコード形式がありません。");
        }
        writeLog("読取形式: " + formats.join(", "));
        return new BarcodeDetector({ formats: formats });
      });
    }

    return Promise.resolve(new BarcodeDetector({ formats: BARCODE_FORMAT_CANDIDATES }));
  }

  function detectBarcode() {
    if (!barcodeDetector || !elements.cameraPreview.videoWidth) {
      return;
    }

    barcodeDetector.detect(elements.cameraPreview).then(function (barcodes) {
      var rawValue;
      var extractedCode;
      if (!barcodes || barcodes.length === 0) {
        return;
      }

      rawValue = String(barcodes[0].rawValue || "");
      extractedCode = extractSearchCode(rawValue);
      if (extractedCode === "") {
        writeLog("読取値からJAN/GTINを抽出できません: " + rawValue);
        return;
      }

      elements.searchInput.value = extractedCode;
      runSearch(rawValue);
      setStatus("コードを読み取りました: " + extractedCode);
      writeLog("コード読取成功: " + rawValue + " -> " + extractedCode);
      stopScanner();
    }).catch(function (error) {
      writeLog("コード読取エラー: " + error.message);
    });
  }

  function stopScanner() {
    if (scanTimer) {
      window.clearInterval(scanTimer);
      scanTimer = null;
    }

    if (currentStream) {
      currentStream.getTracks().forEach(function (track) {
        track.stop();
      });
      currentStream = null;
    }

    if (elements.cameraPreview) {
      elements.cameraPreview.srcObject = null;
    }

    if (elements.cameraPanel) {
      elements.cameraPanel.hidden = true;
    }
  }

  function setStatus(message) {
    elements.statusText.textContent = message;
  }

  function writeLog(message) {
    var item = document.createElement("li");
    var now = new Date();
    item.textContent = formatTime(now) + " " + message;
    elements.logList.prepend(item);

    while (elements.logList.children.length > 80) {
      elements.logList.removeChild(elements.logList.lastElementChild);
    }

    if (window.console && console.info) {
      console.info("[棚検索] " + message);
    }
  }

  function formatTime(date) {
    return [
      pad2(date.getHours()),
      pad2(date.getMinutes()),
      pad2(date.getSeconds())
    ].join(":");
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  return {
    init: init
  };
}());

document.addEventListener("DOMContentLoaded", App.init);
