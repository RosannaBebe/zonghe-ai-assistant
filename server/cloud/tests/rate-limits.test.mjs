import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFeedbackState, handleFeedbackRequest } from '../lib/feedback.ts';

const ORIGIN = 'https://competition.example';
const CONFIG = {
  githubToken: 'fake-only-github-token',
  repository: 'demo-owner/private-feedback',
  adminToken: 'fake-only-admin-token-at-least-24-characters',
  signingSecret: 'fake-only-signing-secret-at-least-32-characters',
  allowedOrigins: [ORIGIN],
};
const noFetch = async () => { throw new Error('Rate-limit tests must never call upstream'); };

function submit(ip) {
  // The form deliberately fails local validation after the rate check, allowing
  // deterministic quota/window testing without any GitHub writes or tickets.
  return new Request('http://unit.internal/api/feedback', {
    method: 'POST', headers: { Origin: ORIGIN, 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' }, body: '{}',
  });
}
function ticket(ip) {
  return new Request(`http://unit.internal/api/feedback-ticket?requestId=${randomUUID()}`, { headers: { Origin: ORIGIN, 'CF-Connecting-IP': ip } });
}

test('invalid optional limits fail closed instead of disabling throttling', async () => {
  for (const rateLimits of [null, '120', { ticket: 0 }, { submit: -1 }, { globalSubmit: 1.5 }, { submit: Infinity }, { ticket: '120' }, { unknown: 10 }]) {
    const response = await handleFeedbackRequest(ticket('198.51.100.1'), { ...CONFIG, rateLimits }, noFetch);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'FEEDBACK_NOT_CONFIGURED');
  }
});

test('IP eviction cannot reset the global bucket, while the 10-minute boundary does', async () => {
  let now = 1800000000000;
  const state = createFeedbackState();
  const config = { ...CONFIG, rateLimits: { ticket: 2, submit: 2, globalSubmit: 3 } };
  const send = (request) => handleFeedbackRequest(request, config, noFetch, { state, now: () => now });
  assert.equal((await send(submit('198.51.100.1'))).status, 400);
  assert.equal((await send(submit('198.51.100.1'))).status, 400);
  assert.equal((await send(submit('198.51.100.1'))).status, 429);
  assert.equal((await send(submit('198.51.100.2'))).status, 400);
  assert.equal((await send(submit('198.51.100.3'))).status, 429);
  for (let index = state.buckets.size; index < 2048; index += 1) {
    state.buckets.set(`old-ip-${index}`, { count: 1, expiresAt: now + 600000 });
  }
  assert.equal((await send(ticket('198.51.100.4'))).status, 200);
  assert.equal(state.buckets.size, 2048);
  assert.equal((await send(submit('198.51.100.5'))).status, 429);
  now += 600000;
  assert.equal((await send(submit('198.51.100.5'))).status, 400);
});
