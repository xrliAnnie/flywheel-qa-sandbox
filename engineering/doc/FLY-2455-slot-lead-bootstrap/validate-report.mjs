// Artifact QA: node validate-report.mjs report.html /absolute/path/to/linkedom/esm/index.js
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { parseHTML } = await import(pathToFileURL(process.argv[3]));
const html = fs.readFileSync(process.argv[2], 'utf8');
const store = new Map();
function open(pathname, mode = 'ok', deny = false) {
  const { window, document } = parseHTML(html);
  let copied = '', fallbackCalls = 0;
  window.HTMLTextAreaElement.prototype.select = function () {};
  document.execCommand = name => {
    assert.equal(name, 'copy');
    fallbackCalls++;
    copied = document.body.lastElementChild.value;
    return true;
  };
  const localStorage = {
    getItem(k) { if (deny) throw new Error('denied'); return store.get(k); },
    setItem(k, v) { if (deny) throw new Error('denied'); store.set(k, v); },
  };
  const navigator = mode === 'absent' ? {} : { clipboard: { async writeText(t) {
    if (mode === 'reject') throw new Error('denied');
    copied = t;
  } } };
  const scripts = [...document.querySelectorAll('script')];
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].getAttribute('nonce'), '__CSP_NONCE__');
  assert.equal(scripts[0].hasAttribute('src'), false);
  assert.equal(document.querySelector('meta[http-equiv]'), null);
  for (const el of document.querySelectorAll('*')) {
    for (const attr of el.attributes) assert.ok(!/^on/i.test(attr.name));
  }
  assert.equal(document.querySelectorAll('.card').length, 7);
  assert.equal(document.querySelectorAll('[data-comment]').length, 7);
  vm.runInNewContext(scripts[0].textContent, { document, location: { pathname }, localStorage, navigator });
  const input = (id, value) => {
    const field = document.getElementById(id);
    field.value = value;
    field.dispatchEvent(new window.Event('input'));
  };
  return { document, input, async copy() {
    document.getElementById('copy-all').dispatchEvent(new window.Event('click'));
    await new Promise(resolve => setImmediate(resolve));
    return { copied, fallbackCalls };
  } };
}
const marker = '【页面意见汇总】FLY-2455';
const a = open('/reports/a');
a.input('c-summary', '<img src=x onerror=alert(1)> 调整');
assert.equal(a.document.querySelector('img'), null);
assert.ok(a.document.getElementById('chunk-0').value.startsWith(marker + '\n01'));
assert.match((await a.copy()).copied, /调整/);
assert.equal(open('/reports/a').document.getElementById('c-summary').value, '<img src=x onerror=alert(1)> 调整');
assert.equal(open('/reports/b').document.getElementById('c-summary').value, '');
a.input('c-flow', '很长的意见😀'.repeat(1000));
const chunks = [...a.document.querySelectorAll('#chunks textarea')].map(x => x.value);
assert.ok(chunks.length > 2);
assert.ok(chunks.every(t => t.startsWith(marker + '\n') && t.length <= 1800));
assert.ok((await a.copy()).copied.split(marker).length > 3);
for (const mode of ['absent', 'reject']) {
  const b = open('/reports/' + mode, mode);
  b.input('c-boundary', 'fallback-' + mode);
  const result = await b.copy();
  assert.equal(result.fallbackCalls, 1, mode);
  assert.match(result.copied, new RegExp('fallback-' + mode));
}
const denied = open('/reports/denied', 'ok', true);
denied.input('c-feedback', 'storage denied still works');
assert.match((await denied.copy()).copied, /storage denied still works/);
console.log('PASS: 7 comment cards; pathname isolation; reload; denied storage; XSS text; chunk limits/markers; copy API + absent/rejected fallback; static nonce/CSP contract.');
