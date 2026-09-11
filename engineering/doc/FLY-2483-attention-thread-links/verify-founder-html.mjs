// Artifact-only checks. A VM DOM fixture is not browser visual verification.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script, createContext } from 'node:vm';

const html = readFileSync(new URL('./founder-design.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
assert.equal(scripts.length, 1);
assert.match(scripts[0][1], /nonce="__CSP_NONCE__"/);
assert.doesNotMatch(html, /Content-Security-Policy/i);
assert.doesNotMatch(html, /\bon[a-z]+\s*=/i);
assert.doesNotMatch(html, /<(script|link|img|iframe)[^>]+(?:src|href)=/i);
assert.doesNotMatch(html, /<table\b/i);
assert.doesNotMatch(scripts[0][2], /innerHTML/);
assert(Buffer.byteLength(html) < 512 * 1024);
const inputs = [...html.matchAll(/<textarea[^>]*data-comment="([^"]+)"[^>]*data-title="([^"]+)"/g)];
const sections = [...html.matchAll(/<section\b[\s\S]*?<\/section>/g)];
assert.equal(inputs.length, sections.length);
assert(sections.every(s => /<textarea\b/.test(s[0])));
assert.equal(new Set(inputs.map(i => i[1])).size, inputs.length);
assert.equal((html.match(/DIAGRAM PENDING LOCAL RENDER/g) || []).length + (html.match(/<svg\b/g) || []).length, 2);
const executable = new Script(scripts[0][2]);
const marker = '【页面意见汇总】FLY-2483';

class Element {
  constructor() { this.value = ''; this.dataset = {}; this.style = {}; this.events = {}; this.children = []; this.textContent = ''; }
  addEventListener(name, fn) { this.events[name] = fn; }
  appendChild(child) { this.children.push(child); }
  replaceChildren() { this.children = []; }
  setAttribute() {}
  select() {}
  remove() {}
}
function fixture({ pathname = '/test/one', saved = new Map(), denyStorage = false, clipboard = 'success', fallback = true } = {}) {
  const rows = inputs.map(([, key, title]) => Object.assign(new Element(), {dataset: {comment:key, title}}));
  const chunks = new Element(), status = new Element(), button = new Element();
  const savedLabels = new Map(rows.map(row => [row.dataset.comment, new Element()]));
  const copied = [];
  let fallbacks = 0;
  const document = {
    body: new Element(),
    querySelectorAll: () => rows,
    querySelector: (selector) => savedLabels.get(selector.match(/="([^"]+)"/)[1]),
    getElementById: id => ({'comment-chunks':chunks, 'copy-status':status, 'copy-all':button})[id],
    createElement: () => new Element(),
    execCommand: command => { assert.equal(command, 'copy'); fallbacks++; return fallback; },
  };
  const navigator = {};
  if (clipboard !== 'absent') navigator.clipboard = {writeText: async text => {
    if (clipboard === 'reject') throw new Error('denied');
    copied.push(text);
  }};
  const context = createContext({document, navigator, location:{pathname}, localStorage: {
    getItem: key => { if (denyStorage) throw new Error('disabled'); return saved.get(key); },
    setItem: (key, val) => { if (denyStorage) throw new Error('disabled'); saved.set(key,val); },
  }});
  executable.runInContext(context);
  return {rows,chunks,status,button,copied,saved,savedLabels,get fallbacks(){return fallbacks;}};
}
let f = fixture();
assert.equal(f.chunks.children.length, 1);
assert(f.chunks.children[0].children[0].textContent.startsWith(marker + '\n'));
f.rows[0].value = '想看停止的边界'; f.rows[0].events.input();
assert.equal(f.saved.get('flywheel:design-comments:/test/one:summary'), '想看停止的边界');
assert(f.chunks.children[0].children[0].textContent.includes('01 / 一句话结论\n想看停止的边界'));
let reload = fixture({saved:f.saved}); assert.equal(reload.rows[0].value, '想看停止的边界');
let other = fixture({pathname:'/test/two',saved:f.saved}); assert.equal(other.rows[0].value, '');
f.rows[1].value = '🧪长意见'.repeat(1500); f.rows[1].events.input();
assert(f.chunks.children.length > 1);
for (const chunk of f.chunks.children) {
  const text = chunk.children[0].textContent;
  assert(text.startsWith(marker+'\n'));
  assert(text.length <= 1800);
  assert.doesNotMatch(text, /[\uD800-\uDBFF]$/);
}
await f.button.events.click(); assert(f.copied[0].startsWith(marker+'\n'));
assert.equal(f.status.textContent,'已复制');
await f.chunks.children[1].children[1].events.click(); assert.equal(f.copied.length,2);
for (const clipboard of ['reject','absent']) {
  const denied = fixture({clipboard,denyStorage:true});
  denied.rows[0].value = '保存被禁也应可复制'; denied.rows[0].events.input();
  await denied.button.events.click();
  assert.equal(denied.fallbacks,1); assert.equal(denied.status.textContent,'已复制');
  assert.equal(denied.savedLabels.get('summary').textContent,'未保存；仍可复制');
}
const failed = fixture({clipboard:'reject',fallback:false});
await failed.button.events.click(); assert.match(failed.status.textContent,/复制失败/);
f.rows.forEach(row => {row.value=''; row.events.input();});
assert.equal(f.chunks.children.length,1);
assert.match(f.chunks.children[0].children[0].textContent,/暂无意见/);
console.log('PASS: artifact shape, 11 section comments, one nonce script, no external assets/tables/inline handlers, pathname storage, live summary, 1800-character Unicode chunks, clipboard success/rejection/absence/failure, storage denied, clear/reload isolation.');
console.log('LIMIT: no browser rendering or real CSP execution verified by this VM fixture.');
