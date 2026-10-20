import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createCloudServer, readConfig } from '../adapter.mjs';

const ORIGIN = 'https://competition.example';
const SECOND_ORIGIN = 'https://second.example';
const REPOSITORY = 'demo-owner/private-feedback';
const REPOSITORY_URL = `https://api.github.com/repos/${REPOSITORY}`;
const TEST_ENV = Object.freeze({
  DEEPSEEK_API_KEY: 'fake-only-model-key-never-a-real-secret',
  DEMO_ACCESS_TOKEN: 'fake-only-demo-access-at-least-24-characters',
  ALLOWED_ORIGIN: `${ORIGIN}, ${SECOND_ORIGIN}`,
  FEEDBACK_GITHUB_TOKEN: 'fake-only-github-token-never-a-real-secret',
  FEEDBACK_REPOSITORY: REPOSITORY,
  FEEDBACK_ADMIN_TOKEN: 'fake-only-admin-token-at-least-24-characters',
  FEEDBACK_SIGNING_SECRET: 'fake-only-signing-secret-at-least-32-characters',
});
const RENDER_ENV = Object.freeze({ ...TEST_ENV, TRUST_RENDER_EDGE: 'true' });

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function fakeUpstream({ privateRepository = true, metadataStatus = 200, issueStatus = 200, modelMessage } = {}) {
  const calls = [];
  const issues = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === 'https://api.deepseek.com/chat/completions') {
      return json({ choices: [{ message: modelMessage || { content: '  测试草稿，等待人工复核。  ' } }] });
    }
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.Authorization, `Bearer ${TEST_ENV.FEEDBACK_GITHUB_TOKEN}`);
    if (url === REPOSITORY_URL) {
      return json({ private: privateRepository, full_name: REPOSITORY, has_issues: true }, metadataStatus,
        metadataStatus === 302 ? { Location: 'https://untrusted.example/repository' } : {});
    }
    if (url === `${REPOSITORY_URL}/issues` && init.method === 'POST') {
      if (issueStatus !== 200) return json({}, issueStatus, { Location: 'https://untrusted.example/issues' });
      const submitted = JSON.parse(init.body);
      const issue = { ...submitted, number: issues.length + 1, created_at: new Date().toISOString() };
      issues.unshift(issue);
      return json(issue, 201);
    }
    if (url.startsWith(`${REPOSITORY_URL}/issues?`) && init.method === 'GET') {
      if (issueStatus !== 200) return json({}, issueStatus, { Location: 'https://untrusted.example/issues' });
      return json(issues);
    }
    throw new Error(`Unexpected fake upstream destination: ${url}`);
  };
  return { calls, issues, fetchImpl };
}

async function start(t, { env = TEST_ENV, upstream = fakeUpstream(), fetchImpl = upstream.fetchImpl, limits } = {}) {
  // Explicit test config and injected fetch: no process.env, .env or real API.
  const server = createCloudServer(readConfig({ ...env }), { fetchImpl, limits });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, server, upstream };
}

async function request(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { Origin: ORIGIN, ...options.headers },
    signal: options.signal || AbortSignal.timeout(3000),
  });
  const text = await response.text();
  return {
    status: response.status, headers: response.headers, text,
    json: text && response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null,
  };
}

function post(body, headers = {}) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ENV.DEMO_ACCESS_TOKEN}`, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function rawPost(base, path, chunks, headers = {}, end = true) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, {
      method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ENV.DEMO_ACCESS_TOKEN}`, ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (part) => { text += part; });
      res.once('end', () => {
        req.destroy();
        resolve({ status: res.statusCode, headers: res.headers, text, json: text ? JSON.parse(text) : null });
      });
      res.once('error', reject);
    });
    req.once('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('Local test request timed out')));
    for (const chunk of chunks) req.write(chunk);
    if (end) req.end();
  });
}

async function ticket(base, id = randomUUID(), headers = {}) {
  const response = await request(base, `/api/feedback-ticket?requestId=${id}`, { headers });
  assert.equal(response.status, 200);
  assert.equal(typeof response.json.ticket, 'string');
  return { id, ticket: response.json.ticket };
}

function feedbackBody(id, content = '手机上测试反馈，请保留原文。') {
  return { requestId: id, content, page: 'feedback', device: 'mobile', website: '' };
}

test('cloud config is Sites-compatible; mobile health is minimal and independent of feature secrets', async (t) => {
  const config = readConfig({});
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 10000);
  assert.equal(config.gateway.model, 'deepseek-chat');
  assert.deepEqual(config.gateway.allowedOrigins, []);
  assert.equal(config.trustRenderEdge, false);
  assert.equal(config.feedback.rateLimits, undefined);
  assert.equal(readConfig({ RENDER: 'true' }).trustRenderEdge, false);
  assert.equal(readConfig({ TRUST_RENDER_EDGE: 'TRUE' }).trustRenderEdge, false);
  assert.deepEqual(readConfig(RENDER_ENV).feedback.rateLimits, { ticket: 120, submit: 60, globalSubmit: 200 });
  assert.throws(() => readConfig({ PORT: '12.5' }));
  assert.throws(() => readConfig({ PORT: '65536' }));
  const { base, upstream } = await start(t);
  const health = await request(base, '/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { ok: true, service: 'zhixing-cloud', status: 'process-running' });
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(health.headers.get('access-control-allow-origin'), ORIGIN);
  const page = await request(base, '/');
  assert.equal(page.status, 200);
  assert.match(page.text, /lang="zh-CN"/);
  assert.match(page.text, /name="viewport"/);
  assert.match(page.text, /服务地址可以访问/);
  assert.match(page.text, /只检查网络与服务进程/);
  assert.match(page.text, /正式接口由项目维护者更新/);
  assert.doesNotMatch(page.text, /填写这个站点的根地址/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  for (const value of Object.values(TEST_ENV)) assert.ok(!page.text.includes(value));
  assert.equal((await request(base, '/', { method: 'HEAD' })).text, '');
  assert.equal(upstream.calls.length, 0);
  const empty = await start(t, { env: {} });
  assert.equal((await fetch(`${empty.base}/health`)).status, 200);
  assert.equal((await request(empty.base, '/api/generate', post({ task: 'minutes', input: '记录' }))).status, 503);
  assert.equal((await request(empty.base, '/api/feedback')).status, 503);
});

test('CORS, OPTIONS, wrong methods and independent access tokens survive the HTTP adapter', async (t) => {
  const { base, upstream } = await start(t);
  for (const path of ['/api/generate', '/api/agent', '/api/feedback', '/api/feedback-ticket']) {
    const response = await request(base, path, { method: 'OPTIONS' });
    assert.equal(response.status, 204);
    assert.equal(response.text, '');
    assert.equal(response.headers.get('content-length'), null);
    assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(response.headers.get('vary'), 'Origin');
    assert.match(response.headers.get('access-control-allow-headers'), /Authorization/);
    const denied = await request(base, path, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  }
  assert.equal((await fetch(`${base}/api/feedback-ticket?requestId=${randomUUID()}`)).status, 403);
  const wrongMethod = await request(base, '/api/generate');
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST, OPTIONS');
  const noAccess = await request(base, '/api/generate', post({ task: 'minutes', input: '记录' }, { Authorization: '' }));
  assert.equal(noAccess.status, 401);
  assert.equal(noAccess.headers.get('access-control-allow-origin'), ORIGIN);
  const noAdmin = await request(base, '/api/feedback', { headers: { Authorization: `Bearer ${TEST_ENV.DEMO_ACCESS_TOKEN}` } });
  assert.equal(noAdmin.status, 401);
  assert.equal(noAdmin.json.error.code, 'FEEDBACK_ADMIN_UNAUTHORIZED');
  assert.equal((await request(base, '/api/no-such-action')).status, 404);
  assert.equal(upstream.calls.length, 0);
});

test('AI generation, planning and upstream errors retain the pure handler contract', async (t) => {
  const { base, upstream } = await start(t);
  const result = await request(base, '/api/generate/', post({ task: 'minutes', input: '原始会议记录' }));
  assert.equal(result.status, 200);
  assert.equal(result.json.text, '测试草稿，等待人工复核。');
  assert.equal(result.json.mode, 'deepseek');
  assert.equal(upstream.calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(upstream.calls[0].init.headers.Authorization, `Bearer ${TEST_ENV.DEEPSEEK_API_KEY}`);
  const call = (name) => ({ type: 'function', function: { name, arguments: JSON.stringify({ reason: '使用已录入资料，等待人工确认。' }) } });
  const planner = await start(t, { upstream: fakeUpstream({ modelMessage: { tool_calls: [call('sort_participants'), call('generate_materials')] } }) });
  const plan = await request(planner.base, '/api/agent', post({ goal: '准备会议', context: { participants: [] } }));
  assert.equal(plan.status, 200);
  assert.deepEqual(plan.json.steps.map((step) => step.tool), ['sort_participants', 'generate_materials']);
  const bad = await start(t, { upstream: fakeUpstream({ modelMessage: { tool_calls: [call('generate_materials')] } }) });
  const invalid = await request(bad.base, '/api/agent', post({ goal: '准备会议' }));
  assert.equal(invalid.status, 502);
  assert.equal(invalid.json.error.code, 'INVALID_PLAN');
  const busy = await start(t, { fetchImpl: async () => json({}, 429) });
  assert.equal((await request(busy.base, '/api/generate', post({ task: 'minutes', input: '记录' }))).json.error.code, 'MODEL_BUSY');
});

test('64 KB and 8 KB limits return readable 413 for fixed-length and chunked requests', async (t) => {
  const { base, upstream } = await start(t);
  for (const [path, length] of [['/api/generate', 65537], ['/api/feedback', 8193]]) {
    const fixed = await rawPost(base, path, ['x'], { 'Content-Length': String(length) });
    assert.equal(fixed.status, 413);
    assert.equal(fixed.json.error.code, 'BODY_TOO_LARGE');
    assert.equal(fixed.headers['access-control-allow-origin'], ORIGIN);
    const chunks = [Buffer.alloc(length - 10, 32), Buffer.alloc(10, 32)];
    const chunked = await rawPost(base, path, chunks);
    assert.equal(chunked.status, 413);
    assert.equal(chunked.json.error.code, 'BODY_TOO_LARGE');
    assert.equal(chunked.headers['access-control-allow-origin'], ORIGIN);
  }
  assert.equal(upstream.calls.length, 0);
});

test('malformed UTF-8/JSON and non-JSON content fail locally without leaking config', async (t) => {
  const { base, upstream } = await start(t);
  assert.equal((await rawPost(base, '/api/generate', [Buffer.from([0xff, 0xfe])])).json.error.code, 'INVALID_JSON');
  const malformed = await request(base, '/api/generate', post('{broken'));
  assert.equal(malformed.status, 400);
  assert.equal(malformed.json.error.code, 'INVALID_JSON');
  const wrongType = await request(base, '/api/generate', post('{}', { 'Content-Type': 'text/plain' }));
  assert.equal(wrongType.status, 415);
  for (const value of Object.values(TEST_ENV)) assert.ok(!malformed.text.includes(value));
  assert.equal(upstream.calls.length, 0);
});

test('normal body completion does not abort a delayed upstream response', async (t) => {
  let signal;
  const { base } = await start(t, { fetchImpl: async (_url, init) => {
    signal = init.signal;
    await delay(30);
    assert.equal(signal.aborted, false);
    return json({ choices: [{ message: { content: '延迟回复' } }] });
  } });
  const result = await request(base, '/api/generate', post({ task: 'minutes', input: '记录' }));
  assert.equal(result.status, 200);
  assert.equal(signal.aborted, false);
});

test('a disconnected HTTP client aborts the upstream request', async (t) => {
  let entered;
  let aborted;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const abortedPromise = new Promise((resolve) => { aborted = resolve; });
  const { base } = await start(t, { fetchImpl: async (_url, init) => {
    entered();
    return new Promise((_resolve, reject) => {
      const stop = () => { aborted(); reject(new DOMException('Cancelled', 'AbortError')); };
      init.signal.addEventListener('abort', stop, { once: true });
      if (init.signal.aborted) stop();
    });
  } });
  const req = http.request(`${base}/api/generate`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_ENV.DEMO_ACCESS_TOKEN}` } });
  req.on('error', () => {});
  req.end(JSON.stringify({ task: 'minutes', input: '记录' }));
  await Promise.race([enteredPromise, delay(2000).then(() => { throw new Error('Upstream was not entered'); })]);
  req.destroy();
  await Promise.race([abortedPromise, delay(2000).then(() => { throw new Error('Upstream was not aborted'); })]);
});

test('slow body and whole-request deadlines return bounded errors and abort upstream work', async (t) => {
  const slow = await start(t, { limits: { bodyTimeoutMs: 50 } });
  const upload = await rawPost(slow.base, '/api/generate', ['{'], { 'Content-Length': '100' }, false);
  assert.equal(upload.status, 408);
  assert.equal(upload.json.error.code, 'REQUEST_TIMEOUT');
  assert.equal(slow.upstream.calls.length, 0);
  let aborted = false;
  const stalled = await start(t, { limits: { operationTimeoutMs: 60 }, fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Cancelled', 'AbortError')); }, { once: true });
  }) });
  const result = await request(stalled.base, '/api/generate', post({ task: 'minutes', input: '记录' }));
  assert.equal(result.status, 504);
  assert.equal(result.json.error.code, 'SERVICE_TIMEOUT');
  assert.equal(aborted, true);
});

test('ticket binding, feedback storage, idempotent retry and admin-only listing work through real HTTP', async (t) => {
  const { base, upstream } = await start(t);
  const form = await ticket(base);
  const body = feedbackBody(form.id, '反馈 @someone `<script>`，请按原文保存。');
  const result = await request(base, '/api/feedback', post(body, { 'X-Feedback-Ticket': form.ticket, Authorization: '' }));
  assert.equal(result.status, 200);
  assert.equal(result.json.duplicate, false);
  assert.equal(result.json.item.url, '');
  assert.equal(result.json.item.content, body.content);
  assert.equal(upstream.issues.length, 1);
  assert.ok(!upstream.issues[0].body.includes('@someone'));
  const repeat = await request(base, '/api/feedback', post(body, { 'X-Feedback-Ticket': form.ticket }));
  assert.equal(repeat.status, 200);
  assert.equal(repeat.json.duplicate, true);
  assert.equal(upstream.issues.length, 1);
  const conflict = await request(base, '/api/feedback', post(feedbackBody(form.id, '不同内容'), { 'X-Feedback-Ticket': form.ticket }));
  assert.equal(conflict.status, 409);
  const crossed = await request(base, '/api/feedback', post(body, { Origin: SECOND_ORIGIN, 'X-Feedback-Ticket': form.ticket }));
  assert.equal(crossed.status, 403);
  assert.equal(crossed.json.error.code, 'INVALID_FEEDBACK_TICKET');
  const invalid = await request(base, '/api/feedback', post(feedbackBody(randomUUID()), { 'X-Feedback-Ticket': `${form.ticket}broken` }));
  assert.equal(invalid.status, 403);
  const listed = await request(base, '/api/feedback', { headers: { Authorization: `Bearer ${TEST_ENV.FEEDBACK_ADMIN_TOKEN}` } });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.items[0].content, body.content);
  assert.equal(listed.json.items[0].url, `https://github.com/${REPOSITORY}/issues/1`);
  assert.equal(upstream.calls.filter((call) => call.url === REPOSITORY_URL).length, 1);
});

test('simultaneous retries share the per-process feedback lock', async (t) => {
  const { base, upstream } = await start(t);
  const form = await ticket(base);
  const results = await Promise.all([1, 2].map(() => request(base, '/api/feedback', post(feedbackBody(form.id), { 'X-Feedback-Ticket': form.ticket }))));
  assert.deepEqual(results.map((result) => result.status), [200, 200]);
  assert.deepEqual(results.map((result) => result.json.duplicate).sort(), [false, true]);
  assert.equal(upstream.issues.length, 1);
});

test('public repositories and metadata/Issues redirects fail closed without following a Location', async (t) => {
  for (const setting of [{ privateRepository: false }, { metadataStatus: 302 }, { issueStatus: 302 }]) {
    const { base, upstream } = await start(t, { upstream: fakeUpstream(setting) });
    const response = await request(base, '/api/feedback', { headers: { Authorization: `Bearer ${TEST_ENV.FEEDBACK_ADMIN_TOKEN}` } });
    assert.equal(response.status, 502);
    assert.equal(response.json.error.code, 'FEEDBACK_STORAGE_ERROR');
    assert.equal(upstream.calls.some((call) => call.url.startsWith('https://untrusted.example')), false);
    if (!setting.issueStatus) assert.equal(upstream.calls.length, 1);
  }
});

test('forged client-IP headers cannot reset the socket-based ticket rate limit', async (t) => {
  const { base, upstream } = await start(t);
  for (let index = 0; index < 20; index += 1) {
    await ticket(base, randomUUID(), {
      'CF-Connecting-IP': `198.51.100.${index + 1}`,
      'X-Forwarded-For': `192.0.2.${index + 1}`,
      'X-Real-IP': `203.0.113.${index + 1}`,
      Forwarded: `for=192.0.2.${index + 1}`,
    });
  }
  const denied = await request(base, `/api/feedback-ticket?requestId=${randomUUID()}`, { headers: { 'CF-Connecting-IP': '198.51.100.250', 'X-Forwarded-For': '192.0.2.250' } });
  assert.equal(denied.status, 429);
  assert.equal(denied.json.error.code, 'FEEDBACK_RATE_LIMITED');
  assert.equal(denied.headers.get('retry-after'), '60');
  assert.equal(upstream.calls.length, 0);
});

test('an unconfigured AI feature does not block configured feedback', async (t) => {
  const { base, upstream } = await start(t, { env: { ...TEST_ENV, DEEPSEEK_API_KEY: '' } });
  const ai = await request(base, '/api/generate', post({ task: 'minutes', input: '记录' }));
  assert.equal(ai.status, 503);
  assert.equal(ai.json.error.code, 'SERVICE_NOT_CONFIGURED');
  await ticket(base);
  const listed = await request(base, '/api/feedback', { headers: { Authorization: `Bearer ${TEST_ENV.FEEDBACK_ADMIN_TOKEN}` } });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json.items, []);
  assert.equal(upstream.calls.every((call) => call.url.startsWith(REPOSITORY_URL)), true);
});

test('Render opt-in uses only the validated edge IP and gives distinct IPs distinct ticket buckets', async (t) => {
  const { base, upstream } = await start(t, { env: RENDER_ENV });
  const edge = { 'CF-Connecting-IP': '198.51.100.10' };
  for (let index = 0; index < 120; index += 1) {
    await ticket(base, randomUUID(), { ...edge, 'X-Forwarded-For': `192.0.2.${index + 1}` });
  }
  const limited = await request(base, `/api/feedback-ticket?requestId=${randomUUID()}`, {
    headers: { ...edge, 'X-Forwarded-For': '203.0.113.200', 'X-Real-IP': '203.0.113.200' },
  });
  assert.equal(limited.status, 429);
  await ticket(base, randomUUID(), { 'CF-Connecting-IP': '198.51.100.11' });
  await ticket(base, randomUUID(), { 'CF-Connecting-IP': '2001:db8::1' });
  assert.equal(upstream.calls.length, 0);
});

test('Render opt-in rejects missing, duplicate and malformed edge IPs without using XFF or breaking health/AI', async (t) => {
  const { base, upstream } = await start(t, { env: RENDER_ENV });
  for (const invalid of [undefined, '', 'unknown', '198.51.100.1, 198.51.100.2', '198.51.100.1:443', 'https://example.com']) {
    const headers = { 'X-Forwarded-For': '198.51.100.1', 'X-Real-IP': '198.51.100.1', ...(invalid === undefined ? {} : { 'CF-Connecting-IP': invalid }) };
    for (const [path, options] of [
      [`/api/feedback-ticket?requestId=${randomUUID()}`, { headers }],
      ['/api/feedback', post(feedbackBody(randomUUID()), headers)],
      ['/api/feedback', { headers: { ...headers, Authorization: `Bearer ${TEST_ENV.FEEDBACK_ADMIN_TOKEN}` } }],
      ['/api/feedback', { method: 'OPTIONS', headers }],
    ]) {
      const response = await request(base, path, options);
      assert.equal(response.status, 503);
      assert.equal(response.json.error.code, 'FEEDBACK_PROXY_MISCONFIGURED');
      assert.match(response.json.error.message, /代理来源配置异常/);
      assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
    }
  }
  const duplicates = await rawPost(base, '/api/feedback', ['{}'], { 'CF-Connecting-IP': ['198.51.100.1', '198.51.100.2'] });
  assert.equal(duplicates.status, 503);
  assert.equal(duplicates.json.error.code, 'FEEDBACK_PROXY_MISCONFIGURED');
  assert.equal(upstream.calls.length, 0);
  assert.equal((await request(base, '/health')).status, 200);
  assert.equal((await request(base, '/', { headers: { 'CF-Connecting-IP': 'bad' } })).status, 200);
  assert.equal((await request(base, '/api/generate', post({ task: 'minutes', input: '记录' }))).status, 200);
});

test('seven submissions from a shared Wi-Fi succeed only with the Render trial limits', async (t) => {
  for (const env of [TEST_ENV, RENDER_ENV]) {
    const { base, upstream } = await start(t, { env });
    const edge = { 'CF-Connecting-IP': '198.51.100.25' };
    for (let index = 0; index < 7; index += 1) {
      const form = await ticket(base, randomUUID(), edge);
      const result = await request(base, '/api/feedback', post(feedbackBody(form.id, `同一网络反馈 ${index + 1}`), { ...edge, 'X-Feedback-Ticket': form.ticket }));
      assert.equal(result.status, env === TEST_ENV && index === 6 ? 429 : 200);
    }
    assert.equal(upstream.issues.length, env === TEST_ENV ? 6 : 7);
  }
});

test('the Render global 200-submit guard spans IPs and per-IP rejections do not spend it', async (t) => {
  const { base, upstream } = await start(t, { env: RENDER_ENV });
  let count = 0;
  for (const [ip, size] of [['198.51.100.31', 60], ['198.51.100.32', 60], ['198.51.100.33', 60], ['198.51.100.34', 20]]) {
    let lastForm;
    const edge = { 'CF-Connecting-IP': ip };
    for (let index = 0; index < size; index += 1) {
      lastForm = await ticket(base, randomUUID(), edge);
      const result = await request(base, '/api/feedback', post(feedbackBody(lastForm.id, `全局试用反馈 ${++count}`), { ...edge, 'X-Feedback-Ticket': lastForm.ticket }));
      assert.equal(result.status, 200);
    }
    if (ip === '198.51.100.31') {
      for (let rejected = 0; rejected < 3; rejected += 1) {
        const result = await request(base, '/api/feedback', post(feedbackBody(lastForm.id), { ...edge, 'X-Feedback-Ticket': lastForm.ticket }));
        assert.equal(result.status, 429);
      }
    }
  }
  assert.equal(upstream.issues.length, 200);
  const freshEdge = { 'CF-Connecting-IP': '198.51.100.35' };
  const form = await ticket(base, randomUUID(), freshEdge);
  const denied = await request(base, '/api/feedback', post(feedbackBody(form.id), { ...freshEdge, 'X-Feedback-Ticket': form.ticket }));
  assert.equal(denied.status, 429);
  assert.match(denied.json.error.message, /提交量较大/);
  assert.equal(denied.headers.get('retry-after'), '60');
  assert.equal(upstream.issues.length, 200);
});

test('Render opt-in keeps the separate admin limit at 60 requests per minute', async (t) => {
  const { base } = await start(t, { env: RENDER_ENV });
  for (let index = 0; index < 61; index += 1) {
    const result = await request(base, '/api/feedback', { headers: { 'CF-Connecting-IP': '198.51.100.45', Authorization: `Bearer ${TEST_ENV.FEEDBACK_ADMIN_TOKEN}` } });
    assert.equal(result.status, index === 60 ? 429 : 200);
  }
});
