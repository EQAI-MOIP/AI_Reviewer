#!/usr/bin/env node
'use strict';
/* Optional loopback execution helper. Node.js built-ins only; no npm packages.
 * It neither persists credentials nor logs request URLs/bodies. */
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns').promises;
const net = require('node:net');
const crypto = require('node:crypto');
const { PATHS } = require('./js/api.js');
const ROOT = __dirname;
const MAX_BODY = 72 * 1024 * 1024;
const MAX_RESPONSE = 55 * 1024 * 1024;
const KIPRIS_PATHS = new Set(Object.values(PATHS));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf' };
function fault(code, message) { const e = new Error(message); e.code = code; return e; }
function publicAddress(address) {
  const v = net.isIP(address);
  if (v === 4) {
    const a = address.split('.').map(Number);
    return !(a[0] === 0 || a[0] === 10 || a[0] === 127 || a[0] >= 224 ||
      (a[0] === 100 && a[1] >= 64 && a[1] <= 127) || (a[0] === 169 && a[1] === 254) ||
      (a[0] === 172 && a[1] >= 16 && a[1] <= 31) || (a[0] === 192 && (a[1] === 168 || a[1] === 0 || (a[1] === 88 && a[2] === 99))) ||
      (a[0] === 198 && (a[1] === 18 || a[1] === 19 || (a[1] === 51 && a[2] === 100))) || (a[0] === 203 && a[1] === 0 && a[2] === 113));
  }
  if (v === 6) {
    // Only global unicast. IPv4-mapped, ULA, link-local, multicast and transition ranges are rejected.
    const s = address.toLowerCase();
    return /^[23][0-9a-f]{3}:/.test(s) && !/^2001:(?:0:|db8:|10:|20:)/.test(s) && !s.startsWith('2002:');
  }
  return false;
}
function isLoopback(host) { return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host).toLowerCase()); }
function validateTarget(raw, kind, allowLocal) {
  let u; try { u = new URL(raw); } catch (_) { throw fault('TARGET_URL', '요청 주소 형식이 올바르지 않습니다.'); }
  if (u.username || u.password || u.hash) throw fault('TARGET_URL', '요청 주소에 사용자 정보나 URL 조각을 사용할 수 없습니다.');
  const local = isLoopback(u.hostname);
  if (kind === 'kipris' || kind === 'pdf') {
    if (u.protocol !== 'https:' || u.hostname !== 'plus.kipris.or.kr' || (u.port && u.port !== '443')) throw fault('TARGET_HOST', 'KIPRIS Plus 공식 HTTPS 호스트만 허용합니다.');
    if (kind === 'kipris' && !KIPRIS_PATHS.has(u.pathname)) throw fault('TARGET_PATH', '허용된 KIPRIS Plus 작업이 아닙니다.');
  } else {
    if (local && !allowLocal) throw fault('LOCAL_LLM', '사용자가 설정한 로컬 LLM 주소만 허용합니다.');
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local && allowLocal)) throw fault('TARGET_PROTOCOL', '외부 모델 연결에는 HTTPS가 필요합니다.');
    if (!/\/(?:responses(?:\/input_tokens)?|chat\/completions|models)$/.test(u.pathname)) throw fault('TARGET_PATH', '허용된 LLM API 작업이 아닙니다.');
    if (!local && u.port && u.port !== '443') throw fault('TARGET_PORT', '외부 모델 연결은 HTTPS 기본 포트만 허용합니다.');
  }
  return { url: u, local };
}
async function safeRequest(raw, { kind, method = 'GET', headers = {}, body, allowLocal = false, signal, redirects = 0, lookup = dns.lookup, timeoutMs = 300000 } = {}) {
  const { url: u, local } = validateTarget(raw, kind, allowLocal);
  if (signal && signal.aborted) throw fault('ABORTED', '요청을 중지했습니다.');
  const hostname = u.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  if (local) addresses = [{ address: hostname === 'localhost' ? '127.0.0.1' : hostname, family: hostname === '::1' ? 6 : 4 }];
  else {
    if (net.isIP(hostname)) addresses = [{ address: hostname, family: net.isIP(hostname) }];
    else addresses = await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(x => !publicAddress(x.address))) throw fault('PRIVATE_TARGET', '사설망 또는 예약된 주소로의 요청을 차단했습니다.');
  }
  const chosen = addresses[0];
  return await new Promise((resolve, reject) => {
    const transport = u.protocol === 'https:' ? https : http;
    const req = transport.request(u, {
      method, headers: { ...headers, 'Accept-Encoding': 'identity', 'User-Agent': 'AI-Review-Leader-QURI/3.0' },
      lookup: (_host, opts, cb) => opts && opts.all ? cb(null, [chosen]) : cb(null, chosen.address, chosen.family),
      timeout: Math.min(900000, Math.max(1000, Number(timeoutMs) || 300000)), agent: false
    }, res => {
      const status = res.statusCode || 502;
      if ([301, 302, 303, 307, 308].includes(status)) {
        res.resume();
        // LLM redirects can leak Authorization. Only same-host official PDF/API redirects, without credentials, are accepted.
        if ((kind !== 'pdf' && kind !== 'kipris') || redirects >= 3 || !res.headers.location) { reject(fault('REDIRECT', '외부 리디렉션을 허용하지 않습니다.')); return; }
        let next;
        try { next = new URL(res.headers.location, u); validateTarget(next.href, kind, false); } catch (_) { reject(fault('REDIRECT', '검증되지 않은 PDF 이동 주소를 차단했습니다.')); return; }
        safeRequest(next.href, { kind, method: 'GET', signal, redirects: redirects + 1, lookup }).then(resolve, reject); return;
      }
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > MAX_RESPONSE) { req.destroy(fault('RESPONSE_SIZE', '응답 크기 한도를 초과했습니다.')); } else chunks.push(chunk); });
      res.on('end', () => resolve({ status, bytes: Buffer.concat(chunks), contentType: String(res.headers['content-type'] || 'application/octet-stream') }));
      res.on('error', () => reject(fault('REMOTE_RESPONSE', '외부 서비스 응답을 읽지 못했습니다.')));
    });
    const aborted = () => req.destroy(fault('ABORTED', '요청을 중지했습니다.'));
    if (signal) signal.addEventListener('abort', aborted, { once: true });
    req.on('close', () => { if (signal) signal.removeEventListener('abort', aborted); });
    req.on('timeout', () => req.destroy(fault('TIMEOUT', '외부 서비스 응답 시간이 초과되었습니다.')));
    req.on('error', e => reject(fault(['ABORTED', 'TIMEOUT', 'RESPONSE_SIZE'].includes(e.code) ? e.code : 'REMOTE_CONNECTION', '외부 서비스 연결에 실패했습니다.')));
    if (body) req.write(body);
    req.end();
  });
}
async function readJSON(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw fault('BODY_SIZE', '요청 크기 한도를 초과했습니다.'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { throw fault('JSON_FORMAT', 'JSON 요청 형식이 올바르지 않습니다.'); }
}
function securityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https: http://127.0.0.1:* http://localhost:*; object-src 'self' blob:; frame-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
function createServer(options = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const requestRemote = options.requestRemote || safeRequest;
  const server = http.createServer(async (req, res) => {
    securityHeaders(res);
    const port = server.address() && server.address().port;
    const allowedHosts = new Set(['127.0.0.1:' + port, 'localhost:' + port]);
    const host = String(req.headers.host || '');
    const remote = req.socket.remoteAddress;
    if (!allowedHosts.has(host) || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return json(res, 403, { error: 'LOCAL_ONLY' });
    const origin = req.headers.origin;
    if (origin && origin !== 'http://' + host) return json(res, 403, { error: 'ORIGIN' });
    if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return json(res, 403, { error: 'FETCH_SITE' });
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://' + host).pathname); } catch (_) { return json(res, 400, { error: 'PATH' }); }
    try {
      if (pathname === '/api/session' && req.method === 'GET') return json(res, 200, { token, version: '3.0.0', runtime: 'node-builtins' });
      if (pathname.startsWith('/api/')) {
        if (req.method !== 'POST') return json(res, 405, { error: 'METHOD' });
        if (!/^application\/json(?:;|$)/i.test(String(req.headers['content-type'] || ''))) return json(res, 415, { error: 'CONTENT_TYPE' });
        const given = String(req.headers['x-review-token'] || '');
        if (given.length !== token.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token))) return json(res, 403, { error: 'SESSION' });
        const data = await readJSON(req);
        if (!data || Array.isArray(data) || typeof data !== 'object') return json(res, 400, { error: 'BODY' });
        const controller = new AbortController();
        req.on('aborted', () => controller.abort());
        res.on('close', () => { if (!res.writableEnded) controller.abort(); });
        let result;
        if (pathname === '/api/kipris') {
          if (!KIPRIS_PATHS.has(data.path) || typeof data.key !== 'string' || !data.key.trim() || data.key.length > 4096) return json(res, 400, { error: 'KIPRIS_INPUT' });
          const p = data.params || {};
          const selectors = data.path === PATHS.citedSearch ? ['openNumber', 'publicationNumber', 'registerNumber'] : ['applicationNumber'];
          const present = selectors.filter(k => /^\d{13}$/.test(p[k] || ''));
          if (present.length !== 1 || !Number.isInteger(Number(p.pageNo)) || Number(p.pageNo) < 1 || Number(p.pageNo) > 1000 || Number(p.numOfRows) !== 100) return json(res, 400, { error: 'KIPRIS_PARAMETERS' });
          const u = new URL(data.path, 'https://plus.kipris.or.kr');
          [...present, 'pageNo', 'numOfRows'].forEach(k => u.searchParams.set(k, String(p[k])));
          u.searchParams.set(data.path.startsWith('/kipo-api/') ? 'ServiceKey' : 'accessKey', data.key);
          result = await requestRemote(u.href, { kind: 'kipris', signal: controller.signal });
        } else if (pathname === '/api/pdf') {
          validateTarget(data.url, 'pdf', false);
          result = await requestRemote(data.url, { kind: 'pdf', signal: controller.signal });
        } else if (pathname === '/api/llm') {
          const kind = String(data.kind || '');
          if (!['responses', 'chat', 'count', 'models'].includes(kind)) return json(res, 400, { error: 'LLM_KIND' });
          const validated = validateTarget(data.url, 'llm', data.allowLocalLLM === true);
          const ending = { responses: '/responses', chat: '/chat/completions', count: '/responses/input_tokens', models: '/models' }[kind];
          if (!validated.url.pathname.endsWith(ending)) return json(res, 400, { error: 'LLM_PATH' });
          if (typeof data.key !== 'string' || data.key.length > 4096 || /[\r\n]/.test(data.key)) return json(res, 400, { error: 'LLM_KEY' });
          if (validated.local && Number(validated.url.port || (validated.url.protocol === 'https:' ? 443 : 80)) === port) return json(res, 400, { error: 'RECURSION' });
          if (kind !== 'models' && (!data.payload || typeof data.payload !== 'object' || Array.isArray(data.payload))) return json(res, 400, { error: 'LLM_PAYLOAD' });
          const timeoutMs = Number(data.timeoutMs ?? 300000);
          if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900000) return json(res, 400, { error: 'LLM_TIMEOUT' });
          result = await requestRemote(validated.url.href, { kind: 'llm', method: kind === 'models' ? 'GET' : 'POST', allowLocal: data.allowLocalLLM === true, timeoutMs,
            headers: { 'Content-Type': 'application/json', ...(data.key ? { Authorization: 'Bearer ' + data.key } : {}) },
            body: kind === 'models' ? undefined : JSON.stringify(data.payload), signal: controller.signal });
        } else return json(res, 404, { error: 'NOT_FOUND' });
        if (res.destroyed) return;
        if (result.status < 200 || result.status >= 300) return json(res, result.status >= 400 && result.status <= 599 ? result.status : 502, { error: 'REMOTE_HTTP', status: result.status });
        res.writeHead(200, { 'Content-Type': pathname === '/api/pdf' ? 'application/pdf' : pathname === '/api/kipris' ? 'application/xml; charset=utf-8' : 'application/json; charset=utf-8' });
        return res.end(result.bytes);
      }
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'METHOD' });
      if (pathname === '/') pathname = '/index.html';
      if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(x => x.startsWith('.')) || !MIME[path.extname(pathname).toLowerCase()]) return json(res, 404, { error: 'NOT_FOUND' });
      const full = path.resolve(ROOT, '.' + pathname);
      if (!full.startsWith(ROOT + path.sep) || /(?:^|\/)(?:server\.js|tests)(?:\/|$)/.test(pathname)) return json(res, 404, { error: 'NOT_FOUND' });
      const real = await fs.promises.realpath(full);
      if (!real.startsWith(ROOT + path.sep)) return json(res, 404, { error: 'NOT_FOUND' });
      const stat = await fs.promises.stat(real);
      if (!stat.isFile()) return json(res, 404, { error: 'NOT_FOUND' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(real).toLowerCase()], 'Content-Length': stat.size });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(real).on('error', () => res.destroy()).pipe(res);
    } catch (e) {
      // Error details deliberately exclude remote URL, key, request body and response body.
      if (['ENOENT', 'ENOTDIR'].includes(e.code) && !res.headersSent) return json(res, 404, { error: 'NOT_FOUND' });
      if (!res.headersSent && !res.destroyed) json(res, e.code === 'BODY_SIZE' ? 413 : 502, { error: typeof e.code === 'string' && /^[A-Z_]+$/.test(e.code) ? e.code : 'REQUEST_FAILED', message: '요청을 완료하지 못했습니다. 연결 설정과 서비스 상태를 확인해 주세요.' });
      else if (!res.destroyed) res.end();
    }
  });
  server.requestTimeout = 930000;
  server.headersTimeout = 30000;
  return server;
}
if (require.main === module) {
  const portArg = process.argv.find(x => x.startsWith('--port='));
  const port = portArg ? Number(portArg.slice(7)) : 8765;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) { console.error('포트는 1024~65535 범위로 지정해 주세요.'); process.exitCode = 1; }
  else {
    const server = createServer();
    server.on('error', () => { console.error('실행 도우미를 시작하지 못했습니다. 사용 중인 포트를 확인해 주세요.'); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log('AI 심사팀장 큐리 v3.0.0: http://127.0.0.1:' + port + '\n종료: Ctrl+C. API 키와 문서는 서버에 저장하지 않습니다.'));
  }
}
module.exports = { createServer, publicAddress, validateTarget, safeRequest };
