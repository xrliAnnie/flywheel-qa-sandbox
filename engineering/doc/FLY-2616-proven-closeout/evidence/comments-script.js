
(() => {
  const marker = '【页面意见汇总】FLY-2616';
  const prefix = 'FLY-2616:comments:' + location.pathname + ':';
  const inputs = Array.from(document.querySelectorAll('[data-comment]'));
  const target = document.getElementById('chunks');
  const status = document.getElementById('copy-status');
  let chunks = [];
  function fallback(text) {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed'; field.style.left = '-10000px';
    document.body.appendChild(field); field.select();
    let ok = false;
    try { ok = document.execCommand('copy'); }
    finally { field.remove(); }
    if (!ok) throw new Error('copy_failed');
  }
  async function copy(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try { await navigator.clipboard.writeText(text); }
        catch (_) { fallback(text); }
      } else { fallback(text); }
      status.textContent = '已复制';
    } catch (_) { status.textContent = '复制失败，请选中下方文字手动复制。'; }
  }
  function render() {
    const entries = inputs.filter(el => el.value.trim()).map(el =>
      '[' + el.closest('[data-section]').dataset.section + ']\n' + el.value.trim());
    const content = entries.join('\n\n');
    const chars = Array.from(content);
    const capacity = 1800 - Array.from(marker).length - 1;
    chunks = [];
    for (let i = 0; i < chars.length; i += capacity) {
      chunks.push(marker + '\n' + chars.slice(i, i + capacity).join(''));
    }
    if (!chunks.length) chunks = [marker + '\n（暂无意见）'];
    target.replaceChildren();
    chunks.forEach((text, i) => {
      const pre = document.createElement('pre'); pre.textContent = text;
      const button = document.createElement('button'); button.type = 'button';
      button.textContent = '复制第 ' + (i + 1) + ' 段';
      button.addEventListener('click', () => copy(text));
      target.appendChild(pre); target.appendChild(button);
    });
  }
  inputs.forEach(el => {
    try { el.value = localStorage.getItem(prefix + el.dataset.comment) || ''; }
    catch (_) { /* Browser may disallow local storage; comments still work. */ }
    el.addEventListener('input', () => {
      try { localStorage.setItem(prefix + el.dataset.comment, el.value); } catch (_) {}
      render();
    });
  });
  document.getElementById('copy-all').addEventListener('click', () => copy(chunks.join('\n\n')));
  render();
})();
