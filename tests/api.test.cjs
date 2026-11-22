'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const API = require('../js/api.js');
const Relay = require('../server.js');
const settings = { connectionMode: 'direct', llmKey: 'synthetic-test-key', model: 'test-model', llmBase: 'https://api.openai.com/v1', maxTokens: 50000, outputTokens: 8192 };
function response(data, status = 200) { return new Response(typeof data === 'string' ? data : JSON.stringify(data), { status }); }
function completed(text = '{"ok":true}') { return { status: 'completed', output: [{ status: 'completed', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 300, output_tokens: 20 } }; }
test('application number accepts formatting but rejects contamination', () => {
  assert.equal(API.normalizeApplicationNumber('10-2021-0126226'), '1020210126226');
  assert.throws(() => API.normalizeApplicationNumber('1020210126226abc'), { code: 'APPLICATION_NUMBER' });
  assert.throws(() => API.normalizeApplicationNumber('123'), { code: 'APPLICATION_NUMBER' });
});
test('endpoint adaptation preserves a configured path, avoids duplicated endpoints, never invents a model endpoint', () => {
  assert.equal(API.endpointURL('https://api.openai.com/v1/responses', 'chat'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(API.endpointURL('https://provider.example/custom/v1/', 'count'), 'https://provider.example/custom/v1/responses/input_tokens');
  assert.equal(API.endpointURL('http://127.0.0.1:11434/v1', 'responses'), 'http://127.0.0.1:11434/v1/responses');
  assert.throws(() => API.endpointURL('http://provider.example/v1', 'chat'), { code: 'HTTPS_REQUIRED' });
  assert.throws(() => API.endpointURL('https://provider.example/v1?api_key=synthetic', 'chat'), { code: 'BASE_URL' });
});
test('XML rejects DTD, malformed documents and explicit API errors', () => {
  assert.throws(() => API.parseXML('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///x">]><a/>'), { code: 'XML_DTD' });
  assert.throws(() => API.parseXML('<a><b></a>'), { code: 'XML_FORMAT' });
  assert.throws(() => API.parseXML('<r><resultCode>101</resultCode><resultMsg>key-test</resultMsg></r>'), { code: 'KIPRIS_101' });
});
test('XML parses repeated records, namespace, CDATA and encoded markup', () => {
  const xml = '<ns:r><resultCode>00</resultCode><items><item><documentTitle>의견제출통지서</documentTitle><documentNumber>123</documentNumber></item><item><documentTitle><![CDATA[최후통지]]></documentTitle><documentNumber>456</documentNumber></item></items></ns:r>';
  const x = API.parseXML(xml); assert.equal(x.records('documentTitle').length, 2); assert.equal(x.records('documentTitle')[1].documentNumber, '456');
});
test('pagination reads every page and detects a repeated response', async () => {
  const xml = n => '<r><totalCount>2</totalCount><pageNo>' + n + '</pageNo><numOfRows>1</numOfRows><item><documentTitle>T' + n + '</documentTitle></item></r>';
  let calls = 0;
  const s = { ...API.defaults, connectionMode: 'direct', kiprisKey: 'test', fetcher: async () => response(xml(++calls)) };
  const data = await API._queryAll('history', '1020210126226', s, {}, 'documentTitle');
  assert.equal(calls, 2); assert.equal(data.records.length, 2); assert.equal(data.complete, true);
  await assert.rejects(API._queryAll('history', '1020210126226', { ...s, fetcher: async () => response(xml(1)) }, {}, 'documentTitle'), { code: 'PAGINATION' });
});
test('claim reconstruction keeps earlier unchanged claims and does not retroactively apply later amendments', () => {
  const h = [{ receiptSendSerialNumber: '1', receiptSendDate: '20210101', receiptSendDocumentName: '특허출원서' }, { receiptSendSerialNumber: '2', receiptSendDate: '20220101', receiptSendDocumentName: '명세서등 보정서' }];
  const d = [{ receiptSendSerialNumber: '1', petitionclauseNumber: '1', changeTypeName: '신규', petitionclause: 'old A' }, { receiptSendSerialNumber: '1', petitionclauseNumber: '2', changeTypeName: '신규', petitionclause: 'B' }, { receiptSendSerialNumber: '2', petitionclauseNumber: '1', changeTypeName: '수정', petitionclause: 'new A' }];
  const versions = API.reconstructClaims(h, d);
  assert.equal(versions[0].claims[0].text, 'old A'); assert.equal(versions[1].claims[0].text, 'new A'); assert.equal(versions[1].claims[1].text, 'B'); assert.equal(versions[1].complete, true);
});
test('claim reconstruction fails closed when initial text or update type is unknown', () => {
  const v = API.reconstructClaims([{ receiptSendSerialNumber: '1', receiptSendDate: '20220101' }], [{ receiptSendSerialNumber: '1', petitionclauseNumber: '1', changeTypeName: '수정', petitionclause: 'unknown predecessor' }]);
  assert.equal(v[0].complete, false);
});
test('Responses uses exact count before generation and correct output parameter', async () => {
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, payload: JSON.parse(init.body) }); return response(url.endsWith('input_tokens') ? { input_tokens: 1000 } : completed()); };
  const r = await API.callLLM(settings, { system: 'rules', prompt: 'case', fetcher });
  assert.equal(calls.length, 2); assert.equal(calls[0].url, 'https://api.openai.com/v1/responses/input_tokens');
  assert.equal(calls[1].payload.max_output_tokens, 8192); assert.equal(calls[1].payload.max_tokens, undefined);
  assert.equal(calls[1].payload.store, false); assert.equal(calls[1].payload.truncation, 'disabled');
  assert.deepEqual(r.json, { ok: true }); assert.equal(r.budget.tokenMethod, 'server-exact');
});
test('50k includes input, reserved output and safety margin; oversize request never generates', async () => {
  let n = 0;
  await assert.rejects(API.callLLM(settings, { prompt: 'case', fetcher: async () => { n++; return response({ input_tokens: 45000 }); } }), { code: 'TOKEN_BUDGET' });
  assert.equal(n, 1);
});
test('failed token count never falls back to a guessed PDF budget', async () => {
  let n = 0;
  const bytes = new TextEncoder().encode('%PDF-1.7\nsynthetic-test-only');
  await assert.rejects(API.callLLM(settings, { prompt: 'extract', files: [{ filename: 'test.pdf', bytes }], fetcher: async () => { n++; return response({}, 404); } }), { code: 'HTTP_404' });
  assert.equal(n, 1);
});
test('PDF uses proper Responses input_file shape in token count and create', async () => {
  const calls = []; const bytes = new TextEncoder().encode('%PDF-1.7\nsynthetic-test-only');
  await API.callLLM(settings, { prompt: 'extract', files: [{ filename: 'test.pdf', bytes }], fetcher: async (url, init) => { calls.push(JSON.parse(init.body)); return response(url.endsWith('input_tokens') ? { input_tokens: 4000 } : completed()); } });
  for (const c of calls) { const f = c.input[0].content[1]; assert.equal(f.type, 'input_file'); assert.equal(f.detail, 'high'); assert.ok(f.file_data.startsWith('data:application/pdf;base64,')); }
});
test('Chat uses a separate shape and max_completion_tokens, text estimate stays under budget', async () => {
  let payload;
  const r = await API.callLLM({ ...settings, apiMode: 'chat' }, { system: 'rules', prompt: 'case', fetcher: async (_url, init) => { payload = JSON.parse(init.body); return response({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }); } });
  assert.equal(payload.max_completion_tokens, 8192); assert.equal(payload.max_output_tokens, undefined); assert.equal(payload.messages[0].role, 'system'); assert.equal(r.budget.tokenMethod, 'utf8-byte-upper-estimate');
});
test('required exact token counting is not silently ignored in Chat mode', async () => {
  let n = 0;
  await assert.rejects(API.callLLM({ ...settings, apiMode: 'chat', tokenCounting: 'required' }, { prompt: 'x', fetcher: async () => { n++; return response({}); } }), { code: 'TOKEN_COUNT_MODE' });
  assert.equal(n, 0);
});
test('a configured direct KIPRIS prefix is honored and relay never silently substitutes another base', async () => {
  let address;
  await API.testKipris('1020210126226', { kiprisBase: 'https://proxy.example/kipris', kiprisKey: 'fixture', connectionMode: 'direct', fetcher: async url => { address = url; return response('<r><item><documentTitle>원문 목록</documentTitle></item></r>'); } });
  assert.equal(new URL(address).pathname, '/kipris/openapi/rest/RelatedDocsonfilePatService/relatedDocsonfileInfo');
  await assert.rejects(API.testKipris('1020210126226', { kiprisBase: 'https://proxy.example/kipris', kiprisKey: 'fixture', connectionMode: 'relay' }), { code: 'KIPRIS_BASE' });
});
test('both endpoint modes reject truncated or refused output', async () => {
  await assert.rejects(API.callLLM(settings, { prompt: 'x', fetcher: async url => response(url.endsWith('input_tokens') ? { input_tokens: 100 } : { status: 'incomplete', output: [] }) }), { code: 'LLM_INCOMPLETE' });
  await assert.rejects(API.callLLM({ ...settings, apiMode: 'chat' }, { prompt: 'x', fetcher: async () => response({ choices: [{ finish_reason: 'length', message: { content: '{' } }] }) }), { code: 'LLM_TRUNCATED' });
});
test('remote error bodies never expose keys or signed URLs', async () => {
  await assert.rejects(API.callLLM(settings, { prompt: 'x', fetcher: async () => response('key synthetic-test-key https://signed.example/secret', 403) }), e => !e.message.includes('synthetic-test-key') && !e.message.includes('signed.example'));
});
test('network failures remain collection failures, never a complete no-document result', async () => {
  const r = await API.collect('1020210126226', { ...settings, kiprisKey: 'test', fetcher: async () => { throw new Error('synthetic key'); } });
  assert.equal(r.completeness.history, false); assert.equal(r.completeness.documents, false); assert.ok(r.failures.length > 0); assert.equal(r.documents.length, 0);
});
test('cancellation exposes already acquired history for the UI to retain', async () => {
  const controller = new AbortController(); let n = 0;
  await assert.rejects(API.collect('1020210126226', { ...settings, kiprisKey: 'test', fetcher: async () => { n++; return response('<r><item><documentTitle>의견제출통지서</documentTitle><documentNumber>123</documentNumber><documentDate>20220101</documentDate></item></r>'); } }, { signal: controller.signal, onProgress: e => { if (e.stage === '출원·등록 정보') controller.abort(); } }), error => {
    assert.equal(error.name, 'AbortError'); assert.equal(error.partialCase.history.length, 1); assert.equal(error.partialCase.history[0].documentNumber, '123'); return true;
  });
  assert.equal(n, 1);
});
test('PDF downloads use HTTPS official host only', () => {
  assert.equal(API.safePDFURL('http://plus.kipris.or.kr/a.pdf'), 'https://plus.kipris.or.kr/a.pdf');
  assert.throws(() => API.safePDFURL('https://evil.example/a.pdf'), { code: 'PDF_HOST' });
});
test('citation parser distinguishes publication, registration and application number', () => {
  assert.deepEqual(API.parseCitedIdentifier('KR 10-2020-0012345 A1').selector, 'openNumber');
  assert.equal(API.parseCitedIdentifier('KR102123456B1').number, '1021234560000');
  assert.equal(API.parseCitedIdentifier('1020200012345').supported, false);
  assert.equal(API.parseCitedIdentifier('US20201234567A1').supported, false);
  assert.equal(API.parseCitedIdentifier('https://evil.example/10-2020-0012345').supported, false);
});
test('cited original is downloaded using matched actual application number, never the publication number', async () => {
  const calls = [];
  const citationNo = '1020200012345', actualApp = '1020180098765';
  const result = await API.collectCitedOriginal('KR 10-2020-0012345 A1', { ...settings, kiprisKey: 'test', fetcher: async url => {
    const u = new URL(url); calls.push(u);
    if (u.pathname.endsWith('getAdvancedSearch')) return response('<r><totalCount>1</totalCount><item><openNumber>' + citationNo + '</openNumber><applicationNumber>' + actualApp + '</applicationNumber></item></r>');
    if (u.pathname.endsWith('getPubFullTextInfoSearch')) return response('<r><item><path>http://plus.kipris.or.kr/synthetic.pdf</path><docName>인용공보</docName></item></r>');
    return new Response(new TextEncoder().encode('%PDF-1.7\nfixture only not a legal document'));
  } });
  assert.equal(result.attempted, true); assert.equal(result.failures.length, 0); assert.equal(result.documents.length, 1);
  assert.equal(calls[0].searchParams.get('openNumber'), citationNo); assert.equal(calls[1].searchParams.get('applicationNumber'), actualApp);
  assert.equal(result.documents[0].applicationNumber, actualApp); assert.equal(result.documents[0].identityVerified, false); assert.equal(result.documents[0].citationNumber, citationNo);
  assert.ok(!JSON.stringify(result).includes('synthetic.pdf'));
});
test('cited original with unsupported country is accurately reported as not attempted', async () => {
  let calls = 0;
  const r = await API.collectCitedOriginal('US20200123456A1', { ...settings, kiprisKey: 'test', fetcher: async () => { calls++; throw new Error(); } });
  assert.equal(r.attempted, false); assert.equal(r.failures[0].attempted, false); assert.equal(calls, 0);
});
test('relay rejects private, loopback, metadata and reserved public-target addresses', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.1.1', '192.168.0.1', '100.64.0.1', '198.18.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) assert.equal(Relay.publicAddress(ip), false, ip);
  assert.equal(Relay.publicAddress('8.8.8.8'), true); assert.equal(Relay.publicAddress('2606:4700:4700::1111'), true);
});
test('relay pins resolved addresses and rejects mixed-public/private DNS before network', async () => {
  await assert.rejects(Relay.safeRequest('https://public.example/v1/responses', { kind: 'llm', lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] }), { code: 'PRIVATE_TARGET' });
});
test('relay target validation distinguishes local opt-in and disallows generic proxy paths', () => {
  assert.throws(() => Relay.validateTarget('http://127.0.0.1:11434/v1/responses', 'llm', false), { code: 'LOCAL_LLM' });
  assert.equal(Relay.validateTarget('http://127.0.0.1:11434/v1/responses', 'llm', true).local, true);
  assert.throws(() => Relay.validateTarget('https://public.example/admin', 'llm', false), { code: 'TARGET_PATH' });
  assert.throws(() => Relay.validateTarget('https://public.example/a.pdf', 'pdf', false), { code: 'TARGET_HOST' });
});
test('live loopback relay enforces token, Origin, Host and no external CORS access', async t => {
  const calls = [];
  const server = Relay.createServer({ requestRemote: async (url, opts) => { calls.push({ url, opts }); return { status: 200, bytes: Buffer.from('{"data":[]}') }; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  let r = await fetch(base + '/api/session'); const { token } = await r.json(); assert.equal(typeof token, 'string'); assert.equal(r.headers.get('access-control-allow-origin'), null);
  const body = JSON.stringify({ kind: 'models', url: 'https://api.openai.com/v1/models', key: 'fixture-key' });
  r = await fetch(base + '/api/llm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }); assert.equal(r.status, 403);
  r = await fetch(base + '/api/llm', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Review-Token': token, Origin: 'https://evil.example' }, body }); assert.equal(r.status, 403);
  const hostStatus = await new Promise((resolve, reject) => { require('node:http').get(base + '/api/session', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject); }); assert.equal(hostStatus, 403);
  r = await fetch(base + '/api/llm', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Review-Token': token, Origin: base }, body }); assert.equal(r.status, 200);
  assert.equal(calls.length, 1); assert.equal(calls[0].opts.headers.Authorization, 'Bearer fixture-key');
});
test('relay validates KIPRIS operation parameters and keeps selector fields distinct', async t => {
  const seen = [];
  const server = Relay.createServer({ requestRemote: async (url, options) => { seen.push({ url: new URL(url), options }); return { status: 200, bytes: Buffer.from('<r/>') }; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port, { token } = await (await fetch(base + '/api/session')).json();
  const headers = { 'Content-Type': 'application/json', 'X-Review-Token': token };
  let r = await fetch(base + '/api/kipris', { method: 'POST', headers, body: JSON.stringify({ path: API.PATHS.citedSearch, key: 'fixture-key', params: { openNumber: '1020200012345', pageNo: 1, numOfRows: 100 } }) });
  assert.equal(r.status, 200); assert.equal(seen[0].url.searchParams.get('openNumber'), '1020200012345'); assert.equal(seen[0].url.searchParams.has('applicationNumber'), false); assert.equal(seen[0].url.searchParams.get('ServiceKey'), 'fixture-key');
  r = await fetch(base + '/api/kipris', { method: 'POST', headers, body: JSON.stringify({ path: API.PATHS.citedSearch, key: 'fixture-key', params: { openNumber: '1020200012345', registerNumber: '1021234560000', pageNo: 1, numOfRows: 100 } }) }); assert.equal(r.status, 400);
  r = await fetch(base + '/api/pdf', { method: 'POST', headers, body: JSON.stringify({ url: 'http://169.254.169.254/meta' }) }); assert.equal(r.status, 502);
  assert.equal(seen.length, 1);
});
test('browser adapter → relay → actual local model completes count and generation without third-party code', async t => {
  const calls = [];
  const model = require('node:http').createServer(async (req, res) => {
    const chunks = []; for await (const b of req) chunks.push(b);
    calls.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.url.endsWith('input_tokens') ? { input_tokens: 200 } : completed('{"integration":true}')));
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const relay = Relay.createServer(); await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
  t.after(async () => { API._resetSession(); await Promise.all([new Promise(resolve => relay.close(resolve)), new Promise(resolve => model.close(resolve))]); });
  API._resetSession();
  const base = 'http://127.0.0.1:' + relay.address().port;
  const r = await API.callLLM({ ...settings, connectionMode: 'relay', tokenCounting: 'required', llmBase: 'http://127.0.0.1:' + model.address().port + '/v1' }, { prompt: 'safe fixture', fetcher: (url, init) => fetch(new URL(url, base), init) });
  assert.equal(r.json.integration, true); assert.equal(calls.length, 2); assert.equal(calls[0].path, '/v1/responses/input_tokens'); assert.equal(calls[1].path, '/v1/responses'); assert.equal(calls[1].body.max_output_tokens, 8192); assert.equal(calls[1].authorization, 'Bearer synthetic-test-key');
});
