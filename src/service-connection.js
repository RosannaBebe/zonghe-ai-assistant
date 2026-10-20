/** Wake a sleeping Render service using health GETs before any business request. */
export class ServiceConnectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ServiceConnectionError';
    this.code = code;
  }
}

export function getRenderHealthURL(endpoint) {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.onrender.com') || url.username || url.password) return null;
    return new URL('/health', url.origin).href;
  } catch { return null; }
}

function bounded(value, fallback, maximum) {
  return Number.isFinite(value) && value >= 1 ? Math.min(value, maximum) : fallback;
}

function report(onStatus, phase, message = '') {
  try { onStatus?.({ phase, message }); } catch { /* Status display must not change request behavior. */ }
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(new Error('Health wait interrupted.')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, milliseconds);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

async function checkHealth(url, fetchImpl, signal, timeoutMs) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  let abortListener;
  const interrupted = new Promise((_, reject) => {
    abortListener = () => reject(new Error('Health request interrupted.'));
    controller.signal.addEventListener('abort', abortListener, { once: true });
  });
  const timer = setTimeout(cancel, timeoutMs);
  if (signal.aborted) cancel();
  try {
    return await Promise.race([
      (async () => {
        if (controller.signal.aborted) throw new Error('Health request interrupted.');
        const response = await fetchImpl(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
        });
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            throw new ServiceConnectionError('SERVICE_UNAVAILABLE', '服务健康检查未通过，请保留当前内容并检查服务地址后重试。');
          }
          return false;
        }
        try { return (await response.json())?.ok === true; } catch { return false; }
      })(),
      interrupted,
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', abortListener);
  }
}

/**
 * Only HTTPS *.onrender.com endpoints are probed. Every probe is a credential-free
 * GET /health. The caller remains responsible for exactly one business POST after
 * this resolves; this helper never retries a business request.
 */
export async function waitForService(endpoint, {
  signal,
  onStatus,
  fetchImpl = globalThis.fetch,
  timeoutMs = 90000,
  pollIntervalMs = 1500,
  requestTimeoutMs = 10000,
} = {}) {
  const healthURL = getRenderHealthURL(endpoint);
  if (!healthURL) return { waited: false };
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, bounded(timeoutMs, 90000, 90000));
  if (signal?.aborted) cancel();
  try {
    if (!controller.signal.aborted) report(onStatus, 'connecting', '正在连接服务，首次可能约一分钟。');
    while (!controller.signal.aborted) {
      try {
        if (typeof fetchImpl !== 'function') throw new ServiceConnectionError('SERVICE_UNAVAILABLE', '当前浏览器无法连接服务，请保留内容并更新浏览器后重试。');
        const healthy = await checkHealth(healthURL, fetchImpl, controller.signal, bounded(requestTimeoutMs, 10000, 90000));
        if (healthy && !controller.signal.aborted) {
          report(onStatus, 'ready');
          return { waited: true };
        }
      } catch (error) {
        if (error instanceof ServiceConnectionError) throw error;
        // Render may reset or time out connections while starting. Retry only health.
      }
      if (controller.signal.aborted) break;
      await delay(bounded(pollIntervalMs, 1500, 10000), controller.signal);
    }
    throw new Error('Health wait interrupted.');
  } catch (error) {
    const failure = controller.signal.aborted
      ? new ServiceConnectionError(timedOut ? 'CONNECTION_TIMEOUT' : 'CONNECTION_CANCELLED', timedOut ? '连接服务超时，请保留当前内容后重试。' : '连接已取消，请保留当前内容后重试。')
      : error instanceof ServiceConnectionError ? error : new ServiceConnectionError('SERVICE_UNAVAILABLE', '服务暂时无法连接，请保留当前内容后重试。');
    report(onStatus, failure.code === 'CONNECTION_CANCELLED' ? 'cancelled' : 'error', failure.message);
    throw failure;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
