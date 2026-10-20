/**
 * Private GitHub Issues feedback storage. Runtime bindings contain all secrets.
 * Rate limits, locks and cache are isolate-local. Recent-issue lookup gives best-
 * effort retry deduplication; concurrent isolates can still create duplicates.
 * Node copy extension: optional per-IP limits and an independent global submit
 * bucket. Defaults are unchanged; SOURCE.md documents the Render opt-in policy.
 */
export interface FeedbackConfig {
  githubToken: string;
  repository: string;
  adminToken: string;
  signingSecret: string;
  allowedOrigins: string[];
  rateLimits?: { ticket?: number; submit?: number; globalSubmit?: number };
}

export interface FeedbackItem {
  id: string;
  content: string;
  createdAt: string;
  page: string;
  device: string;
  url: string;
}

type JsonObject = Record<string, unknown>;
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
type FeedbackRecord = {
  version: 1;
  requestId: string;
  content: string;
  createdAt: string;
  page: string;
  device: string;
};
type StoredFeedback = { record: FeedbackRecord; item: FeedbackItem };
type FeedbackState = {
  buckets: Map<string, { count: number; expiresAt: number }>;
  globalSubmitBucket: { count: number; expiresAt: number } | null;
  locks: Map<string, Promise<void>>;
  cache: Map<string, { stored: StoredFeedback; expiresAt: number }>;
};
type Runtime = { state?: FeedbackState; now?: () => number };

export const FEEDBACK_PAGES = Object.freeze([
  "dashboard", "agent", "meeting", "news", "documents", "knowledge", "feedback",
]);
export const FEEDBACK_DEVICES = Object.freeze(["desktop", "mobile", "tablet", "unknown"]);
export const FEEDBACK_MARKER = "<!-- zhixing-feedback:v1 -->";
export const TICKET_TTL_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_UPSTREAM_BYTES = 2 * 1024 * 1024;
const GITHUB_TIMEOUT_MS = 15000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

class FeedbackError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createFeedbackState(): FeedbackState {
  return { buckets: new Map(), globalSubmitBucket: null, locks: new Map(), cache: new Map() };
}
const sharedState = createFeedbackState();

function object(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateConfig(config: FeedbackConfig) {
  if (!config.githubToken?.trim() || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(config.repository)
    || !config.adminToken || config.adminToken.length < 24
    || !config.signingSecret || config.signingSecret.length < 32
    || !Array.isArray(config.allowedOrigins) || !config.allowedOrigins.length) {
    throw new FeedbackError(503, "FEEDBACK_NOT_CONFIGURED", "反馈服务尚未配置完成，请稍后再试。");
  }
  if (config.rateLimits !== undefined && (!object(config.rateLimits)
    || Object.entries(config.rateLimits).some(([key, value]) => !["ticket", "submit", "globalSubmit"].includes(key)
      || !Number.isSafeInteger(value) || Number(value) < 1))) {
    throw new FeedbackError(503, "FEEDBACK_NOT_CONFIGURED", "反馈服务尚未配置完成，请稍后再试。");
  }
  for (const origin of config.allowedOrigins) {
    let parsed: URL;
    try { parsed = new URL(origin); }
    catch { throw new FeedbackError(503, "FEEDBACK_NOT_CONFIGURED", "反馈服务尚未配置完成，请稍后再试。"); }
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new FeedbackError(503, "FEEDBACK_NOT_CONFIGURED", "反馈服务尚未配置完成，请稍后再试。");
    }
  }
}

function validRequestId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function metadata(value: unknown, allowed: readonly string[], field: string): string {
  if (typeof value !== "string" || value.length > 32 || !allowed.includes(value)) {
    throw new FeedbackError(400, "INVALID_METADATA", `${field}信息无效，请刷新页面后重试。`);
  }
  return value;
}

function contentOf(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new FeedbackError(400, "CONTENT_REQUIRED", "请填写反馈内容。");
  }
  const content = value.trim();
  if (Array.from(content).length > 1000) {
    throw new FeedbackError(400, "CONTENT_TOO_LONG", "反馈内容最多 1000 字，请精简后提交。");
  }
  return content;
}

function fromPayload(payload: unknown, now: number): FeedbackRecord {
  if (!object(payload)) throw new FeedbackError(400, "INVALID_REQUEST", "请求必须是 JSON 对象。");
  if (payload.website !== "") throw new FeedbackError(400, "INVALID_FORM", "表单校验未通过，请刷新页面后重试。");
  if (!validRequestId(payload.requestId)) throw new FeedbackError(400, "INVALID_REQUEST_ID", "反馈编号无效，请刷新页面后重试。");
  return {
    version: 1,
    requestId: payload.requestId.toLowerCase(),
    content: contentOf(payload.content),
    createdAt: new Date(now).toISOString(),
    page: metadata(payload.page, FEEDBACK_PAGES, "页面"),
    device: metadata(payload.device, FEEDBACK_DEVICES, "设备"),
  };
}

async function readJson(body: ReadableStream<Uint8Array> | null, limit: number, upstream = false): Promise<unknown> {
  const invalid = () => new FeedbackError(upstream ? 502 : 400, upstream ? "FEEDBACK_STORAGE_ERROR" : "INVALID_JSON", upstream ? "反馈存储暂时不可用，请稍后重试。" : "请求 JSON 格式无效。");
  if (!body) throw invalid();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new FeedbackError(upstream ? 502 : 413, upstream ? "FEEDBACK_STORAGE_ERROR" : "BODY_TOO_LARGE", upstream ? "反馈存储响应过大，请稍后重试。" : "提交内容过大，请精简后重试。");
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw invalid(); }
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decode64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encoding");
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(standard + "=".repeat((4 - standard.length % 4) % 4)), (c) => c.charCodeAt(0));
}

async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function makeTicket(requestId: string, origin: string, secret: string, now: number) {
  const expiresAt = now + TICKET_TTL_MS;
  const payload = base64url(encoder.encode(JSON.stringify({ v: 1, requestId, origin, issuedAt: now, expiresAt })));
  const signature = await crypto.subtle.sign("HMAC", await signingKey(secret), encoder.encode(payload));
  return { ticket: `${payload}.${base64url(new Uint8Array(signature))}`, expiresAt: new Date(expiresAt).toISOString() };
}

async function verifyTicket(ticket: string | null, requestId: string, origin: string, secret: string, now: number) {
  let valid = false;
  try {
    if (!ticket || ticket.length > 1600) throw new Error();
    const parts = ticket.split(".");
    if (parts.length !== 2) throw new Error();
    const signature = decode64(parts[1]);
    if (signature.byteLength !== 32) throw new Error();
    const signed = await crypto.subtle.verify("HMAC", await signingKey(secret), signature, encoder.encode(parts[0]));
    if (!signed) throw new Error();
    const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decode64(parts[0])));
    valid = object(payload) && payload.v === 1 && payload.requestId === requestId && payload.origin === origin
      && typeof payload.issuedAt === "number" && typeof payload.expiresAt === "number"
      && payload.expiresAt - payload.issuedAt === TICKET_TTL_MS
      && payload.issuedAt <= now + 5000 && payload.expiresAt > now;
  } catch { valid = false; }
  if (!valid) throw new FeedbackError(403, "INVALID_FEEDBACK_TICKET", "反馈表单已失效，请刷新后重新提交。");
}

async function sameToken(received: string, expected: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(received)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left), b = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < 32; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function checkRate(request: Request, config: FeedbackConfig, state: FeedbackState, kind: string, now: number) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${config.signingSecret}:${ip}`));
  const key = `${config.repository}:${kind}:${base64url(new Uint8Array(digest))}`;
  for (const [existing, bucket] of state.buckets) if (bucket.expiresAt <= now) state.buckets.delete(existing);
  const limits = kind === "ticket" ? { count: config.rateLimits?.ticket ?? 20, window: 600000 }
    : kind === "submit" ? { count: config.rateLimits?.submit ?? 6, window: 600000 } : { count: 60, window: 60000 };
  const bucket = state.buckets.get(key);
  if (bucket && bucket.count >= limits.count) throw new FeedbackError(429, "FEEDBACK_RATE_LIMITED", "操作过于频繁，请稍后再试。");
  if (kind === "submit" && config.rateLimits?.globalSubmit !== undefined) {
    // Separate from the bounded IP map: cycling IPs must never evict or reset
    // the global guard. A request rejected by its IP limit costs no global slot.
    if (!state.globalSubmitBucket || state.globalSubmitBucket.expiresAt <= now) {
      state.globalSubmitBucket = { count: 0, expiresAt: now + 600000 };
    }
    if (state.globalSubmitBucket.count >= config.rateLimits.globalSubmit) {
      throw new FeedbackError(429, "FEEDBACK_RATE_LIMITED", "反馈服务当前提交量较大，请稍后再试。");
    }
    state.globalSubmitBucket.count += 1;
  }
  if (bucket) bucket.count += 1;
  else {
    if (state.buckets.size >= 2048) state.buckets.delete(state.buckets.keys().next().value!);
    state.buckets.set(key, { count: 1, expiresAt: now + limits.window });
  }
}

function issueBody(record: FeedbackRecord): string {
  // Escaped @ and fence characters decode back exactly, without mentions or Markdown breakout.
  const json = JSON.stringify(record, null, 2).replace(/@/g, "\\u0040").replace(/`/g, "\\u0060")
    .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `${FEEDBACK_MARKER}\n\`\`\`json\n${json}\n\`\`\`\n`;
}

function parseIssue(value: unknown, repository: string): StoredFeedback | null {
  if (!object(value) || Object.hasOwn(value, "pull_request") || typeof value.body !== "string"
    || !Number.isSafeInteger(value.number) || Number(value.number) < 1
    || typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at))) return null;
  const pattern = /^<!-- zhixing-feedback:v1 -->\r?\n```json\r?\n([\s\S]+)\r?\n```\s*$/;
  const match = value.body.match(pattern);
  if (!match) return null;
  try {
    const data: unknown = JSON.parse(match[1]);
    if (!object(data) || data.version !== 1 || !validRequestId(data.requestId)
      || typeof data.createdAt !== "string" || !Number.isFinite(Date.parse(data.createdAt))) return null;
    const content = contentOf(data.content);
    const page = metadata(data.page, FEEDBACK_PAGES, "页面");
    const device = metadata(data.device, FEEDBACK_DEVICES, "设备");
    const record: FeedbackRecord = { version: 1, requestId: data.requestId.toLowerCase(), content, page, device, createdAt: data.createdAt };
    return {
      record,
      item: { id: String(value.number), content, createdAt: value.created_at, page, device, url: `https://github.com/${repository}/issues/${value.number}` },
    };
  } catch { return null; }
}

async function github(path: string, config: FeedbackConfig, request: Request, fetchImpl: Fetcher, body?: unknown) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) controller.abort();
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${config.repository}/issues${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${config.githubToken.trim()}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "zhixing-feedback" },
      // Workers supports manual/follow only; reject 3xx below without forwarding credentials.
      ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal, redirect: "manual",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new FeedbackError(response.status === 429 ? 429 : 502, response.status === 429 ? "FEEDBACK_RATE_LIMITED" : "FEEDBACK_STORAGE_ERROR", response.status === 429 ? "反馈服务繁忙，请稍后再试。" : "反馈存储暂时不可用，请稍后重试。");
    }
    return { data: await readJson(response.body, MAX_UPSTREAM_BYTES, true), hasMore: /<[^>]+>;\s*rel="next"/.test(response.headers.get("Link") || "") };
  } catch (error) {
    if (controller.signal.aborted) throw new FeedbackError(504, "FEEDBACK_TIMEOUT", "反馈服务响应超时，请保留内容后重试。");
    throw error;
  } finally { clearTimeout(timeout); request.signal.removeEventListener("abort", abort); }
}

function sameSubmission(left: FeedbackRecord, right: FeedbackRecord): boolean {
  return left.content === right.content && left.page === right.page && left.device === right.device;
}

async function locked<T>(state: FeedbackState, key: string, work: () => Promise<T>): Promise<T> {
  if (state.locks.size >= 256 && !state.locks.has(key)) throw new FeedbackError(429, "FEEDBACK_RATE_LIMITED", "反馈服务繁忙，请稍后再试。");
  const previous = state.locks.get(key) || Promise.resolve();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  state.locks.set(key, pending);
  await previous;
  try { return await work(); }
  finally { release(); if (state.locks.get(key) === pending) state.locks.delete(key); }
}

async function saveFeedback(record: FeedbackRecord, config: FeedbackConfig, request: Request, fetchImpl: Fetcher, state: FeedbackState, now: number) {
  const key = `${config.repository}:${record.requestId}`;
  return locked(state, key, async () => {
    for (const [cachedKey, entry] of state.cache) if (entry.expiresAt <= now) state.cache.delete(cachedKey);
    let stored = state.cache.get(key)?.stored;
    if (!stored) {
      // Deliberately bounded recent lookup. This is not an atomic GitHub uniqueness guarantee.
      const recent = await github("?state=all&sort=created&direction=desc&per_page=100&page=1", config, request, fetchImpl);
      if (!Array.isArray(recent.data)) throw new FeedbackError(502, "FEEDBACK_STORAGE_ERROR", "反馈存储响应无效，请稍后重试。");
      stored = recent.data.slice(0, 100).map((issue) => parseIssue(issue, config.repository)).find((entry) => entry?.record.requestId === record.requestId) || undefined;
    }
    if (stored) {
      if (!sameSubmission(stored.record, record)) throw new FeedbackError(409, "FEEDBACK_REQUEST_CONFLICT", "该反馈编号已用于其他内容，请重新打开表单后提交。");
      return { item: { ...stored.item, url: "" }, duplicate: true };
    }
    const created = await github("", config, request, fetchImpl, { title: `知行用户反馈 · ${record.requestId}`, body: issueBody(record) });
    const saved = parseIssue(created.data, config.repository);
    if (!saved || saved.record.requestId !== record.requestId || !sameSubmission(saved.record, record)) {
      throw new FeedbackError(502, "FEEDBACK_STORAGE_ERROR", "反馈存储响应无效，请保留内容后重试。");
    }
    if (state.cache.size >= 256) state.cache.delete(state.cache.keys().next().value!);
    state.cache.set(key, { stored: saved, expiresAt: now + 86400000 });
    return { item: { ...saved.item, url: "" }, duplicate: false };
  });
}

export async function handleFeedbackRequest(request: Request, config: FeedbackConfig, fetchImpl: Fetcher = fetch, runtime: Runtime = {}): Promise<Response> {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Vary: "Origin" });
  const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers });
  const state = runtime.state || sharedState;
  const now = runtime.now?.() ?? Date.now();
  try {
    const origin = request.headers.get("Origin");
    if (origin && config.allowedOrigins?.includes(origin)) headers.set("Access-Control-Allow-Origin", origin);
    validateConfig(config);
    if (origin && !config.allowedOrigins.includes(origin)) throw new FeedbackError(403, "ORIGIN_FORBIDDEN", "当前网页来源未获反馈服务允许。");
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "");
    if (!["/api/feedback", "/api/feedback-ticket"].includes(path)) throw new FeedbackError(404, "NOT_FOUND", "接口不存在。");
    if (request.method === "OPTIONS") {
      if (!origin) throw new FeedbackError(403, "ORIGIN_REQUIRED", "请从允许的网页提交反馈。");
      headers.set("Access-Control-Allow-Methods", path === "/api/feedback" ? "GET, POST, OPTIONS" : "GET, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Feedback-Ticket");
      headers.set("Access-Control-Max-Age", "600");
      return new Response(null, { status: 204, headers });
    }
    if (path === "/api/feedback-ticket") {
      if (request.method !== "GET") { headers.set("Allow", "GET, OPTIONS"); throw new FeedbackError(405, "METHOD_NOT_ALLOWED", "表单票据仅支持 GET。"); }
      if (!origin) throw new FeedbackError(403, "ORIGIN_REQUIRED", "请从允许的网页提交反馈。");
      const requestId = url.searchParams.get("requestId");
      if (url.searchParams.getAll("requestId").length !== 1 || !validRequestId(requestId)) throw new FeedbackError(400, "INVALID_REQUEST_ID", "反馈编号无效，请刷新页面后重试。");
      await checkRate(request, config, state, "ticket", now);
      return respond(await makeTicket(requestId.toLowerCase(), origin, config.signingSecret, now));
    }
    if (request.method === "GET") {
      await checkRate(request, config, state, "admin", now);
      const authorization = request.headers.get("Authorization") || "";
      const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (!token || !await sameToken(token, config.adminToken)) throw new FeedbackError(401, "FEEDBACK_ADMIN_UNAUTHORIZED", "反馈管理口令无效。");
      const pageText = url.searchParams.get("page") || "1";
      if (!/^[1-9]\d{0,3}$/.test(pageText) || Number(pageText) > 1000 || url.searchParams.getAll("page").length > 1) throw new FeedbackError(400, "INVALID_PAGE", "分页参数无效。");
      const page = Number(pageText);
      const result = await github(`?state=all&sort=created&direction=desc&per_page=20&page=${page}`, config, request, fetchImpl);
      if (!Array.isArray(result.data)) throw new FeedbackError(502, "FEEDBACK_STORAGE_ERROR", "反馈存储响应无效，请稍后重试。");
      const items = result.data.slice(0, 20).map((issue) => parseIssue(issue, config.repository)).filter((entry): entry is StoredFeedback => entry !== null).map((entry) => entry.item);
      return respond({ items, hasMore: result.hasMore, nextPage: result.hasMore ? page + 1 : null });
    }
    if (request.method !== "POST") { headers.set("Allow", "GET, POST, OPTIONS"); throw new FeedbackError(405, "METHOD_NOT_ALLOWED", "反馈接口仅支持 GET 和 POST。"); }
    if (!origin) throw new FeedbackError(403, "ORIGIN_REQUIRED", "请从允许的网页提交反馈。");
    await checkRate(request, config, state, "submit", now);
    if ((request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase() !== "application/json") throw new FeedbackError(415, "JSON_REQUIRED", "请求内容必须为 application/json。");
    const length = Number(request.headers.get("Content-Length"));
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new FeedbackError(413, "BODY_TOO_LARGE", "提交内容过大，请精简后重试。");
    const record = fromPayload(await readJson(request.body, MAX_BODY_BYTES), now);
    await verifyTicket(request.headers.get("X-Feedback-Ticket"), record.requestId, origin, config.signingSecret, now);
    return respond(await saveFeedback(record, config, request, fetchImpl, state, now));
  } catch (error) {
    const known = error instanceof FeedbackError;
    if (known && error.status === 429) headers.set("Retry-After", "60");
    return respond({ error: { code: known ? error.code : "FEEDBACK_UNAVAILABLE", message: known ? error.message : "反馈服务暂时不可用，请稍后重试。" } }, known ? error.status : 502);
  }
}
