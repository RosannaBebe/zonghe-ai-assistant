/**
 * Local demonstration data and deterministic workflow helpers.
 * All names, organizations, policies, history and news below are fictional.
 * This module makes no network requests and does not call an AI model.
 */

const CSV_COLUMNS = ['姓名', '单位', '职务', '主客', '职级', '接待备注'];
const VALID_RANKS = new Set([1, 2, 3, 4, 5]);

export function createInitialState() {
  return {
    meeting: {
      title: '2026 年度经营管理交流会',
      date: '2026-10-22',
      time: '09:00',
      location: '总部 · 第一会议室',
      host: '综合管理部',
      topic: '经营管理协同与重点工作推进',
      sortRule: 'guest-first',
      layout: 'boardroom',
      revision: 1,
      confirmedRevision: 0,
    },
    participants: [
      { id: 'person-1', name: '顾承远', organization: '星桥协作中心（虚构）', position: '主任', side: 'guest', rank: 1, diet: '无特殊要求' },
      { id: 'person-2', name: '林予安', organization: '启原集团（虚构）', position: '总经理', side: 'host', rank: 1, diet: '无特殊要求' },
      { id: 'person-3', name: '叶舒宁', organization: '星桥协作中心（虚构）', position: '副主任', side: 'guest', rank: 2, diet: '清淡餐食' },
      { id: 'person-4', name: '程景和', organization: '启原集团（虚构）', position: '副总经理', side: 'host', rank: 2, diet: '无特殊要求' },
      { id: 'person-5', name: '许望舒', organization: '星桥协作中心（虚构）', position: '业务负责人', side: 'guest', rank: 3, diet: '无特殊要求' },
      { id: 'person-6', name: '李知遥', organization: '启原集团（虚构）', position: '综合管理部部长', side: 'host', rank: 3, diet: '无特殊要求' },
      { id: 'person-7', name: '陆星澜', organization: '星桥协作中心（虚构）', position: '项目经理', side: 'guest', rank: 4, diet: '饮用温水' },
      { id: 'person-8', name: '周亦衡', organization: '启原集团（虚构）', position: '经营管理部主管', side: 'host', rank: 4, diet: '无特殊要求' },
      { id: 'person-9', name: '沈南溪', organization: '星桥协作中心（虚构）', position: '项目专员', side: 'guest', rank: 5, diet: '无特殊要求' },
      { id: 'person-10', name: '唐可言', organization: '启原集团（虚构）', position: '会务专员', side: 'host', rank: 5, diet: '无特殊要求' },
    ],
    news: [
      { id: 'news-1', title: '示例｜集团召开季度经营协同交流会', source: '内部演示素材', url: '', publishedAt: '2026-10-14', summary: '虚构素材：会议围绕跨部门协作、重点事项跟进与流程优化展开交流。仅用于演示采集、核验、复核与审批流程。', category: '企业动态', status: '待核验', verified: false, selected: false, notes: '' },
      { id: 'news-2', title: '示例｜综合管理数字化试点进入演示阶段', source: '内部演示素材', url: '', publishedAt: '2026-10-13', summary: '虚构素材：试点聚焦会务材料、信息编审与会议待办三个场景。文中内容不代表任何真实企业或真实报道。', category: '数字化建设', status: '待核验', verified: false, selected: false, notes: '' },
      { id: 'news-3', title: '示例｜来访接待材料模板完成内部讨论', source: '内部演示素材', url: '', publishedAt: '2026-10-12', summary: '虚构素材：讨论建议统一参会名单、会议议程与接待手册格式，并保留人工排序确认环节。', category: '管理实践', status: '待核验', verified: false, selected: false, notes: '' },
      { id: 'news-4', title: '示例｜重点工作行动项开展闭环跟进', source: '内部演示素材', url: '', publishedAt: '2026-10-11', summary: '虚构素材：各项行动按负责人、截止时间与办理状态记录；未明确的信息需补充确认后再执行。', category: '重点工作', status: '待核验', verified: false, selected: false, notes: '' },
    ],
    knowledge: [
      { id: 'knowledge-1', title: '会务材料标准模板（演示）', type: '模板', updatedAt: '2026-10-10', tags: ['会议', '材料', '模板'], content: '【虚构演示模板】会务材料共用同一份参会名单和会议信息：参会名单、会议议程、会议手册、桌签、座次图。生成前由会务负责人确认排序；调整人员、职级、主客、规则或会议信息后，应重新确认。' },
      { id: 'knowledge-2', title: '会务排序与人工确认指引（演示）', type: '制度', updatedAt: '2026-10-09', tags: ['排序', '人工确认', '制度'], content: '【虚构指引，不是企业真实制度】职级数字越小，展示优先级越高；同一职级按选定主客规则排序，同组内维持录入顺序。实际礼宾安排以企业规范和会务负责人确认为准。本示例座次仅用于流程演示。' },
      { id: 'knowledge-3', title: '新闻来源核验与编审指引（演示）', type: '制度', updatedAt: '2026-10-08', tags: ['新闻', '来源', '审批'], content: '【虚构指引】核验来源、标题、发布时间和事实表述，记录核验说明。完成来源核验后依次提交复核和审批。所有预置新闻均为内部演示素材，没有真实来源链接；演示审批仅改变本地流程状态，不对外发布。' },
      { id: 'knowledge-4', title: '星桥协作中心来访记录（虚构 · 已授权演示）', type: '来访记录', updatedAt: '2026-09-20', tags: ['来访', '接待', '已授权演示'], authorized: true, content: '【虚构、已授权用于演示的通用偏好】上次示例接待使用纸质议程与电子材料并行；会议室提供饮用水；提前说明停车与签到位置。不包含真实访客、个人敏感信息或真实来访历史。' },
      { id: 'knowledge-5', title: '会议纪要与行动项模板（演示）', type: '模板', updatedAt: '2026-10-07', tags: ['纪要', '待办', '闭环'], content: '【演示模板】纪要应保留会议主题、原始讨论记录与行动项。每项待办记录事项、负责人、期限和来源句。原文未明确的负责人或日期留空并标记待确认；经人工复核后再纳入跟进。' },
    ],
    tasks: [],
    minutes: {
      input: '本次会议围绕经营管理协同与重点工作推进展开交流。\n讨论记录：各部门将统一协同事项台账，并在后续会议中跟进进展。\n待办：李知遥负责汇总各部门协同事项，截止2026-10-25。\n待办：周亦衡负责整理重点工作进度清单，截止2026-10-27。\n待办：补充下一次交流会议议题。',
      output: '',
      reviewed: false,
    },
    activity: [],
  };
}

/** Rank always has precedence; host/guest is a tie-breaker. Input is not mutated. */
export function sortParticipants(participants, rule = 'guest-first') {
  const preferredSide = rule === 'host-first' ? 'host' : 'guest';
  return [...participants]
    .map((participant, index) => ({ participant, index }))
    .sort((a, b) => {
      const rankA = Number(a.participant.rank);
      const rankB = Number(b.participant.rank);
      const orderA = Number.isFinite(rankA) ? rankA : Number.POSITIVE_INFINITY;
      const orderB = Number.isFinite(rankB) ? rankB : Number.POSITIVE_INFINITY;
      const rankDifference = orderA - orderB;
      if (rankDifference && !Number.isNaN(rankDifference)) return rankDifference;
      const sideDifference = Number(b.participant.side === preferredSide) - Number(a.participant.side === preferredSide);
      return sideDifference || a.index - b.index;
    })
    .map(({ participant }) => participant);
}

function parseCSVRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let closedQuote = false;
  let line = 1;
  let rowLine = 1;

  const finishField = () => {
    row.push(field);
    field = '';
    closedQuote = false;
  };
  const finishRow = () => {
    finishField();
    if (row.some((value) => value.trim() !== '')) rows.push({ fields: row, line: rowLine });
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else if (char === '\r' && text[i + 1] === '\n') {
        field += '\n';
        line += 1;
        i += 1;
      } else {
        field += char;
        if (char === '\n' || char === '\r') line += 1;
      }
      continue;
    }
    if (closedQuote && char !== ',' && char !== '\n' && char !== '\r') {
      if (char === ' ' || char === '\t') continue;
      throw new Error(`第 ${line} 行：引号结束后应为逗号或换行。`);
    }
    if (char === '"') {
      if (field.length !== 0) throw new Error(`第 ${line} 行：字段中的引号需要成对包裹，并使用两个双引号表示引号。`);
      quoted = true;
    } else if (char === ',') {
      finishField();
    } else if (char === '\n' || char === '\r') {
      finishRow();
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      line += 1;
      rowLine = line;
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error(`第 ${rowLine} 行：存在未闭合的双引号。`);
  finishRow();
  return rows;
}

/**
 * Atomic CSV import: any syntax or row-validation error returns no participants.
 * Supports UTF-8 BOM, CRLF, quoted commas, escaped quotes, and quoted newlines.
 */
export function parseParticipantsCSV(text) {
  if (typeof text !== 'string' || !text.trim()) return { participants: [], errors: ['CSV 内容为空，请上传包含表头和参会人员的文件。'] };
  let rows;
  try {
    rows = parseCSVRows(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    return { participants: [], errors: [error.message] };
  }
  if (rows.length < 2) return { participants: [], errors: ['CSV 至少需要一行表头和一行参会人员。'] };
  const header = rows[0].fields.map((field) => field.trim());
  const missing = CSV_COLUMNS.filter((column) => !header.includes(column));
  if (missing.length) return { participants: [], errors: [`缺少表头：${missing.join('、')}。请使用提供的 CSV 模板。`] };
  const repeated = header.filter((column, index) => header.indexOf(column) !== index);
  if (repeated.length) return { participants: [], errors: [`表头重复：${[...new Set(repeated)].join('、')}。`] };

  const errors = [];
  const participants = [];
  const seen = new Set();
  const sideMap = { 主方: 'host', 主: 'host', 主办方: 'host', host: 'host', 客方: 'guest', 客: 'guest', 来宾: 'guest', guest: 'guest' };
  for (const { fields, line } of rows.slice(1)) {
    if (fields.length !== header.length) {
      errors.push(`第 ${line} 行：共有 ${fields.length} 列，与表头的 ${header.length} 列不一致。含逗号的内容需使用双引号包裹。`);
      continue;
    }
    const cell = (column) => fields[header.indexOf(column)].trim();
    const name = cell('姓名');
    const organization = cell('单位');
    const rankText = cell('职级');
    const rank = Number(rankText);
    const side = sideMap[cell('主客').toLowerCase()];
    let valid = true;
    if (!name) { errors.push(`第 ${line} 行：姓名不能为空。`); valid = false; }
    if (!/^[1-5]$/.test(rankText) || !VALID_RANKS.has(rank)) { errors.push(`第 ${line} 行：职级必须为 1 到 5 的整数，数字越小优先级越高。`); valid = false; }
    if (!side) { errors.push(`第 ${line} 行：主客应填写“主方”或“客方”。`); valid = false; }
    const key = `${name}\u0000${organization}`;
    if (name && seen.has(key)) { errors.push(`第 ${line} 行：“${name}”在同一单位重复，请核实后导入。`); valid = false; }
    seen.add(key);
    if (valid) participants.push({ id: `import-${line}`, name, organization, position: cell('职务'), side, rank, diet: cell('接待备注') });
  }
  return { participants: errors.length ? [] : participants, errors };
}

function escapeCSVCell(value) {
  let text = String(value ?? '');
  // Excel/Sheets can execute formula-looking cells even when CSV-quoted.
  if (/^[\s\uFEFF]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function participantsToCSV(participants) {
  const rows = [CSV_COLUMNS, ...participants.map((person) => [person.name, person.organization, person.position, person.side === 'host' ? '主方' : '客方', person.rank, person.diet])];
  return `\uFEFF${rows.map((row) => row.map(escapeCSVCell).join(',')).join('\r\n')}\r\n`;
}

export function generateAgenda(meeting = {}) {
  const parsedTime = /^(\d{1,2}):(\d{2})$/.exec(meeting.time || '');
  const hour = parsedTime ? Number(parsedTime[1]) : 9;
  const minute = parsedTime ? Number(parsedTime[2]) : 0;
  const validTime = hour < 24 && minute < 60;
  const start = validTime ? hour * 60 + minute : 9 * 60;
  const at = (offset) => {
    const total = (start + offset) % (24 * 60);
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  };
  return [
    { time: at(0), title: '签到与材料领取', speaker: meeting.host || '会务组' },
    { time: at(15), title: '主持开场与议程说明', speaker: '主持人（待确认）' },
    { time: at(20), title: '双方代表致辞', speaker: '主客方代表（待确认）' },
    { time: at(30), title: meeting.topic || '会议主题交流', speaker: '相关负责人（待确认）' },
    { time: at(60), title: '交流讨论与行动项确认', speaker: '全体参会人员' },
    { time: at(85), title: '总结与会后安排', speaker: '主持人（待确认）' },
  ];
}

function taskId(source) {
  let hash = 2166136261;
  for (let i = 0; i < source.length; i += 1) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
  return `minute-task-${(hash >>> 0).toString(36)}`;
}

/** Extracts explicit action lines. Blank owner/deadline means it was not supplied. */
export function deriveMinutes(text, meeting = {}) {
  const input = String(text ?? '').trim();
  const title = `${meeting.title || '会议'} · 会议纪要（演示草稿）`;
  if (!input) return { title, content: '演示模式：按文本规则整理，未调用大模型。请先输入会议记录；目前没有可整理的内容。', tasks: [] };
  const tasks = [];
  const seen = new Set();
  const segments = input.split(/\r?\n|(?<=[。；;])\s*/).map((line) => line.trim()).filter(Boolean);
  for (const source of segments) {
    const hasLabel = /^(?:[-*•]\s*)?(?:\d+[.、]\s*)?(?:待办|行动项|任务)\s*[:：]/.test(source);
    const hasOwner = /^(?:[-*•]\s*)?(?:由)?[^，,。；;：:]{1,16}负责/.test(source);
    if (!hasLabel && !hasOwner) continue;
    let body = source.replace(/^(?:[-*•]\s*)?(?:\d+[.、]\s*)?(?:(?:待办|行动项|任务)\s*[:：])?\s*/, '');
    let owner = '';
    const ownerMatch = /^(?:由)?([^，,。；;：:]{1,16}?)负责\s*[:：]?\s*/.exec(body);
    if (ownerMatch) {
      owner = ownerMatch[1].trim();
      body = body.slice(ownerMatch[0].length);
    }
    const datePattern = '(?:\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}|\\d{4}年\\d{1,2}月\\d{1,2}日|\\d{1,2}月\\d{1,2}日|今天|明天|后天|本周[一二三四五六日天]|下周[一二三四五六日天])';
    const deadlineMatch = new RegExp(`(?:截止(?:时间|日期)?|期限|完成(?:时间|日期))\\s*[:：]?\\s*(${datePattern})`).exec(body);
    const beforeMatch = !deadlineMatch && new RegExp(`(${datePattern})\\s*(?:前|之前)`).exec(body);
    const deadline = deadlineMatch?.[1] || beforeMatch?.[1] || '';
    if (deadlineMatch) body = body.replace(deadlineMatch[0], '');
    if (beforeMatch) body = body.replace(beforeMatch[0], '');
    const taskTitle = body.replace(/^[\s，,。；;]+|[\s，,。；;]+$/g, '').trim();
    if (!taskTitle) continue;
    const key = `${taskTitle}\u0000${owner}\u0000${deadline}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tasks.push({ id: taskId(key), title: taskTitle, owner, deadline, status: '待办理', source });
  }
  const metadata = [meeting.title && `会议：${meeting.title}`, meeting.date && `日期：${meeting.date}`, meeting.location && `地点：${meeting.location}`].filter(Boolean).join('\n');
  const taskLines = tasks.length
    ? tasks.map((task, index) => `${index + 1}. ${task.title}\n   负责人：${task.owner || '原文未明确，待确认'}；期限：${task.deadline || '原文未明确，待确认'}\n   来源：${task.source}`).join('\n')
    : '未识别到明确的待办。可使用“待办：姓名负责事项，截止日期。”格式补充记录。';
  const content = ['演示模式：按文本规则整理，未调用大模型。以下内容仅依据输入记录，需人工复核。', metadata, '会议记录\n' + input, '行动项\n' + taskLines, '复核提示：请核实原始记录、负责人和期限；未明确的信息保持待确认。'].filter(Boolean).join('\n\n');
  return { title, content, tasks };
}

/** Every meeting/person/rule/layout edit must call this before rendering materials. */
export function invalidateMeeting(state) {
  state.meeting.revision = (Number(state.meeting.revision) || 0) + 1;
  state.meeting.confirmedRevision = 0;
  return state;
}

export function getOrderedParticipants(state) {
  return sortParticipants(state.participants || [], state.meeting?.sortRule || 'guest-first');
}
