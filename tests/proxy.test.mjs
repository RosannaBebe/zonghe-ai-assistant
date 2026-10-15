import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const relayURL = new URL('../server/ai-proxy.mjs', import.meta.url).href;
const relayPath = fileURLToPath(relayURL);
const TEST_KEY = 'test-only-secret-key-never-a-real-credential';
const TEST_TOKEN = 'test-only-access-token-at-least-24-characters';
const ALLOWED_ORIGIN = 'http://localhost:4173';

// An explicit, minimal environment prevents inherited keys, NODE_OPTIONS,
// or a developer's .env from affecting any child process in these tests.
const testEnvironment = {
  HOST: '127.0.0.1',
  PORT: '8787',
  DEEPSEEK_API_KEY: TEST_KEY,
  DEMO_ACCESS_TOKEN: TEST_TOKEN,
  DEEPSEEK_MODEL: 'deepseek-chat',
  ALLOWED_ORIGIN,
};

let child;
let baseURL;
let childOutput = '';
const upstreamCalls = [];

before(async () => {
  // The child binds an ephemeral loopback port and injects a fake fetch.
  // Even a valid request cannot access the real DeepSeek service.
  const bootstrap = `
    import { createRelayServer, readConfig } from ${JSON.stringify(relayURL)};
    const config = readConfig();
    const server = createRelayServer(config, {
      fetchImpl: async (url, options) => {
        process.send({ type: 'upstream', url, authorization: options.headers.Authorization, body: JSON.parse(options.body) });
        return new Response(JSON.stringify({ choices: [{ message: { content: '  测试草稿：需要人工复核。  ' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    });
    server.listen(0, '127.0.0.1', () => process.send({ type: 'ready', port: server.address().port }));
    process.once('SIGTERM', () => {
      server.close(() => process.exit(0));
      server.closeAllConnections();
    });
  `;
  child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], {
    env: { ...testEnvironment },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.on('data', (chunk) => { childOutput += chunk; });
  child.stderr.on('data', (chunk) => { childOutput += chunk; });
  child.on('message', (message) => {
    if (message.type === 'upstream') upstreamCalls.push(message);
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Local relay did not start: ${childOutput}`)), 5000);
    const onMessage = (message) => {
      if (message.type !== 'ready') return;
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('message', onMessage);
      resolve(message.port);
    };
    const onExit = (code) => {
      clearTimeout(timer);
      child.off('message', onMessage);
      reject(new Error(`Local relay exited with ${code}: ${childOutput}`));
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  baseURL = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  await exited;
  clearTimeout(timer);
});

async function request(path, options = {}) {
  const response = await fetch(`${baseURL}${path}`, {
    ...options,
    headers: { Origin: ALLOWED_ORIGIN, ...options.headers },
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, json: text ? JSON.parse(text) : null };
}

function postBody(body, headers = {}) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}`, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

test('relay health is minimal, allows only configured CORS and never exposes credentials', async () => {
  const result = await request('/health');
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { ok: true, service: 'ai-relay' });
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(result.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assert.equal(result.headers.get('vary'), 'Origin');
  assert.ok(!result.text.includes(TEST_KEY));
  assert.ok(!result.text.includes(TEST_TOKEN));
  assert.ok(!childOutput.includes(TEST_KEY));
  assert.ok(!childOutput.includes(TEST_TOKEN));
  assert.equal(upstreamCalls.length, 0);
});

test('wrong origins are rejected before health, preflight or generation', async () => {
  const count = upstreamCalls.length;
  for (const [path, method] of [['/health', 'GET'], ['/api/generate', 'OPTIONS'], ['/api/generate', 'POST']]) {
    const result = await request(path, { method, headers: { Origin: 'https://untrusted.example' } });
    assert.equal(result.status, 403);
    assert.equal(result.json.error.code, 'ORIGIN_FORBIDDEN');
    assert.equal(result.headers.get('access-control-allow-origin'), null);
  }
  assert.equal(upstreamCalls.length, count);
});

test('preflight is bounded, unknown paths are 404 and generation rejects other methods', async () => {
  const count = upstreamCalls.length;
  const preflight = await request('/api/generate', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.text, '');
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Content-Type, Authorization');
  const missing = await request('/missing');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'NOT_FOUND');
  const method = await request('/api/generate');
  assert.equal(method.status, 405);
  assert.equal(method.json.error.code, 'METHOD_NOT_ALLOWED');
  assert.equal(method.headers.get('allow'), 'POST, OPTIONS');
  assert.equal(upstreamCalls.length, count);
});

test('missing and incorrect access tokens fail without calling upstream', async () => {
  const count = upstreamCalls.length;
  for (const authorization of ['', 'Bearer incorrect', `Basic ${TEST_TOKEN}`]) {
    const result = await request('/api/generate', postBody({ task: 'minutes', input: '测试记录。' }, { Authorization: authorization }));
    assert.equal(result.status, 401);
    assert.equal(result.json.error.code, 'UNAUTHORIZED');
    assert.ok(!result.text.includes(TEST_KEY));
    assert.ok(!result.text.includes(TEST_TOKEN));
  }
  assert.equal(upstreamCalls.length, count);
});

test('invalid body, task, input and context are rejected locally with useful error codes', async (t) => {
  const cases = [
    ['non-JSON content type', postBody('{}', { 'Content-Type': 'text/plain' }), 415, 'JSON_REQUIRED'],
    ['malformed JSON', postBody('{broken'), 400, 'INVALID_JSON'],
    ['JSON array', postBody('[]'), 400, 'INVALID_REQUEST'],
    ['JSON null', postBody('null'), 400, 'INVALID_REQUEST'],
    ['unsupported task', postBody({ task: 'publish', input: '示例' }), 400, 'INVALID_TASK'],
    ['inherited object key is not a task', postBody({ task: '__proto__', input: '示例' }), 400, 'INVALID_TASK'],
    ['missing input', postBody({ task: 'minutes' }), 400, 'INPUT_REQUIRED'],
    ['blank input', postBody({ task: 'minutes', input: '  \n ' }), 400, 'INPUT_REQUIRED'],
    ['oversized input', postBody({ task: 'minutes', input: 'a'.repeat(18001) }), 413, 'INPUT_TOO_LONG'],
    ['non-object context', postBody({ task: 'minutes', input: '示例', context: '说明' }), 400, 'INVALID_CONTEXT'],
    ['array context', postBody({ task: 'minutes', input: '示例', context: [] }), 400, 'INVALID_CONTEXT'],
    ['oversized context', postBody({ task: 'minutes', input: '示例', context: { text: 'a'.repeat(8000) } }), 413, 'CONTEXT_TOO_LONG'],
    ['oversized body', postBody(' '.repeat(65537)), 413, 'BODY_TOO_LARGE'],
  ];
  for (const [name, options, status, code] of cases) {
    await t.test(name, async () => {
      const count = upstreamCalls.length;
      const result = await request('/api/generate', options);
      assert.equal(result.status, status);
      assert.equal(result.json.error.code, code);
      assert.equal(typeof result.json.error.message, 'string');
      assert.equal(upstreamCalls.length, count);
    });
  }
});

test('valid generation uses the server-side key and returns only the expected public result', async () => {
  const count = upstreamCalls.length;
  const result = await request('/api/generate', postBody({ task: 'minutes', input: '  待办：整理清单。  ', context: { title: '测试会议' } }));
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { text: '测试草稿：需要人工复核。', mode: 'deepseek', model: 'deepseek-chat' });
  assert.ok(!result.text.includes(TEST_KEY));
  assert.ok(!result.text.includes(TEST_TOKEN));
  // IPC and HTTP are separate channels; wait briefly for the already sent event.
  for (let i = 0; upstreamCalls.length === count && i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(upstreamCalls.length, count + 1);
  const call = upstreamCalls.at(-1);
  assert.equal(call.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(call.authorization, `Bearer ${TEST_KEY}`);
  assert.equal(call.body.model, 'deepseek-chat');
  assert.equal(call.body.stream, false);
  assert.match(call.body.messages[0].content, /待人工审核/);
  assert.match(call.body.messages[1].content, /待办：整理清单/);
});

async function runCLI(overrides) {
  const processChild = spawn(process.execPath, [relayPath], {
    env: { ...testEnvironment, ...overrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  processChild.stdout.on('data', (chunk) => { output += chunk; });
  processChild.stderr.on('data', (chunk) => { output += chunk; });
  const timer = setTimeout(() => processChild.kill('SIGKILL'), 5000);
  const [code, signal] = await once(processChild, 'exit');
  clearTimeout(timer);
  return { code, signal, output };
}

test('CLI refuses absent keys and unsafe configuration without reading a local .env', async (t) => {
  const cases = [
    ['missing API key', { DEEPSEEK_API_KEY: '' }, /DEEPSEEK_API_KEY/],
    ['public host without access token', { HOST: '0.0.0.0', DEMO_ACCESS_TOKEN: '' }, /DEMO_ACCESS_TOKEN/],
    ['short access token', { DEMO_ACCESS_TOKEN: 'short' }, /24/],
    ['wildcard origin', { ALLOWED_ORIGIN: '*' }, /ALLOWED_ORIGIN/],
    ['origin with a path', { ALLOWED_ORIGIN: 'https://example.com/app' }, /ALLOWED_ORIGIN/],
    ['invalid port', { PORT: '0' }, /PORT/],
    ['unsupported model', { DEEPSEEK_MODEL: 'unlisted-model' }, /DEEPSEEK_MODEL/],
  ];
  for (const [name, overrides, error] of cases) {
    await t.test(name, async () => {
      const result = await runCLI(overrides);
      assert.equal(result.code, 1);
      assert.equal(result.signal, null);
      assert.match(result.output, error);
      assert.ok(!result.output.includes(TEST_KEY));
      assert.ok(!result.output.includes(TEST_TOKEN));
    });
  }
});
