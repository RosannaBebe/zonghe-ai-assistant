import {
  FEEDBACK_MAX_LENGTH,
  FeedbackError,
  countFeedbackCharacters,
  createFeedbackPayload,
  escapeFeedbackHTML as esc,
  getFeedbackDevice,
  listFeedback,
  submitFeedback,
} from './feedback.js';

const ADMIN_STORAGE_KEY = 'zhixing-feedback-admin';
const PAGE_NAMES = { agent: '智能体工作台', meeting: '会务助手', news: '政务信息助手', documents: '公文助手', knowledge: '综合知识库', feedback: '反馈记录', dashboard: '工作台' };
const DEVICE_NAMES = { desktop: '电脑', mobile: '手机', tablet: '平板', unknown: '未识别设备' };
const closeIcon = '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>';
const messageIcon = '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-4 3V11.5A7.5 7.5 0 0 1 9.5 4h3a7.5 7.5 0 0 1 7.5 7.5Z"/><path d="M7 10h8M7 14h5"/></svg>';
const spinner = '<span class="feedback-spinner" aria-hidden="true"></span>';

let callbacks = { getPage: () => 'feedback', navigate() {}, refresh() {}, notify() {} };
let initialized = false;
let dialog;
let opener;
let draft = '';
let draftPage = 'feedback';
let pendingPayload = null;
let submitting = false;
let composing = false;
let submissionError = '';
let submissionSaved = false;
let submissionConnectionStatus = '';
let adminToken = '';
let authenticated = false;
let items = [];
let hasMore = false;
let nextPage = null;
let attemptedLoad = false;
let loading = false;
let listError = '';
let listConnectionStatus = '';
let listRequest = null;
let listController = null;
let listGeneration = 0;

function currentPage() {
  const page = callbacks.getPage();
  return Object.hasOwn(PAGE_NAMES, page) ? page : 'feedback';
}

function refreshPage() {
  if (currentPage() === 'feedback') callbacks.refresh();
}

function readStoredToken() {
  try { return (globalThis.sessionStorage?.getItem(ADMIN_STORAGE_KEY) || '').trim(); }
  catch { return ''; }
}

function storeToken(token) {
  try {
    if (token) globalThis.sessionStorage?.setItem(ADMIN_STORAGE_KEY, token);
    else globalThis.sessionStorage?.removeItem(ADMIN_STORAGE_KEY);
  } catch { /* The current in-memory session remains usable. */ }
}

function safeError(error, fallback) {
  return error instanceof FeedbackError ? error.message : fallback;
}

function button(label, action, extra = '') {
  return `<button type="button" class="btn ${extra}" data-feedback-action="${action}">${label}</button>`;
}

function formatTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间待确认';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

function privateIssueURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function renderItem(item) {
  const url = privateIssueURL(item.url);
  return `<article class="feedback-card"><p class="feedback-card-content">${esc(item.content)}</p><div class="feedback-card-meta"><time datetime="${esc(item.createdAt)}">${esc(formatTime(item.createdAt))}</time><span>${esc(PAGE_NAMES[item.page] || '其他页面')}</span><span>${esc(DEVICE_NAMES[item.device] || DEVICE_NAMES.unknown)}</span>${authenticated && url ? `<a class="feedback-card-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">在私有 GitHub 查看 ↗</a>` : ''}</div></article>`;
}

/** Pure markup: rendering alone never fetches records or reads storage. */
export function renderFeedbackPage() {
  const heading = `<div class="page-title"><div><p class="eyebrow">PRODUCT FEEDBACK</p><h1>反馈记录</h1><p>问题与建议统一收集，由项目维护者查看和跟进。</p></div>${button(`${messageIcon}提交反馈`, 'open', 'primary')}</div>`;
  if (!adminToken) {
    return `${heading}<section class="feedback-panel feedback-admin-panel"><div class="feedback-intro"><h2>维护者查看</h2><p>反馈保存在私有 GitHub 仓库中，仅供项目维护者查看。提交反馈无需口令；查看记录需要独立的反馈管理口令。</p></div><form id="feedback-admin-form" class="feedback-form feedback-admin-form" data-feedback-form="admin" novalidate><label class="feedback-label" for="feedback-admin-token">反馈管理口令</label><input class="feedback-admin-input" id="feedback-admin-token" name="feedback-admin-token" type="password" autocomplete="off" spellcheck="false" aria-describedby="feedback-admin-hint" placeholder="输入反馈管理口令"><p class="feedback-hint" id="feedback-admin-hint">口令仅保存在当前浏览器会话，退出查看后清除。这与模型访问口令无关。</p>${listError ? `<p class="feedback-status is-error" role="alert">${esc(listError)}</p>` : ''}<div class="feedback-actions"><button type="submit" class="btn primary" data-feedback-action="login">查看反馈记录</button></div></form></section>`;
  }
  return `${heading}<section class="feedback-panel"><div class="feedback-list-header"><div><h2>${authenticated ? '已收集的反馈' : '验证管理权限'}</h2><p>${authenticated ? `已加载 ${items.length} 条 · 提交时间为北京时间` : '验证成功后才显示私有反馈记录。'}</p></div><div class="feedback-list-controls"><button type="button" class="btn small" data-feedback-action="refresh" ${loading ? 'disabled' : ''}>刷新</button>${button('退出查看', 'logout', 'small')}</div></div>${listError ? `<p class="feedback-status is-error" role="alert">${esc(listError)}</p>` : ''}<div class="feedback-list" aria-busy="${loading}">${authenticated ? items.map(renderItem).join('') : ''}</div>${loading ? `<div class="feedback-loading" role="status" aria-live="polite">${spinner}${esc(listConnectionStatus || (authenticated ? '正在加载反馈…' : '正在验证并读取反馈…'))}</div>` : authenticated && !items.length ? `<div class="feedback-empty">${messageIcon}<strong>暂时没有反馈</strong><p>收到的新建议会显示在这里。</p></div>` : !authenticated && !listError ? '<div class="feedback-empty"><p>正在准备读取反馈记录。</p></div>' : ''}${authenticated && hasMore ? `<div class="feedback-pagination"><button type="button" class="btn" data-feedback-action="more" ${loading ? 'disabled' : ''}>${loading ? '正在加载…' : '加载更多'}</button></div>` : authenticated && items.length && !loading ? '<div class="feedback-pagination"><p>已加载全部反馈</p></div>' : ''}</section>`;
}

function updateDialog() {
  if (!dialog) return;
  const textarea = dialog.querySelector('#feedback-content');
  const counter = dialog.querySelector('#feedback-count');
  const status = dialog.querySelector('#feedback-submit-status');
  const submit = dialog.querySelector('[data-feedback-action="submit"]');
  if (!textarea || !counter || !status || !submit) return;
  const count = countFeedbackCharacters(draft);
  const over = count > FEEDBACK_MAX_LENGTH;
  counter.textContent = `${count}/${FEEDBACK_MAX_LENGTH}`;
  counter.classList.toggle('is-over', over);
  textarea.setAttribute('aria-invalid', String(over));
  textarea.disabled = submitting;
  submit.disabled = submitting || composing || !draft.trim() || over;
  submit.textContent = submitting ? '正在提交…' : pendingPayload && submissionError ? '重试提交' : '提交反馈';
  const message = over ? `已超出 ${count - FEEDBACK_MAX_LENGTH} 字，请精简至 ${FEEDBACK_MAX_LENGTH} 字以内后提交。`
    : submissionError || (submitting ? submissionConnectionStatus || '正在保存反馈，可以关闭窗口；提交结果会提示你。' : submissionSaved ? '反馈已保存，感谢你的建议。' : '');
  status.textContent = message;
  status.className = `feedback-status ${over || submissionError ? 'is-error' : submissionSaved ? 'is-success' : 'is-info'}`;
  status.setAttribute('role', over || submissionError ? 'alert' : 'status');
  dialog.setAttribute('aria-busy', String(submitting));
}

function saveDialogDraft() {
  const textarea = dialog?.querySelector('#feedback-content');
  if (!textarea || submitting) return;
  if (textarea.value !== draft) {
    draft = textarea.value;
    pendingPayload = null;
    submissionError = '';
    submissionSaved = false;
  }
}

function closeFeedbackDialog() {
  saveDialogDraft();
  composing = false;
  if (dialog?.open) dialog.close();
  if (opener?.isConnected) opener.focus();
}

function createDialog() {
  if (dialog?.isConnected) return dialog;
  dialog = document.getElementById('feedback-dialog') || document.createElement('dialog');
  dialog.id = 'feedback-dialog';
  dialog.className = 'feedback-dialog';
  dialog.setAttribute('aria-labelledby', 'feedback-dialog-title');
  dialog.setAttribute('aria-describedby', 'feedback-dialog-description');
  if (!dialog.isConnected) document.body.appendChild(dialog);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); closeFeedbackDialog(); });
  dialog.addEventListener('close', () => { saveDialogDraft(); composing = false; });
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeFeedbackDialog();
  });
  return dialog;
}

/** Opens a separate body dialog; closing or pressing Escape keeps the draft. */
export function openFeedbackDialog() {
  createDialog();
  if (dialog.open) { dialog.querySelector('#feedback-content')?.focus(); return; }
  if (!draft && !pendingPayload && !submitting) {
    draftPage = currentPage();
    submissionError = '';
    submissionSaved = false;
  }
  opener = document.activeElement;
  dialog.innerHTML = `<div class="modal-head"><div><h2 id="feedback-dialog-title">提交反馈</h2><p id="feedback-dialog-description">说说遇到的问题，或你希望改进的地方。</p></div><button type="button" class="feedback-close" data-feedback-action="close" aria-label="关闭反馈窗口">${closeIcon}</button></div><form id="feedback-submit-form" class="feedback-form" data-feedback-form="submit" novalidate><label class="feedback-label" for="feedback-content">反馈内容</label><textarea id="feedback-content" class="feedback-textarea" name="content" rows="6" aria-describedby="feedback-privacy feedback-count feedback-submit-status" placeholder="例如：导出会议材料时，希望可以先预览桌签样式。">${esc(draft)}</textarea><div class="feedback-form-meta"><p class="feedback-hint" id="feedback-privacy">内容保存至私有 GitHub，仅供维护者查看。仅附带当前功能页面和设备类型，不会附带会议、人员或公文内容。</p><span class="feedback-counter" id="feedback-count">0/${FEEDBACK_MAX_LENGTH}</span></div><p class="feedback-status" id="feedback-submit-status" role="status" aria-live="polite"></p><div class="feedback-actions">${button(submissionSaved ? '关闭' : '暂时关闭', 'close')}<button type="submit" class="btn primary" data-feedback-action="submit">提交反馈</button></div></form><p class="feedback-dialog-footer">查看已收集的反馈需维护者口令。<button type="button" class="text-link" data-feedback-action="view">前往反馈记录</button></p>`;
  updateDialog();
  dialog.showModal();
  if (!submitting) dialog.querySelector('#feedback-content')?.focus();
}

async function sendDraft() {
  if (submitting || composing) return;
  saveDialogDraft();
  if (countFeedbackCharacters(draft) > FEEDBACK_MAX_LENGTH) { updateDialog(); return; }
  try {
    if (!pendingPayload) pendingPayload = createFeedbackPayload({ content: draft, page: draftPage, device: getFeedbackDevice() });
  } catch (error) {
    submissionError = safeError(error, '请检查反馈内容后重试。');
    updateDialog();
    return;
  }
  submitting = true;
  submissionError = '';
  submissionSaved = false;
  submissionConnectionStatus = '';
  updateDialog();
  try {
    const result = await submitFeedback(pendingPayload, { onStatus: ({ phase, message }) => {
      submissionConnectionStatus = phase === 'connecting' ? message : '';
      updateDialog();
    } });
    draft = '';
    pendingPayload = null;
    submissionSaved = true;
    const textarea = dialog?.querySelector('#feedback-content');
    if (textarea) textarea.value = '';
    if (authenticated && adminToken) {
      items = [result.item, ...items.filter((item) => item.id !== result.item.id)];
      refreshPage();
    }
    callbacks.notify('反馈已保存，感谢你的建议。');
  } catch (error) {
    submissionError = safeError(error, '反馈暂未保存，请保留内容后重试。');
    if (error?.code === 'REQUEST_CONFLICT' || error?.code === 'INVALID_REQUEST_ID') pendingPayload = null;
    if (!dialog?.open) callbacks.notify(submissionError);
  } finally {
    submitting = false;
    submissionConnectionStatus = '';
    updateDialog();
  }
}

function clearAdminSession() {
  listGeneration += 1;
  listController?.abort();
  listController = null;
  listRequest = null;
  adminToken = '';
  authenticated = false;
  items = [];
  hasMore = false;
  nextPage = null;
  loading = false;
  attemptedLoad = false;
  listError = '';
  listConnectionStatus = '';
  storeToken('');
}

function loadFeedback(reset = false) {
  if (!adminToken) return Promise.resolve();
  if (loading) return listRequest || Promise.resolve();
  if (!reset && !nextPage) return Promise.resolve();
  const token = adminToken;
  const generation = ++listGeneration;
  const page = reset ? 1 : nextPage;
  const controller = new AbortController();
  listController = controller;
  loading = true;
  attemptedLoad = true;
  listError = '';
  listConnectionStatus = '';
  refreshPage();
  listRequest = (async () => {
    try {
      const result = await listFeedback({ page, token, signal: controller.signal, onStatus: ({ phase, message }) => {
        if (generation !== listGeneration || token !== adminToken) return;
        listConnectionStatus = phase === 'connecting' ? message : '';
        refreshPage();
      } });
      if (generation !== listGeneration || token !== adminToken) return;
      items = reset ? result.items : [...new Map([...items, ...result.items].map((item) => [item.id, item])).values()];
      hasMore = result.hasMore;
      nextPage = result.nextPage;
      authenticated = true;
    } catch (error) {
      if (generation !== listGeneration || token !== adminToken) return;
      const message = safeError(error, '反馈记录暂时无法读取，请稍后重试。');
      if (error?.code === 'UNAUTHORIZED') clearAdminSession();
      listError = message;
    } finally {
      // Logging out invalidates the request, so a late response cannot restore data.
      if (generation === listGeneration && token === adminToken) {
        loading = false;
        listConnectionStatus = '';
        listController = null;
        listRequest = null;
        refreshPage();
      } else if (!adminToken) refreshPage();
    }
  })();
  return listRequest;
}

/** Called after entering/rendering feedback. Anonymous visitors never fetch lists. */
export function ensureFeedbackLoaded() {
  if (currentPage() !== 'feedback' || !adminToken || attemptedLoad) return Promise.resolve();
  return loadFeedback(true);
}

function login() {
  if (loading) return;
  const input = document.getElementById('feedback-admin-token');
  const token = typeof input?.value === 'string' ? input.value.trim() : '';
  if (!token || /[\r\n]/.test(token)) {
    listError = '请输入有效的反馈管理口令。';
    refreshPage();
    document.getElementById('feedback-admin-token')?.focus();
    return;
  }
  clearAdminSession();
  adminToken = token;
  storeToken(token);
  void loadFeedback(true);
}

function onClick(event) {
  const control = event.target.closest?.('[data-feedback-action]');
  if (!control || control.disabled) return;
  const action = control.dataset.feedbackAction;
  if (!['open', 'close', 'submit', 'view', 'login', 'logout', 'refresh', 'more'].includes(action)) return;
  event.preventDefault();
  if (action === 'open') openFeedbackDialog();
  else if (action === 'close') closeFeedbackDialog();
  else if (action === 'submit') void sendDraft();
  else if (action === 'view') { closeFeedbackDialog(); callbacks.navigate('feedback'); }
  else if (action === 'login') login();
  else if (action === 'logout') { clearAdminSession(); refreshPage(); callbacks.notify('已退出反馈查看，管理口令和记录缓存已清除。'); }
  else if (action === 'refresh') void loadFeedback(true);
  else if (action === 'more') void loadFeedback(false);
}

function onSubmit(event) {
  const type = event.target.dataset?.feedbackForm;
  if (!['submit', 'admin'].includes(type)) return;
  // The host application skips feedback-* forms; handle only our own form marker.
  event.preventDefault();
  if (type === 'submit') void sendDraft();
  else login();
}

function onInput(event) {
  if (event.target.id !== 'feedback-content') return;
  saveDialogDraft();
  updateDialog();
}

function onComposition(event) {
  if (event.target.id !== 'feedback-content') return;
  composing = event.type === 'compositionstart';
  if (!composing) saveDialogDraft();
  updateDialog();
}

/** Install once; repeated calls update host callbacks without duplicating listeners. */
export function initializeFeedbackUI({ getPage, navigate, refresh, notify } = {}) {
  for (const [name, value] of Object.entries({ getPage, navigate, refresh, notify })) {
    if (typeof value === 'function') callbacks[name] = value;
  }
  if (initialized) return;
  initialized = true;
  adminToken = readStoredToken();
  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('input', onInput);
  document.addEventListener('compositionstart', onComposition);
  document.addEventListener('compositionend', onComposition);
}
