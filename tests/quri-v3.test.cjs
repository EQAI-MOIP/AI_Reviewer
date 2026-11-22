/* QURI v3 animation/tour integration contracts using Node built-ins only.
 * This deliberately small DOM harness is NOT a browser, layout or accessibility audit.
 * It executes the real app.js against elements parsed from the actual index.html.
 * API transport and document/LLM processing are stubbed; those have separate tests.
 * Run: node --test tests/quri-v3.test.cjs
 * Harness is copied from the local UI test helper; this file does not import or
 * register tests from ui.test.cjs. It executes the actual app and guide modules.
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
function harness(overrides = {}) {
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
  const api = {...RealAPI, usesRelay:() => false, testConnection:async() => ({models:['local-test'],modelAvailable:true,note:'모의 모델 목록'})};
  const window = { ReviewAPI:api, ReviewRules:Rules, ReviewEngine:engine, scrollTo() {}, addEventListener(type, fn) { if (!windowEvents.has(type)) windowEvents.set(type, []); windowEvents.get(type).push(fn); } };
  const location = { hash:'', protocol:'file:', hostname:'' };
  const sandbox = { window, document, navigator:{onLine:true}, location, history:{replaceState(a,b,hash) { location.hash = hash; }}, FormData:MiniFormData,
    File, Blob, URL:TestURL, AbortController, DOMException, TextEncoder, TextDecoder, console, setTimeout:() => 1, clearTimeout() {}, requestAnimationFrame:fn => fn() };
  vm.runInNewContext(appSource, sandbox, {filename:'js/app.js'});
  const $ = id => document.getElementById(id);
  return {document,window,app:window.ReviewApp,$,engine,recorded,blobURLs,click:node => (typeof node === 'string' ? $(node) : node).click(),
    submit:node => document.dispatch('submit', typeof node === 'string' ? $(node) : node),
    event:(type,node,extra) => document.dispatch(type,typeof node === 'string' ? $(node) : node,extra),
    beforeUnload() { const e = {defaultPrevented:false,preventDefault() {this.defaultPrevented=true;}}; for (const fn of windowEvents.get('beforeunload') || []) fn(e); return e; }
  };
}


MiniNode.prototype.insertBefore = function (node,before) {
  if(node.parentNode)node.remove();node.parentNode=this;
  const i=this.childNodes.indexOf(before);if(i<0)this.childNodes.push(node);else this.childNodes.splice(i,0,node);
  return node;
};
Object.defineProperty(MiniNode.prototype,'isConnected',{get(){return this.ownerDocument.contains(this);}});
const guideSource=fs.readFileSync(path.join(ROOT,'js/quri-guide.js'),'utf8');
function guideHarness() {
  const h=harness(),callbacks=new Map(),clock={now:100000,created:0},observers={intersection:[],mutation:[]},motion={matches:false};
  h.document.readyState='complete';h.document.documentElement=h.document.querySelector('html');h.window.document=h.document;
  h.window.setInterval=fn=>{const id=++clock.created;callbacks.set(id,fn);return id;};
  h.window.clearInterval=id=>callbacks.delete(id);
  h.window.requestAnimationFrame=fn=>fn();
  h.window.matchMedia=()=>motion;
  motion.addEventListener=(type,fn)=>{motion.changed=fn;};
  h.window.IntersectionObserver=class {
    constructor(fn){this.fn=fn;this.targets=new Set();observers.intersection.push(this);}
    observe(el){this.targets.add(el);}unobserve(el){this.targets.delete(el);}
    emit(target,isIntersecting){this.fn([{target,isIntersecting}]);}
  };
  h.window.MutationObserver=class {
    constructor(fn){this.fn=fn;this.targets=[];observers.mutation.push(this);}
    observe(el){this.targets.push(el);} emit(){this.fn([]);}
  };
  class TestDate extends Date { static now(){return clock.now;} }
  vm.runInNewContext(guideSource,{window:h.window,Date:TestDate,console},{filename:'js/quri-guide.js'});
  Object.assign(h,{guide:h.window.QuriGuide,timers:callbacks,clock,observers,motion,
    tick(ms){clock.now+=ms;for(const fn of [...callbacks.values()])fn();},
    mutations(){for(const o of observers.mutation)o.emit();}});
  return h;
}
function pendingUpload(h) {
  let resolve;
  h.engine.ingestFile=()=>new Promise(done=>{resolve=done;});
  const work=h.app.addFiles([new File(['합성 원문 시험'], 'synthetic.txt',{type:'text/plain'})]);
  return {work,finish(){resolve({id:'quri-test-document',title:'합성 원문',filename:'synthetic.txt',type:'other',text:'합성 원문 시험',pages:[{page:1,text:'합성 원문 시험'}],extraction:{complete:false,warnings:[]}});return work;}};
}

test('guide opens only on request, visits all six real views/targets, and never submits work', async()=>{
  const h=guideHarness();
  assert.equal(h.$('quri-tour-panel').hidden,true);assert.equal(h.$('quri-tour-start').getAttribute('aria-expanded'),'false');
  await h.click('quri-tour-start');
  assert.equal(h.$('quri-tour-position').textContent,'1 / 6');assert.equal(h.$('quri-tour-previous').disabled,true);
  await h.click('quri-tour-next');assert(h.$('home-drop-zone').classList.contains('quri-tour-target'));
  await h.click('quri-tour-next');assert(h.$('application-number').classList.contains('quri-tour-target'));assert.equal(h.$('live-start-panel').hidden,false);
  await h.click('quri-tour-next');assert.equal(h.$('view-documents').hidden,false);assert(h.$('preparation-title').classList.contains('quri-tour-target'));
  await h.click('quri-tour-next');assert(h.$('review-documents').classList.contains('quri-tour-target'));
  await h.click('quri-tour-next');assert.equal(h.$('view-results').hidden,false);assert.equal(h.$('quri-tour-position').textContent,'6 / 6');
  await h.click('quri-tour-next');assert.equal(h.$('quri-tour-panel').hidden,true);assert.equal(h.document.querySelectorAll('.quri-tour-target').length,0);
  assert.equal(h.recorded.ingest.length,0);assert.equal(h.app.getCase(),null);assert.equal(h.timers.size,0);
});

test('Escape closes from the actual input, restores focus, and navigation keeps its own focus',async()=>{
  const h=guideHarness();h.$('quri-tour-start').focus();await h.click('quri-tour-start');await h.click('quri-tour-next');await h.click('quri-tour-next');
  h.$('application-number').focus();await h.event('keydown','application-number',{key:'Escape'});
  assert.equal(h.$('quri-tour-panel').hidden,true);assert.equal(h.document.activeElement.id,'quri-tour-start');
  await h.click('quri-tour-start');await h.click(h.document.querySelector('.nav-item[data-view="settings"]'));
  assert.equal(h.$('quri-tour-panel').hidden,true);assert.equal(h.document.activeElement.id,'settings-title');
});

test('actual upload hooks maintain one waiting timer, preserve progress across navigation, and render source text safely',async()=>{
  const h=guideHarness(),work=pendingUpload(h);
  assert.equal(h.app.isBusy(),true);assert.equal(h.$('hero-robot').dataset.quriMotion,'reading');assert.equal(h.timers.size,1);
  h.guide.setState('reading',{message:'<script>document data</script>'});
  assert.match(h.document.querySelector('.quri-waiting-status').textContent,/<script>document data<\/script>/);assert.equal(h.document.querySelector('.quri-waiting-status').querySelectorAll('script').length,0);
  h.guide.setState('reading',{message:'원문 2쪽을 확인합니다.'});assert.equal(h.clock.created,1);
  h.app.showView('documents');h.mutations();
  assert.equal(h.$('guide-sprite').dataset.quriMotion,'reading');assert.equal(h.$('guide-message').textContent,'원문 2쪽을 확인합니다.');
  h.tick(2000);assert.equal(h.document.querySelector('.quri-waiting-status').querySelector('time').textContent,'경과 0분 02초');
  await work.finish();assert.equal(h.timers.size,0);assert.equal(h.app.isBusy(),false);assert.equal(h.document.querySelector('.quri-waiting-status').hidden,true);
});

test('completed intake shows hold and new case releases the old visual state',async()=>{
  const h=guideHarness(),work=pendingUpload(h);await work.finish();
  assert.equal(h.$('hero-robot').dataset.quriMotion,'hold');assert.equal(h.$('hero-robot').dataset.quriPlay,'false');
  h.app.newCase();h.guide.refresh();
  assert.equal(h.$('hero-robot').dataset.quriMotion,'upload');assert.equal(h.app.getCase().documents.length,0);assert.equal(h.timers.size,0);
});

test('hidden tabs stop timers and off-screen sprites pause without losing elapsed time',async()=>{
  const h=guideHarness(),work=pendingUpload(h);h.tick(3000);
  h.document.hidden=true;await h.event('visibilitychange',h.document);
  assert.equal(h.timers.size,0);assert.equal(h.$('hero-robot').dataset.quriPlay,'false');
  h.tick(17000);h.document.hidden=false;await h.event('visibilitychange',h.document);
  assert.equal(h.timers.size,1);assert.equal(h.document.querySelector('.quri-waiting-status').querySelector('time').textContent,'경과 0분 20초');
  h.observers.intersection[0].emit(h.$('hero-robot'),false);assert.equal(h.$('hero-robot').dataset.quriPlay,'false');
  h.observers.intersection[0].emit(h.$('hero-robot'),true);assert.equal(h.$('hero-robot').dataset.quriPlay,'true');
  await work.finish();assert.equal(h.timers.size,0);
});

test('both system preference and the real motion toggle stop frames while retaining labels',async()=>{
  const h=guideHarness();assert.equal(h.$('hero-robot').dataset.quriPlay,'true');
  h.motion.matches=true;h.motion.changed();assert.equal(h.$('hero-robot').dataset.quriPlay,'false');
  assert.match(h.$('hero-robot').getAttribute('aria-label'),/큐리/);
  h.motion.matches=false;h.motion.changed();assert.equal(h.$('hero-robot').dataset.quriPlay,'true');
  await h.click('motion-toggle');assert.equal(h.$('hero-robot').dataset.quriPlay,'false');
  await h.click('motion-toggle');assert.equal(h.$('hero-robot').dataset.quriPlay,'true');
});

test('synthetic demo remains explicitly labeled and does not start waiting work',async()=>{
  const h=guideHarness();await h.app.showDemo('clear');h.mutations();
  assert.equal(h.app.getCase().mode,'demo');assert.equal(h.$('result-robot').dataset.quriMotion,'complete');
  assert.match(h.$('result-robot').getAttribute('aria-label'),/합성 예시/);assert.equal(h.$('demo-banner').hidden,false);assert.equal(h.timers.size,0);
  await h.app.showDemo('missing');h.mutations();assert.equal(h.$('result-robot').dataset.quriMotion,'hold');assert.equal(h.$('result-robot').dataset.quriPlay,'false');
});

test('controller busy state recovers missing hooks and prevents guide from starting mid-request',async()=>{
  const h=guideHarness(),guide=h.guide;h.window.QuriGuide=undefined;const work=pendingUpload(h);h.window.QuriGuide=guide;
  assert.equal(h.app.isBusy(),true);assert.equal(h.timers.size,0);
  h.mutations();assert.equal(h.$('hero-robot').dataset.quriMotion,'reading');assert.equal(h.timers.size,1);assert.equal(h.$('quri-tour-start').disabled,true);
  guide.startTour();assert.equal(h.$('quri-tour-panel').hidden,true);
  await work.finish();assert.equal(h.timers.size,0);assert.equal(h.$('quri-tour-start').disabled,false);
});
