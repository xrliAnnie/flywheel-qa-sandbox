// Design-artifact verification only. VM DOM stand-ins do not prove browser layout/CSP.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('./design.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
assert.equal(scripts.length, 1);
assert.equal(scripts[0][1].trim(), 'nonce="__CSP_NONCE__"');
assert(!/<meta[^>]+Content-Security-Policy/i.test(html));
assert(!/<(?:table|iframe|link)\b|\son\w+\s*=|\b(?:src|href)="https?:/i.test(html));
assert(!/innerHTML|fetch\(|XMLHttpRequest|WebSocket/.test(scripts[0][2]));
assert(Buffer.byteLength(html) < 512 * 1024);
const cards = [...html.matchAll(/<(?:header|section)\b[^>]*data-section="([^"]+)"[^>]*>([\s\S]*?)<\/(?:header|section)>/g)];
assert.equal(cards.length, 10);
for (const card of cards) assert.equal([...card[2].matchAll(/data-comment=/g)].length, 1);
const marker = '【页面意见汇总】FLY-2485';
const definitions = [...html.matchAll(/<textarea[^>]*data-comment="([^"]+)"[^>]*data-title="([^"]+)"/g)];
const source = scripts[0][2];
new vm.Script(source);

function boot({ path = '/report-a', stored = new Map(), denied = false, clipboard = 'success' } = {}) {
  class Element {
    constructor(tag = 'div') { this.tag = tag; this.value = ''; this.children = []; this.events = {}; this.dataset = {}; }
    addEventListener(type, fn) { this.events[type] = fn; }
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.children.push(child); }
    replaceChildren(...children) { this.children = children; }
    select() { selected = this; }
    remove() {}
  }
  let selected;
  let copied;
  let fallbackCount = 0;
  const inputs = definitions.map((match) => Object.assign(new Element('textarea'), { dataset: { comment: match[1], title: match[2] } }));
  const ids = new Map(['comment-chunks', 'copy-status', 'copy-all'].map(id => [id, new Element()]));
  const document = {
    body: new Element(),
    querySelectorAll: () => inputs,
    getElementById: id => ids.get(id),
    createElement: tag => new Element(tag),
    execCommand: command => { assert.equal(command, 'copy'); copied = selected.value; fallbackCount++; return true; },
  };
  const navigator = clipboard === 'absent' ? {} : { clipboard: { writeText: async text => {
    if (clipboard === 'reject') throw Error('clipboard rejected');
    copied = text;
  } } };
  const localStorage = {
    getItem: key => { if (denied) throw Error('storage denied'); return stored.get(key); },
    setItem: (key, value) => { if (denied) throw Error('storage denied'); stored.set(key, value); },
  };
  vm.runInNewContext(source, { document, navigator, localStorage, location: { pathname: path } });
  return { inputs, ids, stored, write(index, text) { inputs[index].value = text; inputs[index].events.input(); },
    chunks() { return ids.get('comment-chunks').children.filter(node => node.className === 'export-chunk').map(node => node.children[1].value); },
    async copy() { ids.get('copy-all').events.click(); await new Promise(resolve => setImmediate(resolve)); return { copied, fallbackCount }; } };
}

const page = boot();
assert.equal(page.chunks().length, 0);
page.write(0, '保留机器句 <script>alert(1)</script>');
page.write(1, '不同角色保留各自判断');
assert(page.chunks()[0].startsWith(marker + '\n'));
assert(page.chunks()[0].includes('[先看结论]\n保留机器句 <script>alert(1)</script>'));
assert(page.chunks()[0].includes('[改动路径]\n不同角色保留各自判断'));
assert.equal(boot({ stored: page.stored }).inputs[0].value, page.inputs[0].value);
assert.equal(boot({ path: '/report-b', stored: page.stored }).inputs[0].value, '');
assert.equal((await page.copy()).fallbackCount, 0);
for (const clipboard of ['absent', 'reject']) {
  const fallback = boot({ clipboard });
  fallback.write(2, '复制回退');
  const result = await fallback.copy();
  assert.equal(result.fallbackCount, 1);
  assert(result.copied.startsWith(marker + '\n'));
}
const denied = boot({ denied: true });
denied.write(0, '无存储也能复制');
assert((await denied.copy()).copied.includes('无存储也能复制'));
page.write(0, '🙂中文'.repeat(1400));
assert(page.chunks().length > 3);
for (const chunk of page.chunks()) {
  assert(chunk.startsWith(marker + '\n'));
  assert(chunk.length <= 1800);
  assert(!/[\uD800-\uDBFF]$/.test(chunk));
}
const recombined = page.chunks().map(chunk => chunk.slice(marker.length + 1)).join('');
assert(recombined.includes('🙂中文'.repeat(1400)));
page.inputs.forEach((_, index) => page.write(index, ''));
assert.equal(page.chunks().length, 0);
console.log('PASS: structure, single nonce script, 10 comment sections, no tables/external dependencies; persistence, path isolation, storage denied, clipboard success/absent/rejection fallback, Unicode chunking and empty-comment removal. Browser layout/CSP not tested.');
