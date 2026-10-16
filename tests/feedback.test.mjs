import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEEDBACK_ENDPOINT, FEEDBACK_TICKET_ENDPOINT, FEEDBACK_MAX_LENGTH, FeedbackError, countFeedbackCharacters,
  validateFeedbackContent, createFeedbackRequestId, createFeedbackPayload,
  getFeedbackDevice, escapeFeedbackHTML, submitFeedback, listFeedback,
} from '../src/feedback.js';

const REQUEST_ID = '9be052c6-71ab-4e38-8944-3b5a9d574e5d';
const ticketResult = { ticket: 'test-feedback-ticket.signed', expiresAt: '2099-10-16T02:00:00.000Z' };
const item = { id: 'feedback-1', content: '建议增加会议材料预览。', createdAt: '2026-10-16T02:00:00.000Z', page: 'meeting', device: 'desktop', url: 'https://example.com/feedback/1' };
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const payload = (content = item.content) => createFeedbackPayload({ content, requestId: REQUEST_ID, page: item.page, device: item.device });

test('feedback validates trimmed content with a Unicode code point limit', () => {
  assert.equal(FEEDBACK_MAX_LENGTH, 1000);
  assert.equal(countFeedbackCharacters('中😀文'), 3);
  assert.equal(validateFeedbackContent('  建议\n增加预览。  '), '建议\n增加预览。');
  assert.equal(countFeedbackCharacters(validateFeedbackContent(' 😀'.trim().repeat(1000))), 1000);
  for (const value of ['', ' \n\t\u3000', null, 3]) assert.throws(() => validateFeedbackContent(value), { code: 'EMPTY_CONTENT' });
  assert.throws(() => validateFeedbackContent('😀'.repeat(1001)), { code: 'CONTENT_TOO_LONG' });
});

test('request IDs use UUID randomness and existing IDs stay stable for retries', () => {
  assert.equal(createFeedbackRequestId({ randomUUID: () => REQUEST_ID }), REQUEST_ID);
  const fallback = createFeedbackRequestId({ getRandomValues: (bytes) => bytes.fill(0) });
  assert.equal(fallback, '00000000-0000-4000-8000-000000000000');
  assert.throws(() => createFeedbackRequestId({}), { code: 'REQUEST_ID_UNAVAILABLE' });
  assert.equal(payload().requestId, REQUEST_ID);
  assert.throws(() => createFeedbackPayload({ content: '建议', requestId: 'invalid' }), { code: 'INVALID_REQUEST_ID' });
});

test('feedback payload projects only allowed fields and page/device enums', () => {
  const body = createFeedbackPayload({ content: '  建议。 ', requestId: REQUEST_ID, page: 'https://example.com/app?token=secret#private', device: '桌面浏览器', website: 'spam', apiKey: 'secret', participants: ['not-sent'] });
  assert.deepEqual(body, { content: '建议。', requestId: REQUEST_ID, page: 'feedback', device: 'unknown', website: '' });
  for (const page of ['agent', 'meeting', 'news', 'documents', 'knowledge', 'feedback', 'dashboard']) {
    assert.equal(createFeedbackPayload({ content: '建议', requestId: REQUEST_ID, page }).page, page);
  }
  for (const device of ['desktop', 'mobile', 'tablet', 'unknown']) {
    assert.equal(createFeedbackPayload({ content: '建议', requestId: REQUEST_ID, device }).device, device);
  }
});

test('device labels are coarse and HTML text is escaped instead of interpreted', () => {
  assert.equal(getFeedbackDevice({ userAgent: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36' }), 'desktop');
  assert.equal(getFeedbackDevice({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1' }), 'mobile');
  assert.equal(getFeedbackDevice({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Safari/604.1' }), 'tablet');
  assert.equal(getFeedbackDevice({}), 'unknown');
  assert.equal(escapeFeedbackHTML('<img src=x onerror="alert(1)"> & \'test\''), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;test&#39;');
});

test('public submission gets a UUID-only ticket then sends JSON with X-Feedback-Ticket and no Bearer', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(options.method === 'GET' ? ticketResult : { item, duplicate: false });
  };
  const body = payload();
  const result = await submitFeedback(body, { token: 'model-token-must-never-be-forwarded', fetchImpl });
  assert.deepEqual(result, { item, duplicate: false, requestId: REQUEST_ID });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${FEEDBACK_TICKET_ENDPOINT}?requestId=${REQUEST_ID}`);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[0].options.headers['X-Feedback-Ticket'], undefined);
  assert.deepEqual([...new URL(calls[0].url).searchParams.keys()], ['requestId']);
  assert.equal(calls[1].url, FEEDBACK_ENDPOINT);
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[1].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[1].options.headers['X-Feedback-Ticket'], ticketResult.ticket);
  assert.deepEqual(JSON.parse(calls[1].options.body), body);
  for (const call of calls) {
    assert.equal(call.options.headers.Authorization, undefined);
    assert.equal(call.options.headers.Origin, undefined);
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.referrerPolicy, 'no-referrer');
    assert.ok(!JSON.stringify(call).includes('model-token-must-never-be-forwarded'));
  }
});

test('retrying the same feedback fetches a fresh ticket and preserves its idempotency UUID', async () => {
  let ticketCount = 0;
  let posts = 0;
  const body = payload();
  const fetchImpl = async (url, options) => {
    if (options.method === 'GET') {
      assert.equal(url, `${FEEDBACK_TICKET_ENDPOINT}?requestId=${REQUEST_ID}`);
      ticketCount += 1;
      return jsonResponse({ ...ticketResult, ticket: `fresh-ticket-${ticketCount}` });
    }
    posts += 1;
    assert.equal(JSON.parse(options.body).requestId, REQUEST_ID);
    assert.equal(options.headers['X-Feedback-Ticket'], `fresh-ticket-${posts}`);
    if (posts === 1) throw new Error('connection-lost-after-write');
    return jsonResponse({ item, duplicate: true });
  };
  await assert.rejects(submitFeedback(body, { fetchImpl }), { code: 'NETWORK_ERROR', requestId: REQUEST_ID });
  const retried = await submitFeedback(body, { fetchImpl });
  assert.equal(retried.duplicate, true);
  assert.equal(ticketCount, 2);
  assert.equal(posts, 2);
});

test('ticket errors and malformed tickets prevent POST and retain safe retry details', async () => {
  for (const [response, code] of [
    [jsonResponse({ error: 'SECRET ticket signing details' }, 503), 'SERVICE_UNAVAILABLE'],
    [jsonResponse({ ticket: '', expiresAt: ticketResult.expiresAt }), 'INVALID_RESPONSE'],
    [jsonResponse({ ticket: 'unsafe\r\nheader', expiresAt: ticketResult.expiresAt }), 'INVALID_RESPONSE'],
    [jsonResponse({ ticket: ticketResult.ticket, expiresAt: 'invalid' }), 'INVALID_RESPONSE'],
    [jsonResponse({ ticket: ticketResult.ticket }), 'INVALID_RESPONSE'],
  ]) {
    let calls = 0;
    await assert.rejects(submitFeedback(payload(), { fetchImpl: async (_url, options) => {
      calls += 1;
      assert.equal(options.method, 'GET');
      return response;
    } }), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.requestId, REQUEST_ID);
      assert.ok(!error.message.includes('SECRET'));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('list parses pagination and keeps content plain while discarding unsafe URLs', async () => {
  let requestedURL;
  const maliciousItem = { ...item, content: '<script>alert(1)</script>\n原文保留', url: 'javascript:alert(1)' };
  const result = await listFeedback({ page: 2, token: 'separate-feedback-admin-token', fetchImpl: async (url, options) => {
    requestedURL = url;
    assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined);
    assert.equal(options.headers.Authorization, 'Bearer separate-feedback-admin-token');
    assert.equal(options.headers['X-Feedback-Ticket'], undefined);
    return jsonResponse({ items: [maliciousItem], hasMore: true, nextPage: 3 });
  } });
  assert.equal(requestedURL, `${FEEDBACK_ENDPOINT}?page=2`);
  assert.equal(result.items[0].content, maliciousItem.content);
  assert.equal(result.items[0].url, '');
  assert.equal(escapeFeedbackHTML(result.items[0].content), '&lt;script&gt;alert(1)&lt;/script&gt;\n原文保留');
  assert.equal(result.nextPage, 3);
  const empty = await listFeedback({ fetchImpl: async () => jsonResponse({ items: [], hasMore: false, nextPage: null }) });
  assert.deepEqual(empty, { items: [], hasMore: false, nextPage: null });
});

test('HTTP failures use safe messages without exposing response bodies or credentials', async () => {
  for (const [status, code] of [[400, 'INVALID_SUBMISSION'], [401, 'TICKET_INVALID'], [403, 'FORBIDDEN'], [409, 'REQUEST_CONFLICT'], [429, 'RATE_LIMITED'], [500, 'SERVICE_UNAVAILABLE']]) {
    await assert.rejects(submitFeedback(payload(), { fetchImpl: async (_url, options) => options.method === 'GET' ? jsonResponse(ticketResult) : jsonResponse({ error: 'SECRET upstream stack token=private' }, status) }), (error) => {
      assert.ok(error instanceof FeedbackError);
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      assert.equal(error.requestId, REQUEST_ID);
      assert.ok(!error.message.includes('SECRET'));
      assert.ok(!error.message.includes('private'));
      return true;
    });
  }
});

test('timeouts and network errors are safe, retryable and retain the same request ID', async () => {
  await assert.rejects(submitFeedback(payload(), { timeoutMs: 5, fetchImpl: async () => new Promise(() => {}) }), (error) => {
    assert.equal(error.code, 'TIMEOUT');
    assert.equal(error.message, '连接超时，保留内容后可重试。');
    assert.equal(error.retryable, true);
    assert.equal(error.requestId, REQUEST_ID);
    return true;
  });
  await assert.rejects(submitFeedback(payload(), { fetchImpl: async () => { throw new Error('private-network-debug'); } }), (error) => {
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.equal(error.retryable, true);
    assert.ok(!error.message.includes('private-network-debug'));
    return true;
  });
});

test('cancelled and invalid submissions never call fetch', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return jsonResponse({ item }); };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(submitFeedback(payload(), { signal: controller.signal, fetchImpl }), { code: 'CANCELLED' });
  await assert.rejects(submitFeedback({ ...payload(), content: '  ' }, { fetchImpl }), { code: 'EMPTY_CONTENT' });
  await assert.rejects(listFeedback({ page: 0, fetchImpl }), { code: 'INVALID_PAGE' });
  assert.equal(calls, 0);
});

test('malformed responses and broken pagination fail with a safe error', async () => {
  const brokenPages = [
    { items: {}, hasMore: false },
    { items: [], hasMore: true, nextPage: 1 },
    { items: [], hasMore: true, nextPage: '2' },
    { items: [{ ...item, createdAt: 'not-a-date' }], hasMore: false },
    { items: [{ ...item, content: 'a'.repeat(1001) }], hasMore: false },
  ];
  for (const body of brokenPages) await assert.rejects(listFeedback({ fetchImpl: async () => jsonResponse(body) }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(listFeedback({ fetchImpl: async () => new Response('<h1>private failure</h1>', { status: 200 }) }), { code: 'INVALID_RESPONSE' });
});
