import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentModelRequest, readAgentPlan } from '../server/ai-proxy.mjs';
import { validatePlan } from '../src/agent.js';

// Pure contract tests: importing these helpers does not start the relay,
// read .env, request credentials, or call the network.
const TOOL_NAMES = [
  'lookup_people',
  'sort_participants',
  'prepare_agenda',
  'generate_materials',
  'draft_minutes',
  'extract_tasks',
];

function toolCall(name, args = { reason: '根据本次会务目标安排此步骤。' }) {
  return { id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function modelResult(calls, content = '先规划会务准备与纪要跟进，关键步骤等待人工确认。') {
  return { choices: [{ message: { role: 'assistant', content, tool_calls: calls } }] };
}

function rejectsPlan(calls) {
  assert.throws(() => readAgentPlan(modelResult(calls), 'deepseek-chat'), {
    status: 502,
    code: 'INVALID_AGENT_PLAN',
  });
}

test('agent model request exposes exactly the six allowed tools with reason-only arguments', () => {
  const request = buildAgentModelRequest({ goal: '准备会务材料', context: {} }, 'deepseek-chat');
  assert.equal(request.model, 'deepseek-chat');
  assert.equal(request.stream, false);
  assert.equal(request.tool_choice, 'auto');
  assert.deepEqual(request.tools.map((tool) => tool.function.name), TOOL_NAMES);
  for (const tool of request.tools) {
    assert.equal(tool.type, 'function');
    assert.equal(tool.function.parameters.type, 'object');
    assert.deepEqual(Object.keys(tool.function.parameters.properties), ['reason']);
    assert.deepEqual(tool.function.parameters.required, ['reason']);
    assert.equal(tool.function.parameters.properties.reason.type, 'string');
    assert.equal(tool.function.parameters.additionalProperties, false);
  }
  assert.deepEqual(request.messages.map((message) => message.role), ['system', 'user']);
});

test('agent request projects business context and excludes reception notes, hidden fields and credentials', () => {
  const context = {
    meeting: { title: '交流会', date: '2026-10-22', sortRule: 'guest-first', secret: 'meeting-hidden', confirmedRevision: 9 },
    participants: [{ id: 'person-1', name: '示例来宾', organization: '虚构单位', position: '负责人', side: 'guest', rank: 1, diet: 'private-reception-note', phone: 'hidden-phone', apiKey: 'hidden-person-key' }],
    hasMinutes: true,
    minutes: 'hidden-minutes-body',
    token: 'hidden-token',
    DEEPSEEK_API_KEY: 'hidden-api-key',
  };
  const original = structuredClone(context);
  const request = buildAgentModelRequest({ goal: '  准备交流会  ', context, token: 'top-level-hidden' }, 'deepseek-reasoner');
  const userMessage = request.messages[1].content;
  const payload = JSON.parse(userMessage.slice(userMessage.indexOf('\n') + 1));
  assert.deepEqual(payload, {
    goal: '准备交流会',
    context: {
      meeting: { title: '交流会', date: '2026-10-22', sortRule: 'guest-first' },
      participants: [{ name: '示例来宾', organization: '虚构单位', position: '负责人', side: 'guest', rank: 1 }],
      hasMinutes: true,
    },
  });
  for (const privateText of ['private-reception-note', 'meeting-hidden', 'hidden-phone', 'hidden-person-key', 'hidden-minutes-body', 'hidden-token', 'hidden-api-key', 'top-level-hidden']) {
    assert.ok(!userMessage.includes(privateText));
  }
  assert.ok(!userMessage.includes('diet'));
  assert.deepEqual(context, original);
});

test('agent request rejects missing goals and malformed or oversized business context', () => {
  const cases = [
    [{ goal: '  ' }, 400, 'GOAL_REQUIRED'],
    [{ goal: 'a'.repeat(4001) }, 413, 'GOAL_TOO_LONG'],
    [{ goal: '准备会议', context: [] }, 400, 'INVALID_CONTEXT'],
    [{ goal: '准备会议', context: { meeting: 'not-an-object' } }, 400, 'INVALID_CONTEXT'],
    [{ goal: '准备会议', context: { participants: {} } }, 400, 'INVALID_CONTEXT'],
    [{ goal: '准备会议', context: { participants: [null] } }, 400, 'INVALID_CONTEXT'],
    [{ goal: '准备会议', context: { participants: Array.from({ length: 201 }, () => ({})) } }, 400, 'INVALID_CONTEXT'],
    [{ goal: '准备会议', context: { text: 'a'.repeat(8000) } }, 413, 'CONTEXT_TOO_LONG'],
  ];
  for (const [data, status, code] of cases) {
    assert.throws(() => buildAgentModelRequest(data, 'deepseek-chat'), { status, code });
  }
});

test('successful server plan satisfies the frontend validation contract without executing tools', () => {
  const calls = TOOL_NAMES.map((name) => toolCall(name, { reason: '  根据目标安排，执行时等待必要的人工确认。  ' }));
  const result = modelResult(calls);
  const original = structuredClone(result);
  const plan = readAgentPlan(result, 'deepseek-chat');
  assert.equal(plan.mode, 'deepseek');
  assert.equal(plan.model, 'deepseek-chat');
  assert.deepEqual(plan.steps.map((step) => step.tool), TOOL_NAMES);
  assert.ok(plan.steps.every((step) => typeof step.label === 'string' && step.label.length > 0));
  assert.ok(plan.steps.every((step) => step.reason === '根据目标安排，执行时等待必要的人工确认。'));
  assert.deepEqual(validatePlan(plan), { summary: plan.summary, steps: plan.steps, mode: 'deepseek' });
  assert.deepEqual(result, original);
});

test('materials and extracted tasks require their prerequisites earlier in the plan', () => {
  for (const names of [
    ['generate_materials'],
    ['generate_materials', 'sort_participants'],
    ['lookup_people', 'prepare_agenda', 'generate_materials'],
    ['extract_tasks'],
    ['extract_tasks', 'draft_minutes'],
    ['sort_participants', 'generate_materials', 'extract_tasks'],
  ]) rejectsPlan(names.map((name) => toolCall(name)));

  for (const names of [
    ['sort_participants', 'generate_materials'],
    ['draft_minutes', 'extract_tasks'],
    ['prepare_agenda'],
  ]) {
    const plan = readAgentPlan(modelResult(names.map((name) => toolCall(name))), 'deepseek-chat');
    assert.deepEqual(validatePlan(plan).steps.map((step) => step.tool), names);
  }
});

test('unknown tools, prototype keys, duplicate calls and more than six steps are rejected', () => {
  rejectsPlan([toolCall('send_email')]);
  rejectsPlan([toolCall('__proto__')]);
  rejectsPlan([toolCall('constructor')]);
  rejectsPlan([toolCall('lookup_people'), toolCall('lookup_people')]);
  rejectsPlan([...TOOL_NAMES.map((name) => toolCall(name)), toolCall('lookup_people')]);
  rejectsPlan([{ ...toolCall('lookup_people'), type: 'code_interpreter' }]);
});

test('additional tool arguments and malformed arguments cannot pass through to the browser', () => {
  for (const args of [
    { reason: '准备会议', url: 'https://example.invalid' },
    { reason: '准备会议', code: 'arbitrary-code' },
    { reason: '准备会议', confirmedRevision: 1 },
    [],
    null,
    'plain-text',
  ]) rejectsPlan([toolCall('lookup_people', args)]);
  rejectsPlan([{ type: 'function', function: { name: 'lookup_people', arguments: '{broken' } }]);
});

test('tool reasons must be present, nonempty strings of at most 400 characters', () => {
  for (const args of [{}, { reason: '' }, { reason: '   ' }, { reason: 1 }, { reason: 'a'.repeat(401) }]) {
    rejectsPlan([toolCall('lookup_people', args)]);
  }
  const plan = readAgentPlan(modelResult([toolCall('lookup_people', { reason: 'a'.repeat(400) })]), 'deepseek-chat');
  assert.equal(validatePlan(plan).steps[0].reason.length, 400);
});

test('missing or empty tool_calls means unsupported goal, never a fabricated successful plan', () => {
  for (const result of [
    {},
    { choices: [] },
    { choices: [{ message: { content: '这个目标需要其他能力。' } }] },
    modelResult([]),
    modelResult('not-an-array'),
    { choices: [{ message: { content: JSON.stringify({ steps: [{ tool: 'lookup_people' }] }) } }] },
  ]) {
    assert.throws(() => readAgentPlan(result, 'deepseek-chat'), { status: 400, code: 'UNSUPPORTED_GOAL' });
  }
});

test('summary fallback and truncation remain compatible with frontend limits', () => {
  const calls = [toolCall('lookup_people')];
  const fallback = readAgentPlan(modelResult(calls, '  '), 'deepseek-chat');
  assert.match(fallback.summary, /等待逐项执行/);
  assert.doesNotThrow(() => validatePlan(fallback));
  const truncated = readAgentPlan(modelResult(calls, 'a'.repeat(900)), 'deepseek-chat');
  assert.equal(truncated.summary.length, 800);
  assert.doesNotThrow(() => validatePlan(truncated));
});
