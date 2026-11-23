/* UI event-contract checks using Node built-ins only.
 * This deliberately small DOM harness is NOT a browser, layout or accessibility audit.
 * It executes the real app.js against elements parsed from the actual index.html.
 * API transport and document/LLM processing are stubbed; those have separate tests.
 * Run: node --test tests/ui.test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { File, Blob } = require('node:buffer');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
const RealAPI = require('../js/api.js');
const Rules = require('../js/rules-data.js');
require('../js/parsers.js');

function decode(s) {
  return String(s).replace(/&(?:amp|lt|gt|quot|apos|#39|#10|#x20);/g, x => ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&#39;':"'",'&#10;':'\n','&#x20;':' '})[x]);
}
const dataAttr = key => 'data-' + key.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
class MiniText {
  constructor(text, doc) { this.nodeType = 3; this.data = String(text); this.ownerDocument = doc; this.parentNode = null; }
  get textContent() { return this.data; }
  set textContent(value) { this.data = String(value); }
  remove() { if (this.parentNode) this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1); this.parentNode = null; }
}
class MiniNode {
  constructor(tag, doc) {
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.parentNode = null;
    this.childNodes = []; this.attrs = {}; this.listeners = new Map(); this.style = { setProperty(key,value) { this[key] = String(value); }, getPropertyValue(key) { return this[key] || ''; } }; this._value = null;
    this.checked = false; this.disabled = false; this.hidden = false; this.open = false; this.required = false;
    this.files = []; this.resetCount = 0;
    this.dataset = new Proxy({}, { get: (_, key) => this.getAttribute(dataAttr(String(key))) ?? undefined,
      set: (_, key, value) => { this.setAttribute(dataAttr(String(key)), value); return true; } });
    this.classList = {
      contains: cls => this.className.split(/\s+/).includes(cls),
      add: (...classes) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...classes])].join(' '); },
      remove: (...classes) => { this.className = this.className.split(/\s+/).filter(x => !classes.includes(x)).join(' '); },
      toggle: (cls, force) => { const next = force === undefined ? !this.classList.contains(cls) : force; if (next) this.classList.add(cls); else this.classList.remove(cls); return next; }
    };
  }
  get id() { return this.attrs.id || ''; } set id(v) { this.attrs.id = String(v); }
  get className() { return this.attrs.class || ''; } set className(v) { this.attrs.class = String(v); }
  get type() { return this.attrs.type || (this.tagName === 'BUTTON' ? 'submit' : 'text'); } set type(v) { this.attrs.type = String(v); }
  get name() { return this.attrs.name || ''; } set name(v) { this.attrs.name = String(v); }
  get title() { return this.attrs.title || ''; } set title(v) { this.attrs.title = String(v); }
  get value() {
    if (this._value !== null) return this._value;
    if (this.tagName === 'SELECT') { const opts = this.querySelectorAll('option'); return (opts.find(o => 'selected' in o.attrs) || opts[0])?.value || ''; }
    if (this.tagName === 'TEXTAREA') return this.textContent;
    return this.attrs.value || (this.tagName === 'OPTION' ? this.textContent : '');
  }
  set value(v) { this._value = String(v); }
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  get firstElementChild() { return this.children[0] || null; }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get textContent() { return this.childNodes.map(n => n.textContent).join(''); }
  set textContent(v) { this.replaceChildren(new MiniText(String(v), this.ownerDocument)); }
  set innerHTML(_) { throw new Error('Test harness rejects innerHTML: render untrusted material as text.'); }
  get elements() { return { namedItem: name => this.querySelectorAll('input,select,textarea,button').find(n => n.name === name) || null }; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (['hidden','checked','disabled','open','required'].includes(k)) this[k] = true; }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; if (['hidden','checked','disabled','open','required'].includes(k)) this[k] = false; }
  append(...nodes) { for (let n of nodes) { if (typeof n !== 'object') n = new MiniText(n, this.ownerDocument); if (n.parentNode) n.remove(); n.parentNode = this; this.childNodes.push(n); } }
  prepend(...nodes) { for (let i = nodes.length - 1; i >= 0; i--) { let n = nodes[i]; if (typeof n !== 'object') n = new MiniText(n, this.ownerDocument); if (n.parentNode) n.remove(); n.parentNode = this; this.childNodes.unshift(n); } }
  replaceChildren(...nodes) { for (const n of this.childNodes) n.parentNode = null; this.childNodes = []; this.append(...nodes); }
  remove() { if (this.parentNode) this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1); this.parentNode = null; }
  after(node) { const p = this.parentNode; if (!p) return; node.parentNode = p; p.childNodes.splice(p.childNodes.indexOf(this) + 1, 0, node); }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  matches(selector) {
    return selector.split(',').some(part => {
      let s = part.trim(); if (!s) return false;
      const tag = s.match(/^[a-zA-Z][\w-]*/); if (tag && this.tagName !== tag[0].toUpperCase()) return false;
      const id = s.match(/#([\w-]+)/); if (id && this.id !== id[1]) return false;
      for (const m of s.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(m[1])) return false;
      for (const m of s.matchAll(/\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/g)) {
        const actual = this.getAttribute(m[1]); if (actual === null) return false;
        const expected = m[2] ?? m[3] ?? m[4]; if (expected !== undefined && actual !== expected) return false;
      }
      return true;
    });
  }
  querySelectorAll(selector) { const out = []; const walk = n => { for (const child of n.children) { if (child.matches(selector)) out.push(child); walk(child); } }; walk(this); return out; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.matches(selector)) return n; return null; }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() {}
  showModal() { this.open = true; }
  close() { this.open = false; return this.ownerDocument.dispatch('close', this, {}, false); }
  click() {
    if (this.disabled) return Promise.resolve();
    if (this.tagName === 'A' && this.download) this.ownerDocument.downloads.push({ filename: this.download, href: this.href });
    return this.ownerDocument.dispatch('click', this);
  }
  reset() {
    this.resetCount++;
    for (const n of this.querySelectorAll('input,textarea,select')) { n._value = null; n.checked = 'checked' in n.attrs; }
  }
}
class MiniDocument extends MiniNode {
  constructor(source) {
    super('document', null); this.ownerDocument = this; this.nodeType = 9; this.downloads = []; this.activeElement = null;
    const stack = [this], voids = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
    for (const token of source.match(/<!--[\s\S]*?-->|<![^>]*>|<\/[^>]+>|<[^>]+>|[^<]+/g) || []) {
      if (token.startsWith('<!')) continue;
      const end = token.match(/^<\/([\w-]+)/); if (end) { while (stack.length > 1) if (stack.pop().tagName === end[1].toUpperCase()) break; continue; }
      const start = token.match(/^<([\w-]+)/);
      if (start) {
        const node = new MiniNode(start[1], this);
        const tail = token.slice(start[0].length).replace(/\/?\s*>$/, '');
        for (const a of tail.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) node.setAttribute(a[1], decode(a[2] ?? a[3] ?? a[4] ?? ''));
        stack[stack.length - 1].append(node);
        if (!voids.has(start[1].toLowerCase()) && !/\/>$/.test(token)) stack.push(node);
      } else stack[stack.length - 1].append(new MiniText(decode(token), this));
    }
    this.body = this.querySelector('body');
  }
  getElementById(id) { return this.querySelectorAll('[id]').find(n => n.id === id) || null; }
  createElement(tag) { return new MiniNode(tag, this); }
  createTextNode(text) { return new MiniText(text, this); }
  dispatch(type, target = this, extra = {}, bubble = true) {
    const event = { type, target, currentTarget: null, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    const pending = [];
    for (let n = target; n; n = bubble ? n.parentNode : null) {
      event.currentTarget = n;
      for (const fn of n.listeners.get(type) || []) pending.push(fn(event));
    }
    // Native DOM events clear currentTarget when synchronous dispatch finishes.
    // Clearing before promises resolve catches a real async form-handler bug.
    event.currentTarget = null;
    return Promise.all(pending).then(() => event);
  }
}
class MiniFormData {
  constructor(form) {
    assert(form && form.tagName === 'FORM', 'FormData must receive a live form element'); this.items = [];
    for (const n of form.querySelectorAll('input,select,textarea')) {
      if (!n.name || n.disabled || ['checkbox','radio'].includes(n.type) && !n.checked) continue;
      this.items.push([n.name, n.type === 'checkbox' ? n.value || 'on' : n.value]);
    }
  }
  get(key) { return this.items.find(([k]) => k === key)?.[1] ?? null; }
  getAll(key) { return this.items.filter(([k]) => k === key).map(([, value]) => value); }
  has(key) { return this.items.some(([k]) => k === key); }
  forEach(fn) { this.items.forEach(([k, value]) => fn(value, k)); }
}

function emptyCase(no = '1020260000001') { return { schemaVersion:1, applicationNumber:no, mode:'manual', status:'hold', summary:'검토 준비', documents:[], findings:[], history:[], coverage:[], failures:[], completeness:{history:false,documents:false,identity:false,claims:false}, ledger:[] }; }
function fixtureCase(scenario) {
  const c = emptyCase(); c.mode = 'demo'; c.status = {finding:'issues',clear:'clear',missing:'hold'}[scenario] || 'issues'; c.summary = '설명용 합성 사건';
  c.documents = [{id:'d1',title:'합성 등록청구항',type:'registration-gazette',date:'20261120',documentNumber:'EXAMPLE',text:'[쪽 1] 원문 대조를 위한 합성 자료입니다.',identityVerified:true,pages:[{page:1,text:'원문 대조를 위한 합성 자료입니다.'}],extraction:{complete:true}}];
  if (scenario === 'finding') c.findings = [
    {id:'f1',ruleId:'RC-07',code:'0511',verdict:'confirmed',title:'선호 표현으로 발생한 불명확성',summary:'조건이 확인된 합성 반려사유입니다.',claims:[1],evidence:[{documentId:'d1',page:1,quote:'원문 대조를 위한 합성 자료입니다.'}]},
    {id:'f2',ruleId:'OA-15',codeCandidate:'1024',verdict:'conditional',title:'보정 전후 판본 추가 확인',summary:'판본 대조가 필요합니다.',evidence:[]}
  ];
  if (scenario === 'missing') c.failures.push({stage:'문서',message:'합성 서류 일부 미확보'});
  c.coverage = [{ruleId:'RC-07',status:'checked',documentId:'d1'}]; return c;
}
function harness(overrides = {}, options = {}) {
  const document = new MiniDocument(html), windowEvents = new Map(), blobURLs = new Map(), recorded = { ingest:[], serialize:[] };
  let objectSequence = 0;
  class TestURL extends URL {}
  TestURL.createObjectURL = blob => { const url = 'blob:ui-test/' + (++objectSequence); blobURLs.set(url, blob); return url; };
  TestURL.revokeObjectURL = url => blobURLs.delete(url);
  const engine = {
    createCase:emptyCase, demoCase:fixtureCase,
    async prepareCase(c, s, opts) { for (const stage of ['history','documents','claims']) opts.onProgress({stage,message:'시험 ' + stage}); return c; },
    async review(c, s, opts) { await this.prepareCase(c, s, opts); for (const stage of ['oa','decision','evidence']) opts.onProgress({stage,message:'시험 ' + stage}); c.status = 'hold'; c.summary = '모의 API 검토 완료'; return c; },
    localReview(c) { c.status = 'hold'; return c; },
    async ingestFile(file, metadata) { recorded.ingest.push({ file, metadata }); await Promise.resolve(); return { id:'manual-' + recorded.ingest.length, ...metadata, text:await file.text(), identityVerified:metadata.identityConfirmed, extraction:{complete:false} }; },
    async importCase(source) { const c = JSON.parse(source); if (!c.applicationNumber || !Array.isArray(c.documents)) throw new Error('지원하지 않는 사건 형식'); return c; },
    serializeCase(c, ...rest) { recorded.serialize.push([c, ...rest]); return { applicationNumber:c.applicationNumber,documents:c.documents,findings:c.findings,mode:c.mode,status:c.status }; },
    makeReport(c) { return '# 검토 내역\n' + c.summary; }, ...overrides
  };
  const api = {...RealAPI, usesRelay:() => false, testConnection:async() => ({models:['local-test'],modelAvailable:true,note:'모의 모델 목록'}), ...options.api};
  const window = { ReviewAPI:api, ReviewRules:Rules, ReviewEngine:engine, scrollTo() {}, addEventListener(type, fn) { if (!windowEvents.has(type)) windowEvents.set(type, []); windowEvents.get(type).push(fn); } };
  const location = { hash:'', protocol:'file:', hostname:'', ...options.location }, historyCalls = [];
  const sandbox = { window, document, navigator:{onLine:true}, location, history:{replaceState(a,b,hash) { location.hash = hash; historyCalls.push(['replace', hash]); }, pushState(a,b,hash) { location.hash = hash; historyCalls.push(['push', hash]); }}, FormData:MiniFormData,
    File, Blob, URL:TestURL, AbortController, DOMException, TextEncoder, TextDecoder, console, setTimeout:() => 1, clearTimeout() {}, requestAnimationFrame:fn => fn() };
  vm.runInNewContext(appSource, sandbox, {filename:'js/app.js'});
  const $ = id => document.getElementById(id);
  return {document,window,app:window.ReviewApp,$,engine,recorded,blobURLs,location,historyCalls,click:node => (typeof node === 'string' ? $(node) : node).click(),
    submit:node => document.dispatch('submit', typeof node === 'string' ? $(node) : node),
    event:(type,node,extra) => document.dispatch(type,typeof node === 'string' ? $(node) : node,extra),
    beforeUnload() { const e = {defaultPrevented:false,preventDefault() {this.defaultPrevented=true;}}; for (const fn of windowEvents.get('beforeunload') || []) fn(e); return e; },
    navigate(hash, type = 'popstate') { location.hash = hash; for (const fn of windowEvents.get(type) || []) fn({ type }); }
  };
}

test('actual HTML exposes all controller IDs and only existing local executable/image assets', () => {
  const d = new MiniDocument(html);
  const ids = d.querySelectorAll('[id]').map(n => n.id);
  assert.equal(ids.length,new Set(ids).size,'duplicate DOM IDs');
  const dynamic = new Set([...appSource.matchAll(/\.id\s*=\s*'([^']+)'/g)].map(m => m[1]));
  for (const [,id] of appSource.matchAll(/\$\('([^']+)'\)/g)) assert(d.getElementById(id) || dynamic.has(id),'missing controller element ' + id);
  for (const label of d.querySelectorAll('label[for]')) assert(d.getElementById(label.getAttribute('for')),'unbound label ' + label.getAttribute('for'));
  const scripts = d.querySelectorAll('script[src]').map(n => n.getAttribute('src'));
  assert.deepEqual(scripts,['js/rules-data.js','js/parsers.js','js/api.js','js/engine.js','js/app.js','js/quri-guide.js']);
  const resources = [...scripts,...d.querySelectorAll('link[href]').map(n => n.getAttribute('href')),...d.querySelectorAll('img[src]').map(n => n.getAttribute('src'))];
  for (const stylesheet of resources.filter(resource=>/\.css$/i.test(resource))) {
    const css=fs.readFileSync(path.join(ROOT,stylesheet),'utf8');
    assert(!/@import\b/i.test(css),'external CSS imports are forbidden');
    for (const [,raw] of css.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)) resources.push(path.posix.normalize(path.posix.dirname(stylesheet)+'/'+raw));
  }
  for (const resource of resources) { assert(!/^(?:https?:|\/\/|data:)/i.test(resource),'nonlocal resource ' + resource); assert(fs.existsSync(path.join(ROOT,resource)),'missing local resource ' + resource); }
});

test('all six real navigation controls activate exactly one matching view', async () => {
  const h = harness();
  for (const view of ['review','results','documents','rules','guide','settings']) {
    const nav = h.document.querySelector('.nav-item[data-view="' + view + '"]'); assert(nav,'missing nav ' + view);
    await h.click(nav);
    assert.deepEqual(h.document.querySelectorAll('.view').filter(n => !n.hidden).map(n => n.id),['view-' + view]);
    assert.equal(nav.getAttribute('aria-current'),'page'); assert.equal(h.document.activeElement.tagName,'H1');
  }
});

test('three demo choices keep synthetic marker and show the exact distinct statuses', async () => {
  const h = harness(); await h.click('demo-button');
  for (const [scenario,label,pose] of [['finding','반려 검토사항이 있어요','quri-pose-explain'],['clear','적용한 규칙에서 발견되지 않았어요','quri-pose-complete'],['missing','추가 확인이 필요해요','quri-pose-thoughtful']]) {
    await h.click(h.document.querySelector('[data-action="demo"][data-value="' + scenario + '"]'));
    assert.equal(h.$('result-status').textContent,label); assert.equal(h.$('demo-banner').hidden,false);
    assert.match(h.$('result-application').textContent,/합성 예시/); assert.match(h.$('result-scope').textContent,/실제.*아닙니다/);
    assert(h.$('result-robot').classList.contains(pose)); assert.equal(h.app.getCase().mode,'demo');
  }
  await h.click('exit-demo'); assert.equal(h.app.getCase(),null); assert(h.$('demo-banner').hidden);
});

test('finding filter buttons from the HTML select confirmed and pending cards', async () => {
  const h = harness(); await h.click('demo-button');
  const filter = value => h.$('finding-filters').querySelector('[data-filter="' + value + '"]');
  assert.equal(h.$('findings-list').querySelectorAll('.finding-card').length,2);
  await h.click(filter('confirmed')); let cards = h.$('findings-list').querySelectorAll('.finding-card');
  assert.equal(cards.length,1); assert.equal(cards[0].dataset.verdict,'confirmed'); assert.equal(filter('confirmed').getAttribute('aria-pressed'),'true');
  await h.click(filter('pending')); cards = h.$('findings-list').querySelectorAll('.finding-card');
  assert.equal(cards.length,1); assert.equal(cards[0].dataset.verdict,'conditional'); assert.equal(filter('confirmed').getAttribute('aria-pressed'),'false');
  await h.click(filter('all')); assert.equal(h.$('findings-list').querySelectorAll('.finding-card').length,2);
});

test('manual form survives async currentTarget clearing and preserves metadata', async () => {
  const h = harness(); h.$('application-number').value = '10-2026-0000001';
  h.$('document-name').value = '테스트 원문'; h.$('document-date').value = '2026-11-20'; h.$('document-number').value = 'SYNTH-1';
  h.$('document-type').value = 'oa'; h.$('document-verified').checked = true;
  h.$('document-text').value = '이 문장은 원문 직접 추가의 비동기 동작을 확인하는 충분한 길이의 합성 문서입니다.';
  const form = h.$('manual-document-form'); await h.submit(form);
  assert.equal(h.recorded.ingest.length,1); assert.equal(h.recorded.ingest[0].metadata.date,'20261120'); assert.equal(h.recorded.ingest[0].metadata.identityConfirmed,true);
  assert.equal(h.app.getCase().documents.length,1); assert.equal(form.resetCount,1); assert.equal(h.$('document-name').value,'');
  assert.match(h.$('documents-list').textContent,/테스트 원문/); assert.equal(h.$('document-count').textContent,'1');
  assert.equal(h.$('document-feedback').textContent,'원문이 추가되었습니다.'); assert.equal(h.$('document-text').disabled,false);
});

test('official code search keeps four digits including leading zero', async () => {
  const h = harness(); h.$('rules-filter').value = 'codes'; h.$('rules-search').value = '0511'; await h.event('input','rules-search');
  const badges = h.$('rules-list').querySelectorAll('.rule-id').map(n => n.textContent);
  assert.deepEqual(badges,['0511']); assert(Rules.codeList.every(c => /^\d{4}$/.test(c.code)));
  assert.match(h.$('rules-list').textContent,/0511/);
});

test('untrusted finding and document strings display as text without creating markup', async () => {
  const h = harness(); const c = emptyCase(); const attack = '<img src=x onerror="alert(1)"><script>bad()</script>';
  c.documents = [{id:'d1',type:'other',title:attack,date:'20261120',text:attack,pages:[{page:1,text:attack}]}];
  c.findings = [{id:'f1',ruleId:'OA-14',codeCandidate:'1231',verdict:'conditional',title:attack,summary:attack,evidence:[{documentId:'d1',page:1,quote:attack}]}];
  const originalScriptCount = h.document.querySelectorAll('script').length;
  await h.app.importSaved({size:2000,text:async()=>JSON.stringify(c)});
  assert(h.$('findings-list').textContent.includes(attack)); assert(h.$('documents-list').textContent.includes(attack));
  await h.click(h.document.querySelector('[data-action="finding"]')); assert(h.$('finding-detail').textContent.includes(attack));
  await h.click(h.document.querySelector('[data-action="document"]')); assert(h.$('document-dialog-content').textContent.includes(attack));
  assert.equal(h.document.querySelectorAll('img').length,0); assert.equal(h.document.querySelectorAll('script').length,originalScriptCount);
});

test('invalid import preserves current case and demo close restores prior work', async () => {
  const h = harness(), c = emptyCase(); c.documents = [{id:'d1',title:'보존할 문서',text:'원문'}];
  await h.app.importSaved({size:1000,text:async()=>JSON.stringify(c)}); const previous = h.app.getCase();
  await h.app.importSaved({size:12,text:async()=>'{malformed'});
  assert.equal(h.app.getCase(),previous); assert.match(h.$('toast').textContent,/열지 못했습니다/);
  await h.click('demo-button'); assert.notEqual(h.app.getCase(),previous);
  await h.click('exit-demo'); assert.equal(h.app.getCase(),previous); assert.match(h.$('documents-list').textContent,/보존할 문서/);
});

test('case export serializes only the current case, never API settings', async () => {
  const h = harness(); h.$('kipris-key').value='TEST_KIPRIS_SECRET'; h.$('llm-key').value='TEST_LLM_SECRET'; h.$('llm-model').value='local-test'; await h.submit('settings-form');
  await h.click('demo-button'); await h.click('export-case');
  assert.equal(h.recorded.serialize.length,1); assert.equal(h.recorded.serialize[0].length,1); assert.equal(h.recorded.serialize[0][0],h.app.getCase());
  const download = h.document.downloads.at(-1); assert(download); assert.match(download.filename,/_DEMO\.json$/);
  const data = await h.blobURLs.get(download.href).text();
  assert(!data.includes('TEST_KIPRIS_SECRET')); assert(!data.includes('TEST_LLM_SECRET')); assert(!data.includes('llmKey')); assert(!data.includes('kiprisKey'));
});

test('progress updates retain live stage elements and do not convert container to text', async () => {
  const h = harness(); h.$('application-number').value='10-2026-0000001'; h.$('kipris-key').value='TEST_KEY'; h.$('llm-key').value='TEST_LLM'; h.$('llm-model').value='local-test';
  await h.submit('review-form');
  assert(h.$('stage-robot'),'progress must not remove stage sprite'); assert(h.$('stage-title'),'progress must not remove stage title'); assert(h.$('token-meter'),'progress must not remove budget label');
  assert.equal(h.app.getCase().summary,'모의 API 검토 완료'); assert.equal(h.$('run-log').children.length,6);
  assert.equal(h.$('progress-detail').hidden,false); assert.equal(h.$('run-log').hidden,false);
  assert.equal(h.$('start-review').disabled,false); assert.equal(h.$('cancel-review').hidden,true);
});

test('v3 new-case action releases prior bytes text results previews and unsaved references', async () => {
  const h = harness(); h.$('document-name').value='이전 사건'; h.$('document-date').value='2026-11-20';
  h.$('document-text').value='이전 사건 원문과 추출 내용은 새 사건에서 남아 있지 않아야 합니다.';
  await h.submit('manual-document-form'); const original = h.app.getCase(), doc = original.documents[0];
  doc.bytes = new Uint8Array([37,80,68,70,45]); doc.verifiedPdf=true; doc.filename='old.pdf'; doc.sourceLocations=[{text:'이전 본문'}];
  original.findings=[{ruleId:'RC-07',summary:'이전 판단'}];
  assert(h.beforeUnload().defaultPrevented);
  const preview = h.document.querySelector('[data-action="document"]'); await h.click(preview);
  assert.equal(h.blobURLs.size,1);
  await h.click('clear-documents');
  assert.notEqual(h.app.getCase(),original); assert.equal(original.disposed,true);
  assert.equal(original.documents.length,0); assert.equal(original.findings.length,0);
  assert.equal(doc.bytes,null); assert.equal(doc.text,''); assert.equal(doc.sourceLocations.length,0);
  assert.equal(h.blobURLs.size,0); assert.equal(h.$('document-pdf').getAttribute('src'),null);
  assert.equal(h.$('document-dialog-content').textContent,''); assert.equal(h.app.memoryStats().documents,0);
  assert.equal(h.beforeUnload().defaultPrevented,false,'an explicitly discarded case is not retained as unsaved');
  assert.equal(h.document.querySelector('[data-action="session"]'),null);
});

test('real engine demo cases render compatible statuses and exact official code', async () => {
  const RealEngine = require('../js/engine.js');
  const h = harness(RealEngine);
  for (const [scenario,label] of [['finding','반려 검토사항이 있어요'],['clear','적용한 규칙에서 발견되지 않았어요'],['missing','추가 확인이 필요해요']]) {
    h.app.showDemo(scenario);
    assert.equal(h.$('result-status').textContent,label);
    assert.equal(h.$('demo-banner').hidden,false);
    if (scenario === 'finding') {
      assert.equal(h.$('findings-list').querySelector('.finding-code').textContent,'0511');
      await h.click(h.$('findings-list').querySelector('[data-action="finding"]'));
      assert.match(h.$('finding-detail').textContent,/이중한정|어느 범위/);
      assert.equal(h.$('finding-dialog').open,true);
    }
  }
});

test('real engine manual import, keyless case export and reopen retain source but downgrade unverified conclusions', async () => {
  const RealEngine = require('../js/engine.js');
  const h = harness(RealEngine);
  h.$('application-number').value='10-2026-0000001'; h.$('document-name').value='통지서 원문'; h.$('document-type').value='oa';
  h.$('document-date').value='2026-11-20'; h.$('document-number').value='123456'; h.$('document-verified').checked=true;
  h.$('document-text').value='[쪽 1]\n의견제출통지서\n출원번호 10-2026-0000001\n발송일 2026-11-20\n발송번호 123456\n원문 텍스트와 메타데이터가 앱과 실제 엔진 사이에서 유지되는지 점검하는 합성 문서입니다.';
  await h.submit('manual-document-form');
  const c=h.app.getCase(); assert.equal(c.documents.length,1); assert.equal(c.documents[0].type,'office-action'); assert.equal(c.documents[0].identityVerified,true);
  assert.equal(c.documents[0].pages[0].page,1); assert.match(c.documents[0].text,/합성 문서/);
  h.$('kipris-key').value='NEVER_EXPORT_KIPRIS'; h.$('llm-key').value='NEVER_EXPORT_LLM'; h.$('llm-model').value='local-test'; await h.submit('settings-form');
  // Non-schema fields must not be smuggled into portable files either.
  c.settings={llmKey:'NEVER_EXPORT_LLM',kiprisKey:'NEVER_EXPORT_KIPRIS'}; c.llmKey='NEVER_EXPORT_LLM';
  await h.click('export-case');
  const download=h.document.downloads.at(-1), blob=h.blobURLs.get(download.href), serialized=await blob.text();
  assert(!serialized.includes('NEVER_EXPORT_')); assert(!serialized.includes('llmKey')); assert(!serialized.includes('kiprisKey'));
  const data=JSON.parse(serialized); assert.equal(data.format,'ai-review-chief-case'); assert.equal(data.documents[0].type,'office-action');
  await h.app.importSaved({size:blob.size,text:async()=>serialized});
  const reopened=h.app.getCase(); assert.notEqual(reopened,c); assert.equal(reopened.status,'hold'); assert.equal(reopened.documents[0].identityVerified,false);
  assert.match(h.$('documents-list').textContent,/통지서 원문/); assert.match(h.$('result-scope').textContent,/저장한 사건/);
});

// v2 regressions use the real intake/diagnostic engine. No external transport is invoked.
const V2_NOTICE = '[쪽 1]\n의견제출통지서\n발송일: 2024. 5. 12.\n발송번호: 9-5-2024-0001234\n이 출원은 특허법 제42조제4항제2호의 요건을 충족하지 못합니다. 청구항 1의 온도센서에 관한 문언과 보호범위를 확인해야 합니다.\n';
const v2TextFile = (text = V2_NOTICE, name = '의견제출통지서.txt') => new File([text], name, {type:'text/plain'});

test('v2 blank-number manual upload works without keys and stays unverified', async () => {
  const h = harness(require('../js/engine.js'));
  await h.app.addFiles([v2TextFile()]);
  const c = h.app.getCase(), d = c.documents[0];
  assert.equal(c.applicationNumber,''); assert.equal(c.mode,'manual'); assert.equal(c.documents.length,1);
  assert.equal(d.type,'office-action'); assert.equal(d.date,'20240512'); assert.equal(d.documentNumber,'9520240001234');
  assert.equal(d.identityVerified,false); assert.equal(d.reviewerCompleteConfirmed,false);
  assert.equal(d.metadataSuggested,true); assert.equal(h.$('view-documents').hidden,false);
  assert.match(h.$('documents-list').textContent,/확인 필요/); assert.match(h.$('review-documents').textContent,/로컬 예비 점검/);
  await h.app.runDocuments();
  assert.equal(c.status,'hold'); assert(c.findings.every(f=>f.verdict!=='confirmed'));
  assert.equal(h.$('view-results').hidden,false);
});

test('v2 detected application numbers are suggestions and mixed files cannot become one confirmed case', async () => {
  const h = harness(require('../js/engine.js'));
  await h.app.addFiles([
    v2TextFile(V2_NOTICE.replace('발송일:', '출원번호: 10-2024-0000001\n발송일:'),'first.txt'),
    v2TextFile(V2_NOTICE.replace('발송일:', '출원번호: 10-2024-0000002\n발송일:'),'second.txt')
  ]);
  const c = h.app.getCase();
  assert.equal(c.applicationNumber,''); assert.equal(c.documents.length,2);
  assert.deepEqual(c.documents.map(d=>d.suggestedApplicationNumber),['1020240000001','1020240000002']);
  assert(c.documents.every(d=>d.applicationNumber===''&&d.identityVerified===false));
  h.$('manual-case-number').value='10-2024-0000001'; await h.submit('manual-case-form');
  assert.equal(c.applicationNumber,''); assert.match(h.$('case-number-feedback').textContent,/다릅니다/);
  assert(c.documents.every(d=>d.identityVerified===false));
});

test('v2 upload suppresses duplicate bytes under another name and reports failures per file', async () => {
  const h = harness(require('../js/engine.js'));
  await h.app.addFiles([v2TextFile(),v2TextFile(V2_NOTICE,'renamed.txt'),new File([],'empty.pdf',{type:'application/pdf'})]);
  assert.equal(h.app.getCase().documents.length,1);
  assert.match(h.$('upload-feedback').textContent,/1개 추가/);
  assert.match(h.$('upload-feedback').textContent,/중복 1개 제외/);
  assert.match(h.$('upload-feedback').textContent,/확인 필요 1개/);
  assert.match(h.$('upload-feedback').textContent,/empty\.pdf/);
  assert.equal(h.$('upload-feedback').querySelector('details').open,true);
  assert.equal(h.$('document-files').disabled,false);
});

test('v2 malformed PDF bytes are excluded and explained without discarding valid sibling files', async () => {
  const h=harness(require('../js/engine.js'));
  await h.app.addFiles([new File(['<html>service error, not a PDF</html>'],'broken.pdf',{type:'application/pdf'}),v2TextFile()]);
  const c=h.app.getCase();
  assert.equal(c.documents.length,1); assert.equal(c.documents[0].filename,'의견제출통지서.txt');
  assert.match(h.$('upload-feedback').textContent,/1개 추가/);
  assert.match(h.$('upload-feedback').textContent,/확인 필요 1개/);
  assert.match(h.$('upload-feedback').textContent,/broken\.pdf/);
  assert.match(h.$('upload-feedback').textContent,/PDF|형식|서명/);
  assert.equal(h.$('upload-feedback').querySelector('details').open,true);
  assert.equal(c.documents[0].identityVerified,false);
});

test('v2 ordinary JSON is a source document and recognized saved JSON reopens the case', async () => {
  const Engine = require('../js/engine.js'), h = harness(Engine);
  const source = JSON.stringify({title:'일반 JSON 참고 자료',text:'온도센서의 결합관계와 작동조건에 관한 설명을 포함한 원문 참고 자료입니다.'});
  await h.app.addFiles([new File([source],'reference.json',{type:'application/json'})]);
  const original=h.app.getCase(); assert.equal(original.documents.length,1); assert.equal(original.mode,'manual');
  assert.match(original.documents[0].text,/온도센서/);
  const data=Engine.serializeCase(original), saved=typeof data==='string'?data:JSON.stringify(data);
  await h.app.addFiles([new File([saved],'saved-case.json',{type:'application/json'})]);
  assert.notEqual(h.app.getCase(),original); assert.equal(h.app.getCase().documents.length,1);
  assert.equal(h.app.getCase().imported,true); assert.equal(h.app.getCase().status,'hold');
  assert.equal(h.app.getCase().documents[0].identityVerified,false);
});

test('v2 document modal saves metadata without granting unchecked verification', async () => {
  const h=harness(require('../js/engine.js')); await h.app.addFiles([v2TextFile()]);
  await h.click(h.$('documents-list').querySelector('[data-action="document"]'));
  assert.equal(h.$('document-dialog').open,true);
  h.$('edit-doc-title').value='원문을 확인 중인 1차 통지서'; h.$('edit-doc-date').value='2024-05-12';
  await h.submit(h.document.querySelector('[data-document-edit]'));
  const d=h.app.getCase().documents[0];
  assert.equal(d.title,'원문을 확인 중인 1차 통지서'); assert.equal(d.date,'20240512');
  assert.equal(d.identityVerified,false); assert.equal(d.reviewerCompleteConfirmed,false); assert.equal(d.metadataSuggested,false);
  assert.equal(h.$('document-dialog-title').textContent,d.title);
});

test('v2 input tabs support arrow keys Home and End and track focus and panel visibility', async () => {
  const h=harness();
  assert.equal(h.$('mode-manual').getAttribute('aria-selected'),'true');
  await h.event('keydown','mode-manual',{key:'ArrowRight'});
  assert.equal(h.$('mode-live').getAttribute('aria-selected'),'true'); assert.equal(h.$('manual-start-panel').hidden,true);
  assert.equal(h.document.activeElement,h.$('mode-live'));
  await h.event('keydown','mode-live',{key:'Home'});
  assert.equal(h.$('mode-manual').getAttribute('aria-selected'),'true'); assert.equal(h.$('live-start-panel').hidden,true);
  await h.event('keydown','mode-manual',{key:'End'});
  assert.equal(h.document.activeElement,h.$('mode-live')); assert.equal(h.$('live-start-panel').hidden,false);
});

test('v2 finding UI cannot turn automatic evidence proof into a reviewer checkbox', async () => {
  const Engine=require('../js/engine.js'), h=harness(Engine); await h.app.addFiles([v2TextFile()]);
  const c=h.app.getCase(), d=c.documents[0];
  c.findings=[{id:'proof-test',ruleId:'OA-15',codeCandidate:'1024',code:null,verdict:'conditional',title:'원문 증거가 필요한 합성 후보',summary:'보정 전후 자료가 필요합니다.',targetDocumentId:d.id,evidence:[],codeValidation:{required:[...Engine.automaticProofFlags,'reasonPredatedAmendment'],errors:[]}}];
  h.app.renderAll(); await h.click(h.$('findings-list').querySelector('[data-action="finding"]'));
  const controls=h.$('finding-detail').querySelectorAll('input[name]').map(n=>n.name);
  assert(controls.includes('reasonPredatedAmendment'));
  for(const key of Engine.automaticProofFlags) assert(!controls.includes(key),'automatic proof exposed as checkbox: '+key);
  assert.match(h.$('finding-detail').textContent,/원문 자료에서 확인할 항목/);
});

test('v2 excluding a source invalidates confirmed findings coverage and its claim version', async () => {
  const h=harness(require('../js/engine.js')); await h.app.addFiles([v2TextFile()]);
  const c=h.app.getCase(), d=c.documents[0];
  c.claimVersions=[{id:'old-version',sourceDocumentId:d.id,claims:[{number:1,text:'온도센서 장치'}],complete:true,historyMatched:true,verifiedAgainstNotice:true}];
  c.findings=[{id:'old-finding',ruleId:'OA-01',code:'1211',verdict:'confirmed',title:'이전 원문의 검토사항',summary:'문서 변경 전 결과',evidence:[{documentId:d.id,page:1,quote:'온도센서'}]}];
  c.coverage=[{ruleId:'OA-01',documentId:d.id,result:'finding',complete:true}]; c.status='issues';
  h.app.renderAll(); await h.click(h.$('documents-list').querySelector('[data-action="remove-document"]'));
  assert.equal(c.documents.length,0); assert.equal(c.claimVersions.length,0); assert.equal(c.coverage.length,0);
  assert(c.findings.every(f=>f.verdict!=='confirmed'&&!f.code)); assert.equal(h.$('confirmed-count').textContent,'0');
  assert.equal(h.$('review-documents').disabled,true); assert.notEqual(c.status,'clear');
});

test('v2 candidate exclusion requires a reason and records the audit without declaring a clear case', async () => {
  const h=harness(require('../js/engine.js')); await h.app.addFiles([v2TextFile()]);
  const c=h.app.getCase(), d=c.documents[0];
  c.findings=[{id:'exclude-candidate',ruleId:'OA-17',codeCandidate:'0512',code:null,verdict:'conditional',title:'원문 대조가 필요한 선호 표현',summary:'문언의 적용 위치를 확인할 필요가 있습니다.',targetDocumentId:d.id,claims:[1],evidence:[],codeValidation:{required:[],errors:[]}}];
  h.app.renderAll(); assert.equal(h.$('pending-count').textContent,'1');
  await h.click(h.$('findings-list').querySelector('[data-action="finding"]'));
  const form=h.$('finding-detail').querySelector('[data-exclude-finding]'); assert(form);
  h.$('exclude-finding-reason').value='짧음'; await h.submit(form);
  assert.equal(c.findings[0].verdict,'conditional'); assert.equal(c.adjudications.length,0);
  assert.equal(h.$('finding-dialog').open,true); assert.match(h.$('toast').textContent,/10.*2,000/);
  const reason='원문의 표현은 발명의 설명에만 있으며 해당 청구항에는 없어 이 후보를 제외합니다.';
  h.$('exclude-finding-reason').value=reason; await h.submit(form);
  assert.equal(c.findings[0].verdict,'excluded'); assert.equal(c.adjudications.length,1);
  assert.equal(c.adjudications[0].reason,reason); assert.equal(h.$('finding-dialog').open,false);
  assert.equal(h.$('pending-count').textContent,'0'); assert.equal(h.$('confirmed-count').textContent,'0');
  assert(h.$('coverage-content').textContent.includes(reason)); assert.match(h.$('coverage-content').textContent,/제외 사유/);
  assert.equal(c.coverage.length,0); assert.equal(c.status,'hold');
});

test('v2 another application is rejected as case evidence but accepted unverified through the citation upload selector', async () => {
  const h=harness(require('../js/engine.js'));
  h.$('manual-case-number').value='10-2024-0000001'; await h.submit('manual-case-form');
  await h.app.addFiles([v2TextFile(V2_NOTICE.replace('발송일:', '출원번호: 10-2024-0000001\n발송일:'),'case-notice.txt')]);
  const c=h.app.getCase(); assert.equal(c.applicationNumber,'1020240000001'); assert.equal(c.documents.length,1);
  const cited='[쪽 1]\n공개특허공보\n출원번호: 10-2022-0000002\n공개번호: 10-2023-0000003\n공개일: 2023-01-20\n이 문헌은 온도센서의 결합관계를 설명한 선행기술 원문을 대신하는 합성 시험 자료입니다.';
  await h.app.addFiles([v2TextFile(cited,'cited-publication.txt')]);
  assert.equal(c.documents.length,1); assert.match(h.$('upload-feedback').textContent,/인용문헌.*선택/);
  h.$('upload-document-type').value='citation'; h.$('document-files').files=[v2TextFile(cited,'cited-publication.txt')];
  await h.event('change','document-files');
  assert.equal(c.documents.length,2);
  const citation=c.documents[1]; assert.equal(citation.type,'citation'); assert.equal(citation.applicationNumber,'1020220000002');
  assert.notEqual(citation.applicationNumber,c.applicationNumber); assert.equal(citation.identityVerified,false);
  assert.equal(c.applicationNumber,'1020240000001'); assert.equal(c.status,'hold');
  assert.match(h.$('upload-feedback').textContent,/1개 추가/);
});


test('v3 valid import cleans the previous case only after validation succeeds', async () => {
  const h=harness(); h.$('document-name').value='먼저 준비한 사건';h.$('document-text').value='가져오기 실패 시에는 이 자료를 유지하고 성공 시에만 정리합니다.';
  await h.submit('manual-document-form');const prior=h.app.getCase();
  await h.app.importSaved(new File(['{}'],'invalid.json'));assert.equal(h.app.getCase(),prior);assert.equal(prior.documents.length,1);
  const next=emptyCase();next.applicationNumber='1020260000002';
  await h.app.importSaved(new File([JSON.stringify(next)],'next.json'));
  assert.notEqual(h.app.getCase(),prior);assert.equal(prior.disposed,true);assert.equal(prior.documents.length,0);
  assert.equal(h.app.getCase().applicationNumber,'1020260000002');assert.equal(h.app.memoryStats().activeCases,1);
});

test('v3 JSON detection locks workspace before reading and refuses a concurrent intake', async () => {
  let finish,reads=0;const content='{\"description\":\"일반 문서 형식이며 사건 보관 JSON이 아닙니다.\"}';const json={name:'ordinary.json',size:90,text:()=>++reads===1?new Promise(resolve=>{finish=resolve;}):Promise.resolve(content)};
  const h=harness();const first=h.app.addFiles([json]);assert.equal(h.app.isBusy(),true);
  await h.app.addFiles([new File(['동시에 들어온 자료는 첫 입력이 끝나기 전에 추가하지 않습니다.'],'other.txt')]);
  assert.equal(h.recorded.ingest.length,0);finish('{"description":"일반 문서 형식이며 사건 보관 JSON이 아닙니다."}');await first;
  assert.equal(h.recorded.ingest.length,1);assert.equal(h.app.isBusy(),false);
});

test('v3 cancelled saved-case import leaves the previous case intact', async () => {
  let finish;const h=harness({importCase:()=>new Promise(resolve=>{finish=resolve;})});
  h.$('document-name').value='현재 사건';h.$('document-text').value='불러오기를 취소해도 현재 사건은 그대로 유지되어야 합니다.';
  await h.submit('manual-document-form');const prior=h.app.getCase();
  const opening=h.app.importSaved(new File(['{}'],'saved.json'));for(let i=0;i<20&&!finish;i++)await new Promise(setImmediate);assert.equal(typeof finish,'function');
  await h.click('cancel-review');finish({...emptyCase(),applicationNumber:'1020260000003'});await opening;
  assert.equal(h.app.getCase(),prior);assert.equal(prior.documents.length,1);assert.equal(h.app.isBusy(),false);
});

test('v3 aggregate upload cap rejects bytes before any file body is read', async () => {
  const h=harness();let read=false;
  await h.app.addFiles([{name:'large.pdf',size:181*1048576,arrayBuffer:async()=>{read=true;return new ArrayBuffer(1);}}]);
  assert.equal(read,false);assert.equal(h.recorded.ingest.length,0);assert.match(h.$('toast').textContent,/180 MiB/);
});

test('v3 output presets and settings retain explicit model limits and call caps', async () => {
  const h=harness();assert.equal(h.$('output-tokens').value,'32768');assert.equal(h.$('max-tokens').value,'128000');
  await h.click(h.document.querySelector('[data-token-profile="65536"]'));assert.equal(h.$('output-tokens').value,'65536');
  assert.match(h.$('budget-hint').textContent,/추론/);
  h.$('max-tokens').value='8192';await h.submit('settings-form');assert.match(h.$('settings-feedback').textContent,/전체 예산/);
  h.$('max-tokens').value='128000';h.$('max-model-calls').value='301';await h.submit('settings-form');assert.match(h.$('settings-feedback').textContent,/1~300/);
});

test('v3 manual memory purge clears demo backup as well as the visible synthetic case', async () => {
  const h=harness();h.$('document-name').value='원래 문서';h.$('document-text').value='예시를 열기 전에 입력했던 사건의 원문도 명시적 비우기에서 지웁니다.';
  await h.submit('manual-document-form');const prior=h.app.getCase();h.app.showDemo();
  await h.click('purge-case');assert.equal(h.app.getCase(),null);assert.equal(prior.disposed,true);assert.equal(h.app.memoryStats().documents,0);
  await h.click('exit-demo');assert.equal(h.app.getCase(),null);
});

test('public hosting labels and settings refuse the unavailable local relay', async () => {
  const h = harness({}, {location:{protocol:'https:',hostname:'aireviewer.moip.ai.kr'}});
  assert.equal(h.$('connection-label').textContent, '웹에서 사용 중');
  assert.equal(h.$('hosting-notice').hidden, false);
  assert.equal(h.$('hosting-settings-message').hidden, false);
  assert.match(h.$('hosting-settings-message').textContent, /CORS/);
  assert.match(h.$('hosting-settings-message').textContent, /중계 서버가 없습니다/);
  assert(h.$('connection-mode').querySelector('option[value="relay"]').disabled);
  h.$('connection-mode').value = 'relay';
  await h.submit('settings-form');
  assert.match(h.$('settings-feedback').textContent, /로컬 중계를 사용할 수 없습니다/);
});

test('public navigation supports deep links, browser back, and hash changes without losing a case', async () => {
  const h = harness({}, {location:{hash:'#documents',protocol:'https:',hostname:'aireviewer.moip.ai.kr'}});
  assert.equal(h.$('view-documents').hidden, false);
  h.$('document-name').value = '합성 검토 문서';
  h.$('document-text').value = '탭을 이동하더라도 준비한 문서의 내용은 유지되어야 합니다.';
  await h.submit('manual-document-form');
  const c = h.app.getCase();
  await h.click(h.document.querySelector('.nav-item[data-view="settings"]'));
  assert.deepEqual(h.historyCalls.at(-1), ['push', '#settings']);
  const count = h.historyCalls.length;
  h.navigate('#documents');
  assert.equal(h.$('view-documents').hidden, false);
  assert.equal(h.app.getCase(), c);
  assert.equal(h.historyCalls.length, count, 'history traversal must not create another history entry');
  h.navigate('#rules', 'hashchange');
  assert.equal(h.$('view-rules').hidden, false);
  assert.equal(h.document.title, '검토 규칙 · AI 심사팀장 큐리');
  for (const hash of ['#unknown', '#constructor', '#toString', '#__proto__']) {
    const invalid = harness({}, {location:{hash}});
    assert.equal(invalid.$('view-review').hidden, false);
    assert.equal(invalid.location.hash, '#review');
    invalid.navigate(hash, 'hashchange');
    assert.equal(invalid.$('view-review').hidden, false);
  }
});

test('model connection checks lock competing work and can be cancelled from settings', async () => {
  let calls = 0, signal;
  const h = harness({}, {api:{testConnection:async (settings, options) => {
    calls++; signal = options.signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), {once:true}));
  }}});
  const pending = h.click('test-llm');
  assert.equal(h.app.isBusy(), true);
  assert.equal(h.$('settings-form').getAttribute('aria-busy'), 'true');
  assert.equal(h.$('cancel-connection').hidden, false);
  assert.equal(h.$('save-settings').disabled, true);
  assert.equal(h.$('home-upload-button').disabled, true);
  await h.click('test-llm');
  assert.equal(calls, 1);
  await h.click('cancel-connection');
  await pending;
  assert(signal.aborted);
  assert.equal(h.app.isBusy(), false);
  assert.equal(h.$('cancel-connection').hidden, true);
  assert.equal(h.$('save-settings').disabled, false);
  assert.match(h.$('llm-test-result').textContent, /중단했습니다/);
  assert.equal(h.$('available-models'), null, 'cancelled checks must not populate model suggestions');
});
