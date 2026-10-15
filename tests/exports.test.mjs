import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, createDocxBlob, createSeatMapSvg, openPrintSheet } from '../src/exports.js';

function unzipStored(bytes) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = new Map();
  let offset = 0;
  while (data.getUint32(offset, true) === 0x04034b50) {
    assert.equal(data.getUint16(offset + 8, true), 0, 'store compression is supported by Word');
    const size = data.getUint32(offset + 18, true);
    assert.equal(size, data.getUint32(offset + 22, true));
    const nameLength = data.getUint16(offset + 26, true);
    const extraLength = data.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(bytes.slice(offset + 30, offset + 30 + nameLength));
    const start = offset + 30 + nameLength + extraLength;
    const payload = bytes.slice(start, start + size);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    assert.equal((crc ^ 0xffffffff) >>> 0, data.getUint32(offset + 14, true), 'each file has a correct CRC');
    files.set(name, new TextDecoder().decode(payload));
    offset = start + size;
  }
  assert.equal(data.getUint32(offset, true), 0x02014b50, 'archive has a central directory');
  const centralOffset = offset;
  let entries = 0;
  while (data.getUint32(offset, true) === 0x02014b50) {
    const localOffset = data.getUint32(offset + 42, true);
    assert.equal(data.getUint32(localOffset, true), 0x04034b50, 'directory points to a local file');
    offset += 46 + data.getUint16(offset + 28, true) + data.getUint16(offset + 30, true) + data.getUint16(offset + 32, true);
    entries += 1;
  }
  assert.equal(data.getUint32(offset, true), 0x06054b50, 'archive has an end record');
  assert.equal(data.getUint16(offset + 10, true), entries);
  assert.equal(data.getUint32(offset + 12, true), offset - centralOffset);
  assert.equal(data.getUint32(offset + 16, true), centralOffset);
  assert.equal(offset + 22, bytes.length);
  return files;
}

test('Word export is a valid ZIP package containing Chinese OOXML, escaped text and A4 settings', async () => {
  const blob = createDocxBlob('项目协同会', [
    { text: '一、会议议程', heading: true },
    '会议负责人：张三\n企业 & 合作方 <待确认>\t下一项',
    { text: '异常\u0001字符也可导出' },
    '</w:t><script>alert(1)</script>',
  ]);
  assert.equal(blob.type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const files = unzipStored(new Uint8Array(await blob.arrayBuffer()));
  assert.deepEqual([...files.keys()], ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
  assert.match(files.get('[Content_Types].xml'), /wordprocessingml.document.main\+xml/);
  assert.match(files.get('_rels/.rels'), /Target="word\/document.xml"/);
  const document = files.get('word/document.xml');
  assert.match(document, /会议负责人：张三/);
  assert.match(document, /企业 &amp; 合作方 &lt;待确认&gt;/);
  assert.match(document, /<w:br\/>/);
  assert.match(document, /<w:tab\/>/);
  assert.match(document, /w:eastAsia="宋体"/);
  assert.match(document, /w:w="11906" w:h="16838"/);
  assert.match(document, /&lt;\/w:t&gt;&lt;script&gt;/);
  assert.doesNotMatch(document, /\u0001|<script>/);
});

test('seating maps preserve every participant and escape injected markup in either layout', () => {
  const people = Array.from({ length: 27 }, (_, index) => ({
    name: index === 0 ? '<script>alert("x")</script>' : `参会人员${index + 1}`,
    organization: '示例企业 & 研发部', position: '业务协同负责人', side: index % 2 ? 'guest' : 'host',
  }));
  for (const layout of ['boardroom', 'round']) {
    const svg = createSeatMapSvg(people, { title: '会议 <秋季>', layout, location: '一号会议室' });
    assert.equal((svg.match(/data-seat="\d+"/g) || []).length, people.length);
    assert.match(svg, /参会人员27/);
    assert.match(svg, /&lt;script&gt;/);
    assert.doesNotMatch(svg, /<script>|rotate\(/);
    assert.match(svg, /实际礼宾座次人工确认/);
    assert.match(svg, /会议 &lt;秋季&gt;/);
    assert.match(svg, /示例企业 &amp; 研发部/);
    assert.doesNotMatch(svg, /NaN|Infinity/);
  }
  assert.match(createSeatMapSvg([], {}), /请先添加并确认参会名单/);
});

test('HTML escaping handles user-controlled attribute and markup characters', () => {
  assert.equal(escapeHtml(`<&>"'`), '&lt;&amp;&gt;&quot;&#39;');
  assert.equal(escapeHtml(null), '');
});

test('print preview paginates cards, escapes content and waits for the user to print', () => {
  const priorWindow = globalThis.window;
  let html;
  let printCalls = 0;
  globalThis.window = { open: () => ({
    document: { open() {}, write(value) { html = value; }, close() {} },
    print() { printCalls += 1; }, close() {},
  }) };
  try {
    const people = Array.from({ length: 7 }, (_, index) => ({
      name: index === 0 ? '<img src=x onerror=alert(1)>' : `嘉宾${index + 1}`,
      organization: '企业', position: '经理', diet: '<script>bad()</script>',
    }));
    assert.equal(openPrintSheet('nameplates', people, { title: '协同会' }), true);
    assert.equal((html.match(/class="print-page nameplates"/g) || []).length, 4);
    assert.equal((html.match(/class="nameplate"/g) || []).length, 7);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(html, /<img|<script>|onload=/);
    assert.match(html, /onclick="window.print\(\)"/);
    assert.equal(printCalls, 0);
    assert.equal(openPrintSheet('mealplates', people, { title: '协同会' }), true);
    assert.equal((html.match(/class="print-page mealplates"/g) || []).length, 2);
    assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
    assert.equal(openPrintSheet('seats', people, { title: '协同会', layout: 'round' }), true);
    assert.match(html, /size:A4 landscape/);
    assert.match(html, /<svg/);
    globalThis.window.open = () => null;
    assert.equal(openPrintSheet('nameplates', people, {}), false);
    assert.equal(openPrintSheet('unknown', people, {}), false);
  } finally {
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  }
});
