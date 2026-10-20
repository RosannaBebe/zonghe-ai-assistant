/**
 * Dependency-free Node >= 22.18 adapter for the copied Web-standard handlers.
 * See SOURCE.md for provenance and the intentionally conservative proxy policy.
 */
import http from 'node:http';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { handleRequest } from './lib/gateway.ts';
import { createFeedbackState, handleFeedbackRequest } from './lib/feedback.ts';

const API_PATHS = new Set(['/api/generate', '/api/agent', '/api/feedback', '/api/feedback-ticket']);
const FORWARDED_HEADERS = ['authorization', 'content-type', 'content-length', 'origin', 'x-feedback-ticket'];
const DEFAULT_LIMITS = Object.freeze({ bodyTimeoutMs: 20000, operationTimeoutMs: 60000, headersTimeoutMs: 10000 });
const PRIVATE_REPOSITORY_TTL_MS = 60000;
const MAX_REPOSITORY_RESPONSE_BYTES = 64 * 1024;
const HEALTH_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light"><title>知行 · 服务连接检查</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;background:#f2f6f5;color:#183c33;font:16px/1.7 system-ui,-apple-system,"Noto Sans SC",sans-serif;padding:max(24px,env(safe-area-inset-top)) 20px max(24px,env(safe-area-inset-bottom))}main{width:min(100%,520px);padding:32px 26px;background:#fff;border:1px solid #d9e5df;border-radius:24px;box-shadow:0 12px 48px #163e3310}.tag{font-size:13px;color:#32664f;letter-spacing:.12em}h1{font-size:28px;line-height:1.4;margin:14px 0}p{margin:12px 0;color:#4c615a}.status{display:flex;align-items:center;gap:10px;font-weight:600}.dot{width:10px;height:10px;border-radius:50%;background:#26865e;flex:none}.note{border-top:1px solid #e3ebe7;padding-top:20px;margin-top:24px;font-size:14px}a{display:inline-flex;align-items:center;min-height:48px;color:#176b50;font-weight:600;text-underline-offset:5px}code{overflow-wrap:anywhere}</style></head>
<body><main><div class="tag">知行 · 综合管理 AI 助手</div><h1>服务地址可以访问</h1><div class="status"><span class="dot" aria-hidden="true"></span>后端服务运行中</div><p>能看到此页面，说明当前浏览器可以访问这个后端地址。</p><p>请返回知行网页验证 AI 与反馈功能。正式接口由项目维护者更新；此页面的地址不是模型生成接口。</p><p class="note">此页只检查网络与服务进程。AI 生成和反馈存储是否可用，需要在网页内分别验证。</p><a href="/health">查看基础健康状态</a></main></body></html>`;

export function readConfig(env = process.env) {
  const host = (env.HOST || '0.0.0.0').trim();
  const portText = env.PORT || '10000';
  const port = Number(portText);
  if (!host || !/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('请检查 HOST 与 PORT；端口必须为 1 至 65535 的整数。');
  }
  const allowedOrigins = (env.ALLOWED_ORIGIN || '').split(',').map((value) => value.trim()).filter(Boolean);
  // Explicit deployment assertion, never auto-enabled by the RENDER flag.
  // Only use on a Render Free public web service; see SOURCE.md.
  const trustRenderEdge = env.TRUST_RENDER_EDGE === 'true';
  return {
    host,
    port,
    trustRenderEdge,
    gateway: {
      apiKey: env.DEEPSEEK_API_KEY || '',
      accessToken: env.DEMO_ACCESS_TOKEN || '',
      allowedOrigins,
      model: env.DEEPSEEK_MODEL || 'deepseek-chat',
    },
    feedback: {
      githubToken: env.FEEDBACK_GITHUB_TOKEN || '',
      repository: env.FEEDBACK_REPOSITORY || '',
      adminToken: env.FEEDBACK_ADMIN_TOKEN || '',
      signingSecret: env.FEEDBACK_SIGNING_SECRET || '',
      allowedOrigins,
      ...(trustRenderEdge ? { rateLimits: { ticket: 120, submit: 60, globalSubmit: 200 } } : {}),
    },
  };
}

function renderEdgeAddress(req) {
  const value = req.headers['cf-connecting-ip'];
  // Reject absent, duplicate/comma-separated, malformed or non-IP values.
  // X-Forwarded-For never supplies a fallback, even in opt-in mode.
  return typeof value === 'string' && isIP(value) ? value : null;
}

function requestHeaders(req, trustedAddress = null) {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = req.headers[name];
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  // The copied handler consumes this header as a rate-limit key. The default
  // always replaces client headers with the socket address. A validated address
  // can be supplied only by the explicit Render Free public-edge policy.
  let address = trustedAddress || req.socket.remoteAddress || '';
  if (address.startsWith('::ffff:') && isIP(address.slice(7)) === 4) address = address.slice(7);
  headers.set('CF-Connecting-IP', isIP(address) ? address : 'unknown');
  return headers;
}

/** Unlike Readable.toWeb(req), cancellation does not destroy the response socket. */
function incomingBody(req) {
  let streamController;
  let ended = false;
  const clean = () => {
    req.off('data', onData);
    req.off('end', onEnd);
    req.off('error', onError);
    req.off('aborted', onAborted);
  };
  const fail = (error) => {
    if (ended) return;
    ended = true;
    clean();
    req.pause();
    streamController.error(error);
  };
  const onData = (chunk) => {
    streamController.enqueue(chunk);
    if (streamController.desiredSize <= 0) req.pause();
  };
  const onEnd = () => {
    if (ended) return;
    ended = true;
    clean();
    streamController.close();
  };
  const onError = (error) => fail(error);
  const onAborted = () => fail(new DOMException('Request cancelled', 'AbortError'));
  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;
      req.pause();
      req.on('data', onData);
      req.once('end', onEnd);
      req.once('error', onError);
      req.once('aborted', onAborted);
    },
    pull() { if (!ended) req.resume(); },
    cancel() {
      ended = true;
      clean();
      req.pause();
    },
  });
  return { stream, fail, dispose: () => { ended = true; clean(); req.pause(); } };
}

function baseHeaders() {
  return new Headers({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    Vary: 'Origin',
  });
}

function jsonError(status, code, message, origin, allowedOrigins) {
  const headers = baseHeaders();
  headers.set('Content-Type', 'application/json; charset=utf-8');
  if (origin && allowedOrigins.includes(origin)) headers.set('Access-Control-Allow-Origin', origin);
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers });
}

function healthResponse(path, request, allowedOrigins) {
  const headers = baseHeaders();
  const origin = request.headers.get('Origin');
  if (origin && !allowedOrigins.includes(origin)) {
    return jsonError(403, 'ORIGIN_FORBIDDEN', '当前网页来源未获服务端允许。', null, allowedOrigins);
  }
  if (origin) headers.set('Access-Control-Allow-Origin', origin);
  if (!['GET', 'HEAD'].includes(request.method)) {
    const response = jsonError(405, 'METHOD_NOT_ALLOWED', '状态页面仅支持 GET 和 HEAD。', origin, allowedOrigins);
    response.headers.set('Allow', 'GET, HEAD');
    return response;
  }
  if (path === '/health') {
    headers.set('Content-Type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify({ ok: true, service: 'zhixing-cloud', status: 'process-running' }), { headers });
  }
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  return new Response(HEALTH_HTML, { headers });
}

async function readRepositoryMetadata(response) {
  if (!response.body) throw new Error('Repository response is empty');
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_REPOSITORY_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Repository response is too large');
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

function privateGithubFetch(config, fetchImpl) {
  let verifiedUntil = 0;
  const repositoryUrl = `https://api.github.com/repos/${config.repository}`;
  return async (url, init = {}) => {
    if (url !== `${repositoryUrl}/issues` && !url.startsWith(`${repositoryUrl}/issues?`)) {
      throw new Error('Unexpected feedback storage destination');
    }
    if (Date.now() >= verifiedUntil) {
      // The handler's existing 15-second timer and disconnect signal cover both
      // metadata validation and the subsequent Issues request, including bodies.
      const response = await fetchImpl(repositoryUrl, { ...init, method: 'GET', body: undefined, redirect: 'manual' });
      if (!response.ok) {
        await response.body?.cancel();
        return new Response(null, { status: response.status === 429 ? 429 : 502 });
      }
      const metadata = await readRepositoryMetadata(response);
      if (metadata?.private !== true || typeof metadata.full_name !== 'string'
        || metadata.full_name.toLowerCase() !== config.repository.toLowerCase() || metadata.has_issues === false) {
        return new Response(null, { status: 502 });
      }
      verifiedUntil = Date.now() + PRIVATE_REPOSITORY_TTL_MS;
    }
    return fetchImpl(url, { ...init, redirect: 'manual' });
  };
}

async function sendResponse(req, res, response) {
  if (res.destroyed || res.writableEnded) {
    await response.body?.cancel();
    return;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (res.destroyed || res.writableEnded) return;
  const headers = Object.fromEntries(response.headers);
  const bodyAllowed = response.status !== 204 && response.status !== 304;
  if (bodyAllowed) headers['content-length'] = String(bytes.byteLength);
  else delete headers['content-length'];
  // Early authentication/validation failures may leave an unread request body.
  // Flush the JSON error before closing, instead of destroying the socket in a
  // stream cancellation callback (which would hide a useful 401/413 response).
  if (!req.readableEnded && (req.headers['transfer-encoding'] || Number(req.headers['content-length']) > 0)) {
    headers.connection = 'close';
  }
  res.writeHead(response.status, headers);
  res.end(req.method === 'HEAD' || !bodyAllowed ? undefined : bytes);
}

export function createCloudServer(config = readConfig(), { fetchImpl = globalThis.fetch, limits = {} } = {}) {
  const timers = { ...DEFAULT_LIMITS, ...limits };
  for (const value of Object.values(timers)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('服务超时必须是正整数毫秒。');
  }
  const state = createFeedbackState();
  const feedbackFetch = privateGithubFetch(config.feedback, fetchImpl);
  const server = http.createServer(async (req, res) => {
    const controller = new AbortController();
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
    const allowedOrigins = config.gateway.allowedOrigins;
    let body;
    let bodyTimer;
    let finished = false;
    let deadlineExpired = false;
    const abort = () => {
      controller.abort();
      body?.fail(new DOMException('Request cancelled', 'AbortError'));
    };
    const onDisconnect = () => { if (!res.writableFinished) abort(); cleanup(); };
    const onBodyEnd = () => clearTimeout(bodyTimer);
    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearTimeout(bodyTimer);
      clearTimeout(operationTimer);
      req.off('aborted', abort);
      req.off('error', abort);
      req.off('end', onBodyEnd);
      res.off('close', onDisconnect);
      body?.dispose();
    };
    const timedOut = (status, code, message) => {
      if (finished || deadlineExpired || res.writableEnded || res.destroyed) return;
      deadlineExpired = true;
      abort();
      res.setHeader('Connection', 'close');
      void sendResponse(req, res, jsonError(status, code, message, origin, allowedOrigins)).catch(() => res.destroy());
    };
    const operationTimer = setTimeout(() => timedOut(504, 'SERVICE_TIMEOUT', '服务响应超时，请稍后重试。'), timers.operationTimeoutMs);
    operationTimer.unref();
    req.once('aborted', abort);
    req.once('error', abort);
    req.once('end', onBodyEnd);
    res.once('close', onDisconnect);
    res.once('finish', cleanup);
    try {
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) {
        return await sendResponse(req, res, jsonError(400, 'INVALID_REQUEST', '请求地址无效。', origin, allowedOrigins));
      }
      // Use a fixed internal origin: neither Host nor forwarding headers can
      // turn this service into a proxy or change a ticket's permitted origin.
      const url = new URL(req.url, 'http://zhixing.internal');
      const path = url.pathname.replace(/\/$/, '') || '/';
      const method = req.method || 'GET';
      const isFeedback = path === '/api/feedback' || path === '/api/feedback-ticket';
      const trustedAddress = config.trustRenderEdge && isFeedback ? renderEdgeAddress(req) : null;
      if (config.trustRenderEdge && isFeedback && !trustedAddress) {
        return await sendResponse(req, res, jsonError(503, 'FEEDBACK_PROXY_MISCONFIGURED', '反馈代理来源配置异常，请联系维护者检查 Render 公网入口。', origin, allowedOrigins));
      }
      if (!['GET', 'HEAD'].includes(method)) {
        body = incomingBody(req);
        bodyTimer = setTimeout(() => timedOut(408, 'REQUEST_TIMEOUT', '上传请求超时，请精简内容后重试。'), timers.bodyTimeoutMs);
        bodyTimer.unref();
      }
      const request = new Request(url, {
        method, headers: requestHeaders(req, trustedAddress), signal: controller.signal,
        ...(body ? { body: body.stream, duplex: 'half' } : {}),
      });
      let response;
      if (path === '/' || path === '/health') response = healthResponse(path, request, allowedOrigins);
      else if (!API_PATHS.has(path)) response = jsonError(404, 'NOT_FOUND', '接口不存在。', origin, allowedOrigins);
      else if (isFeedback) {
        response = await handleFeedbackRequest(request, config.feedback, feedbackFetch, { state });
      } else response = await handleRequest(request, config.gateway, fetchImpl);
      if (deadlineExpired) await response.body?.cancel();
      else await sendResponse(req, res, response);
    } catch {
      if (!deadlineExpired) await sendResponse(req, res, jsonError(502, 'SERVICE_UNAVAILABLE', '服务暂时不可用，请稍后重试。', origin, allowedOrigins)).catch(() => res.destroy());
    }
  });
  server.requestTimeout = timers.bodyTimeoutMs;
  server.headersTimeout = Math.min(timers.headersTimeoutMs, timers.bodyTimeoutMs);
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  // No error object, request body, URL or credential is written to logs.
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    else socket.destroy();
  });
  return server;
}

export function startCloudServer(env = process.env) {
  const config = readConfig(env);
  const server = createCloudServer(config);
  server.on('error', () => {
    console.error('知行备用服务启动失败，请检查监听地址与端口。');
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => console.log('知行备用服务已启动。运行日志不记录业务内容与密钥。'));
  const shutdown = () => {
    const deadline = setTimeout(() => { server.closeAllConnections(); }, 10000);
    deadline.unref();
    server.close(() => { clearTimeout(deadline); });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  server.once('close', () => {
    process.off('SIGTERM', shutdown);
    process.off('SIGINT', shutdown);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { startCloudServer(); }
  catch { console.error('知行备用服务未能启动，请检查 Node 版本及 HOST、PORT 配置。'); process.exitCode = 1; }
}
