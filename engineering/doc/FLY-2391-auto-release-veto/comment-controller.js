
(() => {
  'use strict';
  const marker = '【页面意见汇总】FLY-2391';
  const prefix = 'flywheel:design-comments:' + location.pathname + ':';
  const inputs = Array.from(document.querySelectorAll('textarea[data-comment]'));
  const chunksBox = document.getElementById('comment-chunks');
  const status = document.getElementById('copy-status');
  let chunks = [];
  function splitText(text) {
    const chars = Array.from(text);
    const room = 1800 - Array.from(marker).length - 1;
    if (!chars.length) return [marker + '\n（暂无意见）'];
    const result = [];
    let part = '';
    for (const char of chars) {
      if (part.length + char.length > room) {
        result.push(marker + '\n' + part);
        part = '';
      }
      part += char;
    }
    if (part) result.push(marker + '\n' + part);
    return result;
  }
  function fallbackCopy(text) {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('aria-label', '复制意见');
    helper.style.position = 'fixed';
    helper.style.left = '-10000px';
    document.body.appendChild(helper);
    helper.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    helper.remove();
    return ok;
  }
  async function copyText(text) {
    let ok = false;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try { await navigator.clipboard.writeText(text); ok = true; }
      catch (_) { ok = fallbackCopy(text); }
    } else { ok = fallbackCopy(text); }
    status.textContent = ok ? '已复制' : '复制失败，请选中下方文字手动复制';
  }
  function updateSummary() {
    const entries = inputs.filter(input => input.value.trim()).map(input =>
      input.dataset.title + '\n' + input.value.trim());
    chunks = splitText(entries.join('\n\n'));
    chunksBox.replaceChildren();
    chunks.forEach((chunk, index) => {
      const block = document.createElement('div');
      block.className = 'chunk';
      const text = document.createElement('pre');
      text.textContent = chunk;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary';
      button.textContent = '复制第 ' + (index + 1) + ' 段';
      button.addEventListener('click', () => copyText(chunk));
      block.appendChild(text);
      block.appendChild(button);
      chunksBox.appendChild(block);
    });
  }
  inputs.forEach(input => {
    const saved = document.querySelector('[data-saved="' + input.dataset.comment + '"]');
    try { input.value = localStorage.getItem(prefix + input.dataset.comment) || ''; }
    catch (_) { if (saved) saved.textContent = '无法读取本机保存'; }
    input.addEventListener('input', () => {
      try {
        localStorage.setItem(prefix + input.dataset.comment, input.value);
        if (saved) saved.textContent = '已保存';
      } catch (_) { if (saved) saved.textContent = '未保存；仍可复制'; }
      updateSummary();
    });
  });
  document.getElementById('copy-all').addEventListener('click', () => copyText(chunks.join('\n\n')));
  updateSummary();
})();
