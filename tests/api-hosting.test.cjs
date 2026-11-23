'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const API = require('../js/api.js');
const source = fs.readFileSync(path.join(__dirname, '../js/api.js'), 'utf8');
const settings = { llmBase: 'https://model.example/v1', llmKey: 'synthetic-hosting-test-key', model: 'fixture-model' };
const session = { token: 'a'.repeat(64), runtime: 'node-builtins', version: '3.0.0' };
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

function at(url) {
  const context = vm.createContext({ module: { exports: {} }, location: new URL(url), URL,
    TextEncoder, TextDecoder, AbortController, DOMException, Uint8Array, setTimeout, clearTimeout });
  vm.runInContext(source, context);
  return context.module.exports;
}

test('public root, project subpath, and local-file pages use direct API requests automatically', async () => {
  for (const url of ['https://aireviewer.moip.ai.kr/', 'https://eqai-moip.github.io/AI_Reviewer/', 'file:///app/index.html']) {
    const api = at(url), calls = [];
    assert.equal(api.runtimeInfo().canUseRelay, false);
    const result = await api.testConnection(settings, { fetcher: async (target, init) => {
      calls.push({ target, init }); return response({ data: [{ id: 'fixture-model' }] });
    } });
    assert.equal(result.modelAvailable, true); assert.equal(calls.length, 1);
    assert.equal(calls[0].target, 'https://model.example/v1/models');
    assert.equal(calls[0].init.credentials, 'omit');
    assert.equal(calls[0].init.redirect, 'error');
    assert.equal(calls[0].init.referrerPolicy, 'no-referrer');
  }
});

test('explicit relay on a hosted or file page is rejected before any key or document is transmitted', async () => {
  for (const url of ['https://eqai-moip.github.io/AI_Reviewer/', 'file:///app/index.html']) {
    const api = at(url); let calls = 0;
    await assert.rejects(api.callLLM({ ...settings, connectionMode: 'relay' }, {
      prompt: 'synthetic document', fetcher: async () => { calls++; return response(session); }
    }), e => e.code === 'RELAY_UNAVAILABLE' && !e.message.includes(settings.llmKey));
    assert.equal(calls, 0);
  }
});

test('loopback helper handshake and relay are selected automatically, and a completed session is reused', async () => {
  const api = at('http://127.0.0.1:8765/'), calls = [];
  assert.equal(api.runtimeInfo().mode, 'local');
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url === '/api/session') return response(session);
    assert.equal(init.headers['X-Review-Token'], session.token);
    assert.equal(init.redirect, 'error');
    return response({ data: [] });
  };
  await api.testConnection(settings, { fetcher }); await api.testConnection(settings, { fetcher });
  assert.deepEqual(calls.map(x => x.url), ['/api/session', '/api/llm', '/api/llm']);
});

test('stopping during the helper handshake cancels promptly and does not send a relay request', async () => {
  const api = at('http://localhost:8765/'), controller = new AbortController();
  const calls = []; let started;
  const ready = new Promise(resolve => { started = resolve; });
  const pending = api.testConnection(settings, { signal: controller.signal, fetcher: (url, init) => {
    calls.push(url); started();
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  } });
  await ready; controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(calls, ['/api/session']);
  // The cancelled handshake must not poison the next attempt.
  const recovered = await api.testConnection(settings, { fetcher: async url => response(url === '/api/session' ? session : { data: [] }) });
  assert.equal(recovered.connected, true);
});

test('request timeout covers the helper handshake', async () => {
  const api = at('http://localhost:8765/'); let calls = 0;
  await assert.rejects(api.testConnection({ ...settings, timeoutMs: 20 }, { fetcher: (_url, init) => {
    calls++;
    return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  } }), { code: 'TIMEOUT' });
  assert.equal(calls, 1);
});

test('static localhost HTML is not accepted as an execution helper', async () => {
  const api = at('http://localhost:8080/'); let calls = 0;
  await assert.rejects(api.testConnection(settings, { fetcher: async () => {
    calls++; return new Response('<html>static fallback synthetic-hosting-test-key</html>');
  } }), e => e.code === 'RELAY_UNAVAILABLE' && !e.message.includes(settings.llmKey));
  assert.equal(calls, 1);
});

test('oversized session response is cancelled without posting credentials', async () => {
  const api = at('http://localhost:8765/'); let cancelled = false, calls = 0;
  const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4097)); }, cancel() { cancelled = true; } });
  await assert.rejects(api.testConnection(settings, { fetcher: async () => { calls++; return new Response(body); } }), { code: 'RESPONSE_SIZE' });
  assert.equal(cancelled, true); assert.equal(calls, 1);
});

test('a restarted helper invalidates the old token and reconnects on the next attempt', async () => {
  const api = at('http://localhost:8765/'); let handshakes = 0, relayCalls = 0;
  const fetcher = async url => {
    if (url === '/api/session') { handshakes++; return response(session); }
    if (++relayCalls === 2) return new Response('no private response body exposed', { status: 403 });
    return response({ data: [] });
  };
  await api.testConnection(settings, { fetcher });
  await assert.rejects(api.testConnection(settings, { fetcher }), { code: 'HTTP_403' });
  await api.testConnection(settings, { fetcher });
  assert.equal(handshakes, 2);
});

test('invalid JSON values and malformed model lists never report a successful connection', async () => {
  for (const value of [null, [], 'ok', false]) {
    await assert.rejects(API.testConnection({ ...settings, connectionMode: 'direct' }, { fetcher: async () => response(value) }), { code: 'LLM_JSON' });
  }
  for (const value of [{}, { data: null }, { data: [null] }, { data: [{ id: '' }] }]) {
    await assert.rejects(API.testConnection({ ...settings, connectionMode: 'direct' }, { fetcher: async () => response(value) }), { code: 'LLM_MODELS' });
  }
});

test('public network errors give direct-connection guidance without leaking a remote error', async () => {
  const api = at('https://eqai-moip.github.io/AI_Reviewer/');
  await assert.rejects(api.testConnection(settings, { fetcher: async () => { throw new Error(settings.llmKey); } }), e => {
    assert.equal(e.code, 'NETWORK'); assert.match(e.message, /CORS/); assert.match(e.message, /내려받은 앱/);
    assert.equal(e.message.includes(settings.llmKey), false); return true;
  });
});
