import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as feedbackClient from '../src/feedback.js';

const uiPath = new URL('../src/feedback-ui.js', import.meta.url);
const uiSource = readFileSync(uiPath, 'utf8')
  .replace(/^import\s*\{[\s\S]*?\}\s*from\s*'\.\/feedback.js';\s*/, '')
  .replace(/^export /gm, '');
const ADMIN_KEY = 'zhixing-feedback-admin';
const sampleItem = {
  id: 'feedback-one', content: '希望可以预览会议材料。', createdAt: '2026-10-16T02:00:00.000Z',
  page: 'meeting', device: 'desktop', url: 'https://github.com/example/private-feedback/issues/1',
};
const decode = (text) => text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ({
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
})[entity]);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/**
 * Runs the real UI module and event handlers with an isolated DOM/session fixture.
 * API boundaries are replaced with controllable promises; no network or layout
 * engine is involved. Assertions cover workflow state, not rendered snapshots.
 */
function createFeedbackUI({ page = 'feedback', storedToken = '' } = {}) {
  const listeners = new Map();
  const nodes = new Map();
  const session = new Map(storedToken ? [[ADMIN_KEY, storedToken]] : []);
  const submissions = [];
  const listCalls = [];
  const notifications = [];
  let currentPage = page;
  let rendered = '';
  let submitHandler = async () => { throw new Error('Unexpected submission in this test.'); };
  let listHandler = async () => { throw new Error('Unexpected private list request in this test.'); };

  function makeNode(id = '') {
    const ownListeners = new Map();
    const controls = new Map();
    const classes = new Set();
    let html = '';
    const node = {
      id, isConnected: false, open: false, value: '', textContent: '', disabled: false, dataset: {}, className: '', attributes: {},
      classList: {
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
        contains: (name) => classes.has(name),
      },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      addEventListener(type, callback) { ownListeners.set(type, callback); },
      dispatch(type, extra = {}) { ownListeners.get(type)?.({ type, target: this, preventDefault() {}, ...extra }); },
      showModal() { this.open = true; },
      close() { this.open = false; this.dispatch('close'); },
      focus() { document.activeElement = this; },
      querySelector(selector) {
        if (selector.startsWith('#')) return nodes.get(selector.slice(1)) || null;
        const action = /data-feedback-action="([^"]+)"/.exec(selector)?.[1];
        return controls.get(action) || null;
      },
      closest() { return this; },
      getBoundingClientRect: () => ({ left: 0, right: 600, top: 0, bottom: 600 }),
    };
    Object.defineProperty(node, 'innerHTML', {
      get: () => html,
      set(value) {
        html = String(value);
        if (node.id !== 'feedback-dialog') return;
        for (const childID of ['feedback-content', 'feedback-count', 'feedback-submit-status']) {
          const child = makeNode(childID);
          child.isConnected = true;
          nodes.set(childID, child);
        }
        nodes.get('feedback-content').value = decode(/<textarea[^>]*>([\s\S]*?)<\/textarea>/.exec(html)?.[1] || '');
        const submit = makeNode('feedback-submit-button');
        submit.dataset.feedbackAction = 'submit';
        controls.set('submit', submit);
        nodes.set(submit.id, submit);
      },
    });
    return node;
  }

  const document = {
    activeElement: makeNode('opener'),
    body: { appendChild(node) { node.isConnected = true; nodes.set(node.id, node); } },
    getElementById: (id) => nodes.get(id) || null,
    createElement: () => makeNode(),
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
  };
  const context = vm.createContext({
    ...feedbackClient,
    esc: feedbackClient.escapeFeedbackHTML,
    document, console, Date, Intl, URL, Map, AbortController,
    sessionStorage: { getItem: (key) => session.get(key) || null, setItem: (key, value) => session.set(key, value), removeItem: (key) => session.delete(key) },
    submitFeedback: async (payload) => {
      submissions.push(structuredClone(payload));
      return await submitHandler(payload);
    },
    listFeedback: async (options) => {
      listCalls.push(options);
      return await listHandler(options);
    },
  });
  vm.runInContext(`${uiSource}\nglobalThis.__feedbackUI = { initializeFeedbackUI, openFeedbackDialog, renderFeedbackPage, ensureFeedbackLoaded };`, context, { filename: uiPath.pathname });
  const ui = context.__feedbackUI;
  function render() {
    rendered = ui.renderFeedbackPage();
    // The application's app-root rerender leaves the body dialog intact.
    if (rendered.includes('id="feedback-admin-token"')) nodes.set('feedback-admin-token', makeNode('feedback-admin-token'));
    else nodes.delete('feedback-admin-token');
    return rendered;
  }
  ui.initializeFeedbackUI({ getPage: () => currentPage, navigate: (next) => { currentPage = next; render(); }, refresh: render, notify: (message) => notifications.push(message) });
  render();

  function dispatch(type, target) {
    for (const callback of listeners.get(type) || []) callback({ type, target, preventDefault() {} });
  }
  return {
    ui, session, submissions, listCalls, notifications, listeners, nodes,
    render,
    get html() { return rendered; },
    get textarea() { return nodes.get('feedback-content'); },
    get submitButton() { return nodes.get('feedback-submit-button'); },
    get status() { return nodes.get('feedback-submit-status')?.textContent || ''; },
    setPage(next) { currentPage = next; render(); },
    setAdminInput(token) { nodes.get('feedback-admin-token').value = token; },
    onSubmit(handler) { submitHandler = handler; },
    onList(handler) { listHandler = handler; },
    click(action) { const node = makeNode(); node.dataset.feedbackAction = action; dispatch('click', node); },
    input(value) { const node = nodes.get('feedback-content'); node.value = value; dispatch('input', node); },
    composition(type) { dispatch(type, nodes.get('feedback-content')); },
    escape() { nodes.get('feedback-dialog').dispatch('cancel'); },
    flush: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

test('anonymous feedback visitors never request private records, including after repeated renders', async () => {
  const app = createFeedbackUI();
  for (let i = 0; i < 3; i += 1) {
    app.render();
    await app.ui.ensureFeedbackLoaded();
  }
  app.ui.initializeFeedbackUI({});
  assert.equal(app.listeners.get('click').length, 1, 'reinitialization must not duplicate action handlers');
  assert.equal(app.listCalls.length, 0);
  assert.ok(app.nodes.has('feedback-admin-token'));
  assert.ok(!app.html.includes('在私有 GitHub 查看'));
});

test('stored admin credentials load only on the feedback route and only once until refreshed', async () => {
  const app = createFeedbackUI({ page: 'agent', storedToken: 'independent-feedback-admin-token' });
  app.onList(async () => ({ items: [], hasMore: false, nextPage: null }));
  await app.ui.ensureFeedbackLoaded();
  assert.equal(app.listCalls.length, 0);
  app.setPage('feedback');
  await app.ui.ensureFeedbackLoaded();
  await app.ui.ensureFeedbackLoaded();
  assert.equal(app.listCalls.length, 1);
  assert.equal(app.listCalls[0].token, 'independent-feedback-admin-token');
  assert.ok(!app.html.includes('independent-feedback-admin-token'));
  app.click('refresh');
  await app.flush();
  assert.equal(app.listCalls.length, 2);
});

test('a late private-list response cannot restore data or credentials after logout', async () => {
  const app = createFeedbackUI({ storedToken: 'old-admin-token' });
  const pending = deferred();
  app.onList(() => pending.promise);
  const loading = app.ui.ensureFeedbackLoaded();
  assert.equal(app.listCalls.length, 1);
  app.click('logout');
  assert.equal(app.session.has(ADMIN_KEY), false);
  assert.equal(app.listCalls[0].signal.aborted, true);
  pending.resolve({ items: [{ ...sampleItem, content: 'PRIVATE LATE RESPONSE' }], hasMore: false, nextPage: null });
  await loading;
  await app.flush();
  assert.ok(!app.render().includes('PRIVATE LATE RESPONSE'));
  assert.ok(!app.html.includes(sampleItem.url));
  assert.ok(app.nodes.has('feedback-admin-token'));
  assert.equal(app.session.has(ADMIN_KEY), false);
});

test('changing the admin session discards the old request even when it finishes after the new one', async () => {
  const app = createFeedbackUI({ storedToken: 'old-admin-token' });
  const oldRequest = deferred();
  const newRequest = deferred();
  app.onList(({ token }) => token === 'old-admin-token' ? oldRequest.promise : newRequest.promise);
  const originalLoad = app.ui.ensureFeedbackLoaded();
  app.click('logout');
  app.setAdminInput('new-admin-token');
  app.click('login');
  newRequest.resolve({ items: [{ ...sampleItem, content: 'NEW SESSION RECORD' }], hasMore: false, nextPage: null });
  await app.flush();
  assert.ok(app.html.includes('NEW SESSION RECORD'));
  oldRequest.resolve({ items: [{ ...sampleItem, content: 'OLD SESSION RECORD' }], hasMore: false, nextPage: null });
  await originalLoad;
  await app.flush();
  assert.ok(app.render().includes('NEW SESSION RECORD'));
  assert.ok(!app.html.includes('OLD SESSION RECORD'));
  assert.equal(app.session.get(ADMIN_KEY), 'new-admin-token');
});

test('1000 Unicode code points can submit, while 1001 stay editable without truncation and cannot submit', async () => {
  const app = createFeedbackUI({ page: 'meeting' });
  app.onSubmit(async () => ({ item: sampleItem, duplicate: false }));
  app.ui.openFeedbackDialog();
  app.input('😀'.repeat(1001));
  assert.equal(app.textarea.value.length, 2002, 'all user input remains present, including surrogate pairs');
  assert.equal(app.nodes.get('feedback-count').textContent, '1001/1000');
  assert.equal(app.submitButton.disabled, true);
  assert.match(app.status, /已超出 1 字/);
  app.click('submit');
  assert.equal(app.submissions.length, 0, 'dispatch must reject overlong input even if called programmatically');
  app.input('😀'.repeat(1000));
  assert.equal(app.nodes.get('feedback-count').textContent, '1000/1000');
  assert.equal(app.submitButton.disabled, false);
  app.click('submit');
  await app.flush();
  assert.equal(app.submissions.length, 1);
  assert.equal(feedbackClient.countFeedbackCharacters(app.submissions[0].content), 1000);
  assert.equal(app.submissions[0].page, 'meeting');
  assert.deepEqual(Object.keys(app.submissions[0]).sort(), ['content', 'device', 'page', 'requestId', 'website']);
});

test('IME composition stays editable and cannot accidentally trigger submission before composition ends', async () => {
  const app = createFeedbackUI();
  app.onSubmit(async () => ({ item: sampleItem, duplicate: false }));
  app.ui.openFeedbackDialog();
  app.composition('compositionstart');
  app.input('会议材料预览');
  assert.equal(app.textarea.value, '会议材料预览');
  assert.equal(app.submitButton.disabled, true);
  app.click('submit');
  assert.equal(app.submissions.length, 0);
  app.composition('compositionend');
  assert.equal(app.submitButton.disabled, false);
  assert.equal(app.textarea.value, '会议材料预览');
});

test('a network failure keeps the payload UUID for retry and editing creates a new UUID', async () => {
  const app = createFeedbackUI({ page: 'documents' });
  const requests = [];
  app.onSubmit(() => { const request = deferred(); requests.push(request); return request.promise; });
  app.ui.openFeedbackDialog();
  app.input('希望增加预览。');
  app.click('submit');
  const originalID = app.submissions[0].requestId;
  requests[0].reject(new feedbackClient.FeedbackError('NETWORK_ERROR', '暂时无法连接反馈服务。', { retryable: true }));
  await app.flush();
  assert.equal(app.textarea.value, '希望增加预览。');
  app.click('close');
  app.ui.openFeedbackDialog();
  assert.equal(app.textarea.value, '希望增加预览。');
  app.click('submit');
  assert.equal(app.submissions[1].requestId, originalID);
  requests[1].reject(new feedbackClient.FeedbackError('NETWORK_ERROR', '暂时无法连接反馈服务。', { retryable: true }));
  await app.flush();
  app.input('希望增加桌签预览。');
  app.click('submit');
  assert.notEqual(app.submissions[2].requestId, originalID);
  assert.equal(app.submissions[2].content, '希望增加桌签预览。');
  requests[2].resolve({ item: sampleItem, duplicate: false });
  await app.flush();
  assert.equal(app.textarea.value, '');
  assert.match(app.status, /反馈已保存/);
});

test('closing and reopening a pending submission cannot double-send and reports the background result', async () => {
  const app = createFeedbackUI();
  const pending = deferred();
  app.onSubmit(() => pending.promise);
  app.ui.openFeedbackDialog();
  app.input('关闭后仍需保留的反馈。');
  app.escape();
  app.ui.openFeedbackDialog();
  assert.equal(app.textarea.value, '关闭后仍需保留的反馈。');
  app.click('submit');
  app.click('submit');
  app.click('close');
  app.ui.openFeedbackDialog();
  assert.equal(app.textarea.disabled, true);
  assert.equal(app.submitButton.disabled, true);
  app.click('submit');
  assert.equal(app.submissions.length, 1);
  app.click('close');
  pending.resolve({ item: sampleItem, duplicate: false });
  await app.flush();
  assert.equal(app.notifications.length, 1);
  assert.match(app.notifications[0], /反馈已保存/);
  app.ui.openFeedbackDialog();
  assert.equal(app.textarea.value, '');
  assert.equal(app.submitButton.disabled, true);
});

test('authenticated feedback content is escaped and private issue links disappear after logout', async () => {
  const app = createFeedbackUI({ storedToken: 'feedback-admin-only' });
  app.onList(async () => ({ items: [{ ...sampleItem, content: '<img src=x onerror="alert(1)"> & 建议' }], hasMore: false, nextPage: null }));
  await app.ui.ensureFeedbackLoaded();
  assert.ok(app.html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; 建议'));
  assert.ok(!app.html.includes('<img src=x'));
  assert.ok(app.html.includes(sampleItem.url));
  app.click('logout');
  assert.ok(!app.html.includes(sampleItem.url));
  assert.ok(!app.html.includes('onerror'));
});
