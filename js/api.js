/* AI 심사팀장 큐리 v3.0.0 — first-party browser API adapter. No external modules. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReviewAPI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const defaults = Object.freeze({
    kiprisBase: 'https://plus.kipris.or.kr', kiprisKey: '',
    llmBase: 'https://api.openai.com/v1', llmKey: '', model: '',
    apiMode: 'responses', connectionMode: 'auto', maxTokens: 128000,
    outputTokens: 32768, tokenCounting: 'auto', pdfInput: true,
    chatTokenField: 'max_completion_tokens', timeoutMs: 300000,
    maxModelCalls: 100, ruleBatchSize: 3, pdfPagesPerCall: 2
  });
  const PATHS = Object.freeze({
    history: '/openapi/rest/RelatedDocsonfilePatService/relatedDocsonfileInfo',
    OP: '/openapi/rest/IntermediateDocumentOPService/pdfInfoV2',
    RE: '/openapi/rest/IntermediateDocumentREService/pdfInfoV2',
    RG: '/openapi/rest/IntermediateDocumentRGService/pdfInfoV2',
    amendments: '/openapi/rest/ClaimsChangeHistoryService/amendmentHistoryInfo',
    amendmentDetails: '/openapi/rest/ClaimsChangeHistoryService/amendmentHistoryDetailInfo',
    metadata: '/kipo-api/kipi/patUtiModInfoSearchSevice/applicationNumberSearchInfo',
    claims: '/kipo-api/kipi/patUtiModInfoSearchSevice/patentClaimInfo',
    publication: '/kipo-api/kipi/patUtiModInfoSearchSevice/getPubFullTextInfoSearch',
    registration: '/kipo-api/kipi/patUtiModInfoSearchSevice/getAnnFullTextInfoSearch',
    citedSearch: '/kipo-api/kipi/patUtiModInfoSearchSevice/getAdvancedSearch'
  });
  class ReviewAPIError extends Error {
    constructor(code, message, details) { super(message); this.name = 'ReviewAPIError'; this.code = code; this.details = details || {}; }
  }
  function fail(code, message, details) { throw new ReviewAPIError(code, message, details); }
  function normalizeApplicationNumber(value) {
    const s = String(value || '').trim();
    if (!/^[\d\s-]+$/.test(s)) fail('APPLICATION_NUMBER', '출원번호에는 숫자와 하이픈만 사용할 수 있습니다.');
    const n = s.replace(/[\s-]/g, '');
    if (!/^\d{13}$/.test(n)) fail('APPLICATION_NUMBER', '출원번호를 13자리로 입력해 주세요. 예: 10-2021-0126226');
    return n;
  }
  function settingsOf(s) { return Object.assign({}, defaults, s || {}); }
  function utf8(text) { return new TextEncoder().encode(String(text || '')); }
  // A deliberately conservative byte upper estimate, not a provider tokenizer.
  function estimateTokens(text) { return utf8(text).length + 256; }
  function endpointURL(base, kind) {
    let u;
    try { u = new URL(String(base || '').trim()); } catch (_) { fail('BASE_URL', 'Base URL 형식이 올바르지 않습니다.'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) fail('HTTPS_REQUIRED', '외부 API는 HTTPS를 사용해야 합니다. 로컬 LLM만 HTTP를 허용합니다.');
    if (u.username || u.password || u.hash) fail('BASE_URL', 'Base URL에 사용자 정보나 URL 조각을 넣을 수 없습니다.');
    if ([...u.searchParams.keys()].some(k => /key|token|secret|signature|auth/i.test(k))) fail('BASE_URL', 'Base URL에 인증 키를 넣지 말고 API 키 입력란을 사용해 주세요.');
    const suffix = { responses: '/responses', chat: '/chat/completions', count: '/responses/input_tokens', models: '/models' }[kind];
    if (!suffix) fail('API_MODE', '지원하지 않는 API 방식입니다.');
    let p = u.pathname.replace(/\/+$/, '').replace(/\/(?:responses(?:\/input_tokens)?|chat\/completions|models)$/, '');
    if (!p) p = '/v1';
    u.pathname = p + suffix;
    return u.href;
  }
  function redact(value, secrets) {
    let s = String(value || '');
    (secrets || []).filter(Boolean).forEach(k => { s = s.split(String(k)).join('[가림]'); });
    return s.replace(/https?:\/\/[^\s<>"']+/gi, '[주소 생략]').replace(/(?:accessKey|ServiceKey|api[_-]?key|Authorization)\s*[:=]\s*[^\s,&]+/gi, '[인증정보 가림]');
  }
  function abortIfNeeded(signal) { if (signal && signal.aborted) throw new DOMException('작업을 중지했습니다.', 'AbortError'); }
  function linkAbort(signal, ms) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal && signal.reason);
    if (signal) { if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); }
    const timer = setTimeout(() => controller.abort(), ms);
    return { signal: controller.signal, cleanup() { clearTimeout(timer); if (signal) signal.removeEventListener('abort', abort); } };
  }
  function runtimeInfo(page = typeof location !== 'undefined' ? location : null) {
    const protocol = page && page.protocol, hostname = page && page.hostname;
    const local = /^https?:$/.test(protocol || '') && ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
    return { mode: !page ? 'unknown' : local ? 'local' : protocol === 'file:' ? 'file' : 'web', canUseRelay: local };
  }
  async function responseBytes(response, limit) {
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > limit) {
      try { if (response.body) await response.body.cancel(); } catch (_) { /* Already closed. */ }
      fail('RESPONSE_SIZE', '응답이 안전한 처리 크기를 초과했습니다.');
    }
    let bytes;
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > limit) { await reader.cancel(); fail('RESPONSE_SIZE', '응답이 안전한 처리 크기를 초과했습니다.'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      bytes = new Uint8Array(size); let at = 0;
      for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    } else bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) fail('RESPONSE_SIZE', '응답이 안전한 처리 크기를 초과했습니다.');
    return bytes;
  }
  // Cache only a completed handshake. Each caller owns its cancellation signal;
  // cancelling one pending session must not leave another caller with an aborted promise.
  let sessionToken = null;
  async function relayToken(fetcher, signal) {
    abortIfNeeded(signal);
    if (sessionToken) return sessionToken;
    const timeout = linkAbort(signal, 10000);
    try {
      const r = await fetcher('/api/session', { cache: 'no-store', credentials: 'same-origin',
        signal: timeout.signal, redirect: 'error', referrerPolicy: 'no-referrer' });
      if (!r.ok) {
        try { if (r.body) await r.body.cancel(); } catch (_) { /* Already closed. */ }
        fail('RELAY_UNAVAILABLE', '실행 도우미에 연결할 수 없습니다. node server.js로 실행한 주소에서 열어 주세요.');
      }
      const text = new TextDecoder().decode(await responseBytes(r, 4096));
      let data; try { data = JSON.parse(text); } catch (_) { /* A static server may return an HTML page. */ }
      if (!data || data.runtime !== 'node-builtins' || !/^[a-f0-9]{64}$/i.test(data.token || ''))
        fail('RELAY_UNAVAILABLE', '이 주소에서 실행 도우미를 확인할 수 없습니다. node server.js로 실행한 주소를 열거나 브라우저 직접 연결을 선택해 주세요.');
      abortIfNeeded(timeout.signal);
      sessionToken = data.token;
      return sessionToken;
    } catch (e) {
      if (signal && signal.aborted) throw new DOMException('작업을 중지했습니다.', 'AbortError');
      if (timeout.signal.aborted) fail('TIMEOUT', '실행 도우미의 연결 확인 시간이 초과되었습니다. 도우미 실행 상태를 확인해 주세요.');
      if (e instanceof ReviewAPIError) throw e;
      fail('RELAY_UNAVAILABLE', '실행 도우미에 연결할 수 없습니다. node server.js로 실행한 주소에서 열어 주세요.');
    } finally { timeout.cleanup(); }
  }
  function usesRelay(s) {
    if (s.connectionMode === 'direct' || s.useRelay === false) return false;
    if (s.connectionMode === 'relay' || s.useRelay === true) return true;
    return runtimeInfo().canUseRelay;
  }
  async function request(s, target, { signal, fetcher, method = 'GET', headers = {}, body, binary = false, relayPath, relayBody } = {}) {
    const f = fetcher || s.fetcher || globalThis.fetch;
    if (typeof f !== 'function') fail('FETCH_UNAVAILABLE', '이 브라우저는 fetch API를 지원하지 않습니다.');
    abortIfNeeded(signal);
    const relay = usesRelay(s), runtime = runtimeInfo();
    if (relay && runtime.mode !== 'unknown' && !runtime.canUseRelay)
      fail('RELAY_UNAVAILABLE', '공개 사이트나 파일로 연 화면에서는 로컬 중계를 사용할 수 없습니다. 브라우저 직접 연결을 선택하거나 내려받은 앱을 node server.js로 실행한 주소에서 열어 주세요.');
    const timeout = linkAbort(signal, Number(s.timeoutMs) || 300000);
    try {
      let response;
      if (relay) {
        const token = await relayToken(f, timeout.signal);
        abortIfNeeded(timeout.signal);
        response = await f(relayPath, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'Content-Type': 'application/json', 'X-Review-Token': token }, body: JSON.stringify(relayBody), signal: timeout.signal,
          redirect: 'error', referrerPolicy: 'no-referrer' });
      } else {
        response = await f(target, { method, headers, body, signal: timeout.signal, cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
      }
      if (!response.ok) {
        // Never display a remote body: it may echo a key or a signed PDF URL.
        const status = response.status;
        // Cancel unread failure bodies before removing our timeout. Otherwise a streamed
        // error can retain a connection and its buffers after the UI has reported failure.
        try { if (response.body) await response.body.cancel(); } catch (_) { /* Already aborted or closed. */ }
        if (relay && status === 403) sessionToken = null;
        const m = status === 401 || status === 403 ? '인증 또는 상품 이용 권한을 확인해 주세요. 실행 도우미를 다시 시작했다면 한 번 더 실행해 주세요.' : status === 429 ? '요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.' : status === 400 ? '요청 형식·모델 지원 기능을 확인해 주세요. 설정의 API 방식과 모델 ID가 공급자 문서와 일치해야 합니다.' : status === 404 ? '요청 경로 또는 모델을 찾지 못했습니다. Base URL, API 방식, 모델 ID를 확인해 주세요.' : status >= 500 ? '외부 서비스가 요청을 처리하지 못했습니다. 잠시 후 이 단계부터 다시 시도해 주세요.' : '서비스 요청이 실패했습니다.';
        fail('HTTP_' + status, m + ' (HTTP ' + status + ')', { status });
      }
      const limit = binary ? 30 * 1024 * 1024 : 72 * 1024 * 1024;
      const bytes = await responseBytes(response, limit);
      return binary ? bytes : new TextDecoder().decode(bytes);
    } catch (e) {
      if (e instanceof ReviewAPIError) throw e;
      if (signal && signal.aborted) throw new DOMException('작업을 중지했습니다.', 'AbortError');
      if (timeout.signal.aborted) fail('TIMEOUT', '응답 시간이 초과되었습니다. 해당 단계는 완료되지 않았습니다.');
      fail('NETWORK', relay ? '실행 도우미 또는 인터넷 연결을 확인해 주세요. 요청이 완료되지 않았습니다.' : '네트워크 또는 API 제공자의 브라우저 연결 허용(CORS) 설정으로 요청하지 못했습니다. Base URL과 인터넷 연결을 확인하고, CORS를 지원하지 않으면 내려받은 앱의 로컬 실행 도우미를 사용해 주세요.');
    } finally { timeout.cleanup(); }
  }
  function decodeEntities(s) {
    return String(s || '').replace(/&(?:#(x[0-9a-f]+|\d+)|([a-z]+));/gi, (m, n, a) => {
      if (n) { const v = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n); return Number.isFinite(v) && v <= 0x10ffff ? String.fromCodePoint(v) : m; }
      return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[a] || m;
    });
  }
  // Small strict XML reader for the documented flat KIPRIS response records. No DTDs or external entities.
  function parseXML(xml) {
    if (typeof xml !== 'string' || !xml.trim().startsWith('<')) fail('XML_FORMAT', 'KIPRIS Plus의 XML 응답이 아닙니다.');
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail('XML_DTD', '외부 엔터티를 포함한 XML은 처리하지 않습니다.');
    const root = { name: '#document', children: [], text: '' }, stack = [root];
    const tokens = xml.match(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<[^>]*>|[^<]+/g) || [];
    for (const t of tokens) {
      if (t.startsWith('<!--') || t.startsWith('<?')) continue;
      const parent = stack[stack.length - 1];
      if (t.startsWith('<![CDATA[')) { parent.text += t.slice(9, -3); continue; }
      if (t.startsWith('</')) {
        const name = t.slice(2, -1).trim().split(':').pop();
        if (stack.length < 2 || parent.name !== name) fail('XML_FORMAT', 'XML 태그 구조가 일치하지 않습니다.');
        stack.pop();
      } else if (t.startsWith('<')) {
        const m = t.match(/^<([\w:.-]+)(?:\s[^<>]*)?\s*\/?>$/);
        if (!m) fail('XML_FORMAT', 'XML 태그를 읽을 수 없습니다.');
        const n = { name: m[1].split(':').pop(), children: [], text: '' };
        parent.children.push(n);
        if (!/\/\s*>$/.test(t)) stack.push(n);
      } else { parent.text += decodeEntities(t); }
    }
    if (stack.length !== 1 || root.children.length !== 1) fail('XML_FORMAT', 'XML 응답이 잘렸거나 완전하지 않습니다.');
    const all = []; (function walk(n) { all.push(n); n.children.forEach(walk); })(root);
    const value = n => (n.text + n.children.map(value).join('')).trim();
    const field = name => { const n = all.find(x => x.name.toLowerCase() === name.toLowerCase()); return n ? value(n) : ''; };
    const code = field('resultCode') || field('returnReasonCode') || field('returnCode');
    if (code && !['00', '0', '0000', '200', 'SUCCESS', 'NORMAL_SERVICE'].includes(code.toUpperCase())) fail('KIPRIS_' + code.replace(/[^a-z0-9]/gi, '').slice(0, 20), 'KIPRIS Plus 오류 응답입니다. 상품 승인, 키, 호출 한도를 확인해 주세요.', { resultCode: code.replace(/[^a-z0-9]/gi, '').slice(0, 20) });
    if (field('errMsg') || field('errorMessage')) fail('KIPRIS_ERROR', 'KIPRIS Plus가 오류를 반환했습니다. 설정과 상품 이용 권한을 확인해 주세요.');
    function records(marker) {
      const markers = Array.isArray(marker) ? marker : [marker];
      return all.filter(n => markers.some(m => n.children.some(c => c.name === m))).map(n => {
        const o = {}; n.children.forEach(c => { if (!(c.name in o)) o[c.name] = value(c); }); return o;
      });
    }
    return { field, records };
  }
  function kiprisURL(path, params, s) {
    let base;
    try { base = new URL(s.kiprisBase); } catch (_) { fail('KIPRIS_BASE', 'KIPRIS Plus Base URL을 확인해 주세요.'); }
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) fail('KIPRIS_BASE', 'KIPRIS Plus Base URL은 인증정보 없는 HTTPS 주소여야 합니다.');
    if (usesRelay(s) && (base.origin !== 'https://plus.kipris.or.kr' || !['', '/'].includes(base.pathname))) fail('KIPRIS_BASE', '실행 도우미는 KIPRIS Plus 공식 주소만 지원합니다. 사용자 정의 주소는 직접 연결 방식으로 설정해 주세요.');
    const u = new URL(base.pathname.replace(/\/+$/, '') + path, base.origin);
    Object.entries(params).forEach(([k, v]) => { if (v !== '' && v != null) u.searchParams.set(k, String(v)); });
    u.searchParams.set(path.startsWith('/kipo-api/') ? 'ServiceKey' : 'accessKey', s.kiprisKey);
    return u.href;
  }
  async function queryAll(kind, applicationNumber, s, options, marker) {
    const path = PATHS[kind], records = [], seenPages = new Set();
    let expected = null, complete = false, basis = '', page = 1;
    for (; page <= 1000; page++) {
      const params = { ...(options.searchParams || { applicationNumber }), pageNo: page, numOfRows: 100 };
      const xml = await request(s, kiprisURL(path, params, s), { ...options, relayPath: '/api/kipris', relayBody: { path, params, key: s.kiprisKey } });
      const doc = parseXML(xml), rows = doc.records(marker);
      const totalRaw = doc.field('totalCount') || doc.field('totalCnt') || doc.field('totalNumber');
      const total = /^\d+$/.test(totalRaw) ? Number(totalRaw) : null;
      if (total !== null && (total > 100000 || total < 0)) fail('PAGINATION', '전체 문서 수가 허용 범위를 벗어났습니다.');
      if (total !== null) { if (expected !== null && total !== expected) fail('PAGINATION', '조회 중 전체 문서 수가 변경되었습니다. 다시 조회해 주세요.'); expected = total; }
      const signature = JSON.stringify(rows);
      if (seenPages.has(signature) && rows.length) fail('PAGINATION', '같은 페이지가 반복되어 전체 이력을 확인하지 못했습니다.');
      seenPages.add(signature); records.push(...rows);
      if (expected !== null && records.length >= expected) {
        if (records.length !== expected) fail('PAGINATION', '전체 건수와 조회 건수가 일치하지 않습니다.');
        complete = true; basis = 'totalCount'; break;
      }
      const pageRaw = doc.field('pageNo') || doc.field('pageNumber');
      const sizeRaw = doc.field('numOfRows') || doc.field('pageSize');
      const size = /^\d+$/.test(sizeRaw) ? Number(sizeRaw) : 100;
      if (expected === null && !pageRaw && !sizeRaw) {
        // These source-skill operations are documented as full-list responses. Exactly 100 records is suspicious.
        complete = rows.length !== 100; basis = complete ? 'documented-unpaged-response' : 'unverified-page-boundary'; break;
      }
      if (!rows.length || rows.length < size) { complete = expected === null; basis = complete ? 'last-short-page' : 'missing-records'; break; }
    }
    if (!complete) fail('PAGINATION', '전체 응답을 확인하지 못했습니다. 일부 문서만으로 없음 판정을 내리지 않습니다.', { kind, received: records.length });
    return { records, complete, basis, pages: page };
  }
  function documentType(title) {
    const t = String(title || '').replace(/\s+/g, '');
    if (/거절결정/.test(t)) return 'rejection';
    if (/등록결정|특허결정/.test(t)) return 'registration-decision';
    if (/최후/.test(t) && /통지/.test(t)) return 'final-notice';
    if (/의견제출통지|거절이유.*통지/.test(t)) return 'office-action';
    if (/보정서/.test(t)) return 'amendment';
    if (/의견서/.test(t)) return 'opinion';
    return 'history';
  }
  // Intake suggestions are conveniences, never proof of identity, scope, or chronology.
  // Restrict evidence to the opening page and explicit labels; references in reasons
  // and bibliography must not silently become the current application's identity.
  function suggestDocumentMetadata(text, filename = '') {
    const source = String(text || '').normalize('NFC').replace(/\r\n?/g, '\n');
    const firstPage = source.split(/\f|\n\s*\[(?:쪽|page)\s*[2-9]\d*\]\s*\n/i)[0].slice(0, 7000);
    const lines = firstPage.split('\n').map(s => s.trim()).filter(Boolean);
    const out = { type: 'other', title: '', date: '', documentNumber: '', applicationNumber: '', verified: false, suggestions: [], warnings: [] };
    const labels = { 'office-action': '의견제출통지서', 'final-notice': '최후 의견제출통지서', rejection: '거절결정서', 'registration-decision': '등록결정서', publication: '공개공보', 'registration-gazette': '등록공보', claims: '시점별 청구항', amendment: '보정서', opinion: '의견서', citation: '인용문헌' };
    function propose(field, value, basis, quote) {
      if (!value) return;
      out[field] = value;
      out.suggestions.push({ field, value, basis, quote: String(quote || '').slice(0, 240), verified: false });
    }
    function headingType(value, loose) {
      const t = value.replace(/[\s_\-()（）\[\]【】]/g, '');
      const patterns = [
        ['final-notice', /(?:최후의견제출통지서|최후거절이유통지서|최후통지서|의견제출통지서최후)/],
        ['registration-gazette', /(?:등록특허공보|등록실용신안공보|등록공보)/],
        ['publication', /(?:공개특허공보|공개실용신안공보|공개공보)/],
        ['rejection', /(?:특허)?거절결정서/], ['registration-decision', /(?:특허|등록)결정서/],
        ['office-action', /(?:의견제출통지서|거절이유통지서)/],
        ['amendment', /(?:명세서등)?보정서/], ['opinion', /의견서/],
        ['citation', /(?:인용문헌|인용발명)(?:원문)?/],
        ['claims', /(?:청구범위|청구항(?:전문|원문|전체|판본))/]
      ];
      for (const [type, re] of patterns) {
        const m = t.match(re); if (!m) continue;
        const tail = t.slice(m.index + m[0].length);
        if (loose || (m.index < 16 && (tail.length < 16 && !/(?:에서|에서는|에따라|에대한|의이유|을|를|입니다)/.test(tail)))) return type;
      }
      return '';
    }
    // A filename is an explicit user label. An actual document heading takes priority.
    const heading = lines.slice(0, 24).find(line => line.length < 100 && headingType(line, false));
    const inferredType = heading ? headingType(heading, false) : headingType(String(filename).slice(0, 500), true);
    if (inferredType) {
      propose('type', inferredType, heading ? '첫 쪽 문서 제목' : '파일명 추정', heading || filename);
      propose('title', labels[inferredType], heading ? '첫 쪽 문서 제목' : '파일명 추정', heading || filename);
      if (!heading) out.warnings.push('파일명으로 문서 종류를 제안했습니다. 첫 쪽 제목과 최후통지 여부를 확인해 주세요.');
    }
    if (out.type === 'office-action' && lines.slice(0, 28).some(line => /^(?:\[|【)?\s*(?:통지\s*구분\s*[:：]?\s*)?(?:최후\s*통지|최후\s*의견\s*제출\s*통지)(?:\s*[\]】])?$/.test(line))) {
      propose('type', 'final-notice', '첫 쪽 통지 구분', lines.slice(0, 28).find(line => /최후/.test(line)));
      out.title = labels['final-notice'];
    }
    const collect = (field, re, convert, basis) => {
      const matches = [...firstPage.matchAll(re)].map(m => ({ value: convert(m[1]), quote: m[0] })).filter(x => x.value);
      const unique = [...new Set(matches.map(x => x.value))];
      if (unique.length === 1) propose(field, unique[0], basis, matches[0].quote);
      else if (unique.length > 1) out.warnings.push(({ applicationNumber: '출원번호', date: '문서 일자', documentNumber: '문서번호' })[field] + '가 여러 개입니다. 문서의 첫 쪽에서 직접 선택해 주세요.');
    };
    collect('applicationNumber', /^(?:\s*(?:\(21\)|21[.)]|【|\[))?\s*출\s*원\s*(?:번\s*호|No\.?)[\s:：\]】]*((?:10|20)[\s-]*\d{4}[\s-]*\d{7})(?!\d)/gmi, v => v.replace(/\D/g, ''), '첫 쪽 출원번호 표기');
    collect('documentNumber', /^\s*(?:발\s*송|접\s*수|문\s*서)\s*번\s*호\s*[:：]?\s*([0-9][0-9-]{4,40})(?!\d)/gmi, v => v.replace(/\D/g, ''), '첫 쪽 발송·접수·문서번호 표기');
    collect('date', /^\s*(?:발\s*송\s*(?:일\s*자?|년\s*월\s*일)|통\s*지\s*일\s*자?|접\s*수\s*일\s*자?|결\s*정\s*일\s*자?|문\s*서\s*일\s*자?|기\s*준\s*일\s*자?)\s*[:：]?\s*((?:19|20)\d{2}\s*(?:[-./]|년)\s*\d{1,2}\s*(?:[-./]|월)\s*\d{1,2}\s*일?|(?:19|20)\d{6})(?!\d)/gmi, v => {
      const parts = v.match(/\d+/g); if (!parts) return '';
      const n = parts.length === 1 ? parts[0] : parts[0] + parts[1].padStart(2, '0') + parts[2].padStart(2, '0');
      if (!/^\d{8}$/.test(n)) return '';
      const y = Number(n.slice(0, 4)), m = Number(n.slice(4, 6)), d = Number(n.slice(6));
      const date = new Date(Date.UTC(y, m - 1, d));
      return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? n : '';
    }, '첫 쪽 문서 일자 표기');
    if (out.type === 'citation' && out.applicationNumber) out.warnings.push('인용문헌의 출원번호는 검토 사건의 출원번호와 다를 수 있습니다. 현재 사건 번호로 자동 적용하지 않습니다.');
    if (out.suggestions.length) out.warnings.push('자동 추정은 원문 확인을 대신하지 않습니다. 문서 식별자·판본·전체성은 심사관님이 별도로 확인해 주세요.');
    return out;
  }
  const digits = s => String(s || '').replace(/\D/g, '');
  const dateValue = s => digits(s).slice(0, 8);
  async function sha256(bytes) {
    if (!globalThis.crypto || !globalThis.crypto.subtle) fail('CRYPTO', '파일 무결성 검증을 위해 최신 브라우저에서 실행해 주세요.');
    return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))).map(x => x.toString(16).padStart(2, '0')).join('');
  }
  function safePDFURL(url) {
    let u;
    try { u = new URL(url); } catch (_) { fail('PDF_URL', 'PDF 주소가 올바르지 않습니다.'); }
    if (u.hostname !== 'plus.kipris.or.kr' || u.username || u.password || (u.port && u.port !== '443')) fail('PDF_HOST', '검증되지 않은 호스트의 PDF를 다운로드하지 않았습니다.');
    u.protocol = 'https:'; u.hash = '';
    return u.href;
  }
  async function downloadPDF(row, meta, s, options) {
    const raw = row.filePath || row.path;
    if (!raw) fail('PDF_MISSING', 'PDF 다운로드 경로가 없습니다.');
    const url = safePDFURL(raw);
    const bytes = await request(s, url, { ...options, binary: true, relayPath: '/api/pdf', relayBody: { url } });
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-' || bytes.length < 20) fail('PDF_FORMAT', '다운로드한 파일이 유효한 PDF 형식이 아닙니다.');
    return { ...meta, filename: meta.id + '.pdf', bytes, byteLength: bytes.byteLength,
      sha256: await sha256(bytes), verifiedPdf: true, identityVerified: false, pageCount: null,
      text: '', source: 'kipris', verification: 'PDF 서명·바이트·SHA-256 확인. 첫 쪽 식별자·쪽수는 원문 검토 필요.' };
  }
  function cleanText(text) { return decodeEntities(text).replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]+>/g, '').trim(); }
  function reconstructClaims(history, details) {
    const versions = [], problems = [], claims = new Map();
    const ordered = [...history].sort((a, b) => dateValue(a.receiptSendDate).localeCompare(dateValue(b.receiptSendDate)) || Number(a.receiptSendSerialNumber) - Number(b.receiptSendSerialNumber));
    let hasInitial = false;
    for (const step of ordered) {
      const key = step.receiptSendSerialNumber;
      const rows = details.filter(x => x.receiptSendSerialNumber === key);
      const errors = [], seen = new Set();
      if (!rows.length) errors.push('이 단계의 청구항 변경 상세가 없습니다.');
      if (!versions.length && rows.length && rows.every(x => /신규/.test(x.changeTypeName)) && /출원|국내서면|국내단계|번역문/.test(step.receiptSendDocumentName || '') && !/보정/.test(step.receiptSendDocumentName || '')) hasInitial = true;
      for (const x of rows) {
        const number = Number(digits(x.petitionclauseNumber));
        if (!number || seen.has(number)) { errors.push('누락 또는 중복 청구항 번호'); continue; }
        seen.add(number);
        const change = x.changeTypeName || '', text = cleanText(x.petitionclause || '');
        if (/삭제/.test(change)) { if (!claims.has(number)) errors.push('삭제 대상의 이전 원문 미확보'); claims.delete(number); }
        else if (/신규|수정/.test(change)) {
          if (/수정/.test(change) && !claims.has(number)) errors.push('수정 대상의 이전 원문 미확보');
          if (/신규/.test(change) && claims.has(number)) errors.push('신규 청구항 번호가 기존 청구항과 중복');
          if (!text) errors.push('청구항 문언 누락'); else claims.set(number, { number, text });
        } else errors.push('확인되지 않은 변경 유형');
      }
      if (!versions.length && hasInitial) { const numbers = [...claims.keys()].sort((a, b) => a - b); if (numbers.some((n, i) => n !== i + 1)) errors.push('최초 청구항 번호 누락'); }
      if (!versions.length && !hasInitial) errors.push('최초 출원 또는 국내단계 판본을 확인하지 못함');
      problems.push(...errors);
      versions.push({ id: 'claims-' + (key || versions.length + 1), date: dateValue(step.receiptSendDate),
        receiptNumber: step.receiptSendNumber || '', serialNumber: key || '', title: step.receiptSendDocumentName || '',
        claims: Array.from(claims.values()).sort((a, b) => a.number - b.number),
        complete: hasInitial && problems.length === 0, issues: [...new Set(problems)], historyMatched: false,
        source: '청구항 변동 이력 API', verifiedAgainstNotice: false });
    }
    const used = new Set(ordered.map(x => x.receiptSendSerialNumber));
    if (details.some(x => !used.has(x.receiptSendSerialNumber))) problems.push('이력과 연결되지 않은 상세 응답');
    if (problems.length) versions.forEach(x => { x.complete = false; x.issues = [...new Set([...x.issues, ...problems])]; });
    return versions;
  }
  async function collectInternal(applicationNo, settings, options = {}) {
    const s = settingsOf(settings), applicationNumber = normalizeApplicationNumber(applicationNo);
    if (!String(s.kiprisKey || '').trim()) fail('KIPRIS_KEY', '설정에서 KIPRIS Plus API 키를 입력해 주세요.');
    const result = { applicationNumber, history: [], documents: [], claimVersions: [], metadata: [], registeredClaims: [], failures: [],
      completeness: { history: false, documents: false, claims: false, publication: false, registration: false, identity: false }, acquisition: {} };
    let retainedBytes = 0;
    const retainedLimit = 180 * 1024 * 1024;
    function retainDocument(doc) {
      const size = doc.bytes?.byteLength || 0;
      if (retainedBytes + size > retainedLimit || result.documents.length >= 150) {
        doc.bytes = null;
        progress('자료 수집', '사건의 원문 보관 한도에 도달했습니다. 확보된 자료는 유지합니다.');
        fail('CASE_MEMORY_LIMIT', '한 사건의 원문은 합계 180 MiB, 최대 150개까지 보관합니다. 현재 확보 범위로 검토하거나 사건을 나누어 주세요.');
      }
      result.documents.push(doc); retainedBytes += size;
    }
    const progress = (stage, message) => { if (options.onPartial) options.onPartial(result); if (options.onProgress) options.onProgress({ stage, message }); };
    async function attempt(stage, fn) {
      abortIfNeeded(options.signal); progress(stage, stage + ' 확인 중');
      try { return await fn(); } catch (e) {
        if (e.name === 'AbortError') throw e;
        result.failures.push({ stage, code: e.code || 'UNKNOWN', message: redact(e.message, [s.kiprisKey, s.llmKey]) });
        progress(stage, stage + ' 일부 확인 보류'); return null;
      }
    }
    const hist = await attempt('행정처리 이력', () => queryAll('history', applicationNumber, s, options, 'documentTitle'));
    if (hist) {
      result.history = hist.records.map((x, i) => ({ ...x, id: 'history-' + i, title: x.documentTitle || '', date: dateValue(x.documentDate), documentNumber: x.documentNumber || '', type: documentType(x.documentTitle || '') })).sort((a, b) => a.date.localeCompare(b.date));
      if (result.history.some(x => x.applicationNumber && digits(x.applicationNumber) !== applicationNumber)) fail('APPLICATION_MISMATCH', '다른 출원번호의 이력이 섞여 있습니다. 검토를 중지했습니다.');
      result.completeness.history = hist.complete && result.history.length > 0;
      result.acquisition.history = { pages: hist.pages, basis: hist.basis, count: result.history.length };
      if (!result.history.length) result.failures.push({ stage: '행정처리 이력', code: 'EMPTY_HISTORY', message: '이력이 비어 있습니다. 문서가 없다고 단정할 수 없습니다.' });
    }
    const meta = await attempt('출원·등록 정보', () => queryAll('metadata', applicationNumber, s, options, ['applicationNumber', 'registerNumber']));
    if (meta) result.metadata = meta.records.map(x => Object.fromEntries(Object.entries(x).filter(([k]) => !/path|url|key/i.test(k))));
    for (const [kind, types] of [['OP', ['office-action', 'final-notice']], ['RE', ['rejection']], ['RG', ['registration-decision']]]) {
      const expected = result.history.filter(x => types.includes(x.type));
      if (!expected.length && result.completeness.history) continue;
      const list = await attempt(kind + ' 원문 목록', () => queryAll(kind, applicationNumber, s, options, 'filePath'));
      if (!list) continue;
      const matched = new Set();
      for (let i = 0; i < list.records.length; i++) {
        const row = list.records[i], num = digits(row.sendNumber), event = expected.find(x => digits(x.documentNumber) === num && num);
        if (row.applicationNumber && digits(row.applicationNumber) !== applicationNumber) { result.failures.push({ stage: kind, code: 'APPLICATION_MISMATCH', message: '다른 출원의 PDF 응답을 제외했습니다.' }); continue; }
        if (!event) { result.failures.push({ stage: kind, code: 'SEND_NUMBER_UNMATCHED', message: '행정처리 이력의 발송번호와 연결되지 않는 원문은 검토 대상에서 보류했습니다.' }); continue; }
        if (matched.has(num)) { result.failures.push({ stage: kind, code: 'DUPLICATE_SEND_NUMBER', message: '같은 발송번호의 PDF가 중복되어 전체성을 확인할 수 없습니다.' }); continue; }
        const doc = await attempt(event.title, () => downloadPDF(row, { id: applicationNumber + '-' + kind + '-' + num, type: event.type, title: event.title, date: event.date, documentNumber: event.documentNumber, applicationNumber,
          retention: kind === 'RG' ? 'pending-official-correction' : 'retain' }, s, options));
        if (doc) { retainDocument(doc); matched.add(num); }
      }
      expected.filter(x => !matched.has(digits(x.documentNumber))).forEach(x => result.failures.push({ stage: x.title, code: 'DOCUMENT_MISSING', documentNumber: x.documentNumber, message: '이력에 있는 문서의 실제 PDF를 확보하지 못했습니다.' }));
    }
    const amendment = await attempt('청구항 변동 이력', () => queryAll('amendments', applicationNumber, s, options, 'receiptSendSerialNumber'));
    const detail = await attempt('청구항 변경 상세', () => queryAll('amendmentDetails', applicationNumber, s, options, 'petitionclauseNumber'));
    if (amendment && detail) {
      result.claimVersions = reconstructClaims(amendment.records, detail.records);
      for (const v of result.claimVersions) {
        v.historyMatched = result.history.some(x => digits(x.documentNumber) === digits(v.receiptNumber) && dateValue(x.documentDate) === v.date);
        // Initial application may not appear as a separate administrative event. It remains explicitly unverified.
      }
      const amendmentEvents = result.history.filter(x => x.type === 'amendment');
      const allMatched = amendmentEvents.every(x => result.claimVersions.some(v => digits(v.receiptNumber) === digits(x.documentNumber) && v.date === x.date));
      result.completeness.claims = result.claimVersions.length > 0 && result.claimVersions.every(x => x.complete) && allMatched;
      if (!result.completeness.claims) result.failures.push({ stage: '청구범위 판본', code: 'CLAIM_VERSION_INCOMPLETE', message: '최초 판본과 모든 보정을 충분히 대조하지 못했습니다. 청구항별 실체 판단을 보류해야 합니다.' });
    }
    const registered = result.history.some(x => x.type === 'registration-decision') || result.metadata.some(x => /등록/.test(x.registerStatus || x.registerStatusName || x.applicationStatus || '') || /^\d{9,13}$/.test(digits(x.registerNumber)));
    result.isRegistered = registered;
    for (const kind of ['publication', ...(registered ? ['registration'] : [])]) {
      const list = await attempt(kind === 'publication' ? '공개공보' : '등록공보', () => queryAll(kind, applicationNumber, s, options, 'path'));
      if (!list) continue;
      let count = 0;
      for (let i = 0; i < list.records.length; i++) {
        const row = list.records[i];
        const doc = await attempt(kind === 'publication' ? '공개공보 PDF' : '등록공보 PDF', () => downloadPDF(row, {
          id: applicationNumber + '-' + kind + '-' + (i + 1), type: kind === 'publication' ? 'publication' : 'registration-gazette',
          title: row.docName || (kind === 'publication' ? '공개공보' : '등록공보'), date: '', documentNumber: '', applicationNumber, retention: 'retain'
        }, s, options));
        if (doc) { retainDocument(doc); count++; }
      }
      result.completeness[kind] = count > 0 && count === list.records.length;
      if (!count) result.failures.push({ stage: kind, code: 'GAZETTE_MISSING', message: '공보 PDF를 확보하지 못했습니다. 해당 원문에 의존하는 판단은 보류합니다.' });
    }
    if (registered) {
      const claims = await attempt('등록청구항 텍스트', () => queryAll('claims', applicationNumber, s, options, 'claim'));
      if (claims) result.registeredClaims = claims.records.map((x, i) => {
        const text = cleanText(x.claim), written = text.match(/^\s*(?:【|\[)?\s*청구항\s*(\d+)/);
        const number = Number(digits(x.claimNumber || x.petitionclauseNumber || (written && written[1]) || '')) || null;
        return { number, ordinal: i + 1, text, source: '청구항 텍스트 API', verifiedAgainstGazette: false };
      });
    }
    const required = result.history.filter(x => ['office-action', 'final-notice', 'rejection', 'registration-decision'].includes(x.type));
    result.completeness.documents = result.completeness.history && required.every(x => result.documents.some(d => digits(d.documentNumber) === digits(x.documentNumber))) && !result.failures.some(x => ['DUPLICATE_SEND_NUMBER', 'SEND_NUMBER_UNMATCHED'].includes(x.code));
    progress('자료 수집', '원문 수집을 마쳤습니다. 첫 쪽 식별자·판본·인용문헌은 이어서 검증합니다.');
    return result;
  }
  async function collect(applicationNo, settings, options = {}) {
    let partialCase = null;
    try {
      return await collectInternal(applicationNo, settings, { ...options, onPartial(value) { partialCase = value; if (options.onPartial) options.onPartial(value); } });
    } catch (error) {
      if (partialCase) error.partialCase = partialCase;
      throw error;
    }
  }
  function bytesBase64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let b = ''; for (let i = 0; i < bytes.length; i += 8192) b += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(b);
  }
  function parseJSON(text) {
    const s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { return JSON.parse(s); } catch (_) { return null; }
  }
  async function jsonRequest(s, kind, payload, options = {}) {
    const url = endpointURL(s.llmBase, kind);
    const text = await request(s, url, { ...options, method: kind === 'models' ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(s.llmKey ? { Authorization: 'Bearer ' + s.llmKey } : {}) },
      body: kind === 'models' ? undefined : JSON.stringify(payload), relayPath: '/api/llm',
      relayBody: { url, key: s.llmKey || '', kind, payload, timeoutMs: s.timeoutMs, allowLocalLLM: ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname) } });
    let data; try { data = JSON.parse(text); } catch (_) { fail('LLM_JSON', 'LLM 서버의 응답이 JSON이 아닙니다. Base URL과 API 방식을 확인해 주세요.'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail('LLM_JSON', 'LLM 서버의 응답 구조가 올바르지 않습니다. Base URL과 API 방식을 확인해 주세요.');
    if (data.error) fail('LLM_REMOTE', 'LLM 서버가 오류를 반환했습니다. 모델 권한과 API 설정을 확인해 주세요.');
    return data;
  }
  async function callLLM(settings, options = {}) {
    const s = settingsOf(settings), { system = '', prompt = '', files = [], signal } = options;
    abortIfNeeded(signal);
    if (!['responses', 'chat'].includes(s.apiMode)) fail('API_MODE', 'Responses 또는 Chat Completions 방식을 선택해 주세요.');
    if (!String(s.model || '').trim()) fail('MODEL', '설정에서 사용할 모델 ID를 입력해 주세요.');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpointURL(s.llmBase, 'responses')).hostname);
    if (!s.llmKey && !local) fail('LLM_KEY', '설정에서 LLM API 키를 입력해 주세요.');
    const maxTokens = Number(s.maxTokens), output = Number(options.maxOutputTokens ?? s.outputTokens);
    if (!Number.isInteger(maxTokens) || maxTokens < 4096 || maxTokens > 2000000 || !Number.isInteger(output) || output < 256 || output > maxTokens - 1024) fail('TOKEN_SETTINGS', '전체 토큰 예산에는 입력과 출력 여유가 필요합니다. 출력 상한은 전체 예산보다 1,024 이상 작아야 합니다.');
    const totalBytes = files.reduce((n, f) => n + (f.bytes ? f.bytes.byteLength : 0), 0);
    if (totalBytes >= 50000000) fail('FILE_SIZE', '한 요청의 PDF 합계는 50 MB 미만이어야 합니다.');
    if (files.length && s.pdfInput === false) fail('PDF_DISABLED', '설정에서 PDF 원문 입력을 켜거나 검증한 문서 텍스트를 사용해 주세요.');
    if (files.some(f => !f.bytes || new TextDecoder().decode(f.bytes.subarray(0, 5)) !== '%PDF-')) fail('PDF_FORMAT', 'PDF 입력 형식을 확인하지 못했습니다.');
    const fparts = files.map(f => ({ type: 'input_file', filename: String(f.filename || 'document.pdf').replace(/[^a-zA-Z0-9_.가-힣-]/g, '_'), file_data: 'data:application/pdf;base64,' + bytesBase64(f.bytes), detail: 'high' }));
    const input = [{ role: 'user', content: [{ type: 'input_text', text: prompt }, ...fparts] }];
    const mode = s.apiMode === 'chat' ? 'chat' : 'responses';
    if (mode === 'chat' && s.tokenCounting === 'required') fail('TOKEN_COUNT_MODE', '정확한 입력 토큰 계산을 필수로 사용하려면 Responses 방식을 선택해 주세요. Chat 텍스트 입력에는 자동 예상치를 사용할 수 있습니다.');
    const countPayload = { model: s.model, instructions: system, input };
    const official = new URL(endpointURL(s.llmBase, 'responses')).hostname === 'api.openai.com';
    let inputTokens, tokenMethod;
    if (mode === 'responses' && (official || s.tokenCounting === 'required' || files.length > 0)) {
      const count = await jsonRequest(s, 'count', countPayload, { signal, fetcher: options.fetcher });
      if (!Number.isInteger(count.input_tokens) || count.input_tokens < 0) fail('TOKEN_COUNT', 'API가 검증 가능한 입력 토큰 수를 제공하지 않았습니다.');
      inputTokens = count.input_tokens; tokenMethod = 'server-exact';
    } else {
      if (files.length) fail('PDF_TOKEN_COUNT', 'PDF 토큰 예산 확인에는 Responses API와 입력 토큰 계산 기능이 필요합니다. 텍스트 입력 또는 지원 API를 사용해 주세요.');
      inputTokens = estimateTokens(JSON.stringify(countPayload)) + 512; tokenMethod = 'utf8-byte-upper-estimate';
    }
    if (inputTokens + output + 512 > maxTokens) fail('TOKEN_BUDGET', '현재 단계가 토큰 예산을 초과합니다. 문서를 나누거나 요약한 뒤 다시 실행해야 합니다.', { inputTokens, outputTokens: output, maxTokens, tokenMethod });
    let payload;
    if (mode === 'responses') payload = { model: s.model, instructions: system, input, max_output_tokens: output, store: false, truncation: 'disabled' };
    else {
      const field = s.chatTokenField === 'max_tokens' ? 'max_tokens' : 'max_completion_tokens';
      payload = { model: s.model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], [field]: output, stream: false };
    }
    const data = await jsonRequest(s, mode, payload, { signal, fetcher: options.fetcher });
    let text = '';
    if (mode === 'responses') {
      if (data.status === 'incomplete' && data.incomplete_details?.reason === 'max_output_tokens') fail('LLM_TRUNCATED', '출력·추론 토큰 상한으로 응답이 잘렸습니다. 검토 범위를 줄여 재시도하고, 단일 항목도 잘리면 보류합니다.', { reason: 'max_output_tokens', requestedOutputTokens: output, inputTokens, usage: data.usage || {} });
      if (data.status !== 'completed' || data.incomplete_details || data.error) fail('LLM_INCOMPLETE', 'LLM 응답이 완결되지 않았습니다. 잘린 응답을 반려사유 판정에 사용하지 않습니다.');
      const outputs = Array.isArray(data.output) ? data.output : [];
      if (outputs.some(o => o.status && o.status !== 'completed')) fail('LLM_INCOMPLETE', '일부 출력이 완료되지 않았습니다.');
      text = typeof data.output_text === 'string' ? data.output_text : outputs.flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text || '').join('\n');
      if (outputs.flatMap(o => o.content || []).some(c => c.type === 'refusal')) fail('LLM_REFUSAL', '모델이 이 요청에 응답하지 않았습니다. 자동 판정을 중지했습니다.');
    } else {
      const c = data.choices && data.choices[0];
      if (c?.finish_reason === 'length') fail('LLM_TRUNCATED', '출력 토큰 상한으로 응답이 잘렸습니다. 이 응답은 완료된 진단에 사용하지 않습니다.', { reason: 'length', requestedOutputTokens: output, inputTokens, usage: data.usage || {} });
      if (!c || c.finish_reason !== 'stop' || !c.message || c.message.refusal) fail('LLM_INCOMPLETE', 'LLM 응답이 정상적으로 완료되지 않았습니다. 출력 상한과 모델 설정을 확인해 주세요.');
      text = typeof c.message.content === 'string' ? c.message.content : '';
    }
    if (!text.trim()) fail('LLM_EMPTY', 'LLM의 본문 응답이 비어 있습니다. 판단 결과로 사용하지 않습니다.');
    return { text, json: parseJSON(text), usage: data.usage || {}, budget: { inputTokens, outputTokens: output, maxTokens, tokenMethod } };
  }
  async function testConnection(settings, options = {}) {
    const s = settingsOf(settings);
    const data = await jsonRequest(s, 'models', undefined, options);
    if (!Array.isArray(data.data) || data.data.some(x => !x || typeof x.id !== 'string' || !x.id.trim()))
      fail('LLM_MODELS', '모델 목록 형식의 응답을 확인하지 못했습니다. Base URL과 제공자의 /models 지원 여부를 확인해 주세요.');
    const models = data.data.map(x => x.id);
    return { connected: true, models, modelAvailable: s.model ? models.includes(s.model) : null,
      note: '모델 목록 연결 확인입니다. 실제 PDF·분석 호출 가능 여부는 별도입니다.' };
  }
  function probePDF() {
    // A valid one-page synthetic PDF. No user document or private data is used.
    const content = 'BT /F1 22 Tf 50 740 Td (QURI PDF CHECK 314159) Tj ET';
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream'];
    let out = '%PDF-1.4\n'; const offsets = [0];
    objects.forEach((body, i) => { offsets.push(out.length); out += (i + 1) + ' 0 obj\n' + body + '\nendobj\n'; });
    const xref = out.length; out += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(x => String(x).padStart(10, '0') + ' 00000 n \n').join('');
    out += 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
    return utf8(out);
  }
  async function testGeneration(settings, { pdf = false, ...options } = {}) {
    const s = settingsOf(settings);
    if (pdf && s.apiMode !== 'responses') fail('PDF_MODE', 'PDF 판독 확인에는 Responses 방식을 선택해 주세요.');
    const result = await callLLM(s, { ...options, system: 'Return only the requested JSON. Do not add explanations.',
      prompt: pdf ? 'Read the attached one-page PDF. Return only {"marker":"the exact visible line of text"}.' : 'Return exactly {"marker":"QURI TEXT CHECK 271828"}.',
      files: pdf ? [{ filename: 'QURI_synthetic_connection_check.pdf', bytes: probePDF() }] : [],
      maxOutputTokens: Math.min(s.outputTokens, 8192) });
    const expected = pdf ? 'QURI PDF CHECK 314159' : 'QURI TEXT CHECK 271828';
    if (result.json?.marker !== expected) fail('CAPABILITY_CHECK', '연결은 되었지만 합성 점검 문구를 정확히 읽지 못했습니다. 실제 원문 진단 전에 모델과 API 지원 기능을 확인해 주세요.');
    return { connected: true, kind: pdf ? 'pdf' : 'text', usage: result.usage,
      note: (pdf ? '합성 1쪽 PDF의 문구·입력 토큰 계산·응답을 확인했습니다.' : '합성 텍스트의 실제 생성 응답을 확인했습니다.') + ' 실제 업무 문서의 한글·표·수식 정확성은 각 원문에서 확인해야 합니다.' };
  }
  async function testKipris(applicationNo, settings, options = {}) {
    const s = settingsOf(settings), applicationNumber = normalizeApplicationNumber(applicationNo);
    if (!String(s.kiprisKey || '').trim()) fail('KIPRIS_KEY', 'KIPRIS Plus API 키를 입력해 주세요.');
    const history = await queryAll('history', applicationNumber, s, options, 'documentTitle');
    return { connected: true, applicationNumber, historyCount: history.records.length,
      historyComplete: history.complete && history.records.length > 0,
      note: '행정처리 이력 상품 연결만 확인했습니다. 원문 PDF·청구항 상품 권한은 각각 확인해야 합니다.' };
  }
  function parseCitedIdentifier(value) {
    const obj = value && typeof value === 'object' ? value : { identifier: String(value || '') };
    const raw = String(obj.identifier || obj.number || '').trim();
    const text = raw.toUpperCase().replace(/\s+/g, '').replace(/^대한민국/, 'KR');
    const country = String(obj.country || (/^[A-Z]{2}/.test(text) ? text.slice(0, 2) : '')).toUpperCase();
    if (country && country !== 'KR') return { supported: false, reason: '해외 인용문헌은 이 배포판에서 공식 원문 자동 조회 경로가 검증되지 않았습니다. 발행기관 원문 PDF를 추가해 주세요.', raw };
    const suffix = String(obj.kindCode || ((text.match(/([ABU][12]?)$/) || [])[1]) || '').toUpperCase();
    const numericPart = text.replace(/^KR/, '').replace(/[ABU][12]?$/, '').replace(/-/g, '');
    if (!/^\d+$/.test(numericPart)) return { supported: false, reason: '인용문헌의 국가·번호·종류코드를 먼저 확인해 주세요.', raw };
    if (/^[AU]/.test(suffix) && /^\d{13}$/.test(numericPart)) return { supported: true, raw, number: numericPart, kindCode: suffix, selector: 'openNumber', gazette: 'publication' };
    if (/^B/.test(suffix) && /^\d{9}(?:0000)?$/.test(numericPart)) return { supported: true, raw, number: numericPart.length === 9 ? numericPart + '0000' : numericPart, kindCode: suffix, selector: 'registerNumber', gazette: 'registration' };
    // Accept explicit field selection from a user-confirmed bibliography, never infer it from 13 digits alone.
    if (['openNumber', 'publicationNumber', 'registerNumber'].includes(obj.selector) && /^\d{13}$/.test(numericPart)) return { supported: true, raw, number: numericPart, kindCode: suffix, selector: obj.selector, gazette: obj.selector === 'openNumber' ? 'publication' : 'registration' };
    return { supported: false, reason: '출원번호와 공개·등록번호를 구별할 종류코드가 필요합니다. KR 번호와 A/B/U 코드 또는 원문 PDF를 추가해 주세요.', raw };
  }
  async function collectCitedOriginal(identifier, settings, options = {}) {
    const parsed = parseCitedIdentifier(identifier), s = settingsOf(settings);
    const result = { identifier: parsed.raw, attempted: false, documents: [], failures: [], metadata: [], source: 'KIPRIS Plus 공식 공보' };
    if (!parsed.supported) { result.failures.push({ code: 'CITATION_ROUTE_UNVERIFIED', message: parsed.reason, attempted: false }); return result; }
    if (!String(s.kiprisKey || '').trim()) { result.failures.push({ code: 'KIPRIS_KEY', message: '인용문헌 조회에 KIPRIS Plus 키가 필요합니다.', attempted: false }); return result; }
    try {
      result.attempted = true;
      const search = await queryAll('citedSearch', '', s, { ...options, searchParams: { [parsed.selector]: parsed.number } }, 'applicationNumber');
      const matches = search.records.filter(x => digits(x[parsed.selector]) === parsed.number && /^\d{13}$/.test(digits(x.applicationNumber)));
      const apps = [...new Set(matches.map(x => digits(x.applicationNumber)))];
      if (apps.length !== 1) fail('CITATION_IDENTITY', '인용번호와 정확히 일치하는 하나의 출원을 확인하지 못했습니다. 원문을 추가해 주세요.');
      result.metadata = matches.map(x => ({ applicationNumber: x.applicationNumber, openNumber: x.openNumber || '', publicationNumber: x.publicationNumber || '', registerNumber: x.registerNumber || '', inventionTitle: x.inventionTitle || '' }));
      const appNo = apps[0], pdfs = await queryAll(parsed.gazette, appNo, s, options, 'path');
      let citationBytes = 0;
      for (let i = 0; i < pdfs.records.length; i++) {
        if (result.documents.length >= 150) fail('CASE_MEMORY_LIMIT', '인용문헌 수집 건수가 보관 한도를 초과했습니다.');
        const doc = await downloadPDF(pdfs.records[i], { id: 'cited-KR-' + parsed.number + '-' + (i + 1), type: 'citation', title: parsed.raw,
          date: '', documentNumber: '', applicationNumber: appNo, citationIdentifier: parsed.raw, citationNumber: parsed.number,
          citationKind: parsed.kindCode, citationSelector: parsed.selector, retention: 'retain' }, s, options);
        citationBytes += doc.bytes?.byteLength || 0;
        if (citationBytes > 180 * 1024 * 1024) { doc.bytes = null; fail('CASE_MEMORY_LIMIT', '인용문헌 원문 합계가 180 MiB를 초과하여 추가 수집을 중지했습니다.'); }
        result.documents.push(doc);
      }
      if (!result.documents.length) fail('CITATION_PDF_MISSING', '공보 목록에서 실제 인용문헌 PDF를 확보하지 못했습니다.');
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      result.failures.push({ code: e.code || 'CITATION_FAILED', message: redact(e.message, [s.kiprisKey, s.llmKey]), attempted: result.attempted });
    }
    return result;
  }
  return { defaults, PATHS, ReviewAPIError, normalizeApplicationNumber, estimateTokens, endpointURL, parseXML, documentType, suggestDocumentMetadata,
    reconstructClaims, collect, collectCitedOriginal, parseCitedIdentifier, callLLM, testConnection, testGeneration, testKipris, sha256, bytesBase64, redact, safePDFURL, parseJSON, usesRelay, runtimeInfo,
    _queryAll: queryAll, _resetSession() { sessionToken = null; } };
});
