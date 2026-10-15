/** Local-only exports. The Word document is an actual OOXML ZIP, with no service required. */
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const encoder = new TextEncoder();
const SEATING_NOTE = '按确认名单顺序分配，仅作示意，实际礼宾座次人工确认';

export function escapeHtml(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function escapeXml(value = '') {
  return escapeHtml(String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, ''));
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function crc32(bytes) {
  let result = 0xffffffff;
  for (const byte of bytes) result = (result >>> 8) ^ crcTable[(result ^ byte) & 0xff];
  return (result ^ 0xffffffff) >>> 0;
}

function zipStore(files) {
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const [path, contents] of files) {
    const name = encoder.encode(path);
    const data = encoder.encode(contents);
    const checksum = crc32(data);
    const header = new Uint8Array(30 + name.length);
    const local = new DataView(header.buffer);
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names, uncompressed data.
    local.setUint16(12, 33, true); // 1980-01-01, deterministic archive.
    local.setUint32(14, checksum, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    header.set(name, 30);
    parts.push(header, data);

    const record = new Uint8Array(46 + name.length);
    const central = new DataView(record.buffer);
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint16(14, 33, true);
    central.setUint32(16, checksum, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    record.set(name, 46);
    directory.push(record);
    offset += header.length + data.length;
  }
  const directorySize = directory.reduce((total, record) => total + record.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, directorySize, true);
  endView.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end], { type: DOCX_MIME });
}

function wordParagraph(value, heading = false, title = false) {
  const text = String(value ?? '');
  const runs = text.split(/(\r\n|\r|\n|\t)/).map((part) => {
    if (/^(\r\n|\r|\n)$/.test(part)) return '<w:br/>';
    if (part === '\t') return '<w:tab/>';
    return `<w:t xml:space="preserve">${escapeXml(part)}</w:t>`;
  }).join('');
  const size = title ? 36 : heading ? 26 : 22;
  return `<w:p><w:pPr>${title ? '<w:jc w:val="center"/>' : ''}${heading || title ? '<w:keepNext/>' : ''}<w:spacing w:before="${title ? 160 : heading ? 200 : 0}" w:after="${title ? 280 : 120}" w:line="360" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体"/>${heading || title ? '<w:b/>' : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:lang w:val="zh-CN" w:eastAsia="zh-CN"/></w:rPr>${runs}</w:r></w:p>`;
}

/** Creates a valid editable .docx. paragraphs accept strings or { text, heading }. */
export function createDocxBlob(title, paragraphs = []) {
  const body = [wordParagraph(title || '会议材料', true, true), ...paragraphs.map((paragraph) => (
    typeof paragraph === 'object' && paragraph !== null
      ? wordParagraph(paragraph.text, Boolean(paragraph.heading))
      : wordParagraph(paragraph)
  ))].join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  return zipStore([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', document],
  ]);
}

function safeFilename(filename) {
  return String(filename || '会议材料').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-').slice(0, 180);
}

export function downloadFile(filename, content, type = 'text/plain;charset=utf-8') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = safeFilename(filename);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadDocx(title, paragraphs, filename = `${title || '会议材料'}.docx`) {
  const normalized = String(filename).toLowerCase().endsWith('.docx') ? filename : `${filename}.docx`;
  downloadFile(normalized, createDocxBlob(title, paragraphs), DOCX_MIME);
}

function normalizeParticipants(participants = []) {
  return participants.map((person, index) => {
    const entry = typeof person === 'string' ? { name: person } : (person || {});
    return {
      name: String(entry.name || `参会人 ${index + 1}`),
      organization: String(entry.organization || entry.department || ''),
      position: String(entry.position || entry.role || '参会人员'),
      side: entry.side === 'guest' ? 'guest' : 'host',
      diet: String(entry.diet || entry.dietary || entry.meal || '常规用餐'),
      number: index + 1,
    };
  });
}

function wrapText(value, maxWidth) {
  const lines = [];
  let line = '';
  let width = 0;
  for (const character of String(value || '')) {
    if (character === '\n' || character === '\r') {
      if (line) lines.push(line);
      line = '';
      width = 0;
      continue;
    }
    const characterWidth = /[\u0000-\u00ff]/.test(character) ? 0.56 : 1;
    if (line && width + characterWidth > maxWidth) {
      lines.push(line);
      line = '';
      width = 0;
    }
    line += character;
    width += characterWidth;
  }
  if (line) lines.push(line);
  return lines;
}

function svgText(lines, x, y, size, color, options = '') {
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" ${options}>${lines.map((line, index) => `<tspan x="${x}" dy="${index ? size * 1.4 : 0}">${escapeXml(line)}</tspan>`).join('')}</text>`;
}

function seatCard(person, x, y, width, height) {
  const color = person.side === 'guest' ? '#2563eb' : '#64748b';
  const nameLines = wrapText(person.name, (width - 60) / 23);
  const positionLines = wrapText(person.position, (width - 38) / 15);
  const organizationLines = wrapText(person.organization, (width - 38) / 14);
  const nameY = y + 34;
  const positionY = nameY + nameLines.length * 32;
  const organizationY = positionY + positionLines.length * 21;
  return `<g data-seat="${person.number}"><title>${escapeXml(`${person.number}. ${person.name} ${person.organization} ${person.position}`)}</title><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="14" fill="#fff" stroke="#dbe4ee" stroke-width="2"/><rect x="${x}" y="${y + 18}" width="4" height="${height - 36}" rx="2" fill="${color}"/><circle cx="${x + width - 20}" cy="${y + 19}" r="12" fill="#eef3f9"/><text x="${x + width - 20}" y="${y + 23}" text-anchor="middle" font-size="11" fill="#475569">${person.number}</text>${svgText(nameLines, x + 18, nameY, 23, '#152238', 'font-weight="700"')}${svgText(positionLines, x + 18, positionY, 15, '#42526b')}${svgText(organizationLines, x + 18, organizationY, 14, '#64748b')}</g>`;
}

/** All names remain horizontal and every confirmed participant is included. */
export function createSeatMapSvg(participants = [], meeting = {}) {
  const people = normalizeParticipants(participants);
  const round = meeting.layout === 'round';
  const cardWidth = round ? 250 : 270;
  const cardHeight = Math.max(112, ...people.map((person) => (
    35 + wrapText(person.name, (cardWidth - 60) / 23).length * 32
      + wrapText(person.position, (cardWidth - 38) / 15).length * 21
      + wrapText(person.organization, (cardWidth - 38) / 14).length * 20
  )));
  let width = 1120;
  let height;
  let content = '';
  const titleLines = wrapText(meeting.title || meeting.name || '会议座次示意图', 32);
  const metadataLines = wrapText([meeting.date, meeting.time, meeting.location || meeting.venue].filter(Boolean).join(' · '), 64);
  const headerHeight = 88 + titleLines.length * 37 + metadataLines.length * 23;
  if (round) {
    const diagonal = Math.hypot(cardWidth, cardHeight);
    const radius = Math.max(300, people.length > 1 ? (diagonal + 30) / (2 * Math.sin(Math.PI / people.length)) : 300);
    width = Math.ceil((radius + diagonal / 2 + 72) * 2);
    const centerX = width / 2;
    const centerY = headerHeight + width / 2;
    height = headerHeight + width + 112;
    const tableRadius = Math.max(138, radius - diagonal / 2 - 64);
    content += `<circle cx="${centerX}" cy="${centerY}" r="${tableRadius}" fill="#edf3fa" stroke="#c9d7e7" stroke-width="3"/>${svgText(['会议圆桌'], centerX, centerY - 8, 28, '#435b78', 'text-anchor="middle" font-weight="700"')}${svgText(['席位序号仅用于名单核对'], centerX, centerY + 28, 17, '#64748b', 'text-anchor="middle"')}`;
    people.forEach((person, index) => {
      const angle = -Math.PI / 2 + (index / people.length) * Math.PI * 2;
      const centerSeatX = centerX + Math.cos(angle) * radius;
      const centerSeatY = centerY + Math.sin(angle) * radius;
      content += seatCard(person, centerSeatX - cardWidth / 2, centerSeatY - cardHeight / 2, cardWidth, cardHeight);
    });
  } else {
    const rows = Math.max(3, Math.ceil(people.length / 2));
    const tableHeight = rows * (cardHeight + 24) - 24;
    height = headerHeight + tableHeight + 150;
    const tableY = headerHeight;
    content += `<rect x="370" y="${tableY}" width="380" height="${tableHeight}" rx="32" fill="#edf3fa" stroke="#c9d7e7" stroke-width="3"/>${svgText(['会议长桌'], 560, tableY + tableHeight / 2 - 10, 28, '#435b78', 'text-anchor="middle" font-weight="700"')}${svgText(['席位序号仅用于名单核对'], 560, tableY + tableHeight / 2 + 27, 17, '#64748b', 'text-anchor="middle"')}`;
    people.forEach((person, index) => {
      const left = index % 2 === 0;
      const x = left ? 50 : 800;
      const y = tableY + Math.floor(index / 2) * (cardHeight + 24);
      content += `<path d="M ${left ? x + cardWidth : 750} ${y + cardHeight / 2} H ${left ? 370 : x}" stroke="#c3d0e0" stroke-width="2"/>`;
      content += seatCard(person, x, y, cardWidth, cardHeight);
    });
  }
  if (!people.length) content += svgText(['请先添加并确认参会名单'], width / 2, height - 114, 19, '#64748b', 'text-anchor="middle"');
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="会议座次示意图" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif"><title>${escapeXml(meeting.title || meeting.name || '会议座次示意图')} · 座次示意</title><desc>${escapeXml(SEATING_NOTE)}</desc><rect width="${width}" height="${height}" fill="#f8fafc"/>${svgText(titleLines, 50, 54, 28, '#152238', 'font-weight="700"')}${svgText(metadataLines, 50, 64 + titleLines.length * 37, 16, '#64748b')}${content}${svgText([`共 ${people.length} 位参会人 · ${round ? '圆桌' : '长桌'}布局`], 50, height - 58, 17, '#42526b')}${svgText([SEATING_NOTE], 50, height - 27, 16, '#64748b')}</svg>`;
}

function printNameplate(person, title) {
  const panel = `<div class="plate-panel"><div class="plate-organization">${escapeHtml(person.organization)}</div><div class="plate-name">${escapeHtml(person.name)}</div><div class="plate-role">${escapeHtml(person.position)}</div><div class="plate-meeting">${escapeHtml(title)}</div></div>`;
  return `<article class="nameplate"><div class="folded">${panel}</div><div class="fold-line"></div>${panel}</article>`;
}

function printMealplate(person, title) {
  return `<article class="mealplate"><div class="meal-heading">用餐桌牌 · ${person.number}</div><div class="meal-name">${escapeHtml(person.name)}</div><div class="meal-role">${escapeHtml([person.organization, person.position].filter(Boolean).join(' · '))}</div><div class="meal-diet">用餐备注：${escapeHtml(person.diet)}</div><div class="meal-meeting">${escapeHtml(title)}</div></article>`;
}

/** Opens a preview; printing starts only when the user clicks the print button. */
export function openPrintSheet(kind, participants = [], meeting = {}) {
  if (!['nameplates', 'mealplates', 'seats'].includes(kind)) return false;
  const popup = window.open('', '_blank', 'width=1200,height=850');
  if (!popup) return false;
  const people = normalizeParticipants(participants);
  const title = meeting.title || meeting.name || '会议材料';
  const label = { nameplates: '会议桌牌', mealplates: '用餐桌牌', seats: '座次示意图' }[kind];
  let pages = '';
  if (kind === 'seats') {
    pages = `<section class="print-page seats-page">${createSeatMapSvg(participants, meeting)}</section>`;
  } else if (!people.length) {
    pages = '<section class="print-page empty">暂无参会人员，请返回页面补充名单。</section>';
  } else {
    const pageSize = kind === 'nameplates' ? 2 : 6;
    for (let index = 0; index < people.length; index += pageSize) {
      const cards = people.slice(index, index + pageSize).map((person) => kind === 'nameplates'
        ? printNameplate(person, title) : printMealplate(person, title)).join('');
      pages += `<section class="print-page ${kind}">${cards}</section>`;
    }
  }
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · ${label}</title><style>
    *{box-sizing:border-box}body{margin:0;background:#e9eef4;color:#17263b;font-family:"Microsoft YaHei","PingFang SC",sans-serif}.toolbar{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 28px;background:#fff;border-bottom:1px solid #dbe3ed}.toolbar strong{display:block;font-size:17px}.toolbar p{margin:7px 0 0;color:#5d6c80;font-size:13px}.toolbar button{padding:10px 20px;border:0;border-radius:9px;background:#2563eb;color:#fff;font-size:15px;cursor:pointer;white-space:nowrap}.print-page{width:186mm;min-height:250mm;margin:24px auto;padding:0;background:#fff;box-shadow:0 5px 30px #243e5a12;break-after:page;page-break-after:always}.print-page:last-child{break-after:auto;page-break-after:auto}.nameplates{padding-top:10mm}.nameplate{height:104mm;margin-bottom:16mm;border:1px dashed #a0adbd;break-inside:avoid;page-break-inside:avoid}.plate-panel{height:51mm;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:4mm 8mm;text-align:center;overflow-wrap:anywhere}.folded{transform:rotate(180deg)}.fold-line{border-top:1px dashed #c4ced9}.plate-organization{font-size:11pt;color:#657388}.plate-name{font-size:30pt;font-weight:700;line-height:1.3;margin:1.5mm 0;color:#173f70}.plate-role{font-size:12pt}.plate-meeting{font-size:8pt;color:#7c8796;margin-top:2mm}.mealplates{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-rows:77mm;gap:7mm;padding:2mm 0;align-content:start}.mealplate{padding:6mm;border:1px solid #cdd8e5;border-top:3px solid #2563eb;break-inside:avoid;page-break-inside:avoid;overflow-wrap:anywhere}.meal-heading{font-size:9pt;color:#64748b}.meal-name{font-size:24pt;font-weight:700;margin:5mm 0 2mm}.meal-role{font-size:10pt;line-height:1.5}.meal-diet{font-size:11pt;margin-top:5mm;padding-top:4mm;border-top:1px solid #e2e8f0}.meal-meeting{margin-top:4mm;font-size:8pt;color:#64748b}.seats-page{width:273mm;min-height:186mm;display:flex;align-items:center;justify-content:center}.seats-page svg{display:block;width:100%;height:auto;max-height:186mm}.empty{padding:30px}
    @page{size:A4 ${kind === 'seats' ? 'landscape' : 'portrait'};margin:12mm}@media print{body{background:#fff}.toolbar{display:none}.print-page{margin:0;box-shadow:none;min-height:0}.nameplates{padding-top:8mm}.seats-page{height:186mm}.seats-page svg{width:100%;max-height:184mm}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
  </style></head><body><div class="toolbar"><div><strong>${label} · ${escapeHtml(title)}</strong><p>${kind === 'nameplates' ? 'A4 纵向，每页 2 张；沿外框裁剪，沿中线对折。' : kind === 'mealplates' ? 'A4 纵向，每页 6 张；请核对用餐备注后打印。' : `A4 横向；${SEATING_NOTE}。`} 打印时可关闭浏览器页眉与页脚。</p></div><button type="button" onclick="window.print()">打印 / 保存 PDF</button></div>${pages}</body></html>`;
  try {
    popup.opener = null;
    popup.document.open();
    popup.document.write(html);
    popup.document.close();
    return true;
  } catch {
    popup.close();
    return false;
  }
}
