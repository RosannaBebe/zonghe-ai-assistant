import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as domain from '../src/domain.js';
import * as exportsModule from '../src/exports.js';
import * as agent from '../src/agent.js';

const appPath = new URL('../src/app.js', import.meta.url);
const appSource = readFileSync(appPath, 'utf8').replace(/^import [^\n]*;\r?\n/gm, '');
const decode = (text) => text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ({
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
})[entity]);

/**
 * Loads the real application and its listeners into an isolated browser fixture.
 * Only imports are injected: application functions and control flow are unchanged.
 * The small DOM fixture tracks controls; it is not a layout/browser replacement.
 */
function createApp() {
  const listeners = new Map();
  const storage = new Map();
  const session = new Map();
  const nodes = new Map();
  const controls = [];
  const downloads = [];
  const attributes = (source) => Object.fromEntries([...source.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)].map((match) => [match[1], decode(match[2])]));
  const datasetOf = (attrs) => Object.fromEntries(Object.entries(attrs).filter(([name]) => name.startsWith('data-')).map(([name, value]) => [name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value]));

  function makeNode(properties = {}) {
    let html = '';
    const classes = new Set();
    const node = {
      value: '', textContent: '', disabled: false, open: false, dataset: {}, className: '',
      style: {}, checked: false, selectionStart: 0,
      classList: { add: (...names) => names.forEach((name) => classes.add(name)), remove: (...names) => names.forEach((name) => classes.delete(name)), contains: (name) => classes.has(name), toggle(name, force) { const enabled = force ?? !classes.has(name); if (enabled) classes.add(name); else classes.delete(name); return enabled; } },
      addEventListener() {}, close() { this.open = false; }, showModal() { this.open = true; },
      focus() {}, setSelectionRange() {}, getBoundingClientRect: () => ({ left: 0, right: 1, top: 0, bottom: 1 }),
      setAttribute(name, value) { if (name === 'disabled') this.disabled = true; else this[name] = String(value); },
      removeAttribute(name) { if (name === 'disabled') this.disabled = false; else delete this[name]; },
      closest() { return this; }, querySelector: (selector) => document.querySelector(selector),
      ...properties,
    };
    Object.defineProperty(node, 'innerHTML', {
      get: () => html,
      set(value) { html = String(value); if (node.id === 'app') hydrate(html); },
      configurable: true,
    });
    return node;
  }

  function hydrate(html) {
    controls.length = 0;
    for (const key of [...nodes.keys()]) if (!['#app', '#modal', '#toast', '#csv-file', '#text-file'].includes(key)) nodes.delete(key);
    for (const match of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
      const attrs = attributes(match[1]);
      const node = makeNode({ dataset: datasetOf(attrs), disabled: /\bdisabled(?:\s|$|=)/.test(match[1]), textContent: decode(match[2].replace(/<[^>]+>/g, '')) });
      node.innerHTML = match[2];
      controls.push(node);
      if (attrs.id) nodes.set(`#${attrs.id}`, node);
    }
    for (const match of html.matchAll(/<(input|textarea|span|div)\b([^>]*\bid="[^"]+"[^>]*)>/g)) {
      const attrs = attributes(match[2]);
      if (!nodes.has(`#${attrs.id}`)) nodes.set(`#${attrs.id}`, makeNode({ id: attrs.id, value: attrs.value || '', dataset: datasetOf(attrs) }));
    }
  }

  const document = {
    body: makeNode(),
    title: '',
    querySelector(selector) {
      if (nodes.has(selector)) return nodes.get(selector);
      const action = /\[data-action=["']([^"']+)["']\]/.exec(selector)?.[1];
      return action ? controls.find((node) => node.dataset.action === action) || null : null;
    },
    querySelectorAll(selector) {
      return [...new Set(selector.split(',').map((part) => this.querySelector(part.trim())).filter(Boolean))];
    },
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(callback); },
    createElement: () => makeNode(),
  };
  for (const id of ['app', 'modal', 'toast', 'csv-file', 'text-file']) nodes.set(`#${id}`, makeNode({ id }));
  const context = vm.createContext({
    ...domain, ...exportsModule, ...agent,
    isMobile: () => false,
    renderMobileNav: () => '', enhanceMobileTables() {}, installMobileEnhancements() {},
    renderMobileSeatList: () => '', openMaterialPreview() {}, openSeatMapViewer() {}, shareOrDownloadFile() {},
    renderFeedbackPage: () => '<h1>反馈记录</h1>', initializeFeedbackUI() {}, ensureFeedbackLoaded() {},
    esc: exportsModule.escapeHtml,
    downloadDocx: (...args) => downloads.push(args),
    document, console, Date, Math, JSON, URL, AbortSignal, performance,
    location: { hash: '#meeting' },
    window: { addEventListener() {}, scrollTo() {} },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    sessionStorage: { getItem: (key) => session.get(key) || null, setItem: (key, value) => session.set(key, value) },
    FormData: class { constructor(form) { this.fields = new Map(Object.entries(form.fields || {})); } get(name) { return this.fields.get(name) ?? null; } has(name) { return this.fields.has(name); } },
    requestAnimationFrame: (callback) => callback(),
    setTimeout: () => 1, clearTimeout() {},
    fetch: async () => { throw new Error('Unexpected network request in an isolated app test.'); },
  });
  vm.runInContext(`${appSource}\n;globalThis.__appTest = { getState: () => state, makeMinutes, reviewMinutes, modal, go, render };`, context, { filename: appPath.pathname });
  const api = context.__appTest;
  const dispatch = async (type, target) => {
    for (const callback of listeners.get(type) || []) await callback({ target, preventDefault() {} });
  };
  return {
    api, downloads, nodes,
    get state() { return api.getState(); },
    control: (action) => document.querySelector(`[data-action="${action}"]`),
    click: (action, extras = {}) => dispatch('click', makeNode({ dataset: { action, ...extras } })),
    submit: (id, fields) => dispatch('submit', { id, fields }),
    input: (id, value, dataset = {}) => dispatch('input', makeNode({ id, value, dataset })),
    connect(fetchImpl) {
      storage.set('zhixing-model', JSON.stringify({ endpoint: 'https://relay.example/api/generate', consent: true }));
      context.fetch = fetchImpl;
    },
  };
}

test('re-review replaces the single meeting task batch and preserves surviving task progress', async () => {
  const app = createApp();
  app.state.minutes.input = '待办：张三负责汇总台账，截止2026-10-25。\n待办：李四负责联系会场，截止2026-10-26。';
  await app.api.makeMinutes();
  app.api.reviewMinutes();
  assert.equal(app.state.tasks.length, 2);
  const survivingId = app.state.tasks.find((task) => task.owner === '张三').id;
  app.state.tasks.find((task) => task.id === survivingId).status = '已完成';
  app.state.minutes.input = '待办：张三负责汇总台账，截止2026-10-25。';
  await app.api.makeMinutes();
  app.api.reviewMinutes();
  assert.equal(app.state.tasks.length, 1, 'the workbench has one meeting; only its current source actions should remain');
  assert.equal(app.state.tasks.some((task) => task.owner === '李四'), false, 'a removed source action must not remain active');
  assert.equal(app.state.tasks.find((task) => task.id === survivingId).status, '已完成');
});

test('changing meeting metadata revokes approval and prevents reviewing or exporting the old draft', async () => {
  for (const [field, value] of Object.entries({ title: '更名后的会议', date: '2026-11-01', time: '13:30', location: '第二会议室', host: '经营管理部', topic: '新议题' })) {
    const app = createApp();
    await app.api.makeMinutes();
    app.api.reviewMinutes();
    const fields = Object.fromEntries(['title', 'date', 'time', 'location', 'host', 'topic'].map((name) => [name, app.state.meeting[name]]));
    fields[field] = value;
    await app.submit('meeting-form', fields);
    assert.equal(app.state.minutes.reviewed, false, `${field} changes must revoke the old approval`);
    assert.throws(() => app.api.reviewMinutes(), /会议|变化|重新/, `${field} must require a fresh draft`);
    await app.click('export-minutes');
    assert.equal(app.downloads.length, 0, 'a stale approved draft cannot be exported');
  }
});

test('a late model response cannot overwrite data after the user resets the workspace', async () => {
  const app = createApp();
  let respond;
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  app.connect(() => new Promise((resolve) => { respond = resolve; requestStarted(); }));
  app.state.minutes.input = '重置前的记录：待办：张三负责准备会场。';
  const pending = app.api.makeMinutes();
  await started;
  await app.click('reset-confirm');
  const freshMinutes = JSON.stringify(app.state.minutes);
  respond({ ok: true, json: async () => ({ mode: 'deepseek', text: '重置前请求的迟到结果' }) });
  await Promise.allSettled([pending]);
  assert.equal(JSON.stringify(app.state.minutes), freshMinutes);
  assert.equal(app.state.tasks.length, 0);
});

test('modal titles and subtitles render imported names as text while retaining trusted body markup', () => {
  const app = createApp();
  app.api.modal('<img src=x onerror="alert(1)">', '移除 <svg onload="alert(2)"> 后需确认。', '<p class="trusted-body">正文</p>');
  const html = app.nodes.get('#modal').innerHTML;
  assert.match(html, /<h2>&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;<\/h2>/);
  assert.match(html, /移除 &lt;svg onload=&quot;alert\(2\)&quot;&gt; 后需确认/);
  assert.doesNotMatch(html, /<img\b|<svg\s+onload/);
  assert.match(html, /<p class="trusted-body">正文<\/p>/);
});

test('editing reviewed minutes or an action immediately restores review and blocks export', async () => {
  const app = createApp();
  await app.api.makeMinutes();
  app.api.reviewMinutes();
  app.api.go('meeting', 'minutes');
  assert.equal(app.control('review-minutes').disabled, true);
  assert.equal(app.control('export-minutes').disabled, false);

  await app.input('minutes-output', `${app.state.minutes.output}\n补充人工核对说明。`);
  assert.equal(app.state.minutes.reviewed, false);
  assert.equal(app.control('review-minutes').disabled, false, 'the user can review again without navigating away');
  assert.equal(app.control('export-minutes').disabled, true);
  app.api.reviewMinutes();
  app.api.render();
  await app.input('task-owner-0', '已核实的负责人', { draftIndex: '0', draftField: 'owner' });
  assert.equal(app.state.minutes.reviewed, false);
  assert.equal(app.control('review-minutes').disabled, false);
  assert.equal(app.control('export-minutes').disabled, true);
});

test('typing and clearing a document draft immediately updates its export and utility controls', async () => {
  const app = createApp();
  app.api.go('documents');
  assert.equal(app.control('export-doc').disabled, true);
  await app.input('doc-output', '人工填写的完整公文草稿。');
  for (const action of ['export-doc', 'proof-doc', 'save-doc-knowledge']) assert.equal(app.control(action).disabled, false, `${action} should become available for a nonempty draft`);
  app.state.doc.reviewed = true;
  await app.input('doc-output', '');
  assert.equal(app.state.doc.reviewed, false);
  for (const action of ['export-doc', 'proof-doc', 'save-doc-knowledge']) assert.equal(app.control(action).disabled, true, `${action} should be blocked for an empty draft`);
});
