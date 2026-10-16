/** Shared feedback client. Content remains plain text; never interpret it as HTML. */
export const FEEDBACK_ENDPOINT = 'https://zhixing-agent-gateway.rosannabebe.chatgpt.site/api/feedback';
export const FEEDBACK_TICKET_ENDPOINT = 'https://zhixing-agent-gateway.rosannabebe.chatgpt.site/api/feedback-ticket';
export const FEEDBACK_MAX_LENGTH = 1000;

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_RESPONSE_LENGTH = 256 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FEEDBACK_PAGES = new Set(['agent', 'meeting', 'news', 'documents', 'knowledge', 'feedback', 'dashboard']);
const FEEDBACK_DEVICES = new Set(['desktop', 'mobile', 'tablet', 'unknown']);

export class FeedbackError extends Error {
  constructor(code, message, { retryable = false, status, requestId } = {}) {
    super(message);
    this.name = 'FeedbackError';
    this.code = code;
    this.retryable = retryable;
    if (status !== undefined) this.status = status;
    if (requestId) this.requestId = requestId;
  }
}

/** Unicode code points, so an emoji such as 😀 counts as one character. */
export function countFeedbackCharacters(value) {
  return Array.from(typeof value === 'string' ? value : '').length;
}

/** Returns trimmed plain text or throws a safe, user-facing FeedbackError. */
export function validateFeedbackContent(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new FeedbackError('EMPTY_CONTENT', '请先填写反馈内容。');
  }
  const content = value.trim();
  if (countFeedbackCharacters(content) > FEEDBACK_MAX_LENGTH) {
    throw new FeedbackError('CONTENT_TOO_LONG', `反馈最多 ${FEEDBACK_MAX_LENGTH} 字，请精简后提交。`);
  }
  return content;
}

export function createFeedbackRequestId(cryptoSource = globalThis.crypto) {
  if (typeof cryptoSource?.randomUUID === 'function') return cryptoSource.randomUUID();
  if (typeof cryptoSource?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    cryptoSource.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  throw new FeedbackError('REQUEST_ID_UNAVAILABLE', '当前浏览器无法创建提交编号，请刷新页面后重试。');
}

function shortText(value, limit) {
  return typeof value === 'string' ? Array.from(value.trim()).slice(0, limit).join('') : '';
}

function feedbackPage(value) {
  // Only route identifiers are sent, never URL queries, fragments or credentials.
  return FEEDBACK_PAGES.has(value) ? value : 'feedback';
}

/** Only a device category; no full user agent, identifiers or fingerprint. */
export function getFeedbackDevice(navigatorLike = globalThis.navigator) {
  const ua = typeof navigatorLike?.userAgent === 'string' ? navigatorLike.userAgent : '';
  if (!ua) return 'unknown';
  if (/iPad|Tablet/i.test(ua) || (/Macintosh/i.test(ua) && navigatorLike.maxTouchPoints > 1)
    || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
  if (/iPhone|iPod|Mobile|Windows Phone/i.test(ua)) return 'mobile';
  if (/Windows|Macintosh|Mac OS X|X11|Linux|CrOS/i.test(ua)) return 'desktop';
  return 'unknown';
}

/**
 * Create once for a submission and preserve this object for a retry.
 * Editing the content means creating a NEW payload/requestId.
 */
export function createFeedbackPayload({ content, requestId, page = 'feedback', device = 'unknown' } = {}) {
  const cleanContent = validateFeedbackContent(content);
  const id = requestId === undefined ? createFeedbackRequestId() : requestId;
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    throw new FeedbackError('INVALID_REQUEST_ID', '提交编号无效，请重新发起反馈。');
  }
  return {
    content: cleanContent,
    requestId: id.toLowerCase(),
    page: feedbackPage(page),
    device: FEEDBACK_DEVICES.has(device) ? device : 'unknown',
    website: '',
  };
}

/** Use for any string inserted into HTML templates, including dates and labels. */
export function escapeFeedbackHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function safeItemURL(value) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
    return url.href;
  } catch { return ''; }
}

function invalidResponse() {
  return new FeedbackError('INVALID_RESPONSE', '反馈服务返回内容异常，请稍后重试。', { retryable: true });
}

function normalizeItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)
    || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 200
    || typeof item.content !== 'string' || !item.content.trim() || countFeedbackCharacters(item.content) > FEEDBACK_MAX_LENGTH
    || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))) {
    throw invalidResponse();
  }
  return {
    id: item.id,
    content: item.content,
    createdAt: item.createdAt,
    page: shortText(item.page, 200),
    device: shortText(item.device, 100),
    url: safeItemURL(item.url),
  };
}

function responseError(status, publicSubmission = false) {
  if (status === 401 && publicSubmission) {
    return new FeedbackError('TICKET_INVALID', '本次提交凭据已失效，请重试。', { status, retryable: true });
  }
  const messages = {
    400: ['INVALID_SUBMISSION', '反馈内容未通过校验，请检查后重试。'],
    401: ['UNAUTHORIZED', '反馈管理口令无效，请检查后重新输入。'],
    403: ['FORBIDDEN', '当前页面暂不能访问反馈服务，请联系管理员。'],
    404: ['NOT_AVAILABLE', '反馈服务暂未开放，请稍后重试。'],
    409: ['REQUEST_CONFLICT', '本次提交与已有记录不一致，请重新发起反馈。'],
    413: ['CONTENT_TOO_LONG', `反馈最多 ${FEEDBACK_MAX_LENGTH} 字，请精简后提交。`],
    429: ['RATE_LIMITED', '操作较频繁，请稍后再试。'],
  };
  const [code, message] = messages[status] || ['SERVICE_UNAVAILABLE', '反馈服务暂时不可用，请稍后重试。'];
  return new FeedbackError(code, message, { status, retryable: status === 429 || status >= 500 });
}

async function requestFeedback(method, url, body, { token = '', signal, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}, feedbackTicket = '') {
  if (typeof fetchImpl !== 'function') throw new FeedbackError('NETWORK_UNAVAILABLE', '当前浏览器暂不支持反馈提交，请更新浏览器后重试。');
  if (signal?.aborted) throw new FeedbackError('CANCELLED', '操作已取消。');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) timeoutMs = DEFAULT_TIMEOUT_MS;
  const cleanToken = typeof token === 'string' ? token.trim() : '';
  if (/[\r\n]/.test(cleanToken)) throw new FeedbackError('INVALID_TOKEN', '访问口令格式不正确，请重新输入。');
  const headers = { Accept: 'application/json' };
  if (method === 'POST') headers['Content-Type'] = 'application/json';
  if (cleanToken) headers.Authorization = `Bearer ${cleanToken}`;
  if (feedbackTicket) headers['X-Feedback-Ticket'] = feedbackTicket;

  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let abortListener;
  const aborted = new Promise((_, reject) => {
    abortListener = () => reject(new FeedbackError(timedOut ? 'TIMEOUT' : 'CANCELLED', timedOut ? '连接超时，保留内容后可重试。' : '操作已取消。', { retryable: timedOut }));
    controller.signal.addEventListener('abort', abortListener, { once: true });
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(url, {
          method,
          headers,
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal,
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
        });
        // Upstream messages may contain internal details. Never surface them.
        if (!response.ok) throw responseError(response.status, method === 'POST' || url.startsWith(`${FEEDBACK_TICKET_ENDPOINT}?`));
        let payload;
        try {
          const raw = await response.text();
          if (raw.length > MAX_RESPONSE_LENGTH) throw invalidResponse();
          payload = JSON.parse(raw);
        } catch { throw invalidResponse(); }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalidResponse();
        return payload;
      })(),
      aborted,
    ]);
  } catch (error) {
    if (error instanceof FeedbackError) throw error;
    if (controller.signal.aborted) {
      throw new FeedbackError(timedOut ? 'TIMEOUT' : 'CANCELLED', timedOut ? '连接超时，保留内容后可重试。' : '操作已取消。', { retryable: timedOut });
    }
    throw new FeedbackError('NETWORK_ERROR', '暂时无法连接反馈服务，请检查网络后重试。', { retryable: true });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', abortListener);
  }
}

function normalizeTicket(result) {
  const ticket = typeof result.ticket === 'string' ? result.ticket.trim() : '';
  const expiresAt = typeof result.expiresAt === 'number' ? result.expiresAt
    : typeof result.expiresAt === 'string' ? Date.parse(result.expiresAt) : NaN;
  if (!/^[\x21-\x7e]{1,4096}$/.test(ticket) || !Number.isFinite(expiresAt) || expiresAt <= 0) throw invalidResponse();
  return ticket;
}

/**
 * Public ticket GET → ticket-authenticated POST. Never forwards options.token.
 * Returns { item, duplicate, requestId }; retries reuse the UUID and get a new ticket.
 */
export async function submitFeedback(payload, options = {}) {
  const body = createFeedbackPayload(payload);
  const publicOptions = { signal: options.signal, timeoutMs: options.timeoutMs, fetchImpl: options.fetchImpl };
  try {
    // Only the validated UUID is included in this URL; content stays in the POST.
    const ticketResult = await requestFeedback('GET', `${FEEDBACK_TICKET_ENDPOINT}?requestId=${encodeURIComponent(body.requestId)}`, null, publicOptions);
    const ticket = normalizeTicket(ticketResult);
    const result = await requestFeedback('POST', FEEDBACK_ENDPOINT, body, publicOptions, ticket);
    return { item: normalizeItem(result.item ?? result), duplicate: result.duplicate === true, requestId: body.requestId };
  } catch (error) {
    if (error instanceof FeedbackError) error.requestId = body.requestId;
    throw error;
  }
}

/**
 * Returns { items, hasMore, nextPage }; item content is unrendered plain text.
 * options.token is the separate FEEDBACK_ADMIN_TOKEN, never the model access token.
 */
export async function listFeedback({ page = 1, ...options } = {}) {
  if (!Number.isSafeInteger(page) || page < 1) throw new FeedbackError('INVALID_PAGE', '反馈页码无效，请从第一页重新加载。');
  const result = await requestFeedback('GET', `${FEEDBACK_ENDPOINT}?page=${page}`, null, options);
  if (!Array.isArray(result.items) || result.items.length > 100 || typeof result.hasMore !== 'boolean') throw invalidResponse();
  if (result.hasMore && (!Number.isSafeInteger(result.nextPage) || result.nextPage <= page)) throw invalidResponse();
  return {
    items: result.items.map(normalizeItem),
    hasMore: result.hasMore,
    nextPage: result.hasMore ? result.nextPage : null,
  };
}
