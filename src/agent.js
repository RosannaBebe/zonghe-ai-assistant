/**
 * The demo planner below is a local rules demonstration, not an AI model.
 * In connected mode the server asks DeepSeek to select tools; this module only
 * validates the proposed plan. Neither planner executes tools or confirms work.
 * The UI must check the current meeting revision before generate_materials and
 * require a reviewed minutes draft before extract_tasks, immediately at dispatch.
 */

const MAX_GOAL_LENGTH = 2000;
const REQUEST_TIMEOUT_MS = 50000;
const SUPPORTED_SCOPES = '目前支持会前会务准备、参会名单整理，以及会议纪要与待办提取；其他目标请使用相应业务模块。';
const TOOL_DEFINITIONS = Object.freeze({
  lookup_people: { label: '查找本地参会人员', reason: '读取本地已录入的名单，核对姓名、单位与职务；不联网查找个人信息。' },
  sort_participants: { label: '整理名单排序', reason: '根据当前职级与主客规则形成候选顺序，交由会务负责人确认。' },
  prepare_agenda: { label: '起草会议议程', reason: '根据会议时间与主题起草议程，未明确的发言人保留待确认。' },
  generate_materials: { label: '生成会务材料', reason: '等待当前版本的名单与排序经人工确认，再使用同一份信息生成材料。' },
  draft_minutes: { label: '整理会议纪要草稿', reason: '仅根据输入的会议记录整理草稿，缺失的决定、人员与日期不作推断。' },
  extract_tasks: { label: '提取会议行动项', reason: '等待纪要经人工复核，再提取有原文依据的事项；未明确的负责人和期限保留待确认。' },
});
const ALLOWED_TOOLS = new Set(Object.keys(TOOL_DEFINITIONS));

function cleanText(value, field, limit) {
  if (typeof value !== 'string') throw new Error(`智能体计划的${field}必须是文字。`);
  const text = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (!text || text.length > limit) throw new Error(`智能体计划的${field}为空或过长，请重新规划。`);
  return text;
}

function readGoal(goal) {
  if (typeof goal !== 'string' || !goal.trim()) throw new Error('请先填写需要智能体完成的目标。');
  const text = goal.trim();
  if (text.length > MAX_GOAL_LENGTH) throw new Error(`目标请控制在 ${MAX_GOAL_LENGTH} 个字符以内。`);
  return text;
}

/** Only the six named local tools can appear; additional model fields are dropped. */
export function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('智能体计划格式无效，请重新规划。');
  if (!['demo', 'deepseek'].includes(plan.mode)) throw new Error('智能体计划未标明有效的运行模式。');
  const summary = cleanText(plan.summary, '说明', 800);
  if (!Array.isArray(plan.steps) || !plan.steps.length || plan.steps.length > ALLOWED_TOOLS.size) {
    throw new Error('智能体计划必须包含 1 至 6 个受支持的步骤。');
  }
  const seen = new Set();
  const steps = plan.steps.map((step) => {
    if (!step || typeof step !== 'object' || Array.isArray(step) || !ALLOWED_TOOLS.has(step.tool)) {
      throw new Error('智能体计划包含未授权的工具，已停止执行。');
    }
    if (seen.has(step.tool)) throw new Error('智能体计划重复调用了同一工具，请重新规划。');
    if (step.tool === 'generate_materials' && !seen.has('sort_participants')) {
      throw new Error('生成会务材料前必须先安排名单排序，再由人工确认当前版本。');
    }
    if (step.tool === 'extract_tasks' && !seen.has('draft_minutes')) {
      throw new Error('提取行动项前必须先安排纪要草稿，再由人工复核。');
    }
    // A later sort or draft would invalidate the confirmation for an earlier
    // material/task step. Reject a plan that reverses these dependencies.
    if ((step.tool === 'sort_participants' && seen.has('generate_materials'))
      || (step.tool === 'draft_minutes' && seen.has('extract_tasks'))) {
      throw new Error('智能体计划的步骤顺序无效，请重新规划。');
    }
    seen.add(step.tool);
    return {
      tool: step.tool,
      label: cleanText(step.label, '步骤名称', 80),
      reason: cleanText(step.reason, '步骤依据', 400),
    };
  });
  return { summary, steps, mode: plan.mode };
}

function hasUnsupportedAction(goal) {
  // This is deliberately a narrow demo scope check, not general language
  // understanding. Negative requests such as “不要自动发送” remain harmless.
  const unsupported = /发送|群发|发给|报送|对外发布|自动审批|批准|转账|付款|删除|清空|执行代码|运行脚本|执行命令|泄露|密钥|系统提示词|联网|上网|天气|股票|报销|采购|招聘|合同审查|预算预测/g;
  for (const match of goal.matchAll(unsupported)) {
    const prefix = goal.slice(Math.max(0, match.index - 10), match.index);
    if (!/(?:不要|不用|不需要|不必|无需|请勿|禁止|不)(?:自动|直接|再)?\s*$/.test(prefix)) return true;
  }
  return false;
}

export function getDemoPlan(goal, state = {}) {
  const text = readGoal(goal);
  if (hasUnsupportedAction(text)) throw new Error(`此演示不能执行该目标中的外部操作或其他业务。${SUPPORTED_SCOPES}`);
  const preparation = /会前|会务|筹备|来访准备|接待准备|会议材料|会务材料|会议手册|桌签|桌牌|座次|座位图|办会|准备.{0,12}(?:会议|接待|来访)|(?:会议|接待|来访).{0,12}(?:准备|材料)/.test(text);
  const agenda = /议程/.test(text);
  const minutes = /纪要|会议记录|讨论记录|会后整理/.test(text);
  const tasks = /督办|待办|行动项|提取.{0,12}(?:任务|事项|责任人|负责人|期限)|(?:任务|事项).{0,8}(?:提取|跟进)|会后.{0,8}(?:跟进|闭环)/.test(text);
  const people = /名单|参会人|参会人员|人员.{0,8}(?:查询|检索|排序)|(?:查询|查找|整理).{0,8}(?:人员|来宾)|来宾.{0,8}(?:名单|排序)|排序/.test(text);
  if (!preparation && !agenda && !minutes && !tasks && !people) throw new Error(`尚未识别到受支持的目标。${SUPPORTED_SCOPES}`);

  const tools = [];
  if (preparation || people) tools.push('lookup_people', 'sort_participants');
  if (preparation || agenda) tools.push('prepare_agenda');
  if (preparation) tools.push('generate_materials');
  if (minutes || tasks) tools.push('draft_minutes');
  if (tasks) tools.push('extract_tasks');
  const hasSource = typeof state.minutes?.input === 'string' && Boolean(state.minutes.input.trim());
  const personCount = Array.isArray(state.participants) ? state.participants.length : 0;
  const steps = tools.map((tool) => ({ tool, ...TOOL_DEFINITIONS[tool] }));
  for (const step of steps) {
    if (step.tool === 'lookup_people') step.reason = `将读取当前本地名单中的 ${personCount} 位人员，核对姓名、单位与职务；不联网查找个人信息。`;
    if (step.tool === 'draft_minutes' && !hasSource) step.reason = '执行前需先补充会议原始记录；不会凭会议主题虚构讨论、决定或行动项。';
  }
  return validatePlan({
    summary: `规则演示计划：${steps.map((step) => step.label).join(' → ')}。按以下步骤依次执行，名单确认与纪要复核由人工完成。`,
    steps,
    mode: 'demo',
  });
}

function agentEndpoint(endpoint) {
  let url;
  try { url = new URL(String(endpoint || '').trim()); } catch { /* Use a clear field-level error below. */ }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.search || url.hash || !/\/api\/(?:generate|agent)\/?$/.test(url.pathname)) {
    throw new Error('请先配置完整的智能体转发地址，例如 https://企业服务地址/api/generate。');
  }
  if (url.hostname === 'api.deepseek.com') throw new Error('浏览器应连接企业转发服务；DeepSeek API Key 只能配置在服务端。');
  url.pathname = url.pathname.replace(/\/api\/(?:generate|agent)\/?$/, '/api/agent');
  return url.toString();
}

function basicContext(state = {}) {
  const meeting = {};
  // Explicit projection prevents minutes, reception preferences, hidden fields
  // or accidental credentials from being sent as generic state/context.
  for (const field of ['title', 'date', 'time', 'location', 'host', 'topic', 'sortRule', 'layout']) {
    if (typeof state.meeting?.[field] === 'string') meeting[field] = state.meeting[field];
  }
  const participants = (Array.isArray(state.participants) ? state.participants : []).map((person) => {
    const entry = {};
    for (const field of ['name', 'organization', 'position', 'side']) {
      if (typeof person?.[field] === 'string') entry[field] = person[field];
    }
    if (Number.isInteger(person?.rank) && person.rank >= 1 && person.rank <= 5) entry.rank = person.rank;
    return entry;
  });
  const hasMinutes = [state.minutes?.input, state.minutes?.output].some((value) => typeof value === 'string' && Boolean(value.trim()));
  return { meeting, participants, hasMinutes };
}

/** Validates the project-issued relay password, not provider or GitHub credentials. */
export function validateModelToken(value, { required = true } = {}) {
  const token = typeof value === 'string' ? value.trim() : '';
  if (!token && required) throw new Error('请先在「模型与数据设置」填写模型访问口令，口令由项目维护者提供。');
  if (/^(?:github_pat_|ghp_)/i.test(token)) throw new Error('这里需要项目维护者提供的模型访问口令，不能填写 GitHub 令牌。');
  if (/^sk-/i.test(token)) throw new Error('这里需要项目维护者提供的模型访问口令，不能填写 DeepSeek API Key；API Key 只能配置在服务端。');
  return token;
}

/** Calls the enterprise relay, never the model provider or a browser API key. */
export async function requestAgentPlan(goal, state = {}, settings = {}) {
  const text = readGoal(goal);
  const endpoint = agentEndpoint(settings.endpoint);
  const headers = { 'Content-Type': 'application/json' };
  const token = validateModelToken(settings.token);
  headers.Authorization = `Bearer ${token}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: 'POST', headers, signal: controller.signal,
      body: JSON.stringify({ goal: text, context: basicContext(state) }),
    });
    let payload;
    try { payload = await response.json(); } catch { throw new Error('智能体服务返回格式无效，请检查服务端接口。'); }
    if (!response.ok) {
      const messages = {
        400: `智能体服务未接受此目标或上下文。${SUPPORTED_SCOPES}`,
        401: '智能体服务访问口令无效，请检查连接设置。',
        403: '当前网页来源未获智能体服务允许，请检查服务端来源设置。',
        413: '目标或会议背景过长，请精简后重新规划。',
        429: '智能体服务繁忙或额度受限，请稍后重试。',
        504: '智能体规划超时，请稍后重试。',
      };
      throw new Error(messages[response.status] || '智能体服务暂时不可用，请检查服务端状态后重试。');
    }
    const plan = validatePlan(payload);
    if (plan.mode !== 'deepseek') throw new Error('服务未返回真实模型计划，请检查智能体服务配置。');
    return plan;
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') throw new Error('智能体规划超时，请稍后重试。');
    if (error instanceof TypeError) throw new Error('无法连接智能体转发服务，请检查地址、网络与服务端来源设置。');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
