import { createInitialState, sortParticipants, parseParticipantsCSV, participantsToCSV, generateAgenda, deriveMinutes, invalidateMeeting } from './domain.js';
import { escapeHtml as esc, downloadFile, downloadDocx, createDocxBlob, createSeatMapSvg, openPrintSheet } from './exports.js';
import { getDemoPlan, requestAgentPlan } from './agent.js';
import { renderFeedbackPage, initializeFeedbackUI, ensureFeedbackLoaded } from './feedback-ui.js';
import { isMobile, renderMobileNav, enhanceMobileTables, renderMobileSeatList, openMaterialPreview, openSeatMapViewer, shareOrDownloadFile, installMobileEnhancements } from './mobile.js';

const STORE = 'zhixing-workbench-v1';
const DEFAULT_ENDPOINT = 'https://zhixing-agent-gateway.rosannabebe.chatgpt.site/api/generate';
const $ = (s, root = document) => root.querySelector(s);
const uid = (prefix = 'id') => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const day = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
const clockTime = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' });
let storageWarning = false;
let state;
try {
  const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
  state = saved?.meeting && Array.isArray(saved.participants) && Array.isArray(saved.news) && Array.isArray(saved.knowledge) && saved.minutes ? saved : createInitialState();
} catch { state = createInitialState(); storageWarning = true; }
state.checklist ||= [true, true, false, false, false];
state.doc ||= { template: '会议纪要', input: '', output: '', reviewed: false };
state.generatedRevision ||= 0;
let section = ['agent', 'meeting', 'news', 'documents', 'knowledge', 'feedback'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'agent';
let tab = 'people', newsFilter = '全部', knowledgeFilter = '全部', search = '', mobileOpen = false;
let toastTimer, run = null, busy = false;
let drawerReturnFocus = null;
const sectionNames = { agent: '智能体工作台', meeting: '会务助手', news: '政务信息助手', documents: '公文助手', knowledge: '综合知识库', feedback: '反馈列表' };
const checklistItems = ['确认会议时间与地点', '收集参会人员信息', '核对主客排序与座次', '准备会议材料与名签', '检查投屏及现场设备'];
const glyphs = {
  message: '<path d="M21 11a8 8 0 0 1-8 8H6l-4 3V11a8 8 0 0 1 8-8h3a8 8 0 0 1 8 8Z"/><path d="M7 9h9M7 13h6"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18M8 15h2M14 15h2"/>',
  news: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h3M8 18h8M15 15h1"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h6"/>',
  book: '<path d="M12 5c-3-3-7-3-10-1v15c3-2 7-2 10 1 3-3 7-3 10-1V4c-3-2-7-2-10 1zM12 5v15"/>',
  spark: '<path d="m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7L12 3zM20 2v4M18 4h4"/>',
  arrow: '<path d="M4 12h16M14 6l6 6-6 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M5 16v5h14v-5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0z"/><circle cx="12" cy="10" r="2.5"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M20 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  edit: '<path d="m16 3 5 5-12 12-6 1 1-6L16 3zM13 6l5 5"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  up: '<path d="m6 14 6-6 6 6"/>',
  down: '<path d="m6 10 6 6 6-6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  settings: '<path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  search: '<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  shield: '<path d="m12 2 9 4v6c0 6-9 10-9 10S3 18 3 12V6l9-4z"/><path d="m8 12 3 3 5-6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14-5L3 9m0-6v6h6M4 13a8 8 0 0 0 14 5l3-3m0 6v-6h-6"/>',
  play: '<path d="m8 4 12 8-12 8V4z"/>',
  link: '<path d="m10 13 4-4M8 16l-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M14 8l2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 0)"/>',
};
const icon = (name) => `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24">${glyphs[name] || glyphs.file}</svg>`;
const btn = (label, action, cls = '', extra = '') => `<button class="btn ${cls}" data-action="${action}" ${extra}>${label}</button>`;
const badge = (label, color = '') => `<span class="badge ${color}">${esc(label)}</span>`;
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').classList.add('show'); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 4300); }
function save() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { toast('浏览器存储不可用或已满，本次更改只保留在当前页面。'); } }
function log(message) { state.activity.unshift({ message, time: clockTime() }); state.activity = state.activity.slice(0, 12); }
function invalidate(message) { invalidateMeeting(state); state.orderOverride = null; state.generatedRevision = 0; log(message); save(); }
function people() {
  const sorted = sortParticipants(state.participants, state.meeting.sortRule);
  if (!state.orderOverride) return sorted;
  return [...sorted].sort((a, b) => state.orderOverride.indexOf(a.id) - state.orderOverride.indexOf(b.id));
}
const confirmed = () => state.meeting.confirmedRevision === state.meeting.revision && state.participants.length > 0;
const ready = () => confirmed() && state.generatedRevision === state.meeting.revision;
const meetingSignature = () => JSON.stringify(['title','date','time','location','host','topic'].map(key=>state.meeting[key]));
function settings() { let s = {}; try { s = JSON.parse(localStorage.getItem('zhixing-model') || '{}'); s.token = sessionStorage.getItem('zhixing-access') || ''; } catch {} return s; }
function syncMobileDrawer() {
  const mobile = isMobile();
  if (!mobile) mobileOpen = false;
  const open = mobile && mobileOpen;
  document.body.classList.toggle('mobile-drawer-open', open);
  const drawer = $('#mobile-more-drawer');
  drawer?.classList.toggle('mobile-open', open);
  $('.mobile-overlay')?.classList.toggle('open', open);
  if (drawer) {
    drawer.inert = mobile && !open;
    if (mobile) drawer.setAttribute('aria-hidden', String(!open));
    else drawer.removeAttribute('aria-hidden');
    if (open) { drawer.setAttribute('role', 'dialog'); drawer.setAttribute('aria-modal', 'true'); }
    else { drawer.removeAttribute('role'); drawer.removeAttribute('aria-modal'); }
  }
  for (const selector of ['.main', '.mobile-bottom-nav']) { const node = $(selector); if (node) node.inert = open; }
  for (const trigger of document.querySelectorAll('button[data-action="mobile"]')) trigger.setAttribute('aria-expanded', String(open));
  for (const item of document.querySelectorAll('.mobile-nav-item')) {
    const active = item.dataset.action === 'mobile' ? open || ['knowledge','feedback'].includes(section) : !open && item.dataset.section === section;
    item.classList.toggle('active', active);
    if (active && item.dataset.action === 'nav') item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
}
function setMobileDrawer(open, { restoreFocus = true } = {}) {
  const wasOpen = mobileOpen;
  if (open && !wasOpen) drawerReturnFocus = document.activeElement;
  mobileOpen = Boolean(open && isMobile());
  syncMobileDrawer();
  if (mobileOpen) $('#mobile-more-drawer .mobile-drawer-close')?.focus({ preventScroll: true });
  else if (wasOpen && restoreFocus) {
    const target = drawerReturnFocus?.isConnected ? drawerReturnFocus : $('.mobile-bottom-nav [data-action="mobile"]');
    target?.focus({ preventScroll: true });
  }
}
function go(next, nextTab) { section = next; if (nextTab) tab = nextTab; mobileOpen = false; location.hash = next; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
function render() {
  document.title = `${sectionNames[section]} · 知行`;
  const nav = (id, name, g, suffix = '') => `<button class="nav-item ${section === id ? 'active' : ''}" data-action="nav" data-section="${id}">${icon(g)}<span>${name}</span>${suffix}</button>`;
  $('#app').innerHTML = `<div class="shell"><div class="mobile-overlay ${mobileOpen ? 'open' : ''}" data-action="mobile" aria-hidden="true"></div><aside id="mobile-more-drawer" class="sidebar ${mobileOpen ? 'mobile-open' : ''}" aria-label="更多功能"><button type="button" class="mobile-drawer-close" data-action="mobile" aria-label="关闭更多功能">${icon('close')}</button><div class="brand"><img src="./assets/logo.svg" alt="知行标志"><div><strong>知行</strong><small>综合管理 AI 智能助手</small></div></div><div class="nav-label">WORKSPACE</div>${nav('agent', '智能体工作台', 'spark')}<div class="nav-label" style="margin-top:13px">业务工具</div>${nav('meeting', '会务助手', 'calendar', '<small>核心</small>')}${nav('news', '政务信息助手', 'news')}${nav('documents', '公文助手', 'file')}${nav('knowledge', '综合知识库', 'book')}${nav('feedback', '反馈列表', 'message', '<small>临时</small>')}<div class="sidebar-bottom"><div class="nav-divider"></div><button class="nav-item" data-action="guide">${icon('play')}<span>参赛演示指南</span></button><button class="nav-item" data-action="settings">${icon('settings')}<span>模型与数据设置</span></button><div class="local-note"><span><i class="dot"></i>浏览器本地保存</span>演示数据 · 仅当前设备可见</div><div class="user"><div class="avatar">综</div><div><strong>综合管理部</strong><small>经营管理赛道 · 参赛演示</small></div></div></div></aside><main class="main"><header class="topbar"><button class="mobile-menu" data-action="mobile" aria-label="打开更多功能" aria-controls="mobile-more-drawer" aria-expanded="${mobileOpen}">${icon('menu')}<b>知行</b></button><div class="breadcrumbs">经营管理工作空间 ${icon('chevron')}<b>${sectionNames[section]}</b></div><div class="top-actions"><button type="button" class="btn small feedback-entry" data-feedback-action="open">${icon('message')}反馈</button><span class="top-date">${new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'long' })}</span><button class="mode-pill" data-action="settings">${icon('spark')}${settings().endpoint ? '模型接口已配置' : '规则演示模式'}</button><button class="btn ghost small" data-action="guide">${icon('info')}使用指南</button></div></header><div class="page page-fade">${section === 'agent' ? renderAgent() : section === 'meeting' ? renderMeeting() : section === 'news' ? renderNews() : section === 'documents' ? renderDocuments() : section === 'feedback' ? renderFeedbackPage() : renderKnowledge()}<footer class="footnote"><span>${icon('shield')}所有预置人物与业务内容均为虚构演示。实际业务结果需人工审核。</span><span>知行 · 让经营管理更高效</span></footer></div></main>${renderMobileNav(section,mobileOpen)}</div>`;
  enhanceMobileTables(document);
  syncMobileDrawer();
  if(section==='feedback')void ensureFeedbackLoaded();
}
function pageHeading(title, description, action = '') { return `<div class="page-title"><div><p class="eyebrow">${section === 'agent' ? 'BUSINESS OPERATIONS AGENT' : 'OPERATIONS WORKSPACE'}</p><h1>${title}</h1><p>${description}</p></div>${action}</div>`; }
function renderAgent() {
  const completed = run?.steps.filter(s => s.status === 'done').length || 0;
  const baseline = state.baseline || 60;
  const minutes = run?.finishedAt ? Math.max(1, Math.round((run.finishedAt - run.startedAt) / 1000)) : null;
  return `${pageHeading('经营管理智能体', '一句话发起任务，工具协同执行，关键环节由你确认。', btn(`${icon('play')}演示路线`, 'guide'))}<div class="agent-layout"><div><section class="agent-compose"><div class="agent-compose-heading"><div class="agent-mark">${icon('spark')}</div><div><h2>今天，想高效完成哪项工作？</h2><p>从筹备会议开始，把名单、材料和会后跟进串成一条业务流程。</p></div><span class="agent-version">AGENT / 01</span></div><label class="sr-only" for="agent-goal">描述业务任务</label><textarea id="agent-goal" rows="3" placeholder="例如：为下周的经营管理交流会准备参会名单、议程、手册、名签和座位图。">${esc(run?.goal || '为经营管理交流会整理参会名单，按职级和主客顺序排序，再准备议程、手册、名签和座位图。')}</textarea><div class="agent-compose-bottom"><span>${icon('link')}已关联当前会议 · ${state.participants.length} 位参会人员</span>${btn(`${icon('spark')}${busy ? '正在规划…' : '开始执行任务'}`, 'agent-start', 'primary', busy || run?.waiting ? 'disabled' : '')}</div></section><div class="quick-tasks"><button data-action="preset" data-kind="meeting">${icon('calendar')}筹备会议材料${icon('arrow')}</button><button data-action="preset" data-kind="minutes">${icon('file')}整理纪要与督办${icon('arrow')}</button><button data-action="nav" data-section="news">${icon('news')}编审今日要闻${icon('arrow')}</button></div><section class="panel execution-panel"><div class="toolbar"><div><h3>任务执行过程</h3><p>${run ? `${run.mode === 'deepseek' ? 'DeepSeek 规划 · 本地工具执行' : '规则规划演示 · 本地工具执行'} · ${completed}/${run.steps.length} 步已完成` : '规划、调用、确认、交付，每一步都有迹可循'}</p></div>${run ? badge(run.finishedAt ? '已完成' : run.waiting ? '等待人工确认' : '执行中', run.finishedAt ? 'green' : 'blue') : badge('等待任务', 'gray')}</div>${run ? `<div class="execution-summary">${esc(run.finishedAt ? '已完成本次工具计划。具体执行结果及人工确认记录见下方。' : run.summary)}</div><div class="execution-steps">${run.steps.map((s, i) => `<div class="execution-step ${s.status}"><div class="execution-index">${s.status === 'done' ? icon('check') : String(i + 1).padStart(2, '0')}</div><div class="execution-body"><h4>${esc(s.label)}<code>${esc(s.tool)}</code></h4><p>${esc(s.result || s.reason)}</p>${s.status === 'waiting' ? `<div class="agent-confirm"><p>${s.tool === 'generate_materials' ? `已排好 ${state.participants.length} 位参会人员。请打开名单核对职级、主客及座次；确认后继续生成。` : '纪要草稿已生成。请在会务助手中审核原始记录、纪要和行动项，再继续录入督办。'}</p><div class="actions-line">${btn('打开并审核', 'agent-review', 'primary small')}${btn('取消本次任务', 'agent-cancel', 'small')}</div></div>` : ''}</div></div>`).join('')}</div>${run.finishedAt ? `<div class="execution-delivery">${icon('check')}<div><strong>任务已完成，业务成果可以继续编辑和导出</strong><span>运行记录已保存在当前浏览器</span></div>${btn('查看成果', 'agent-result', 'light small')}</div>` : ''}` : `<div class="agent-idle"><div class="idle-diagram"><span>${icon('spark')}理解目标</span><i></i><span>${icon('grid')}调用工具</span><i></i><span>${icon('check')}人工确认</span><i></i><span>${icon('file')}交付成果</span></div><p>试着发起第一个任务。智能体会先给出执行计划，<br>在名单和纪要确认后继续完成后续工作。</p></div>`}</section></div><aside class="agent-aside"><section class="panel side-panel"><h3>本次任务上下文 ${icon('book')}</h3><div class="context-meeting">${icon('calendar')}<h4>${esc(state.meeting.title)}</h4></div><p class="context-date">${esc(state.meeting.date)} · ${esc(state.meeting.time)}</p><div class="context-row"><span>参会名单</span><b>${state.participants.length} 人</b></div><div class="context-row"><span>业务模板</span><b>${state.knowledge.filter(k => k.type === '模板').length} 份</b></div><div class="context-row"><span>名单版本</span><b>V${state.meeting.revision}</b></div><div class="context-row"><span>人工确认</span>${badge(confirmed() ? '已确认' : '待确认', confirmed() ? 'green' : 'amber')}</div>${btn('管理会议与人员', 'open-meeting', 'small context-button')}</section><section class="panel side-panel efficiency"><h3>让提效可以衡量 ${icon('clock')}</h3><label for="baseline">人工完成同类任务的预计耗时</label><div class="baseline-input"><input id="baseline" type="number" min="1" max="10000" value="${baseline}" aria-label="人工基线分钟"><span>分钟</span></div>${minutes ? `<div class="efficiency-result"><span>本次完整演示用时（含确认）</span><b>${minutes}<small>秒</small></b></div>` : '<div class="efficiency-placeholder">完成一次任务后<br>记录本次演示用时</div>'}<p class="note-caption">基线由你估算，默认 60 分钟；演示耗时不能等同真实业务节省。建议试点时以相同规模任务进行前后对照。</p></section><div class="agent-capability"><span>${icon('shield')}关键决策始终由人确认</span><p>自动处理重复工作<br>人工把握业务判断</p></div></aside></div>`;
}
function renderMeeting() {
  const m = state.meeting;
  const steps = [['会议信息', '基础信息已填写', true], ['人员与排序', confirmed() ? '已人工确认' : '等待人工确认', confirmed()], ['材料生成', ready() ? '材料已就绪' : '统一名单联动生成', ready()], ['纪要与督办', state.minutes.reviewed ? '纪要已审核' : '会议结束后处理', state.minutes.reviewed]];
  return `${pageHeading('会务工作台', '从一份名单开始，让每一份会务材料保持一致。', btn(`${icon('edit')}编辑会议信息`, 'edit-meeting'))}<section class="meeting-banner"><div class="meeting-banner-left"><div class="meeting-label">${icon('calendar')}当前会议<span class="mini-tag">内部演示</span></div><h2>${esc(m.title)}</h2><div class="metadata"><span>${icon('calendar')}${esc(m.date)}</span><span>${icon('clock')}${esc(m.time)}</span><span>${icon('pin')}${esc(m.location)}</span></div></div><div class="meeting-stats"><div class="meeting-stat"><b>${state.participants.length}<em>人</em></b><span>参会人员</span></div><div class="stat-divider"></div><div class="meeting-stat"><b>5<em>类</em></b><span>联动会务材料</span></div></div></section><div class="workflow">${steps.map((s, i) => `<div class="workflow-item ${s[2] ? 'done' : i === steps.findIndex(x => !x[2]) ? 'current' : ''}"><div class="workflow-step">${s[2] ? icon('check') : i + 1}</div><div><strong>${s[0]}</strong><small>${s[1]}</small></div></div>${i < 3 ? `<span class="workflow-arrow">${icon('chevron')}</span>` : ''}`).join('')}</div>${run?.waiting ? `<div class="notice blue" style="margin-bottom:17px">${icon('spark')}智能体正在等待审核。${run.waiting === 'generate_materials' ? '请核对人员顺序并点击「确认名单与排序」，然后返回工作台继续。' : '请审核纪要与行动项后点击「审核通过并录入督办」。'}${btn('返回工作台', 'open-agent', 'ghost small')}</div>` : ''}<div class="workspace-grid"><section class="panel"><div class="tabs">${[['people','参会人员'],['agenda','会议议程'],['seats','座位编排'],['materials','会议材料'],['minutes','纪要与督办']].map(([id, name]) => `<button class="tab ${tab === id ? 'active' : ''}" data-action="tab" data-tab="${id}">${name}${id === 'people' ? `<small>${state.participants.length}</small>` : ''}</button>`).join('')}</div>${tab === 'people' ? renderPeople() : tab === 'agenda' ? renderAgenda() : tab === 'seats' ? renderSeats() : tab === 'materials' ? renderMaterials() : renderMinutes()}</section>${renderMeetingAside()}</div>`;
}
function renderPeople() {
  const ordered = people();
  return `<div class="toolbar"><div><h3>参会名单</h3><p>统一维护人员信息，自动同步至各类会务材料</p></div><div class="toolbar-actions">${btn(`${icon('download')}模板`, 'csv-template', 'small')}${btn(`${icon('upload')}导入 CSV`, 'import-people', 'small')}${btn(`${icon('plus')}添加人员`, 'add-person', 'primary small')}</div></div><div class="rule-row"><span>排序规则</span><select class="select-mini" id="sort-rule" aria-label="人员排序规则"><option value="guest-first" ${state.meeting.sortRule === 'guest-first' ? 'selected' : ''}>职级优先 · 同级客方在前</option><option value="host-first" ${state.meeting.sortRule === 'host-first' ? 'selected' : ''}>职级优先 · 同级主方在前</option></select>${badge(confirmed() ? `V${state.meeting.revision} 已确认` : `V${state.meeting.revision} 待确认`, confirmed() ? 'green' : 'amber')}${state.orderOverride ? badge('含人工调整', 'blue') : ''}</div><div class="table-scroll"><table><thead><tr><th>序号</th><th>姓名</th><th>单位 / 部门</th><th>职务</th><th>身份</th><th>职级</th><th>操作</th></tr></thead><tbody>${ordered.map((p, i) => `<tr><td class="text-subtle">${String(i + 1).padStart(2,'0')}</td><td><div class="person-cell"><span class="person-avatar ${p.side}">${esc(p.name.slice(-2))}</span><span class="person-name">${esc(p.name)}</span></div></td><td class="text-subtle">${esc(p.organization)}</td><td>${esc(p.position)}</td><td>${badge(p.side === 'guest' ? '客方' : '主方', p.side === 'guest' ? 'green' : 'blue')}</td><td class="text-subtle">${p.rank}</td><td><div class="row-actions"><button class="icon-button" data-action="move-person" data-id="${esc(p.id)}" data-direction="-1" ${i === 0 ? 'disabled' : ''} aria-label="上移${esc(p.name)}">${icon('up')}<span class="mobile-action-label">上移</span></button><button class="icon-button" data-action="move-person" data-id="${esc(p.id)}" data-direction="1" ${i === ordered.length-1 ? 'disabled' : ''} aria-label="下移${esc(p.name)}">${icon('down')}<span class="mobile-action-label">下移</span></button><button class="icon-button" data-action="edit-person" data-id="${esc(p.id)}" aria-label="编辑${esc(p.name)}">${icon('edit')}<span class="mobile-action-label">编辑</span></button></div></td></tr>`).join('')}</tbody></table>${!ordered.length ? '<div class="empty">添加或导入参会人员，开始准备会务材料。</div>' : ''}</div><div class="table-footer"><p>共 ${ordered.length} 位参会人员 · 职级数字越小越靠前<br><strong>人员变更后需重新确认，确保材料一致</strong></p>${btn(`${icon('check')}${confirmed() ? '名单与排序已确认' : '确认名单与排序'}`, 'confirm-people', confirmed() ? 'light' : 'primary', !ordered.length || confirmed() ? 'disabled' : '')}</div>`;
}
function renderMeetingAside() {
  const count = state.checklist.filter(Boolean).length;
  const notes = people().filter(p => p.diet && !/^(无|无特殊要求)$/.test(p.diet)).slice(0, 3);
  return `<aside class="meeting-aside"><section class="panel side-panel"><h3>会前准备清单 <span>${count} / ${checklistItems.length}</span></h3><div class="check-progress"><i style="width:${count/checklistItems.length*100}%"></i></div>${checklistItems.map((text,i) => `<label class="checklist-item ${state.checklist[i] ? 'checked' : ''}"><input type="checkbox" data-check-index="${i}" ${state.checklist[i] ? 'checked' : ''}>${text}</label>`).join('')}<p class="note-caption">会议室预约、签到与 Pad 材料同步<br>待企业接口接入</p></section><section class="panel side-panel"><h3>接待提示 ${icon('users')}</h3>${notes.length ? notes.map(p => `<div class="reception-note">${icon('info')}<div><strong>${esc(p.name)}</strong><p>${esc(p.diet)}</p></div></div>`).join('') : '<p class="note-caption">本次会议未记录特殊接待要求。</p>'}<p class="note-caption">示例偏好仅供演示。实际录入前须获得本人授权。</p></section><section class="panel side-panel activity-panel"><h3>最近操作 <span>本地记录</span></h3>${state.activity.length ? state.activity.slice(0,3).map(a => `<div class="activity-item"><i></i><div>${esc(a.message)}<span>${esc(a.time)}</span></div></div>`).join('') : '<p class="note-caption">确认名单或生成材料后，<br>操作记录会显示在这里。</p>'}</section></aside>`;
}
function agenda() { return state.agenda || generateAgenda(state.meeting); }
function renderAgenda() { return `<div class="toolbar"><div><h3>会议议程</h3><p>根据会议信息生成的建议议程，可按实际安排修改</p></div>${btn(`${icon('edit')}编辑议程`, 'edit-agenda', 'small')}</div><div class="content-pad" style="padding-top:0"><div class="notice">${icon('info')}这是建议议程。主持人与发言人需由会务负责人确认。</div>${agenda().map(a => `<div class="agenda-item"><div class="agenda-time">${esc(a.time)}</div><div class="agenda-body"><h4>${esc(a.title)}</h4><p>${esc(a.speaker)}</p></div></div>`).join('')}</div>`; }
function renderSeats() { return `<div class="toolbar"><div><h3>座位编排</h3><p>按当前名单顺序分配示意座位 · 共 ${state.participants.length} 席</p></div><select id="seat-layout" class="select-mini" aria-label="座位布局"><option value="boardroom" ${state.meeting.layout === 'boardroom' ? 'selected' : ''}>会议室长桌</option><option value="round" ${state.meeting.layout === 'round' ? 'selected' : ''}>圆桌布局</option></select></div><div class="content-pad" style="padding-top:0"><div class="notice ${confirmed() ? '' : 'amber'}">${icon('info')}${confirmed() ? '人员顺序已确认。实际礼宾座次以企业规范及现场安排为准。' : '当前为待确认预览。请先在参会人员页核对并确认排序。'}</div><div class="seat-preview">${createSeatMapSvg(people(),state.meeting)}${btn(`${icon('search')}放大查看`,'preview-seats','mobile-only mobile-seat-open small')}</div><div class="mobile-only"><div class="mobile-preview-list-heading">座次列表 <span>${state.participants.length} 位</span></div>${renderMobileSeatList(people())}</div><div class="actions-line">${btn(`${icon('download')}导出 SVG 座位图`, 'export-seats', 'small', !ready() ? 'disabled' : '')}${btn('生成会务材料', 'generate-materials', 'primary small', !confirmed() ? 'disabled' : '')}</div></div>`; }
function renderMaterials() {
  const materials = [['users','参会名单','统一名单，包含单位、职务与排序。','CSV','export-list'],['calendar','会议议程','包含时间、议题与发言人安排。','Word','export-agenda'],['book','会议手册','会议信息、议程与参会名单合成。','Word','export-handbook'],['file','桌签与饭签','可直接打印，支持 A4 排版。','打印','export-nameplates'],['grid','座位图','会议室长桌、圆桌两种布局。','SVG','export-seats']];
  return `<div class="toolbar"><div><h3>五类材料，同一份数据</h3><p>${ready() ? `全部材料已关联确认名单 V${state.meeting.revision}` : '确认名单后，一键生成当前版本的全部材料'}</p></div>${btn(`${icon('spark')}${ready() ? '重新生成' : '生成全部材料'}`, 'generate-materials', 'primary small', !confirmed() ? 'disabled' : '')}</div><div class="content-pad" style="padding-top:0"><div class="notice ${confirmed() ? 'blue' : 'amber'}">${icon(confirmed() ? 'link' : 'info')}${confirmed() ? '增删人员、调整职务或修改会议信息后，所有材料将同步失效；重新确认即可生成新版本。' : '请先完成名单排序的人工确认，再生成与导出材料。'}</div><div class="material-grid">${materials.map(([g,title,desc,format,action]) => `<article class="material"><div class="material-icon">${icon(g)}</div>${badge(ready() ? `V${state.meeting.revision} 已就绪` : '待生成', ready() ? 'green' : 'gray')}<h4>${title}</h4><p>${desc}</p><div class="material-actions">${btn(`${icon('download')}${format === '打印' ? '桌签预览' : `导出 ${format}`}`, action, 'small', !ready() ? 'disabled' : '')}${action === 'export-nameplates' ? btn('饭签预览','export-mealplates','small',!ready() ? 'disabled' : '') : ''}</div></article>`).join('')}</div></div>`;
}
function renderMinutes() {
  return `<div class="toolbar"><div><h3>会议纪要与督办</h3><p>记录整理为草稿，经审核后纳入事项跟进</p></div><span data-minutes-status class="badge ${state.minutes.reviewed?'green':'amber'}">${state.minutes.reviewed?'已审核':'待人工审核'}</span></div><div class="content-pad" style="padding-top:0"><div class="field"><div class="editor-label"><label for="minutes-input">原始会议记录</label>${btn(`${icon('upload')}导入 TXT`, 'import-text', 'ghost small', 'data-target="minutes"')}</div><textarea class="large" id="minutes-input" placeholder="粘贴会议记录。明确的待办可写为：待办：张三负责汇总台账，截止2026-10-25。">${esc(state.minutes.input)}</textarea></div><div class="actions-line">${btn(`${icon('spark')}${busy ? '正在整理…' : '整理纪要草稿'}`, 'generate-minutes', 'primary', busy ? 'disabled' : '')}<span class="result-status">${settings().endpoint ? '通过已配置模型生成，需人工复核' : '规则演示 · 不调用模型，不补写缺失事实'}</span></div>${state.minutes.output ? `<div class="field" style="margin-top:25px"><div class="editor-label"><label for="minutes-output">纪要草稿 · 可编辑</label>${badge(state.minutes.mode === 'deepseek' ? 'DeepSeek 生成' : '规则整理','blue')}</div><textarea id="minutes-output" class="large">${esc(state.minutes.output)}</textarea></div><div class="notice">${icon('info')}请同时核对纪要正文与下方行动项。负责人和期限缺失时保留“待确认”，不会自动指派或通知。</div><div class="section-heading"><h3>待审核行动项</h3><span class="text-subtle" style="font-size:10px">保留原文依据</span></div>${renderTaskDrafts()}<div class="actions-line">${btn(`${icon('check')}${state.minutes.reviewed ? '纪要已审核' : '审核通过并录入督办'}`, 'review-minutes', 'primary',state.minutes.reviewed ? 'disabled':'')}${btn(`${icon('download')}导出纪要 Word`, 'export-minutes', '', !state.minutes.reviewed ? 'disabled' : '')}</div>` : ''}${state.tasks.length ? `<div class="section-heading"><h3>督办事项 <span class="text-subtle">${state.tasks.filter(t => t.status === '已完成').length}/${state.tasks.length}</span></h3>${btn('导出事项清单','export-tasks','ghost small')}</div>${state.tasks.map(t => `<label class="task-item ${t.status === '已完成' ? 'done' : ''}"><input type="checkbox" data-task-id="${esc(t.id)}" ${t.status === '已完成' ? 'checked' : ''}><div><strong>${esc(t.title)}</strong><p>负责人：${esc(t.owner || '待确认')} · 截止：${esc(t.deadline || '待确认')} · ${esc(t.status)}</p></div></label>`).join('')}` : ''}</div>`;
}
function renderTaskDrafts() { return (state.minutes.drafts || []).length ? state.minutes.drafts.map((t,i) => `<div class="task-draft"><div class="field"><label for="task-title-${i}">事项 ${i+1}</label><input id="task-title-${i}" data-draft-index="${i}" data-draft-field="title" value="${esc(t.title)}"></div><div class="field-row"><div class="field"><label>负责人</label><input aria-label="事项${i+1}负责人" data-draft-index="${i}" data-draft-field="owner" value="${esc(t.owner)}" placeholder="待确认"></div><div class="field"><label>截止时间</label><input aria-label="事项${i+1}截止时间" data-draft-index="${i}" data-draft-field="deadline" value="${esc(t.deadline)}" placeholder="待确认"></div></div><p class="note-caption">原文：${esc(t.source)}</p></div>`).join('') : '<p class="note-caption">原文中未找到明确的待办语句。请在记录中补充“待办：事项、负责人、期限”后重新整理。</p>'; }
function renderNews() {
  const filtered = state.news.filter(n => newsFilter === '全部' || n.status === newsFilter);
  return `${pageHeading('政务信息助手','采集有出处，编审有步骤，让每一条信息可追溯。',btn(`${icon('plus')}录入候选信息`,'add-news','primary'))}<div class="news-grid"><section class="panel"><div class="toolbar"><div class="filters">${['全部','待核验','待复核','待审批','已通过'].map(f => `<button class="filter ${newsFilter === f ? 'active':''}" data-action="filter-news" data-filter="${f}">${f}${f === '全部' ? ` ${state.news.length}` : ''}</button>`).join('')}</div>${btn(`${icon('download')}导出选中发布稿`,'export-news','small')}</div><div class="notice" style="margin:0 23px 8px">${icon('info')}预置候选为虚构素材。当前演练人工审批步骤，未接实时检索、事实核验服务与石化通发送。</div>${filtered.map(n => `<article class="news-row"><input type="checkbox" data-news-select="${esc(n.id)}" ${n.selected ? 'checked':''} aria-label="选择${esc(n.title)}"><div class="news-row-body"><div class="news-meta">${badge(n.category,'blue')}${badge(n.status,n.status === '已通过'?'green':'amber')}<span>${esc(n.publishedAt)}</span></div><button class="news-title" data-action="view-news" data-id="${esc(n.id)}"><h3>${esc(n.title)}</h3></button><p>${esc(n.summary)}</p><div class="news-actions"><div class="news-meta"><span>${icon('link')} ${esc(n.source)}</span>${safeURL(n.url) ? `<a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">查看来源</a>` : '<span>无真实外部来源</span>'}</div>${btn(n.status === '待核验' ? '核验与编辑' : n.status === '待复核' ? '主任复核' : n.status === '待审批' ? '执行审批' : '查看记录','view-news','small',`data-id="${esc(n.id)}"`)}</div></div></article>`).join('')}${!filtered.length ? '<div class="empty">该阶段暂无素材。可从其他阶段继续编审。</div>':''}</section><aside class="news-aside"><section class="panel side-panel"><h3>今日要闻编审流程</h3>${[['来源核验','核对真实性、时间、来源、数据与链接'],['主任复核','人工筛选，修改摘要并检查重复'],['审批确认','复核记录留痕，批准后才能导出'],['导出发布稿','导出已批准稿件，供授权人员发布']].map(([t,d],i)=>`<div class="review-step"><span>${i+1}</span><div><h4>${t}</h4><p>${d}</p></div></div>`).join('')}<div class="notice amber">审批为本地流程演练，无真实角色鉴权。石化通接口及权限待确认。</div></section></aside></div>`;
}
function safeURL(value) { try { return ['http:','https:'].includes(new URL(value).protocol); } catch { return false; } }
function renderDocuments() { return `${pageHeading('公文助手','用模板规范表达，保留事实依据，让起草和校对更高效。')}<div class="doc-layout"><section class="panel"><div class="doc-tabs">${['会议纪要','工作通知','请示报告'].map(t=>`<button class="doc-template ${state.doc.template === t ? 'active':''}" data-action="doc-template" data-template="${t}">${t}</button>`).join('')}</div><div class="content-pad"><div class="editor-grid"><div><div class="field"><label for="doc-input">业务素材与起草要求</label><textarea class="large" id="doc-input" placeholder="输入业务事实、时间地点、原始记录及起草要求。缺失信息将标为待补充。">${esc(state.doc.input)}</textarea></div>${btn(`${icon('spark')}${busy ? '正在起草…':'生成公文草稿'}`,'generate-doc','primary',busy?'disabled':'')}${btn('引用当前会议记录','use-minutes','ghost small')}<p class="result-status">${settings().endpoint ? '通过已配置 DeepSeek 接口生成' : '演示模式使用规则模板，不调用模型'}</p></div><div><div class="field"><div class="editor-label"><label for="doc-output">${state.doc.template}草稿</label><span data-doc-status class="badge ${state.doc.reviewed?'green':'amber'}">${state.doc.reviewed?'已人工确认':'待人工审核'}</span></div><textarea class="large" id="doc-output" placeholder="草稿会显示在这里。生成后可继续编辑、校对和导出。">${esc(state.doc.output)}</textarea></div><div class="actions-line">${btn('文本校对','proof-doc','small',!state.doc.output?'disabled':'')}${btn('确认并导出 Word','export-doc','primary small',!state.doc.output?'disabled':'')}</div></div></div>${state.doc.proofs ? `<ul class="proof-list">${state.doc.proofs.map(p=>`<li>${esc(p)}</li>`).join('')}</ul>`:''}<div class="actions-line" style="margin-top:23px">${btn(`${icon('book')}保存草稿到知识库`,'save-doc-knowledge','small',!state.doc.output?'disabled':'')}</div></div></section><aside class="panel side-panel doc-help"><h3>起草与复核提示</h3><h4>先有事实，再有表达</h4><p>时间、参与人、结论、责任人应有材料依据；未明确的信息保留待确认。</p><h4>模板可以继续完善</h4><p>首版内置三种通用结构。企业正式公文格式和历史样稿可在后续导入。</p><h4>轻量校对范围</h4><ul><li>待补充内容</li><li>重复词与标点</li><li>明显的中英文标点混用</li></ul><p>不代表已完成事实、格式规范或法规合规审查。</p></aside></div>`; }
function renderKnowledge() {
  const records = [...state.knowledge, ...state.participants.map(p=>({id:p.id,title:p.name,type:'人员',updatedAt:day(),tags:[p.side==='guest'?'客方':'主方',p.position],content:`${p.organization} · ${p.position} · 职级 ${p.rank}`,person:true}))];
  const filtered = records.filter(k=>(knowledgeFilter === '全部' || k.type === knowledgeFilter) && `${k.title} ${k.content} ${(k.tags||[]).join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  return `${pageHeading('综合知识库','沉淀人员、来访记录与业务模板，为下一次任务提供上下文。',btn(`${icon('plus')}新增资料`,'add-knowledge','primary'))}<div class="toolbar knowledge-tools" style="padding:0 0 23px"><div class="filters">${['全部','模板','制度','来访记录','人员','会议资料'].map(f=>`<button class="filter ${knowledgeFilter===f?'active':''}" data-action="filter-knowledge" data-filter="${f}">${f}</button>`).join('')}</div><div class="searchbox">${icon('search')}<input id="knowledge-search" placeholder="搜索人员、模板或关键词" value="${esc(search)}" aria-label="搜索知识库"></div></div><div class="knowledge-grid">${filtered.map(k=>`<article class="panel knowledge-card"><div class="knowledge-top">${icon(k.person?'users':k.type==='来访记录'?'calendar':'file')}${badge(k.type)}</div><h3>${esc(k.title)}</h3><p>${esc(k.content.slice(0,90))}${k.content.length>90?'…':''}</p><div class="tags">${(k.tags||[]).slice(0,3).map(t=>`<span class="tag">${esc(t)}</span>`).join('')}</div><div class="knowledge-bottom"><span>${k.person?'与当前会议名单同步':esc(k.updatedAt)+' 更新'}</span><button class="text-link" data-action="${k.person?'edit-person':'view-knowledge'}" data-id="${esc(k.id)}">查看与编辑 ${icon('chevron')}</button></div></article>`).join('')}</div>${!filtered.length?'<div class="panel empty">没有匹配的资料，请调整关键词或筛选条件。</div>':''}<div class="notice" style="margin-top:23px">${icon('book')}当前知识库为浏览器内的结构化检索和资料维护；向量检索、企业文档库与跨设备共享留待接入。</div>`;
}

function modal(title, subtitle, body, form = '', actions = '', wide = false) {
  const el = $('#modal');
  el.className = wide ? 'wide' : '';
  el.innerHTML = `<div class="modal-head"><div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div><button data-action="close-modal" aria-label="关闭弹窗">${icon('close')}</button></div>${form ? `<form id="${form}">` : ''}${body}${actions ? `<div class="modal-actions">${actions}</div>` : ''}${form ? '</form>' : ''}`;
  if (!el.open) el.showModal();
}
const cancel = () => btn('取消', 'close-modal', '', 'type="button"');
const submit = (label = '保存') => `<button class="btn primary" type="submit">${label}</button>`;
function personModal(id) {
  const p = state.participants.find(p => p.id === id) || { id:'',name:'',organization:'',position:'',side:'guest',rank:3,diet:'' };
  modal(p.id ? '编辑参会人员' : '添加参会人员', '信息变更后，原确认和会务材料将失效，需重新确认。', `<input type="hidden" name="id" value="${esc(p.id)}"><div class="field-row"><div class="field"><label for="person-name">姓名</label><input id="person-name" name="name" value="${esc(p.name)}" required maxlength="30"></div><div class="field"><label for="person-org">单位 / 部门</label><input id="person-org" name="organization" value="${esc(p.organization)}" required maxlength="80"></div></div><div class="field"><label for="person-position">职务</label><input id="person-position" name="position" value="${esc(p.position)}" required maxlength="60"></div><div class="field-row"><div class="field"><label for="person-side">主客身份</label><select id="person-side" name="side"><option value="guest" ${p.side==='guest'?'selected':''}>客方</option><option value="host" ${p.side==='host'?'selected':''}>主方</option></select></div><div class="field"><label for="person-rank">职级（数字越小越靠前）</label><select id="person-rank" name="rank">${[1,2,3,4,5].map(n=>`<option ${Number(p.rank)===n?'selected':''}>${n}</option>`).join('')}</select></div></div><div class="field"><label for="person-diet">接待备注</label><input id="person-diet" name="diet" value="${esc(p.diet)}" maxlength="160" placeholder="可选，请仅录入经授权的接待需求"></div><label class="checkbox-label"><input type="checkbox" name="authorized" ${p.diet ? 'checked':''}>如填写接待备注，我已取得本人授权；当前预置内容为虚构演示。</label>`, 'person-form', `${p.id ? btn(`${icon('trash')}移除人员`,'remove-person','danger','type="button" data-id="'+esc(p.id)+'"'):''}${cancel()}${submit()}`);
}
function meetingModal() {
  const m = state.meeting;
  modal('编辑会议信息','修改后，人员确认与生成材料会同步更新版本。',`<div class="field"><label for="meeting-title">会议名称</label><input id="meeting-title" name="title" value="${esc(m.title)}" required maxlength="100"></div><div class="field-row"><div class="field"><label for="meeting-date">会议日期</label><input id="meeting-date" name="date" type="date" value="${esc(m.date)}" required></div><div class="field"><label for="meeting-time">开始时间</label><input id="meeting-time" name="time" type="time" value="${esc(m.time)}" required></div></div><div class="field"><label for="meeting-location">会议地点</label><input id="meeting-location" name="location" value="${esc(m.location)}" required maxlength="100"></div><div class="field"><label for="meeting-host">承办部门</label><input id="meeting-host" name="host" value="${esc(m.host)}" required maxlength="60"></div><div class="field"><label for="meeting-topic">会议主题</label><input id="meeting-topic" name="topic" value="${esc(m.topic)}" required maxlength="160"></div>`, 'meeting-form',cancel()+submit());
}
function agendaModal() {
  modal('编辑会议议程','每行使用「时间 | 议题 | 发言人」格式。修改后需重新确认材料版本。',`<div class="field"><label for="agenda-editor">议程安排</label><textarea id="agenda-editor" name="agenda" class="large" required>${esc(agenda().map(a=>`${a.time} | ${a.title} | ${a.speaker}`).join('\n'))}</textarea></div>`,'agenda-form',cancel()+submit());
}
function newsModal(id) {
  const n = state.news.find(n=>n.id===id);
  if (!n) return;
  const demo = n.source==='内部演示素材';
  modal('信息核验与编审', demo ? '这是虚构素材，仅演练审批；勾选核验项不代表获得真实事实依据。' : '核验记录、复核与审批在本地留痕，不会自动发送。',`<h3 style="font-size:16px;line-height:1.8;margin:0 0 15px">${esc(n.title)}</h3><div class="news-meta">${badge(n.status,'blue')}<span>${esc(n.source)} · ${esc(n.publishedAt)}</span>${safeURL(n.url)?`<a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">打开来源</a>`:''}</div><input type="hidden" name="id" value="${esc(n.id)}"><div class="field" style="margin-top:20px"><label for="news-summary">摘要</label><textarea id="news-summary" name="summary" required ${n.status!=='待核验'?'readonly':''}>${esc(n.summary)}</textarea></div>${n.status==='待核验'?`<div class="notice amber">${demo?'请选择演示核验项以体验流程，不用于真实发布。':'请打开原文逐项核对；无法确认的信息应保留待核验状态。'}</div>${['来源主体与真实性','发布时间与时效性','标题、数据与原文一致','链接可追溯（演示素材按示例处理）','未与已有素材重复'].map((x,i)=>`<label class="checkbox-label"><input type="checkbox" name="check-${i}" required>${x}</label>`).join('')}`:''}<div class="field"><label for="news-note">${n.status==='待核验'?'核验':n.status==='待复核'?'主任复核':'审批'}说明</label><textarea id="news-note" name="note" placeholder="记录核验依据或审核意见" ${n.status==='已通过'?'readonly':''}>${n.status==='已通过'?esc(n.notes):''}</textarea></div>${n.notes&&n.status!=='已通过'?`<p class="dialog-prose">历史记录：${esc(n.notes)}</p>`:''}${n.status!=='已通过'?'<p class="note-caption">当前为单人流程演练，按钮不代表企业真实审批权限。</p>':''}`,'news-review-form',`${n.status!=='待核验'?btn('退回重新核验','reset-news','small','type="button" data-id="'+esc(n.id)+'"'):''}${cancel()}${n.status==='已通过'?'':submit(n.status==='待核验'?'完成核验，提交复核':n.status==='待复核'?'复核通过，提交审批':'审批通过')}`,true);
}
function addNewsModal() { modal('录入候选信息','首版通过人工录入来源信息，不宣称完成在线检索或事实核验。',`<div class="field"><label for="new-news-title">标题</label><input id="new-news-title" name="title" required maxlength="150"></div><div class="field-row"><div class="field"><label for="new-news-source">来源名称</label><input id="new-news-source" name="source" required maxlength="100"></div><div class="field"><label for="new-news-date">发布时间</label><input id="new-news-date" name="date" type="date" value="${day()}" required></div></div><div class="field"><label for="new-news-url">原文链接</label><input id="new-news-url" name="url" type="url" placeholder="https://…" required maxlength="1000"></div><div class="field"><label for="new-news-summary">内容摘要</label><textarea id="new-news-summary" name="summary" required maxlength="5000"></textarea></div>`,'news-form',cancel()+submit('加入候选库')); }
function knowledgeModal(id) {
  const k = state.knowledge.find(k=>k.id===id) || {id:'',title:'',type:'会议资料',tags:[],content:''};
  modal(k.id?'资料详情与编辑':'新增知识资料','资料仅保存在当前浏览器。人员资料请在会务名单中维护。',`<input type="hidden" name="id" value="${esc(k.id)}"><div class="field"><label for="knowledge-title">标题</label><input id="knowledge-title" name="title" value="${esc(k.title)}" required maxlength="150"></div><div class="field-row"><div class="field"><label for="knowledge-type">分类</label><select name="type" id="knowledge-type">${['模板','制度','来访记录','会议资料'].map(t=>`<option ${k.type===t?'selected':''}>${t}</option>`).join('')}</select></div><div class="field"><label for="knowledge-tags">标签（逗号分隔）</label><input id="knowledge-tags" name="tags" value="${esc((k.tags||[]).join('，'))}" maxlength="150"></div></div><div class="field"><label for="knowledge-content">正文</label><textarea id="knowledge-content" name="content" class="large" required maxlength="30000">${esc(k.content)}</textarea></div><label class="checkbox-label"><input type="checkbox" name="authorized" ${k.authorized?'checked':''}>来访资料如包含接待偏好或个人信息，已取得本人授权。</label>`,'knowledge-form',`${k.id?btn('删除资料','delete-knowledge','danger','type="button" data-id="'+esc(k.id)+'"'):''}${cancel()}${submit()}`,true);
}
function settingsModal() {
  const s = settings();
  modal('模型与数据设置','默认无需配置即可体验规则演示。真实模型通过独立服务端调用。',`<div class="notice blue">${icon('shield')}GitHub Pages 仅托管静态网页。DeepSeek API Key 必须配置在服务端，不能填入网页或提交仓库。</div><div class="field" style="margin-top:20px"><label for="model-endpoint">你的服务端接口</label><input id="model-endpoint" name="endpoint" type="url" value="${esc(s.endpoint||DEFAULT_ENDPOINT)}" placeholder="https://你的服务地址/api/generate"><p class="hint">留空使用规则演示。只连接你信任的服务端；模型请求会发送当前任务及相关业务文本。</p></div><div class="field"><label for="model-token">演示访问口令（服务端 DEMO_ACCESS_TOKEN）</label><input id="model-token" name="token" type="password" autocomplete="off" value="${esc(s.token||'')}" placeholder="服务端访问口令，不是 DeepSeek API Key"><p class="hint">口令仅保存在当前浏览器会话。服务器部署说明见仓库 README。</p></div><label class="checkbox-label"><input type="checkbox" name="consent" ${s.consent?'checked':''}>我确认这是受信任的接口，允许发送任务、必要名单字段及业务文本给模型处理。</label><div class="section-heading"><h3>本地演示数据</h3></div><p class="note-caption">重置将清除当前浏览器的名单、资料、草稿与督办记录，恢复虚构示例。</p>${btn('重置为演示数据','reset-dialog','danger small','type="button"')}`,'settings-form',cancel()+submit('保存设置'));
}
function guideModal() {
  modal('用 5 分钟讲清楚业务价值','经营管理赛道 · 以可执行的任务流程展示降本增效',`<div class="guide-steps">${[['发起一项真实业务任务','在智能体工作台输入“准备本次会议全部材料”。观察计划、工具名称和每一步执行结果。'],['在关键节点做人工确认','智能体自动整理名单，暂停等待人工核对。在会务助手确认排序后，继续生成五类材料。'],['展示人员变更的联动效果','修改一位参会人员的职务，旧确认和材料自动失效。重新确认并生成，名单、名签和座位图保持一致。'],['从会议记录走到督办','切换纪要任务，整理原文、查看行动项依据，补充负责人和期限，审核后录入督办。'],['说明提效如何验证','记录演示用时；试点时采集同等规模任务的人工基线、总耗时、返工次数和材料一致性，形成可验证对比。']].map(([t,d],i)=>`<div class="guide-step"><span>${i+1}</span><div><h4>${t}</h4><p>${d}</p></div></div>`).join('')}</div><div class="notice amber">默认是规则编排演示。接入服务端后由 DeepSeek 选择工具，前端执行已限定的业务动作。未实现企业审批、石化通、会议室和文档库接口，演示数据不能作为真实降本结果。</div>`, '',btn('开始会务任务','guide-start','primary'),true);
}
async function generateText(task,input) {
  const s=settings();
  if (!s.endpoint) return null;
  if (!s.consent) throw new Error('请先在模型设置中确认数据发送范围。');
  const response = await fetch(s.endpoint,{method:'POST',headers:{'Content-Type':'application/json',...(s.token?{Authorization:`Bearer ${s.token}`}:{})},body:JSON.stringify({task,input,context:{meeting:state.meeting,template:state.doc.template}}),signal:AbortSignal.timeout(65000),credentials:'omit'});
  let result; try {result=await response.json();}catch{throw new Error('模型服务没有返回有效 JSON，请检查服务端地址。');}
  if(!response.ok)throw new Error(result.error?.message||'模型请求失败，请检查服务端配置。');
  if(!result.text||result.mode!=='deepseek')throw new Error('模型结果格式不正确，未更新业务数据。');
  return result.text;
}
async function makeMinutes() {
  const input=state.minutes.input.trim();
  if(!input)throw new Error('请先输入原始会议记录。');
  const targetState=state,sourceMeeting=meetingSignature();
  const derived=deriveMinutes(input,state.meeting);
  const output=await generateText('minutes',input);
  if(state!==targetState || input!==state.minutes.input.trim() || sourceMeeting!==meetingSignature())throw new Error('数据在生成期间已变化，本次结果未写入，请重新整理。');
  state.minutes={...state.minutes,sourceInput:input,sourceMeeting,output:output||derived.content,reviewed:false,drafts:derived.tasks,mode:output?'deepseek':'demo'};
  log('根据会议记录整理纪要草稿');save();
  return `已生成纪要草稿，识别 ${derived.tasks.length} 条有原文依据的待办，等待人工审核。`;
}
function reviewMinutes() {
  if(!state.minutes.output || state.minutes.sourceInput!==state.minutes.input.trim())throw new Error('原始记录已变化或尚未生成纪要，请先重新整理草稿。');
  if(state.minutes.sourceMeeting!==meetingSignature())throw new Error('会议信息已变化，请重新整理纪要后审核。');
  if((state.minutes.drafts||[]).some(t=>!t.title.trim()))throw new Error('请补全行动项标题后再审核。');
  state.minutes.reviewed=true;
  const previous=state.tasks;
  state.tasks=(state.minutes.drafts||[]).map(t=>({...t,status:previous.find(x=>x.id===t.id)?.status||'待办理',meeting:state.meeting.title}));
  log(`纪要人工审核通过，录入 ${(state.minutes.drafts||[]).length} 条督办`);save();
}
function generateMaterials() {if(!confirmed())throw new Error('请先人工确认名单与排序。');state.generatedRevision=state.meeting.revision;log(`生成 V${state.meeting.revision} 五类会务材料`);save();}
async function startAgent() {
  if(busy || run?.waiting)return;
  const goal=$('#agent-goal')?.value.trim()||'';
  if(!goal)throw new Error('请先描述要完成的业务任务。');
  const startedAt=Date.now();
  busy=true;render();
  try{
    const planState=state,planRevision=state.meeting.revision;
    const s=settings();
    if(s.endpoint&&!s.consent)throw new Error('请先在模型设置中确认允许发送业务上下文。');
    const plan=s.endpoint?await requestAgentPlan(goal,state,s):getDemoPlan(goal,state);
    if(state!==planState || planRevision!==state.meeting.revision)throw new Error('任务背景在规划期间已变化，请重新发起任务。');
    run={...plan,goal,steps:plan.steps.map(s=>({...s,status:'pending'})),startedAt,finishedAt:null,waiting:null,index:0};
    log(`发起智能体任务：${goal.slice(0,45)}`);save();
  }finally{busy=false;render();}
  await advanceAgent();
}
async function advanceAgent() {
  if(!run||run.finishedAt)return;
  const currentRun=run;
  busy=true;
  try{
    while(run.index<run.steps.length){
      const step=run.steps[run.index];
      if((step.tool==='generate_materials'&&!confirmed())||(step.tool==='extract_tasks'&&!state.minutes.reviewed)){
        step.status='waiting';run.waiting=step.tool;render();return;
      }
      run.waiting=null;step.status='running';render();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      if(run!==currentRun)return;
      const start=performance.now();
      if(step.tool==='lookup_people')step.result=`已读取当前会议 ${state.participants.length} 位参会人员，关联 ${state.knowledge.length} 份本地知识资料。`;
      else if(step.tool==='sort_participants'){
        if(state.orderOverride){invalidate('智能体按所选规则重新排序人员');}
        state.participants=sortParticipants(state.participants,state.meeting.sortRule);
        step.result=`已按职级优先、同级${state.meeting.sortRule==='guest-first'?'客方':'主方'}在前排序。${confirmed()?'使用当前已确认名单。':'名单等待人工确认。'}`;
      }
      else if(step.tool==='prepare_agenda'){if(!state.agenda)state.agenda=generateAgenda(state.meeting);step.result=`已准备 ${agenda().length} 个议程环节；未明确的主持与发言人标为待确认。`;}
      else if(step.tool==='generate_materials'){generateMaterials();step.result=`五类材料已关联 V${state.meeting.revision} 确认名单，可导出名单、议程、手册、名签和座位图。`;}
      else if(step.tool==='draft_minutes')step.result=await makeMinutes();
      else if(step.tool==='extract_tasks'){if(!state.minutes.reviewed)throw new Error('纪要尚未审核。');step.result=`${(state.minutes.drafts||[]).length} 条审核行动项已录入本地督办，缺失负责人或期限保持待确认。`;}
      else throw new Error('不支持的工具，任务已停止。');
      if(run!==currentRun)return;
      step.duration=Math.round(performance.now()-start);step.status='done';run.index++;save();render();
    }
    run.finishedAt=Date.now();run.waiting=null;state.lastRun={goal:run.goal,mode:run.mode,startedAt:run.startedAt,finishedAt:run.finishedAt,steps:run.steps.map(s=>({tool:s.tool,result:s.result,duration:s.duration}))};log('智能体任务完成');save();
  }catch(error){if(run===currentRun){run.steps[run.index].status='error';run.steps[run.index].result=error.message;run.waiting=null;toast(error.message);}}
  finally{if(run===currentRun){busy=false;render();}}
}
function requireMaterials() {if(!ready())throw new Error('材料尚未生成或已因业务变化失效，请重新确认并生成。');}
function exportMaterial(action) {
  requireMaterials();const m=state.meeting;const list=people();const prefix=`${m.title}-V${m.revision}`;
  if(action==='export-list')downloadFile(`${prefix}-参会名单.csv`,participantsToCSV(list),'text/csv;charset=utf-8');
  else if(action==='export-agenda')downloadDocx(`${m.title} 会议议程`,[`时间：${m.date} ${m.time}`,`地点：${m.location}`,`名单版本：V${m.revision}`,...agenda().map(a=>`${a.time}　${a.title}　${a.speaker}`),'根据当前信息生成，请以人工确认后的正式安排为准。'],`${prefix}-会议议程.docx`);
  else if(action==='export-handbook')downloadDocx(`${m.title} 会议手册`,[{text:'一 会议信息',heading:true},`时间：${m.date} ${m.time}`,`地点：${m.location}`,`承办部门：${m.host}`,`主题：${m.topic}`,`已确认名单版本：V${m.revision}`,{text:'二 会议议程',heading:true},...agenda().map(a=>`${a.time}　${a.title}　${a.speaker}`),{text:'三 参会人员',heading:true},...list.map((p,i)=>`${i+1}. ${p.name}　${p.organization}　${p.position}　${p.side==='guest'?'客方':'主方'}`),{text:'四 会务提示',heading:true},'请提前到场核对签到信息，材料与实际礼宾安排以会务负责人确认为准。'],`${prefix}-会议手册.docx`);
  else if(action==='export-seats')downloadFile(`${prefix}-座位图.svg`,createSeatMapSvg(list,m),'image/svg+xml;charset=utf-8');
  else if(!openPrintSheet(action==='export-nameplates'?'nameplates':'mealplates',list,m))throw new Error('打印预览窗口被浏览器拦截，请允许此站点弹出窗口后重试。');
  toast(action.includes('plates')?'已打开打印预览，可打印或另存为 PDF。':'已导出当前确认版本的材料。');
}
document.addEventListener('click',async event=>{
  const el=event.target.closest('[data-action]');if(!el||el.disabled)return;
  const a=el.dataset.action,id=el.dataset.id;
  if(mobileOpen && a!=='mobile' && a!=='nav')setMobileDrawer(false,{restoreFocus:false});
  try{
    if(mobileOpen&&a!=='mobile'&&el.closest('#mobile-more-drawer'))setMobileDrawer(false,{restoreFocus:false});
    if(a==='nav')go(el.dataset.section);
    else if(a==='mobile')setMobileDrawer(!mobileOpen);
    else if(a==='tab'){tab=el.dataset.tab;render();}
    else if(a==='close-modal')$('#modal').close();
    else if(a==='edit-meeting')meetingModal();
    else if(a==='add-person'||a==='edit-person')personModal(id);
    else if(a==='remove-person'){const p=state.participants.find(p=>p.id===id);modal('移除参会人员',`移除 ${p.name} 后，名单确认和旧材料会失效。`,'','',cancel()+btn('确认移除','remove-person-confirm','danger',`data-id="${esc(id)}"`));}
    else if(a==='remove-person-confirm'){state.participants=state.participants.filter(p=>p.id!==id);invalidate('移除参会人员');$('#modal').close();render();toast('已移除，请重新确认名单。');}
    else if(a==='move-person'){const ordered=people();const i=ordered.findIndex(p=>p.id===id),j=i+Number(el.dataset.direction);if(j<0||j>=ordered.length)return;[ordered[i],ordered[j]]=[ordered[j],ordered[i]];invalidateMeeting(state);state.generatedRevision=0;state.orderOverride=ordered.map(p=>p.id);log('人工调整名单顺序');save();render();}
    else if(a==='confirm-people'){if(!state.participants.length)throw new Error('名单为空，请添加人员。');state.meeting.confirmedRevision=state.meeting.revision;state.checklist[2]=true;log(`人工确认 V${state.meeting.revision} 名单与排序`);save();render();toast('名单与排序已确认，可生成会务材料。');if(run?.waiting==='generate_materials'){go('agent');await advanceAgent();}}
    else if(a==='csv-template')downloadFile('参会人员导入模板.csv',participantsToCSV([{name:'示例姓名',organization:'示例单位',position:'部门负责人',side:'guest',rank:3,diet:''}]),'text/csv;charset=utf-8');
    else if(a==='import-people')modal('导入参会名单','支持 UTF-8 CSV。先下载模板，再按模板填入人员信息。',`<div class="notice amber">${icon('info')}导入会替换当前名单。必须包含姓名、单位、职务、主客、职级、接待备注六列表头；职级为 1–5。最多 80 位参会人员。</div><label class="checkbox-label"><input id="csv-consent" type="checkbox">如文件含接待偏好，我确认已取得本人授权。</label>`,'',cancel()+btn('选择 CSV 文件','choose-csv','primary'));
    else if(a==='choose-csv'){if(!$('#csv-consent').checked)throw new Error('请先确认接待信息的授权条件。');$('#csv-file').click();}
    else if(a==='edit-agenda')agendaModal();
    else if(a==='generate-materials'){generateMaterials();tab='materials';render();toast('五类材料已按当前确认名单生成。');}
    else if(a==='preview-seats')openSeatMapViewer(people(),state.meeting,{allowExport:ready()});
    else if(['export-list','export-agenda','export-handbook','export-nameplates','export-mealplates','export-seats'].includes(a))await exportMaterial(a);
    else if(a==='import-text'){$('#text-file').dataset.target=el.dataset.target;$('#text-file').click();}
    else if(a==='generate-minutes'){busy=true;render();try{await makeMinutes();}finally{busy=false;render();}}
    else if(a==='review-minutes'){reviewMinutes();render();toast('纪要已审核，行动项已录入本地督办。');if(run?.waiting==='extract_tasks'){go('agent');await advanceAgent();}}
    else if(a==='export-minutes'){if(!state.minutes.reviewed)throw new Error('请先审核纪要。');downloadDocx(`${state.meeting.title} 会议纪要`,state.minutes.output.split('\n'),`${state.meeting.title}-会议纪要.docx`);}
    else if(a==='export-tasks')downloadDocx(`${state.meeting.title} 督办事项`,state.tasks.map((t,i)=>`${i+1}. ${t.title}\n负责人：${t.owner||'待确认'}\n截止：${t.deadline||'待确认'}\n状态：${t.status}\n原文依据：${t.source||'人工录入'}`),`${state.meeting.title}-督办事项.docx`);
    else if(a==='filter-news'){newsFilter=el.dataset.filter;render();}
    else if(a==='add-news')addNewsModal();
    else if(a==='view-news')newsModal(id);
    else if(a==='reset-news'){const n=state.news.find(n=>n.id===id);n.status='待核验';n.verified=false;n.notes+=`\n${day()} ${clockTime()} 退回重新核验`;save();newsModal(id);render();}
    else if(a==='export-news'){const chosen=state.news.filter(n=>n.selected);if(!chosen.length)throw new Error('请先选择要导出的素材。');if(chosen.some(n=>n.status!=='已通过'))throw new Error('所选素材中有尚未审批通过的信息，请先完成编审。');downloadDocx('今日要闻 发布稿（待授权人员发布）',['本文件仅为导出稿，未向石化通或任何平台发送。',...chosen.flatMap(n=>[{text:n.title,heading:true},n.summary,`来源：${n.source}　日期：${n.publishedAt}`,`原文链接：${n.url||'虚构演示素材，无真实来源'}`,`编审记录：${n.notes}`])],'今日要闻-发布稿.docx');toast('已导出审批通过的发布稿，未自动发送。');}
    else if(a==='doc-template'){state.doc.template=el.dataset.template;save();render();}
    else if(a==='use-minutes'){state.doc.input=state.minutes.input;state.doc.reviewed=false;save();render();}
    else if(a==='generate-doc'){
      const docState=state,docTemplate=state.doc.template;const input=state.doc.input.trim();if(!input)throw new Error('请先输入业务素材或引用会议记录。');busy=true;render();
      try{const result=await generateText('draft',`文种：${docTemplate}\n${input}`);if(state!==docState || state.doc.input.trim()!==input || state.doc.template!==docTemplate)throw new Error('业务素材在生成期间已变化，本次结果未写入。');state.doc.output=result||(state.doc.template==='会议纪要'?deriveMinutes(input,state.meeting).content:`${state.doc.template}（演示草稿）\n\n${state.doc.template==='工作通知'?'关于【待补充事项名称】的通知\n\n各有关部门：':'关于【待补充事项名称】的请示\n\n【待补充主送机关】：'}\n\n根据所提供的业务素材，拟稿如下：\n${input}\n\n${state.doc.template==='工作通知'?'工作要求：【待补充责任分工与时限】':'请示事项：【待补充具体请求】\n妥否，请批示。'}\n\n【待补充发文单位与日期】\n\n说明：规则模板演示，未调用模型，需依据实际事实编辑审核。`);state.doc.reviewed=false;state.doc.proofs=null;save();}finally{busy=false;render();}}
    else if(a==='proof-doc'){const text=state.doc.output,findings=[];if(/待补充|待确认/.test(text))findings.push('存在待补充或待确认内容，请补齐后再正式发文。');if(/([，。！？、；：])\1+/.test(text))findings.push('发现连续重复标点，请检查。');if(/的的|了了|进行进行|关于关于/.test(text))findings.push('发现可能的重复词，请核对。');if(/[\u4e00-\u9fff][,;:!?]/.test(text))findings.push('发现中文与英文半角标点混用，请检查文体要求。');if(!findings.length)findings.push('在轻量规则范围内未发现上述问题，仍需核验事实、业务口径及正式公文格式。');state.doc.proofs=findings;save();render();}
    else if(a==='export-doc'){if(!state.doc.output.trim())throw new Error('草稿为空。');modal('确认公文后导出','请确认已核对事实、名称、日期和待补充内容。','<p class="dialog-prose">确认后导出可编辑的 Word 文件。此操作不代表企业正式发文审批。</p>','',cancel()+btn('确认并导出','export-doc-confirm','primary'));}
    else if(a==='export-doc-confirm'){state.doc.reviewed=true;save();downloadDocx(state.doc.template,state.doc.output.split('\n'),`${state.doc.template}-${day()}.docx`);$('#modal').close();render();}
    else if(a==='save-doc-knowledge'){state.knowledge.unshift({id:uid('knowledge'),title:`${state.doc.template}草稿 · ${day()}`,type:'会议资料',updatedAt:day(),tags:['草稿','待审核'],content:state.doc.output,meeting:state.meeting.title});save();toast('草稿已保存到知识库，标记为待审核。');}
    else if(a==='filter-knowledge'){knowledgeFilter=el.dataset.filter;render();}
    else if(a==='add-knowledge'||a==='view-knowledge')knowledgeModal(id);
    else if(a==='delete-knowledge')modal('删除知识资料','删除后无法撤销，请确认当前资料不再需要。','','',cancel()+btn('确认删除','delete-knowledge-confirm','danger',`data-id="${esc(id)}"`));
    else if(a==='delete-knowledge-confirm'){state.knowledge=state.knowledge.filter(k=>k.id!==id);save();$('#modal').close();render();}
    else if(a==='settings')settingsModal();
    else if(a==='guide')guideModal();
    else if(a==='guide-start'){$('#modal').close();go('agent');}
    else if(a==='reset-dialog')modal('重置当前浏览器的演示数据','将清除当前名单、资料、草稿和督办事项，恢复虚构示例。','','',cancel()+btn('确认重置','reset-confirm','danger'));
    else if(a==='reset-confirm'){state=createInitialState();state.checklist=[true,true,false,false,false];state.doc={template:'会议纪要',input:'',output:'',reviewed:false};state.generatedRevision=0;run=null;busy=false;save();$('#modal').close();go('agent');toast('已恢复演示数据。');}
    else if(a==='open-meeting')go('meeting','people');
    else if(a==='open-agent')go('agent');
    else if(a==='preset'){$('#agent-goal').value=el.dataset.kind==='minutes'?'请整理当前会议记录为纪要，提取待办，审核后录入督办。':'请整理本次会议名单，按职级和主客排序，再准备全部会务材料。';$('#agent-goal').focus();}
    else if(a==='agent-start')await startAgent();
    else if(a==='agent-review')go('meeting',run?.waiting==='generate_materials'?'people':'minutes');
    else if(a==='agent-cancel'){run=null;busy=false;render();toast('本次编排已取消，已完成的业务修改仍保留。');}
    else if(a==='agent-result')go('meeting',run?.steps.some(s=>s.tool==='extract_tasks'||s.tool==='draft_minutes')?'minutes':run?.steps.some(s=>s.tool==='generate_materials')?'materials':'people');
  }catch(error){toast(error.message||'操作未完成，请重试。');}
});

document.addEventListener('submit',event=>{
  if(event.target.id?.startsWith('feedback-'))return;
  event.preventDefault();const form=event.target;const f=new FormData(form);const text=n=>String(f.get(n)||'').trim();
  try{
    if(form.id==='person-form'){
      if(!text('name')||!text('organization')||!text('position'))throw new Error('姓名、单位和职务不能为空。');
      if(text('diet')&&!f.has('authorized'))throw new Error('填写接待备注前请确认本人授权。');
      const id=text('id')||uid('person');if(state.participants.some(p=>p.id!==id&&p.name===text('name')&&p.organization===text('organization')))throw new Error('当前单位已存在同名人员，请核实。');
      if(!text('id')&&state.participants.length>=80)throw new Error('首版单场会议最多支持 80 人。');
      const p={id,name:text('name'),organization:text('organization'),position:text('position'),rank:Number(text('rank')),side:text('side'),diet:text('diet'),authorized:f.has('authorized')};
      const i=state.participants.findIndex(p=>p.id===id);if(i>=0)state.participants[i]=p;else state.participants.push(p);invalidate(`${i>=0?'更新':'添加'}参会人员 ${p.name}`);
    }else if(form.id==='meeting-form'){
      for(const key of ['title','date','time','location','host','topic']){if(!text(key))throw new Error('请完整填写会议信息。');state.meeting[key]=text(key);}
      state.agenda=null;state.minutes.reviewed=false;invalidate('更新会议信息与建议议程');
    }else if(form.id==='agenda-form'){
      const lines=text('agenda').split('\n').filter(l=>l.trim());if(!lines.length)throw new Error('至少需要一条议程。');
      const parsed=lines.map((line,i)=>{const a=line.split('|').map(s=>s.trim());if(a.length!==3||!/^([01]\d|2[0-3]):[0-5]\d$/.test(a[0])||!a[1]||!a[2])throw new Error(`第 ${i+1} 行格式不正确，请使用 时间 | 议题 | 发言人。`);return {time:a[0],title:a[1],speaker:a[2]};});state.agenda=parsed;invalidate('更新会议议程');
    }else if(form.id==='news-form'){
      if(!safeURL(text('url')))throw new Error('请输入有效的 HTTP 或 HTTPS 来源链接。');
      if(state.news.some(n=>n.title.replace(/\s/g,'')===text('title').replace(/\s/g,'')||n.url&&n.url.replace(/\/$/,'')===text('url').replace(/\/$/,'')))throw new Error('候选库已有相同标题或来源链接，避免重复录入。');
      state.news.unshift({id:uid('news'),title:text('title'),source:text('source'),url:text('url'),publishedAt:text('date'),summary:text('summary'),category:'人工录入',status:'待核验',verified:false,selected:false,notes:''});save();
    }else if(form.id==='news-review-form'){
      const n=state.news.find(n=>n.id===text('id'));if(n.status==='已通过')return;
      if(n.status==='待核验'){
        if(![0,1,2,3,4].every(i=>f.has(`check-${i}`)))throw new Error('请先完成全部核验项。');
        if(!text('note'))throw new Error('请记录核验依据；虚构素材请注明仅作演示。');
        n.summary=text('summary');n.verified=true;n.status='待复核';
      }else if(n.status==='待复核')n.status='待审批';else n.status='已通过';
      n.notes+=`\n${day()} ${clockTime()} ${n.status}：${text('note')||'人工流程演练确认'}`;save();
    }else if(form.id==='knowledge-form'){
      if(text('type')==='来访记录'&&!f.has('authorized'))throw new Error('来访资料请确认本人授权后保存。');
      const k={id:text('id')||uid('knowledge'),title:text('title'),type:text('type'),updatedAt:day(),tags:text('tags').split(/[,，]/).map(s=>s.trim()).filter(Boolean),content:text('content'),authorized:f.has('authorized')};const i=state.knowledge.findIndex(k=>k.id===text('id'));if(i>=0)state.knowledge[i]=k;else state.knowledge.unshift(k);save();
    }else if(form.id==='settings-form'){
      const endpoint=text('endpoint');if(endpoint){const u=new URL(endpoint);if(!safeURL(endpoint)||!u.pathname.endsWith('/api/generate'))throw new Error('接口地址应以 /api/generate 结尾。');if(u.username||u.password||u.search||u.hash)throw new Error('接口地址不能包含账号、口令、查询参数或片段。');if(u.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(u.hostname))throw new Error('远程接口必须使用 HTTPS。');if(!f.has('consent'))throw new Error('请确认允许向该服务端发送必要业务上下文。');}
      if(/^sk-/.test(text('token')))throw new Error('这里填写服务访问口令，不是 DeepSeek API Key。API Key 只能放在服务端。');
      localStorage.setItem('zhixing-model',JSON.stringify({endpoint,consent:f.has('consent')}));sessionStorage.setItem('zhixing-access',text('token'));
    }
    $('#modal').close();render();toast('已保存。');
  }catch(error){toast(error.message);}
});
function syncReviewControls() {
  const review=$('[data-action="review-minutes"]');
  if(review){review.disabled=state.minutes.reviewed;review.innerHTML=icon('check')+(state.minutes.reviewed?'纪要已审核':'审核通过并录入督办');}
  const exportMinutes=$('[data-action="export-minutes"]');if(exportMinutes)exportMinutes.disabled=!state.minutes.reviewed;
  const status=$('[data-minutes-status]');if(status){status.textContent=state.minutes.reviewed?'已审核':'待人工审核';status.className=`badge ${state.minutes.reviewed?'green':'amber'}`;}
  for(const action of ['export-doc','proof-doc','save-doc-knowledge']){const control=$(`[data-action="${action}"]`);if(control)control.disabled=!state.doc.output.trim();}
  const docStatus=$('[data-doc-status]');if(docStatus){docStatus.textContent=state.doc.reviewed?'已人工确认':'待人工审核';docStatus.className=`badge ${state.doc.reviewed?'green':'amber'}`;}
}
document.addEventListener('input',event=>{
  const el=event.target;
  if(el.id==='knowledge-search'){search=el.value;if(event.isComposing)return;const pos=el.selectionStart;render();const input=$('#knowledge-search');input.focus();input.setSelectionRange(pos,pos);return;}
  if(el.id==='minutes-input'){state.minutes.input=el.value;state.minutes.reviewed=false;}
  if(el.id==='minutes-output'){state.minutes.output=el.value;state.minutes.reviewed=false;}
  if(el.dataset.draftIndex!==undefined){const draft=state.minutes.drafts?.[Number(el.dataset.draftIndex)];if(draft){draft[el.dataset.draftField]=el.value;state.minutes.reviewed=false;}}
  if(el.id==='doc-input'){state.doc.input=el.value;state.doc.reviewed=false;}
  if(el.id==='doc-output'){state.doc.output=el.value;state.doc.reviewed=false;}
  if(el.id==='baseline'){const n=Number(el.value);if(Number.isFinite(n)&&n>=1&&n<=10000)state.baseline=n;}
  if(['minutes-input','minutes-output','doc-input','doc-output','baseline'].includes(el.id)||el.dataset.draftIndex!==undefined){save();syncReviewControls();}
});
document.addEventListener('change',async event=>{
  const el=event.target;
  try{
    if(el.id==='sort-rule'){state.meeting.sortRule=el.value;invalidate('调整人员排序规则');render();}
    else if(el.id==='seat-layout'){state.meeting.layout=el.value;invalidate('调整座位布局');render();}
    else if(el.dataset.checkIndex!==undefined){state.checklist[Number(el.dataset.checkIndex)]=el.checked;save();render();}
    else if(el.dataset.taskId){const task=state.tasks.find(t=>t.id===el.dataset.taskId);task.status=el.checked?'已完成':'待办理';save();render();}
    else if(el.dataset.newsSelect){state.news.find(n=>n.id===el.dataset.newsSelect).selected=el.checked;save();}
    else if(el.id==='csv-file'){
      const file=el.files[0];if(!file)return;if(file.size>1024*1024)throw new Error('CSV 文件不能超过 1 MB。');
      const result=parseParticipantsCSV(await file.text());if(result.errors.length)throw new Error(result.errors.slice(0,3).join(' '));if(result.participants.length>80)throw new Error('首版单场会议最多支持 80 人。');
      state.participants=result.participants.map(p=>({...p,id:uid('import'),authorized:true}));invalidate(`导入 ${state.participants.length} 位参会人员`);$('#modal').close();go('meeting','people');toast('名单已导入并排序，请核对后确认。');
    }else if(el.id==='text-file'){
      const file=el.files[0];if(!file)return;if(file.size>100000)throw new Error('文本文件不能超过 100 KB。');const content=await file.text();state.minutes.input=content;state.minutes.reviewed=false;state.minutes.output='';state.minutes.drafts=[];save();render();toast('会议记录已导入。');
    }
  }catch(error){toast(error.message);}finally{if(el.type==='file')el.value='';}
});
window.addEventListener('hashchange',()=>{const s=location.hash.slice(1);if(sectionNames[s]&&s!==section){section=s;render();}});
$('#modal').addEventListener('click',event=>{if(event.target===$('#modal')){const r=$('#modal').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)$('#modal').close();}});
initializeFeedbackUI({getPage:()=>section,navigate:next=>go(next),refresh:()=>render(),notify:toast});
installMobileEnhancements();
window.addEventListener('resize',syncMobileDrawer);
document.addEventListener('keydown',event=>{
  if(!mobileOpen)return;
  if(event.key==='Escape'){event.preventDefault();setMobileDrawer(false);}
  else if(event.key==='Tab'){
    const items=[...document.querySelectorAll('#mobile-more-drawer button, #mobile-more-drawer a[href]')].filter(el=>!el.disabled);
    if(!items.length)return;
    const first=items[0],last=items[items.length-1];
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  }
});
render();
if(storageWarning)toast('本地数据无法读取，已恢复演示样例。');
