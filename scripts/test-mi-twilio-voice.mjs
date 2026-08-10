import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AI_DISCLOSURE,
  VOICE_STATUSES,
  createTwilioVoiceBackend,
  isProhibitedServiceNumber,
  normalizeE164,
  twilioSignature,
  validateTwilioSignature,
} from '../dist/src/twilio-voice.js';

const root = await mkdtemp(join(tmpdir(), 'mi-twilio-voice-'));
const statePath = join(root, 'twilio.json');
let current = new Date('2026-01-01T00:00:00.000Z');
const env = {
  MI_ROOT: root,
  TWILIO_ACCOUNT_SID: 'ACtest',
  TWILIO_API_KEY_SID: 'SKtest',
  TWILIO_API_KEY_SECRET: 'test-secret',
  TWILIO_AUTH_TOKEN: 'auth-token',
  MI_TWILIO_FROM_NUMBER: '+15551234567',
  MI_TWILIO_WEBHOOK_BASE_URL: 'https://voice.example.test',
  MI_TWILIO_ENV: 'production',
  MI_TWILIO_ALLOWED_COUNTRY_CODES: '1',
  MI_TWILIO_MAX_CALLS_PER_USER: '3',
  MI_TWILIO_MAX_CALLS_PER_NUMBER: '2',
  MI_TWILIO_MAX_CALLS_PER_ACCOUNT: '20',
};
const requests = [];
const events = [];
const backend = createTwilioVoiceBackend({
  env,
  statePath,
  now: () => current,
  eventLogger: async (type, data) => events.push({ type, data }),
  fetchImpl: async (url, init) => {
    requests.push({ url, init });
    return { ok: true, status: 201, async json() { return { sid: 'CA-test-1', status: 'queued' }; } };
  },
  paused: async () => false,
  killed: async () => false,
});

assert.equal(normalizeE164('+1 (555) 123-4568'), '+15551234568');
assert.throws(() => normalizeE164('15551234568'), /E\.164/);
assert.equal(isProhibitedServiceNumber('+15551234911'), true);
assert.equal(isProhibitedServiceNumber('+19005551234'), true);
await assert.rejects(() => backend.createConfirmation({ to: '+15551234568', purpose: 'test', script: 'hello', disclosure: 'This is a caller.' }), /AI disclosure/);
await assert.rejects(() => backend.createConfirmation({ to: '+447700900123', purpose: 'test', script: 'hello', disclosure: AI_DISCLOSURE }), /international/);

const confirmation = await backend.createConfirmation({ to: '+1 (555) 123-4568', purpose: 'Appointment reminder', script: 'Your appointment is tomorrow.', disclosure: AI_DISCLOSURE, userId: 'user-1' });
assert.equal(confirmation.to, '+15551234568');
assert.match(confirmation.confirmationId, /^[a-f0-9]{32}$/);
assert.equal(confirmation.scriptHash.length, 64);
const storedBeforeCall = await readFile(statePath, 'utf8');
assert.equal(storedBeforeCall.includes('+15551234568'), false);
assert.equal(storedBeforeCall.includes('Your appointment is tomorrow.'), false);

const call = await backend.initiate({ confirmationId: confirmation.confirmationId, idempotencyKey: 'voice-1', to: '+15551234568', purpose: 'Appointment reminder', script: 'Your appointment is tomorrow.', disclosure: AI_DISCLOSURE, userId: 'user-1' });
assert.equal(call.status, 'initiated');
assert.equal(call.callSid, 'CA-test-1');
const params = new URLSearchParams(requests[0].init.body);
assert.match(params.get('Twiml'), /AI assistant/);
assert.equal(params.has('Record'), false);
assert.equal(params.get('StatusCallback'), 'https://voice.example.test/api/twilio/status');
assert.equal((await backend.initiate({ confirmationId: confirmation.confirmationId, idempotencyKey: 'voice-1', to: '+15551234568', purpose: 'Appointment reminder', script: 'Your appointment is tomorrow.', disclosure: AI_DISCLOSURE, userId: 'user-1' })).callId, call.callId);
await assert.rejects(() => backend.initiate({ confirmationId: confirmation.confirmationId, idempotencyKey: 'voice-1', to: '+15551234568', purpose: 'different', script: 'Your appointment is tomorrow.', disclosure: AI_DISCLOSURE, userId: 'user-1' }), /idempotency/);

assert.equal((await backend.updateStatus('CA-test-1', 'ringing')).status, 'ringing');
assert.equal((await backend.updateStatus('CA-test-1', 'answered')).status, 'answered');
assert.equal((await backend.updateStatus('CA-test-1', 'completed')).status, 'completed');
assert.equal((await backend.updateStatus('CA-test-1', 'failed')).status, 'completed');
assert.deepEqual(VOICE_STATUSES, ['initiated', 'ringing', 'answered', 'completed', 'busy', 'failed', 'no-answer', 'canceled']);

const signedUrl = 'https://voice.example.test/api/twilio/status';
const signedParams = { CallSid: 'CA-test-1', CallStatus: 'completed' };
const signature = twilioSignature(signedUrl, signedParams, 'auth-token');
assert.equal(validateTwilioSignature(signedUrl, signedParams, signature, 'auth-token'), true);
assert.equal(validateTwilioSignature(signedUrl, signedParams, 'bad', 'auth-token'), false);

current = new Date('2026-01-01T00:10:00.000Z');
const expiredBackend = createTwilioVoiceBackend({ env: { ...env, MI_TWILIO_CONFIRMATION_TTL_MS: '10000' }, statePath: join(root, 'expired.json'), now: () => current, fetchImpl: backend.fetchImpl, paused: async () => false, killed: async () => false });
const expired = await expiredBackend.createConfirmation({ to: '+15551234569', purpose: 'Expired', script: 'This is an AI assistant.', disclosure: AI_DISCLOSURE });
current = new Date('2026-01-01T00:10:20.000Z');
await assert.rejects(() => expiredBackend.initiate({ confirmationId: expired.confirmationId, idempotencyKey: 'expired-1', to: '+15551234569', purpose: 'Expired', script: 'This is an AI assistant.', disclosure: AI_DISCLOSURE }), /expired/);

const limited = createTwilioVoiceBackend({ env: { ...env, MI_TWILIO_MAX_CALLS_PER_USER: '1' }, statePath: join(root, 'limited.json'), now: () => new Date('2026-01-01T00:00:00Z'), fetchImpl: async () => ({ ok: true, status: 201, async json() { return { sid: 'CA-limited' }; } }), paused: async () => false, killed: async () => false });
const first = await limited.createConfirmation({ to: '+15551234570', purpose: 'One', script: 'AI assistant message one.', disclosure: AI_DISCLOSURE, userId: 'same-user' });
await limited.initiate({ confirmationId: first.confirmationId, idempotencyKey: 'limited-1', to: '+15551234570', purpose: 'One', script: 'AI assistant message one.', disclosure: AI_DISCLOSURE, userId: 'same-user' });
const second = await limited.createConfirmation({ to: '+15551234571', purpose: 'Two', script: 'AI assistant message two.', disclosure: AI_DISCLOSURE, userId: 'same-user' });
await assert.rejects(() => limited.initiate({ confirmationId: second.confirmationId, idempotencyKey: 'limited-2', to: '+15551234571', purpose: 'Two', script: 'AI assistant message two.', disclosure: AI_DISCLOSURE, userId: 'same-user' }), /rate limit/);

const storedAfterCall = await readFile(statePath, 'utf8');
assert.equal(storedAfterCall.includes('+15551234568'), false);
assert.equal(storedAfterCall.includes('Your appointment is tomorrow.'), false);
assert.ok(events.some((event) => event.type === 'twilio.voice.initiated'));
const paused = createTwilioVoiceBackend({ env, statePath: join(root, 'paused.json'), paused: async () => true, killed: async () => false });
await assert.rejects(() => paused.initiate({ confirmationId: 'a'.repeat(32), idempotencyKey: 'paused', to: '+15551234568', purpose: 'x', script: 'x', disclosure: AI_DISCLOSURE }), /paused/);

console.log('Mi Twilio voice checks passed.');
