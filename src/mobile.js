import { escapeHtml, createSeatMapSvg, openPrintSheet } from './exports.js';

/** Mobile helpers deliberately have no access to app state or approval flags. */
export const MOBILE_QUERY = '(max-width: 767px)';
const MATERIAL_NAMES = { nameplates: '会议桌签', mealplates: '用餐饭签', seats: '会议座位图' };
const NAV_ICONS = {
  agent: '<path d="m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7L12 3z"/>',
  meeting: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4M16 3v4M4 11h16M8 15h3M8 18h6"/>',
  news: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h8M8 18h4"/>',
  documents: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h6"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
};

export function isMobile() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(MOBILE_QUERY).matches;
}

/** Uses the existing app's nav/mobile actions; no second navigation store. */
export function renderMobileNav(section = 'agent', moreOpen = false) {
  const items = [['agent', '智能体'], ['meeting', '会务'], ['news', '信息'], ['documents', '公文'], ['more', '更多']];
  return `<nav class="mobile-bottom-nav" aria-label="手机主导航">${items.map(([id, label]) => {
    const more = id === 'more';
    const active = more ? moreOpen || ['knowledge','feedback'].includes(section) : section === id && !moreOpen;
    return `<button type="button" class="mobile-nav-item ${active ? 'active' : ''}" data-action="${more ? 'mobile' : 'nav'}"${more ? ` aria-expanded="${Boolean(moreOpen)}" aria-controls="mobile-more-drawer"` : ` data-section="${id}"${active ? ' aria-current="page"' : ''}`}><svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${NAV_ICONS[id]}</svg><span>${label}</span></button>`;
  }).join('')}</nav>`;
}

/** Run after app.render(); preserves existing row actions and table semantics. */
export function enhanceMobileTables(root = document) {
  for (const table of root.querySelectorAll('.table-scroll table')) {
    const headers = [...table.querySelectorAll('thead th')].map((cell) => cell.textContent.trim());
    if (!headers.includes('姓名')) continue;
    table.classList.add('mobile-person-table');
    table.setAttribute('role', 'table');
    table.querySelector('thead')?.setAttribute('role', 'rowgroup');
    table.querySelector('tbody')?.setAttribute('role', 'rowgroup');
    for (const row of table.querySelectorAll('tr')) {
      row.setAttribute('role', 'row');
      [...row.children].forEach((cell, index) => {
        cell.setAttribute('role', cell.tagName === 'TH' ? 'columnheader' : 'cell');
        if (cell.tagName === 'TD') cell.dataset.label = headers[index] || '';
      });
    }
  }
}

function normalizedPeople(participants = []) {
  return participants.map((person, index) => {
    const value = typeof person === 'string' ? { name: person } : person || {};
    return {
      name: String(value.name || `参会人员 ${index + 1}`),
      organization: String(value.organization || value.department || ''),
      position: String(value.position || value.role || '参会人员'),
      diet: String(value.diet || value.dietary || '常规用餐'),
      side: value.side === 'guest' ? 'guest' : 'host',
      number: index + 1,
    };
  });
}

/** Pass people() order; this helper never independently sorts the confirmed list. */
export function renderMobileSeatList(participants = []) {
  const people = normalizedPeople(participants);
  if (!people.length) return '<p class="mobile-seat-empty">暂无座次，请先添加参会人员。</p>';
  return `<ol class="mobile-seat-list" aria-label="按当前名单顺序排列的座次">${people.map((person) => `<li><span class="mobile-seat-number" aria-label="序号 ${person.number}">${String(person.number).padStart(2, '0')}</span><div><strong>${escapeHtml(person.name)}</strong><span>${escapeHtml(person.position)}</span><p>${escapeHtml(person.organization)}</p></div></li>`).join('')}</ol>`;
}

function safeName(filename) {
  return String(filename || '会议材料').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 180);
}

function asBlob(content, type) {
  return content instanceof Blob ? content : new Blob([content], { type });
}

function shareableFile(filename, blob) {
  if (typeof File === 'undefined' || typeof navigator === 'undefined' || typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return null;
  const file = new File([blob], safeName(filename), { type: blob.type || 'application/octet-stream' });
  try { return navigator.canShare({ files: [file] }) ? file : null; } catch { return null; }
}

/** Call directly from a user's tap so Web Share retains its transient activation. */
export async function shareOrDownloadFile(filename, content, type = 'text/plain;charset=utf-8', options = {}) {
  const blob = asBlob(content, type);
  const file = options.preferShare === false || (options.preferShare === undefined && !isMobile()) ? null : shareableFile(filename, blob);
  if (file) {
    try {
      await navigator.share({ files: [file], title: String(options.title || filename) });
      return { method: 'shared' };
    } catch (error) {
      // Cancellation means stop. Never turn a dismissed share sheet into a download.
      if (error?.name === 'AbortError') return { method: 'cancelled' };
      // An unsupported share target or lost browser activation can still save locally.
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = safeName(filename);
  document.body.append(link);
  try { link.click(); } finally {
    link.remove();
    // Safari may defer reading a download URL until after the click handler returns.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  return { method: 'downloaded' };
}

function materialCards(kind, participants, meeting) {
  const title = String(meeting.title || meeting.name || '会议材料');
  if (kind === 'seats') return createSeatMapSvg(participants, meeting);
  const people = normalizedPeople(participants);
  if (!people.length) return '<p class="mobile-seat-empty">暂无参会人员。</p>';
  return people.map((person) => {
    if (kind === 'mealplates') return `<article class="mm-meal-card"><span class="mm-card-eyebrow">用餐饭签 · ${person.number}</span><strong>${escapeHtml(person.name)}</strong><p>${escapeHtml(person.organization)} · ${escapeHtml(person.position)}</p><div class="mm-diet">用餐备注：${escapeHtml(person.diet)}</div><small>${escapeHtml(title)}</small></article>`;
    const panel = `<div class="mm-name-panel"><span>${escapeHtml(person.organization)}</span><strong>${escapeHtml(person.name)}</strong><p>${escapeHtml(person.position)}</p><small>${escapeHtml(title)}</small></div>`;
    return `<article class="mm-name-card"><div class="mm-folded">${panel}</div><div class="mm-fold-line"></div>${panel}</article>`;
  }).join('');
}

// These styles travel with saved HTML, so the material remains usable offline.
const SAVED_MATERIAL_STYLES = `*{box-sizing:border-box}body{margin:0;background:#f3f6fb;color:#20324e;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}header{padding:24px;max-width:920px;margin:auto}h1{font-size:22px;line-height:1.5;margin:0 0 8px}header p{font-size:13px;line-height:1.7;color:#687993}button{font:inherit;border:0;border-radius:8px;padding:12px 18px;background:#4263eb;color:white;min-height:44px}.saved-material{max-width:920px;margin:0 auto;padding:16px 24px 40px}.saved-material svg{width:100%;height:auto}.saved-material.seats{overflow:auto}.mm-name-card,.mm-meal-card{background:white;border:1px solid #dae3ef;border-radius:12px;margin-bottom:16px;break-inside:avoid}.mm-name-panel{min-height:130px;text-align:center;padding:22px 16px;display:flex;flex-direction:column;justify-content:center;align-items:center;overflow-wrap:anywhere}.mm-name-panel>span{font-size:13px;color:#687993}.mm-name-panel strong{display:block;font-size:30px;line-height:1.5;margin:5px 0;color:#224a82}.mm-name-panel p{margin:0;font-size:15px}.mm-name-panel small{font-size:11px;color:#8390a3;margin-top:12px}.mm-folded,.mm-fold-line{display:none}.mm-meal-card{padding:24px}.mm-card-eyebrow{font-size:12px;color:#6c7e99}.mm-meal-card>strong{display:block;font-size:28px;margin:15px 0 8px}.mm-meal-card>p{font-size:14px;line-height:1.7;margin:0;color:#6c7e99}.mm-diet{margin:20px 0 15px;padding-top:16px;border-top:1px solid #e6ecf4;line-height:1.7}.mm-meal-card small{font-size:11px;color:#8390a3}@page{size:A4 portrait;margin:12mm}@media print{body{background:white}header{display:none}.saved-material{max-width:none;padding:0;margin:0}.mm-name-card{height:104mm;margin-bottom:16mm;border:1px dashed #aab8c9;border-radius:0;break-inside:avoid}.mm-name-card:nth-child(2n){break-after:page}.mm-name-card:last-child{break-after:auto}.mm-name-panel{height:51mm;min-height:0;padding:4mm 8mm}.mm-name-panel strong{font-size:30pt;margin:1mm 0}.mm-name-panel>span{font-size:11pt}.mm-name-panel p{font-size:12pt}.mm-name-panel small{font-size:8pt;margin-top:2mm}.mm-folded{display:block;transform:rotate(180deg)}.mm-fold-line{display:block;border-top:1px dashed #bcc8d6}.mealplates{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7mm}.mm-meal-card{height:77mm;margin:0;padding:6mm;border-radius:0}.mm-meal-card>strong{font-size:24pt;margin:4mm 0 2mm}.mm-meal-card>p{font-size:10pt}.mm-diet{font-size:11pt;margin:4mm 0 3mm;padding-top:3mm}.mm-meal-card small{font-size:8pt}.mm-meal-card:nth-child(6n){break-after:page}.seats svg{max-height:260mm;width:100%}}`;

/** Genuine self-contained HTML; never presented or named as a PDF/Word file. */
export function createMaterialPreviewDocument(kind, participants = [], meeting = {}) {
  if (!Object.hasOwn(MATERIAL_NAMES, kind)) throw new Error('不支持此材料预览。');
  const title = String(meeting.title || meeting.name || '会议材料');
  const note = kind === 'seats' ? '按确认名单顺序分配，仅作示意，实际礼宾座次人工确认。' : kind === 'nameplates' ? '打印时使用 A4 纵向，沿外框裁剪并沿中线对折。' : '请核对用餐备注后使用 A4 纵向打印。';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · ${MATERIAL_NAMES[kind]}</title><style>${SAVED_MATERIAL_STYLES}</style></head><body><header><h1>${escapeHtml(title)} · ${MATERIAL_NAMES[kind]}</h1><p>${note}</p><button type="button" onclick="window.print()">打印 / 存为 PDF</button></header><main class="saved-material ${kind}">${materialCards(kind, participants, meeting)}</main></body></html>`;
}

/**
 * Opens an in-page preview. The app must perform its current-version approval
 * check before calling this function. It never grants approval or starts printing.
 */
export function openMaterialPreview(kind, participants = [], meeting = {}, options = {}) {
  if (!Object.hasOwn(MATERIAL_NAMES, kind)) throw new Error('不支持此材料预览。');
  document.querySelector('dialog.mobile-material-preview')?.close();
  const title = String(meeting.title || meeting.name || '会议材料');
  const allowExport = options.allowExport !== false;
  const snapshotPeople = normalizedPeople(participants);
  const snapshotMeeting = { ...meeting };
  const cards = materialCards(kind, snapshotPeople, snapshotMeeting);
  const previewDocument = createMaterialPreviewDocument(kind, snapshotPeople, snapshotMeeting);
  const version = Number.isInteger(meeting.revision) ? `-V${meeting.revision}` : '';
  const filename = `${title}${version}-${MATERIAL_NAMES[kind]}.${kind === 'seats' ? 'svg' : 'html'}`;
  const blob = new Blob([kind === 'seats' ? cards : previewDocument], { type: kind === 'seats' ? 'image/svg+xml;charset=utf-8' : 'text/html;charset=utf-8' });
  const supportsShare = Boolean(shareableFile(filename, blob));
  const priorFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'mobile-material-preview';
  dialog.setAttribute('aria-labelledby', 'mobile-preview-title');
  const zoomToolbar = `<div class="mobile-preview-toolbar" aria-label="座位图缩放"><button type="button" data-preview-action="zoom-out" aria-label="缩小座位图">−</button><button type="button" data-preview-action="zoom-fit">适应屏幕</button><output aria-live="polite">100%</output><button type="button" data-preview-action="zoom-in" aria-label="放大座位图">＋</button></div>`;
  const body = kind === 'seats'
    ? `${zoomToolbar}<p class="mobile-preview-hint">点按加减放大，拖动查看；下方列表可核对全部姓名与职务。</p><div class="mobile-seat-viewport" tabindex="0" aria-label="可滚动的会议座位图"><div class="mobile-seat-canvas">${cards}</div></div><div class="mobile-preview-list-heading">座次列表 <span>${snapshotPeople.length} 位</span></div>${renderMobileSeatList(snapshotPeople)}`
    : `<p class="mobile-preview-hint">${kind === 'nameplates' ? '预览展示桌签正面；打印版包含对折双面。' : '保存或打印前，请再次核对姓名与用餐备注。'}</p><div class="mobile-material-sheet ${kind}">${cards}</div>`;
  dialog.innerHTML = `<header class="mobile-preview-header"><div><span class="mobile-preview-eyebrow">材料预览${version ? ` · ${version.slice(1)}` : ''}</span><h2 id="mobile-preview-title">${MATERIAL_NAMES[kind]}</h2><p>${escapeHtml(title)}</p></div><button type="button" class="mobile-preview-close" data-preview-action="close" aria-label="关闭材料预览">×</button></header><div class="mobile-preview-body">${body}</div><footer class="mobile-preview-footer"><p class="mobile-preview-status" role="status" aria-live="polite">${!allowExport ? '当前为待确认预览，确认名单并生成材料后可保存或打印。' : kind === 'seats' ? '座位图为示意，实际礼宾安排需人工确认。' : '保存为可离线打开的 HTML，打印时可选择存为 PDF。'}</p><div><button type="button" class="btn" data-preview-action="print"${allowExport ? '' : ' disabled'}>打印 / 存 PDF</button><button type="button" class="btn primary" data-preview-action="save"${allowExport ? '' : ' disabled'}>${supportsShare ? '分享 / 存入文件' : `保存 ${kind === 'seats' ? 'SVG' : 'HTML'}`}</button></div></footer>`;
  document.body.append(dialog);
  document.body.classList.add('mobile-preview-open');
  const viewport = dialog.querySelector('.mobile-seat-viewport');
  const canvas = dialog.querySelector('.mobile-seat-canvas');
  const status = dialog.querySelector('.mobile-preview-status');
  const zoomLevels = [1, 1.5, 2, 3, 4, 6, 8, 12, 16];
  let zoomIndex = 0;
  let removed = false;
  const cleanUp = () => {
    if (removed) return;
    removed = true;
    dialog.remove();
    if (!document.querySelector('dialog.mobile-material-preview[open]')) document.body.classList.remove('mobile-preview-open');
    if (priorFocus?.isConnected) priorFocus.focus({ preventScroll: true });
  };
  const close = () => { if (dialog.open) dialog.close(); cleanUp(); };
  const updateZoom = () => {
    if (!canvas) return;
    canvas.style.width = `${zoomLevels[zoomIndex] * 100}%`;
    dialog.querySelector('output').textContent = `${Math.round(zoomLevels[zoomIndex] * 100)}%`;
    dialog.querySelector('[data-preview-action="zoom-out"]').disabled = zoomIndex === 0;
    dialog.querySelector('[data-preview-action="zoom-in"]').disabled = zoomIndex === zoomLevels.length - 1;
  };
  dialog.addEventListener('close', cleanUp, { once: true });
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-preview-action]');
    if (!button) {
      if (event.target === dialog) {
        const bounds = dialog.getBoundingClientRect();
        if (event.clientY < bounds.top || event.clientY > bounds.bottom || event.clientX < bounds.left || event.clientX > bounds.right) close();
      }
      return;
    }
    const action = button.dataset.previewAction;
    if (action === 'close') { close(); return; }
    if (action.startsWith('zoom-')) {
      zoomIndex = action === 'zoom-fit' ? 0 : Math.max(0, Math.min(zoomLevels.length - 1, zoomIndex + (action === 'zoom-in' ? 1 : -1)));
      updateZoom();
      if (action === 'zoom-fit') viewport.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      return;
    }
    if (action === 'print') {
      if (!allowExport) return;
      const opened = openPrintSheet(kind, snapshotPeople, snapshotMeeting);
      status.textContent = opened ? '已打开打印预览，可选择打印机或存为 PDF。' : '打印窗口未能打开。可先保存 HTML 文件，再用浏览器打开并打印。';
      return;
    }
    if (action === 'save') {
      if (!allowExport) return;
      button.disabled = true;
      try {
        const result = await shareOrDownloadFile(filename, blob, blob.type, { title, preferShare: true });
        status.textContent = result.method === 'cancelled' ? '已取消分享，材料仍保留在预览中。' : result.method === 'shared' ? '已完成系统分享操作。' : '已发起文件保存，请在浏览器下载项或“文件”中查看。';
      } catch { status.textContent = '当前浏览器未能保存文件，请换用系统浏览器后重试。'; }
      finally { button.disabled = false; }
    }
  });
  try { dialog.showModal(); } catch { cleanUp(); throw new Error('当前浏览器不支持材料预览，请使用较新的系统浏览器。'); }
  updateZoom();
  dialog.querySelector('[data-preview-action="close"]').focus({ preventScroll: true });
  return { close, element: dialog };
}

export function openSeatMapViewer(participants, meeting, options = {}) {
  return openMaterialPreview('seats', participants, meeting, { allowExport: false, ...options });
}

/** Install once. This only follows viewport/keyboard state, never application data. */
export function installMobileEnhancements() {
  if (typeof window === 'undefined' || typeof document === 'undefined' || !document.documentElement?.style) return () => {};
  const viewport = window.visualViewport;
  let restingHeight = window.innerHeight;
  let viewportWidth = window.innerWidth;
  const update = () => {
    const mobile = isMobile();
    const active = document.activeElement;
    const editing = Boolean(active?.matches?.('input:not([type="checkbox"]):not([type="radio"]),textarea,select,[contenteditable="true"]'));
    if (!editing || Math.abs(window.innerWidth - viewportWidth) > 80) restingHeight = window.innerHeight;
    viewportWidth = window.innerWidth;
    const visibleHeight = viewport?.height || window.innerHeight;
    // Android may shrink innerHeight together with visualViewport; retain the
    // resting height while editing so its keyboard is detected too.
    const keyboardOpen = mobile && editing && Math.max(restingHeight, window.innerHeight) - visibleHeight > 120;
    document.documentElement.classList.toggle('mobile-keyboard-open', Boolean(keyboardOpen));
    document.documentElement.style.setProperty('--mobile-visual-height', `${visibleHeight}px`);
    if (!mobile) document.body.classList.remove('mobile-drawer-open');
  };
  window.addEventListener('resize', update, { passive: true });
  viewport?.addEventListener('resize', update, { passive: true });
  document.addEventListener('focusin', update);
  document.addEventListener('focusout', update);
  update();
  return () => {
    window.removeEventListener('resize', update);
    viewport?.removeEventListener('resize', update);
    document.removeEventListener('focusin', update);
    document.removeEventListener('focusout', update);
    document.documentElement.classList.remove('mobile-keyboard-open');
    document.documentElement.style.removeProperty('--mobile-visual-height');
  };
}
