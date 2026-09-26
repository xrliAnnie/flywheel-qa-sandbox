(function () {
  var ISSUE = "FLY-2904";
  var MARKER = "【页面意见汇总】" + ISSUE;
  var CHUNK_LIMIT = 1800;
  var prefix = "fly-comments:" + ISSUE + ":" + String(window.location.pathname || "/") + ":";

  function storageGet(key) { try { return window.localStorage.getItem(prefix + key) || ""; } catch (e) { return ""; } }
  function storageSet(key, value) { try { window.localStorage.setItem(prefix + key, value); } catch (e) {} }
  function storageDel(key) { try { window.localStorage.removeItem(prefix + key); } catch (e) {} }

  var areas = Array.prototype.slice.call(document.querySelectorAll("textarea[data-key]"));
  var chunksEl = document.getElementById("summary-chunks");
  var statusEl = document.getElementById("copy-status");

  var choices = Array.prototype.slice.call(document.querySelectorAll(".choice[data-key]"));

  function choiceOf(key) {
    var el = document.querySelector('input[name="c-' + key + '"]:checked');
    return el ? el.value : "";
  }

  function collect() {
    var lines = [];
    areas.forEach(function (ta) {
      var key = ta.getAttribute("data-key");
      var text = (ta.value || "").trim();
      var pick = choiceOf(key);
      if (!text && !pick) return;
      lines.push("【" + (ta.getAttribute("data-title") || key) + "】" + (pick ? "〔" + pick + "〕" : "") + text);
    });
    return lines;
  }

  function buildChunks(lines) {
    var chunks = [];
    if (lines.length === 0) return [MARKER + "\n(暂无意见)"];
    var current = MARKER;
    lines.forEach(function (line) {
      var candidate = current + "\n" + line;
      if (candidate.length > CHUNK_LIMIT && current !== MARKER) {
        chunks.push(current);
        current = MARKER + "\n" + line;
      } else {
        current = candidate;
      }
    });
    chunks.push(current);
    return chunks;
  }

  function copyText(text, onDone) {
    function fallback() {
      var ok = false;
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.top = "-1000px";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch (e) { ok = false; }
      onDone(ok);
    }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(text).then(function () { onDone(true); }, function () { fallback(); });
    } else {
      fallback();
    }
  }

  function setStatus(msg) {
    statusEl.textContent = msg;
    window.setTimeout(function () { if (statusEl.textContent === msg) statusEl.textContent = ""; }, 4000);
  }

  function render() {
    var chunks = buildChunks(collect());
    while (chunksEl.firstChild) chunksEl.removeChild(chunksEl.firstChild);
    chunks.forEach(function (chunk, index) {
      var box = document.createElement("div");
      var pre = document.createElement("div");
      pre.className = "summary-box";
      pre.textContent = chunk;
      box.appendChild(pre);
      if (chunks.length > 1) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn sec";
        btn.textContent = "复制第 " + (index + 1) + " / " + chunks.length + " 段";
        btn.addEventListener("click", function () {
          copyText(chunk, function (ok) { setStatus(ok ? "已复制第 " + (index + 1) + " 段" : "复制失败,请手动全选复制"); });
        });
        box.appendChild(btn);
      }
      chunksEl.appendChild(box);
    });
  }

  areas.forEach(function (ta) {
    var key = ta.getAttribute("data-key");
    ta.value = storageGet(key);
    ta.addEventListener("input", function () {
      storageSet(key, ta.value);
      render();
    });
  });

  choices.forEach(function (box) {
    var key = box.getAttribute("data-key");
    var saved = storageGet("choice:" + key);
    Array.prototype.slice.call(box.querySelectorAll("input")).forEach(function (input) {
      if (saved && input.value === saved) input.checked = true;
      input.addEventListener("change", function () {
        storageSet("choice:" + key, input.value);
        render();
      });
    });
  });

  document.getElementById("copy-all").addEventListener("click", function () {
    var text = buildChunks(collect()).join("\n\n");
    copyText(text, function (ok) { setStatus(ok ? "已复制全部评论" : "复制失败,请手动全选复制"); });
  });

  document.getElementById("clear-all").addEventListener("click", function () {
    areas.forEach(function (ta) { ta.value = ""; storageDel(ta.getAttribute("data-key")); storageDel("choice:" + ta.getAttribute("data-key")); });
    Array.prototype.slice.call(document.querySelectorAll(".choice input")).forEach(function (i) { i.checked = false; });
    render();
    setStatus("已清空");
  });

  render();
})();
