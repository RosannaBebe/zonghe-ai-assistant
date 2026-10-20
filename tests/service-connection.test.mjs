import test from 'node:test';
import assert from 'node:assert/strict';
import { getRenderHealthURL, waitForService } from '../src/service-connection.js';
import { requestAgentPlan } from '../src/agent.js';

const endpoint = 'https://internal-demo.onrender.com/api/generate';
const healthURL = 'https://internal-demo.onrender.com/health';
const pending = () => new Promise(() => {});
const response = (status, value = { ok: true }) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => value,
});
const options = (fetchImpl, overrides = {}) => ({
  fetchImpl,
  timeoutMs: 300,
  pollIntervalMs: 1,
  requestTimeoutMs: 60,
  ...overrides,
});
const safeError = (code) => (error) => {
  assert.equal(error.code, code);
  assert.match(error.message, /[\u4e00-\u9fff]/);
  assert.doesNotMatch(error.message, /upstream-secret|private-token|database-password/);
  return true;
};
const assertPublicHealthRequest = (url, init) => {
  assert.equal(url, healthURL);
  assert.equal(init.method, 'GET');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.body, undefined);
  const headers = new Headers(init.headers);
  assert.equal(headers.has('authorization'), false);
  assert.equal(headers.has('cookie'), false);
  assert.ok(init.signal instanceof AbortSignal);
};

test('Render health URL is restricted to HTTPS subdomains and strips paths, queries and fragments', () => {
  assert.equal(getRenderHealthURL(endpoint), healthURL);
  assert.equal(getRenderHealthURL('https://INTERNAL-DEMO.onrender.com/nested/api/agent/?token=private-token#database-password'), healthURL);
  assert.equal(getRenderHealthURL('https://internal-demo.onrender.com/'), healthURL);
  for (const other of [
    '', 'not a URL', '/api/generate',
    'http://internal-demo.onrender.com/api/generate',
    'ftp://internal-demo.onrender.com/api/generate',
    'https://onrender.com/api/generate',
    'https://internal-demo.onrender.com.attacker.example/api/generate',
    'https://not-onrender.com/api/generate',
    'https://relay.example/path/internal-demo.onrender.com',
    'http://localhost:8787/api/generate',
  ]) assert.equal(getRenderHealthURL(other), null, other);
});

test('non-Render services return immediately without requests or connection status', async () => {
  const statuses = [];
  let calls = 0;
  for (const other of ['https://relay.example/api/generate', 'http://localhost:8787/api/generate', '']) {
    assert.deepEqual(await waitForService(other, options(async () => { calls += 1; }, {
      onStatus: (status) => statuses.push(status),
    })), { waited: false });
  }
  assert.equal(calls, 0);
  assert.deepEqual(statuses, []);
});

test('cold Render 503 then healthy response announces connection and sends only public health requests', async () => {
  let calls = 0;
  const statuses = [];
  const result = await waitForService(`${endpoint}?token=private-token#database-password`, options(async (url, init) => {
    assertPublicHealthRequest(url, init);
    calls += 1;
    return response(calls === 1 ? 503 : 200, calls === 1 ? { error: 'upstream-secret' } : { ok: true });
  }, { onStatus: (status) => statuses.push(status) }));
  assert.deepEqual(result, { waited: true });
  assert.equal(calls, 2);
  assert.deepEqual(statuses, [
    { phase: 'connecting', message: '正在连接服务，首次可能约一分钟。' },
    { phase: 'ready', message: '' },
  ]);
});

test('429, server errors and transient network errors retry until the health service is ready', async () => {
  const statuses = [429, 500, 502, 504];
  let calls = 0;
  assert.deepEqual(await waitForService(endpoint, options(async () => {
    const attempt = calls++;
    if (attempt < statuses.length) return response(statuses[attempt], { error: 'upstream-secret' });
    if (attempt === statuses.length) throw new TypeError('upstream-secret database-password');
    return response(200);
  })), { waited: true });
  assert.equal(calls, statuses.length + 2);
});

test('HTTP success still waits for an explicit boolean ok:true JSON body', async () => {
  const invalid = [null, {}, { ok: false }, { ok: 'true' }];
  let calls = 0;
  assert.deepEqual(await waitForService(endpoint, options(async () => {
    const attempt = calls++;
    if (attempt < invalid.length) return response(200, invalid[attempt]);
    if (attempt === invalid.length) return { ok: true, status: 200, json: async () => { throw new SyntaxError('upstream-secret'); } };
    return response(200, { ok: true, service: 'demo' });
  })), { waited: true });
  assert.equal(calls, invalid.length + 2);
});

test('terminal 4xx health responses fail once with a safe unavailable error', async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    let calls = 0;
    const statuses = [];
    await assert.rejects(waitForService(endpoint, options(async () => {
      calls += 1;
      return response(status, { error: 'upstream-secret private-token database-password' });
    }, { onStatus: (value) => statuses.push(value) })), safeError('SERVICE_UNAVAILABLE'));
    assert.equal(calls, 1, `HTTP ${status} must not retry`);
    assert.equal(statuses.some((value) => value.phase === 'ready'), false);
  }
});

test('per-attempt timeout retries a fetch that ignores AbortSignal', { timeout: 3000 }, async () => {
  let calls = 0;
  assert.deepEqual(await waitForService(endpoint, options(async () => {
    calls += 1;
    return calls === 1 ? pending() : response(200);
  }, { requestTimeoutMs: 8 })), { waited: true });
  assert.equal(calls, 2);
});

test('per-attempt timeout also retries a response body that never resolves', { timeout: 3000 }, async () => {
  let calls = 0;
  assert.deepEqual(await waitForService(endpoint, options(async () => {
    calls += 1;
    return calls === 1 ? { ok: true, status: 200, json: pending } : response(200);
  }, { requestTimeoutMs: 8 })), { waited: true });
  assert.equal(calls, 2);
});

test('an already cancelled health wait rejects without sending a request', async () => {
  const controller = new AbortController();
  controller.abort(new Error('private-token'));
  let calls = 0;
  await assert.rejects(waitForService(endpoint, options(async () => { calls += 1; }, {
    signal: controller.signal,
  })), safeError('CONNECTION_CANCELLED'));
  assert.equal(calls, 0);
});

test('outer cancellation releases a fetch that ignores AbortSignal', { timeout: 3000 }, async () => {
  const controller = new AbortController();
  const statuses = [];
  let requestSignal;
  const timer = setTimeout(() => controller.abort(new Error('private-token')), 10);
  try {
    await assert.rejects(waitForService(endpoint, options(async (_url, init) => {
      requestSignal = init.signal;
      return pending();
    }, { signal: controller.signal, onStatus: (value) => statuses.push(value) })), safeError('CONNECTION_CANCELLED'));
    assert.equal(requestSignal.aborted, true);
    assert.equal(statuses.some((value) => value.phase === 'ready'), false);
  } finally { clearTimeout(timer); }
});

test('outer cancellation releases a hanging JSON body', { timeout: 3000 }, async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10);
  try {
    await assert.rejects(waitForService(endpoint, options(async () => ({ ok: true, status: 200, json: pending }), {
      signal: controller.signal,
    })), safeError('CONNECTION_CANCELLED'));
  } finally { clearTimeout(timer); }
});

test('outer cancellation interrupts the polling delay without another request', { timeout: 3000 }, async () => {
  const controller = new AbortController();
  let calls = 0;
  const timer = setTimeout(() => controller.abort(), 10);
  try {
    await assert.rejects(waitForService(endpoint, options(async () => { calls += 1; return response(503); }, {
      signal: controller.signal,
      pollIntervalMs: 100,
    })), safeError('CONNECTION_CANCELLED'));
    assert.equal(calls, 1);
  } finally { clearTimeout(timer); }
});

test('total timeout releases a hanging fetch even when its attempt limit is longer', { timeout: 3000 }, async () => {
  let requestSignal;
  await assert.rejects(waitForService(endpoint, options(async (_url, init) => {
    requestSignal = init.signal;
    return pending();
  }, { timeoutMs: 20, requestTimeoutMs: 200 })), safeError('CONNECTION_TIMEOUT'));
  assert.equal(requestSignal.aborted, true);
});

test('total timeout releases a hanging JSON body', { timeout: 3000 }, async () => {
  await assert.rejects(waitForService(endpoint, options(async () => ({ ok: true, status: 200, json: pending }), {
    timeoutMs: 20,
    requestTimeoutMs: 200,
  })), safeError('CONNECTION_TIMEOUT'));
});

test('total timeout interrupts polling and does not expose the server error body', { timeout: 3000 }, async () => {
  let calls = 0;
  const statuses = [];
  await assert.rejects(waitForService(endpoint, options(async () => {
    calls += 1;
    return response(503, { error: 'upstream-secret database-password' });
  }, {
    timeoutMs: 20,
    pollIntervalMs: 100,
    onStatus: (value) => statuses.push(value),
  })), safeError('CONNECTION_TIMEOUT'));
  assert.equal(calls, 1);
  assert.equal(statuses.some((value) => value.phase === 'ready'), false);
});

test('agent waits for Render health then submits exactly one authenticated business request', { timeout: 3000 }, async () => {
  const calls = [];
  const statuses = [];
  const result = await requestAgentPlan('整理参会名单', {}, {
    endpoint,
    token: 'relay-access-token',
    connectionTimeoutMs: 300,
    connectionPollIntervalMs: 1,
    connectionRequestTimeoutMs: 60,
    onStatus: (value) => statuses.push(value),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url === healthURL) {
        assertPublicHealthRequest(url, init);
        return response(calls.length === 1 ? 503 : 200);
      }
      assert.equal(url, 'https://internal-demo.onrender.com/api/agent');
      assert.equal(init.method, 'POST');
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer relay-access-token');
      assert.equal(JSON.parse(init.body).goal, '整理参会名单');
      return response(200, {
        mode: 'deepseek',
        summary: '待执行计划，需人工确认。',
        steps: [{ tool: 'lookup_people', label: '查询参会名单', reason: '仅查询已有记录。' }],
      });
    },
  });
  assert.equal(result.mode, 'deepseek');
  assert.deepEqual(calls.map(({ init }) => init.method), ['GET', 'GET', 'POST']);
  assert.equal(statuses[0].phase, 'connecting');
  assert.equal(statuses.at(-1).phase, 'ready');
});

test('agent freezes business context before the Render health wait', { timeout: 3000 }, async () => {
  const state = {
    meeting: { title: '启动时会议', topic: '原定议题', location: '原定会场' },
    participants: [{ name: '启动时参会人', organization: '示例企业', position: '经理', side: 'host', rank: 2 }],
    minutes: { input: '', output: '' },
  };
  const initialContext = {
    meeting: { title: '启动时会议', topic: '原定议题', location: '原定会场' },
    participants: [{ name: '启动时参会人', organization: '示例企业', position: '经理', side: 'host', rank: 2 }],
    hasMinutes: false,
  };
  let releaseHealth;
  let markHealthStarted;
  const healthResponse = new Promise((resolve) => { releaseHealth = resolve; });
  const healthStarted = new Promise((resolve) => { markHealthStarted = resolve; });
  const calls = [];
  const request = requestAgentPlan('整理参会名单', state, {
    endpoint,
    token: 'relay-access-token',
    connectionTimeoutMs: 300,
    connectionRequestTimeoutMs: 200,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url === healthURL) {
        assertPublicHealthRequest(url, init);
        markHealthStarted();
        return healthResponse;
      }
      return response(200, {
        mode: 'deepseek',
        summary: '待执行计划，需人工确认。',
        steps: [{ tool: 'lookup_people', label: '查询参会名单', reason: '仅查询已有记录。' }],
      });
    },
  });
  await healthStarted;
  assert.deepEqual(calls.map(({ init }) => init.method), ['GET']);
  state.meeting.title = '等待期间改名';
  state.meeting.topic = '等待期间新议题';
  state.participants[0].name = '等待期间改名的参会人';
  state.participants[0].rank = 5;
  state.participants.push({ name: '等待期间新增参会人', side: 'guest', rank: 1 });
  state.minutes.input = '等待期间新增的会议原始记录';
  releaseHealth(response(200));
  await request;
  assert.deepEqual(calls.map(({ init }) => init.method), ['GET', 'POST']);
  assert.equal(calls[1].url, 'https://internal-demo.onrender.com/api/agent');
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    goal: '整理参会名单',
    context: initialContext,
  });
});
