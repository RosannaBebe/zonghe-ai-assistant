import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, sortParticipants, parseParticipantsCSV, participantsToCSV, generateAgenda, deriveMinutes, invalidateMeeting, getOrderedParticipants } from '../src/domain.js';

const header = '姓名,单位,职务,主客,职级,接待备注';

test('each initial state is independent and contains only clearly labelled demonstration news', () => {
  const first = createInitialState();
  const second = createInitialState();
  first.participants[0].name = '修改';
  assert.notEqual(first.participants[0].name, second.participants[0].name);
  assert.equal(second.participants.length, 10);
  assert.equal(second.participants.filter((person) => person.side === 'host').length, 5);
  assert.ok(second.news.every((item) => item.source === '内部演示素材' && item.url === '' && !item.verified));
});

test('sorting uses numeric rank before side, remains stable and does not change input', () => {
  const people = [
    { id: 'a', side: 'host', rank: 2 },
    { id: 'b', side: 'guest', rank: '2' },
    { id: 'c', side: 'host', rank: 1 },
    { id: 'd', side: 'guest', rank: 2 },
  ];
  assert.deepEqual(sortParticipants(people, 'guest-first').map((person) => person.id), ['c', 'b', 'd', 'a']);
  assert.deepEqual(sortParticipants(people, 'host-first').map((person) => person.id), ['c', 'a', 'b', 'd']);
  assert.deepEqual(people.map((person) => person.id), ['a', 'b', 'c', 'd']);
});

test('CSV reads BOM, quoted commas, quotes, CRLF and embedded newlines', () => {
  const csv = `\uFEFF${header}\r\n顾承远,"示例,单位","负责人""代表",客方,1,"第一行\r\n第二行"\r\n`;
  const { participants, errors } = parseParticipantsCSV(csv);
  assert.deepEqual(errors, []);
  assert.equal(participants.length, 1);
  assert.equal(participants[0].organization, '示例,单位');
  assert.equal(participants[0].position, '负责人"代表');
  assert.equal(participants[0].diet, '第一行\n第二行');
  assert.equal(participants[0].rank, 1);
  assert.equal(participants[0].side, 'guest');
});

test('invalid CSV import is atomic with actionable row errors', () => {
  const result = parseParticipantsCSV(`${header}\n正常,示例单位,主管,主方,2,\n,示例单位,专员,未知,9,`);
  assert.deepEqual(result.participants, []);
  assert.equal(result.errors.length, 3);
  assert.ok(result.errors.every((message) => message.includes('第 3 行')));
  assert.match(result.errors.join(' '), /姓名不能为空/);
  assert.match(result.errors.join(' '), /1 到 5/);
  assert.match(result.errors.join(' '), /主客/);
});

test('malformed quotes, missing columns, duplicate people and blank input are rejected', () => {
  for (const csv of [
    `${header}\n姓名,"未闭合,主管,主方,2,`,
    `${header}\n姓名,单位,"主管"oops,主方,2,`,
    '姓名,单位\n某人,单位',
    `${header}\n某人,单位,主管,主方,2,\n某人,单位,主管,主方,2,`,
    `${header}\n某人,单位,主管,主方,2`,
    '',
  ]) {
    const result = parseParticipantsCSV(csv);
    assert.deepEqual(result.participants, []);
    assert.ok(result.errors.length > 0, `Expected errors for ${csv}`);
  }
});

test('CSV export round-trips normal data and neutralizes spreadsheet formulas', () => {
  const people = createInitialState().participants;
  const decoded = parseParticipantsCSV(participantsToCSV(people));
  assert.deepEqual(decoded.errors, []);
  assert.deepEqual(decoded.participants.map(({ id, ...rest }) => rest), people.map(({ id, ...rest }) => rest));
  const formulaPeople = [{ ...people[0], name: '=HYPERLINK("https://example.invalid")', organization: '  +1+1', position: '@SUM(1)', diet: '\t=2+2' }];
  const csv = participantsToCSV(formulaPeople);
  assert.ok(csv.includes("'=HYPERLINK"));
  assert.ok(csv.includes("'  +1+1"));
  assert.ok(csv.includes("'@SUM(1)"));
  assert.ok(csv.includes("'\t=2+2"));
});

test('any meeting change invalidates confirmation until the new revision is confirmed', () => {
  const state = createInitialState();
  state.meeting.confirmedRevision = state.meeting.revision;
  state.participants[0].rank = 5;
  const returned = invalidateMeeting(state);
  assert.equal(returned, state);
  assert.equal(state.meeting.revision, 2);
  assert.equal(state.meeting.confirmedRevision, 0);
  assert.notEqual(state.meeting.confirmedRevision, state.meeting.revision);
  state.meeting.confirmedRevision = state.meeting.revision;
  assert.equal(state.meeting.confirmedRevision, 2);
  assert.deepEqual(getOrderedParticipants(state), sortParticipants(state.participants, state.meeting.sortRule));
});

test('agenda follows the chosen meeting start time and handles invalid time', () => {
  assert.equal(generateAgenda({ time: '14:30', topic: '项目交流' })[3].time, '15:00');
  assert.equal(generateAgenda({ time: '14:30', topic: '项目交流' })[3].title, '项目交流');
  assert.equal(generateAgenda({ time: '27:61' })[0].time, '09:00');
  assert.equal(generateAgenda({ time: '23:45' })[2].time, '00:05');
});

test('minutes identify explicit tasks, preserve sources and never invent absent owners or dates', () => {
  const state = createInitialState();
  const result = deriveMinutes(state.minutes.input, state.meeting);
  assert.equal(result.tasks.length, 3);
  assert.deepEqual(result.tasks[0], {
    id: result.tasks[0].id,
    title: '汇总各部门协同事项',
    owner: '李知遥',
    deadline: '2026-10-25',
    status: '待办理',
    source: '待办：李知遥负责汇总各部门协同事项，截止2026-10-25。',
  });
  assert.equal(result.tasks[2].owner, '');
  assert.equal(result.tasks[2].deadline, '');
  assert.match(result.content, /未调用大模型/);
  assert.match(result.content, /原文未明确，待确认/);
  assert.equal(deriveMinutes('只讨论整体工作，没有明确行动项。', state.meeting).tasks.length, 0);
  assert.equal(deriveMinutes('', state.meeting).tasks.length, 0);
});

test('minute extraction deduplicates exact tasks and leaves relative dates as supplied', () => {
  const line = '待办：由李知遥负责整理清单，截止下周三。';
  const result = deriveMinutes(`${line}\n${line}`);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].owner, '李知遥');
  assert.equal(result.tasks[0].deadline, '下周三');
  assert.equal(result.tasks[0].source, line);
});
