import { createHmac, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isKilled, isPaused, logEvent } from './state.js';

export const AI_DISCLOSURE = 'This is an AI assistant calling on behalf of Mi.';
export const VOICE_STATUSES = ['initiated', 'ringing', 'answered', 'completed', 'busy', 'failed', 'no-answer', 'canceled'] as const;
export type VoiceStatus = typeof VOICE_STATUSES[number] | 'pending';

type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;
type Clock = () => Date;

type VoiceConfig = {
  enabled: boolean;
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  authToken: string;
  fromNumber: string;
  webhookBaseUrl: string;
  environment: string;
  allowedCountryCodes: string[];
  prohibitedPrefixes: string[];
  allowedPremiumPrefixes: string[];
  allowPremium: boolean;
  maxScriptChars: number;
  maxCallSeconds: number;
  confirmationTtlMs: number;
  rateWindowMs: number;
  maxCallsPerUser: number;
  maxCallsPerNumber: number;
  maxCallsPerAccount: number;
};

export type VoiceDetails = {
  confirmationId: string;
  to: string;
  purpose: string;
  script: string;
  disclosure: string;
  userId?: string;
  idempotencyKey: string;
};

type ConfirmationRecord = {
  id: string;
  expiresAt: string;
  toHash: string;
  purposeHash: string;
  scriptHash: string;
  disclosureHash: string;
  userHash: string;
  consumedBy?: string;
};

type CallRecord = {
  id: string;
  idempotencyKey: string;
  confirmationId: string;
  toHash: string;
  purposeHash: string;
  scriptHash: string;
  disclosureHash: string;
  userHash: string;
  createdAt: string;
  updatedAt: string;
  status: VoiceStatus;
  callSid?: string;
  outcome?: string;
};

type VoiceStore = { version: 1; confirmations: ConfirmationRecord[]; calls: CallRecord[] };

export type TwilioVoiceOptions = {
  env?: NodeJS.ProcessEnv;
  statePath?: string;
  now?: Clock;
  fetchImpl?: FetchLike;
  paused?: () => Promise<boolean>;
  killed?: () => Promise<boolean>;
  eventLogger?: (type: string, data: unknown) => Promise<void>;
};

const MAX_PURPOSE_CHARS = 240;
const MAX_USER_CHARS = 120;
const MAX_IDEMPOTENCY_CHARS = 160;
const DEFAULT_SCRIPT_CHARS = 1200;
const DEFAULT_CALL_SECONDS = 180;
const DEFAULT_CONFIRMATION_TTL_MS = 5 * 60_000;
const LOCK_STALE_MS = 30_000;
const COUNTRY_CODES = ['358', '357', '351', '353', '350', '34', '33', '32', '31', '30', '27', '20', '7', '1', '44', '49', '39', '41', '43', '45', '46', '47', '48', '52', '53', '54', '55', '56', '57', '58', '60', '61', '62', '63', '64', '65', '66', '81', '82', '84', '86', '90', '91', '92', '93', '94', '95', '98', '212', '213', '216', '218', '220', '221', '222', '223', '224', '225', '226', '227', '228', '229', '230', '231', '232', '233', '234', '235', '236', '237', '238', '239', '240', '241', '242', '243', '244', '245', '246', '248', '249', '250', '251', '252', '253', '254', '255', '256', '257', '258', '260', '261', '262', '263', '264', '265', '266', '267', '268', '269', '290', '291', '297', '298', '299', '350', '351', '352', '353', '354', '355', '356', '357', '358', '359', '370', '371', '372', '373', '374', '375', '376', '377', '378', '380', '381', '382', '383', '385', '386', '387', '389', '420', '421', '423', '500', '501', '502', '503', '504', '505', '506', '507', '508', '509', '590', '591', '592', '593', '594', '595', '596', '597', '598', '599', '670', '672', '673', '674', '675', '676', '677', '678', '679', '680', '681', '682', '683', '685', '686', '687', '688', '689', '690', '691', '692', '700', '701', '702', '703', '704', '705', '706', '707', '708', '709', '710', '711', '712', '713', '714', '715', '716', '717', '718', '719', '720', '721', '722', '723', '724', '725', '726', '727', '728', '729', '730', '731', '732', '733', '734', '735', '736', '737', '738', '739', '740', '741', '742', '743', '744', '745', '746', '747', '748', '749', '750', '751', '752', '753', '754', '755', '756', '757', '758', '759', '760', '761', '762', '763', '764', '765', '766', '767', '768', '770', '771', '772', '773', '774', '775', '800', '808', '809', '850', '855', '856', '857', '858', '859', '870', '878', '880', '881', '882', '883', '886', '888', '960', '961', '962', '963', '964', '965', '966', '967', '968', '970', '971', '972', '973', '974', '975', '976', '977', '992', '993', '994', '995', '996', '998'];

const DEFAULT_PROHIBITED_PREFIXES = ['+1900', '+1976', '+1979', '+979'];
const EMERGENCY_CODES = ['000', '110', '111', '112', '118', '119', '911', '997', '998', '999'];

function listEnv(env: NodeJS.ProcessEnv, key: string, fallback: string[]) {
  const value = String(env[key] || '').trim();
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : fallback;
}

function numberEnv(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number) {
  const value = Number(env[key] || fallback);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

export function normalizeE164(input: string): string {
  if (typeof input !== 'string') throw new Error('phone number is required');
  const raw = input.trim();
  if (!/^\+[0-9][0-9 ()-]*$/u.test(raw)) throw new Error('phone number must be E.164');
  const normalized = `+${raw.slice(1).replace(/[ ()-]/g, '')}`;
  if (!/^\+[1-9][0-9]{7,14}$/u.test(normalized)) throw new Error('phone number must be E.164');
  return normalized;
}

function phoneCountryCode(number: string) {
  return [...COUNTRY_CODES].sort((a, b) => b.length - a.length).find((code) => number.slice(1).startsWith(code)) || '';
}

function isPublicHostname(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/u, '');
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host === '::1' || host === '[::1]' || host === '127.0.0.1') return false;
  if (/^(?:0|10|127)\.(?:\d{1,3}\.){2}\d{1,3}$/u.test(host) || /^(?:fc|fd|fe8|fe9|fea|feb)[0-9a-f]*:/iu.test(host.replace(/^\[|\]$/gu, ''))) return false;
  if (/^192\.168\.(?:\d{1,3}\.)?\d{1,3}$/u.test(host) || /^169\.254\.(?:\d{1,3}\.){2}\d{1,3}$/u.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)\d{1,3}$/u.test(host) || /^100\.(?:6[4-9]|[78]\d)\.(?:\d{1,3}\.)\d{1,3}$/u.test(host)) return false;
  return true;
}

function validateWebhookBaseUrl(value: string, environment: string) {
  if (!value) {
    if (environment === 'production') throw new Error('production Twilio voice requires a public HTTPS webhook URL and auth token');
    return;
  }
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('Twilio webhook URL is malformed'); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.hostname) throw new Error('Twilio webhook URL is unsafe');
  if (environment === 'production') {
    if (parsed.protocol !== 'https:' || !isPublicHostname(parsed.hostname)) throw new Error('production Twilio voice requires a public HTTPS webhook URL and auth token');
  } else if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname.toLowerCase()))) {
    throw new Error('development Twilio webhook URL must be HTTPS or loopback HTTP');
  }
}

export function isProhibitedServiceNumber(number: string, prohibitedPrefixes = DEFAULT_PROHIBITED_PREFIXES) {
  const compact = typeof number === 'string' ? `+${number.trim().replace(/^\+/u, '').replace(/[ ()-]/g, '')}` : '';
  // Emergency short codes are not E.164 numbers, so check them before the
  // normalizer rejects short destinations. Also reject country-code forms
  // whose national number is an emergency/service code.
  const digits = compact.slice(1);
  if (EMERGENCY_CODES.includes(digits) || COUNTRY_CODES.some((code) => digits.startsWith(code) && EMERGENCY_CODES.includes(digits.slice(code.length)))) return true;
  const normalized = normalizeE164(number);
  if (prohibitedPrefixes.some((prefix) => /^\+\d+$/u.test(prefix) && normalized.startsWith(prefix))) return true;
  // NANP emergency/service codes can be embedded in a valid local number;
  // fail closed for the known suffixes rather than relying on a short code.
  if (normalized.startsWith('+1') && ['000', '112', '911', '988', '999'].some((suffix) => normalized.slice(2).endsWith(suffix))) return true;
  return false;
}

function validateDestination(number: string, config: VoiceConfig) {
  const normalized = normalizeE164(number);
  if (isProhibitedServiceNumber(normalized, DEFAULT_PROHIBITED_PREFIXES)) throw new Error('destination is a prohibited service number');
  const customPremium = config.prohibitedPrefixes.some((prefix) => !DEFAULT_PROHIBITED_PREFIXES.includes(prefix) && /^\+\d+$/u.test(prefix) && normalized.startsWith(prefix));
  if (customPremium) {
    if (!config.allowPremium || !config.allowedPremiumPrefixes.some((prefix) => normalized.startsWith(prefix))) throw new Error('premium-rate destination is not configured');
  } else if (isProhibitedServiceNumber(normalized, config.prohibitedPrefixes.filter((prefix) => !DEFAULT_PROHIBITED_PREFIXES.includes(prefix)))) {
    throw new Error('destination is a prohibited service number');
  }
  const country = phoneCountryCode(normalized);
  if (!country || !config.allowedCountryCodes.includes(country)) throw new Error('international destination is not configured');
  return normalized;
}

function boundedText(value: unknown, name: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${name} is invalid`);
  return value.trim();
}

function canonicalPurpose(value: unknown) { return boundedText(value, 'purpose', MAX_PURPOSE_CHARS).replace(/\s+/gu, ' '); }
function canonicalScript(value: unknown, max: number) { return boundedText(value, 'script', max).replace(/\r\n?/gu, '\n'); }
function canonicalDisclosure(value: unknown) {
  const disclosure = boundedText(value, 'AI disclosure', 240).replace(/\s+/gu, ' ');
  if (!/(?:\bAI\b|artificial intelligence)/iu.test(disclosure)) throw new Error('AI disclosure is required');
  return disclosure;
}
function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function safeId(value: unknown, name: string) {
  const result = boundedText(value, name, MAX_IDEMPOTENCY_CHARS);
  if (!/^[A-Za-z0-9._:-]+$/u.test(result)) throw new Error(`${name} is invalid`);
  return result;
}
function userHash(value: unknown) { return hash(safeId(value || 'mi', 'user id')); }
function sameDetails(record: { toHash: string; purposeHash: string; scriptHash: string; disclosureHash: string; userHash: string }, details: ReturnType<typeof detailHashes>) {
  return record.toHash === details.toHash && record.purposeHash === details.purposeHash && record.scriptHash === details.scriptHash && record.disclosureHash === details.disclosureHash && record.userHash === details.userHash;
}
function detailHashes(details: { to: string; purpose: string; script: string; disclosure: string; userId?: string }) {
  return { toHash: hash(details.to), purposeHash: hash(details.purpose), scriptHash: hash(details.script), disclosureHash: hash(details.disclosure), userHash: userHash(details.userId) };
}

export function twimlForVoice(disclosure: string, script: string) {
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  return `<Response><Say>${escape(disclosure)}</Say><Pause length="1"/><Say>${escape(script)}</Say></Response>`;
}

export function twilioSignature(url: string, params: Record<string, string>, authToken: string) {
  const payload = url + Object.keys(params).sort().map((key) => `${key}${params[key]}`).join('');
  return createHmac('sha1', authToken).update(payload).digest('base64');
}

export function validateTwilioSignature(url: string, params: Record<string, string>, signature: string, authToken: string) {
  if (!authToken || !signature) return false;
  const expected = twilioSignature(url, params, authToken);
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function loadTwilioVoiceConfig(env: NodeJS.ProcessEnv = process.env): VoiceConfig {
  return {
    enabled: /^(1|true|yes|on)$/iu.test(String(env.MI_TWILIO_ENABLED || '')),
    accountSid: String(env.TWILIO_ACCOUNT_SID || '').trim(),
    apiKeySid: String(env.TWILIO_API_KEY_SID || '').trim(),
    apiKeySecret: String(env.TWILIO_API_KEY_SECRET || '').trim(),
    authToken: String(env.TWILIO_AUTH_TOKEN || '').trim(),
    fromNumber: String(env.MI_TWILIO_FROM_NUMBER || '').trim(),
    webhookBaseUrl: String(env.MI_TWILIO_WEBHOOK_BASE_URL || '').trim().replace(/\/$/u, ''),
    environment: String(env.MI_TWILIO_ENV || 'development').trim().toLowerCase(),
    allowedCountryCodes: listEnv(env, 'MI_TWILIO_ALLOWED_COUNTRY_CODES', ['1']),
    prohibitedPrefixes: [...new Set([...DEFAULT_PROHIBITED_PREFIXES, ...listEnv(env, 'MI_TWILIO_PROHIBITED_PREFIXES', [])])],
    allowedPremiumPrefixes: listEnv(env, 'MI_TWILIO_ALLOWED_PREMIUM_PREFIXES', []),
    allowPremium: /^(1|true|yes|on)$/iu.test(String(env.MI_TWILIO_ALLOW_PREMIUM || '')),
    maxScriptChars: numberEnv(env, 'MI_TWILIO_MAX_SCRIPT_CHARS', DEFAULT_SCRIPT_CHARS, 80, 4000),
    maxCallSeconds: numberEnv(env, 'MI_TWILIO_MAX_CALL_SECONDS', DEFAULT_CALL_SECONDS, 10, 600),
    confirmationTtlMs: numberEnv(env, 'MI_TWILIO_CONFIRMATION_TTL_MS', DEFAULT_CONFIRMATION_TTL_MS, 10_000, 15 * 60_000),
    rateWindowMs: numberEnv(env, 'MI_TWILIO_RATE_WINDOW_MS', 60 * 60_000, 60_000, 24 * 60 * 60_000),
    maxCallsPerUser: numberEnv(env, 'MI_TWILIO_MAX_CALLS_PER_USER', 3, 1, 100),
    maxCallsPerNumber: numberEnv(env, 'MI_TWILIO_MAX_CALLS_PER_NUMBER', 2, 1, 100),
    maxCallsPerAccount: numberEnv(env, 'MI_TWILIO_MAX_CALLS_PER_ACCOUNT', 20, 1, 500),
  };
}

function stateFile(options: TwilioVoiceOptions) { return options.statePath || String(options.env?.MI_TWILIO_STATE_PATH || process.env.MI_TWILIO_STATE_PATH || path.join(options.env?.MI_ROOT || process.env.MI_ROOT || process.cwd(), 'state', 'twilio-voice.json')); }
async function readStore(file: string): Promise<VoiceStore> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (parsed?.version === 1 && Array.isArray(parsed.confirmations) && Array.isArray(parsed.calls)) return parsed;
  } catch {}
  return { version: 1, confirmations: [], calls: [] };
}
async function writeStore(file: string, store: VoiceStore) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(file), 0o700);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(store), { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
    await chmod(file, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
let storeQueue: Promise<unknown> = Promise.resolve();
async function withStore<T>(file: string, action: (store: VoiceStore) => Promise<T> | T): Promise<T> {
  const operation = async () => {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const lock = `${file}.lock`;
    let handle;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { handle = await open(lock, 'wx', 0o600); break; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const info = await stat(lock).catch(() => undefined);
        if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) await rm(lock, { force: true }).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    if (!handle) throw new Error('voice state is busy');
    try { const store = await readStore(file); const result = await action(store); await writeStore(file, store); return result; } finally { await handle.close(); await rm(lock, { force: true }); }
  };
  const result = storeQueue.then(operation, operation);
  storeQueue = result.catch(() => undefined);
  return result as Promise<T>;
}

export class TwilioVoiceBackend {
  readonly config: VoiceConfig;
  private readonly file: string;
  private readonly clock: Clock;
  private readonly fetchImpl: FetchLike;
  private readonly paused: () => Promise<boolean>;
  private readonly killed: () => Promise<boolean>;
  private readonly eventLogger: (type: string, data: unknown) => Promise<void>;

  constructor(options: TwilioVoiceOptions = {}) {
    this.config = loadTwilioVoiceConfig(options.env || process.env);
    this.file = stateFile(options);
    this.clock = options.now || (() => new Date());
    this.fetchImpl = options.fetchImpl || (globalThis.fetch as unknown as FetchLike);
    this.paused = options.paused || isPaused;
    this.killed = options.killed || isKilled;
    this.eventLogger = options.eventLogger || logEvent;
  }

  webhookUrl(pathname: string) {
    if (!this.config.webhookBaseUrl) return '';
    return new URL(pathname, `${this.config.webhookBaseUrl}/`).toString();
  }

  private validateSetup() {
    if (!this.config.enabled) throw new Error('Twilio voice is disabled');
    if (!this.config.accountSid || !this.config.apiKeySid || !this.config.apiKeySecret || !this.config.fromNumber) throw new Error('Twilio voice configuration is incomplete');
    validateWebhookBaseUrl(this.config.webhookBaseUrl, this.config.environment);
    if (this.config.environment === 'production' && !this.config.authToken) throw new Error('production Twilio voice requires a public HTTPS webhook URL and auth token');
    const from = normalizeE164(this.config.fromNumber);
    if (isProhibitedServiceNumber(from)) throw new Error('configured from-number is prohibited');
  }

  async createConfirmation(input: { to: string; purpose: string; script: string; disclosure?: string; userId?: string }) {
    this.validateSetup();
    const to = validateDestination(input.to, this.config);
    const purpose = canonicalPurpose(input.purpose);
    const script = canonicalScript(input.script, this.config.maxScriptChars);
    const disclosure = canonicalDisclosure(input.disclosure || AI_DISCLOSURE);
    const createdAt = this.clock();
    const record: ConfirmationRecord = { id: randomUUID().replaceAll('-', ''), expiresAt: new Date(createdAt.getTime() + this.config.confirmationTtlMs).toISOString(), ...detailHashes({ to, purpose, script, disclosure, userId: input.userId }) };
    await withStore(this.file, async (store) => { store.confirmations = store.confirmations.filter((item) => Date.parse(item.expiresAt) > createdAt.getTime()); store.confirmations.unshift(record); });
    await this.eventLogger('twilio.voice.confirmation_created', { confirmationId: record.id, expiresAt: record.expiresAt, toHash: record.toHash, purposeHash: record.purposeHash, scriptHash: record.scriptHash, disclosureHash: record.disclosureHash });
    return { confirmationId: record.id, expiresAt: record.expiresAt, to, purpose, scriptHash: record.scriptHash, disclosureHash: record.disclosureHash, disclosure };
  }

  async initiate(input: VoiceDetails) {
    this.validateSetup();
    if (await this.paused() || await this.killed()) throw new Error('Twilio voice is paused or kill-switched');
    const to = validateDestination(input.to, this.config);
    const purpose = canonicalPurpose(input.purpose);
    const script = canonicalScript(input.script, this.config.maxScriptChars);
    const disclosure = canonicalDisclosure(input.disclosure);
    const idempotencyKey = safeId(input.idempotencyKey, 'idempotency key');
    const details = { to, purpose, script, disclosure, userId: input.userId };
    const hashes = detailHashes(details);
    let record: CallRecord | undefined;
    let reused = false;
    let retryPending = false;
    const createdAt = this.clock();
    await withStore(this.file, async (store) => {
      const duplicate = store.calls.find((item) => item.idempotencyKey === idempotencyKey);
      if (duplicate) {
        if (!sameDetails(duplicate, hashes)) throw new Error('idempotency key is bound to different call details');
        record = duplicate;
        // A crash can occur after Twilio accepted the idempotent request but
        // before its response was persisted. Retry the same request/key so
        // Twilio reconciles it to the original call instead of leaving the
        // confirmation permanently consumed. Failed transport attempts are
        // likewise retryable with the same exact details.
        if (duplicate.callSid || !['pending', 'failed'].includes(duplicate.status)) { reused = true; return; }
        duplicate.status = 'pending';
        duplicate.outcome = undefined;
        duplicate.updatedAt = createdAt.toISOString();
        retryPending = true;
        return;
      }
      const confirmation = store.confirmations.find((item) => item.id === input.confirmationId);
      if (!confirmation || Date.parse(confirmation.expiresAt) <= createdAt.getTime()) throw new Error('confirmation is missing or expired');
      if (confirmation.consumedBy) throw new Error('confirmation has already been used');
      if (!sameDetails(confirmation, hashes)) throw new Error('confirmation does not match call details');
      const recent = store.calls.filter((item) => Date.parse(item.createdAt) >= createdAt.getTime() - this.config.rateWindowMs);
      if (recent.filter((item) => item.userHash === hashes.userHash).length >= this.config.maxCallsPerUser) throw new Error('user call rate limit exceeded');
      if (recent.filter((item) => item.toHash === hashes.toHash).length >= this.config.maxCallsPerNumber) throw new Error('destination call rate limit exceeded');
      if (recent.length >= this.config.maxCallsPerAccount) throw new Error('account call rate limit exceeded');
      if (!retryPending && store.calls.some((item) => item.toHash === hashes.toHash && !['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(item.status))) throw new Error('a call to this destination is already active');
      record = { id: randomUUID().replaceAll('-', ''), idempotencyKey, confirmationId: input.confirmationId, ...hashes, createdAt: createdAt.toISOString(), updatedAt: createdAt.toISOString(), status: 'pending' };
      confirmation.consumedBy = record.id;
      store.calls.unshift(record);
    });
    if (!record) throw new Error('call could not be prepared');
    if (reused) return this.publicCall(record);

    try {
      const params = new URLSearchParams({ To: to, From: validateDestination(this.config.fromNumber, this.config), Twiml: twimlForVoice(disclosure, script), TimeLimit: String(Math.round(this.config.maxCallSeconds)), StatusCallbackEvent: 'initiated ringing answered completed', StatusCallbackMethod: 'POST' });
      if (this.config.webhookBaseUrl) params.set('StatusCallback', this.webhookUrl('/api/twilio/status'));
      const response = await this.fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.config.accountSid)}/Calls.json`, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${this.config.apiKeySid}:${this.config.apiKeySecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': idempotencyKey }, body: params.toString() });
      if (!response.ok) throw new Error(`Twilio Calls API request failed (${response.status})`);
      const payload = await response.json();
      const callSid = typeof payload?.sid === 'string' ? payload.sid : '';
      if (!callSid) throw new Error('Twilio Calls API returned no call id');
      record = await this.updateCall(record.id, { status: 'initiated', callSid });
      await this.eventLogger('twilio.voice.initiated', { callId: record.id, callSid, status: record.status, toHash: record.toHash, purposeHash: record.purposeHash, scriptHash: record.scriptHash });
      return this.publicCall(record);
    } catch (error) {
      record = await this.updateCall(record.id, { status: 'failed', outcome: 'api_error' });
      await this.eventLogger('twilio.voice.failed', { callId: record.id, status: record.status, outcome: record.outcome, toHash: record.toHash, purposeHash: record.purposeHash, scriptHash: record.scriptHash });
      throw error;
    }
  }

  private async updateCall(id: string, patch: Partial<CallRecord>) {
    let updated: CallRecord | undefined;
    await withStore(this.file, async (store) => {
      const current = store.calls.find((item) => item.id === id);
      if (!current) throw new Error('call not found');
      Object.assign(current, patch, { updatedAt: this.clock().toISOString() });
      updated = current;
    });
    return updated!;
  }

  async updateStatus(callSid: string, status: string) {
    const normalized = status === 'cancelled' ? 'canceled' : status;
    if (!VOICE_STATUSES.includes(normalized as typeof VOICE_STATUSES[number])) throw new Error('unsupported Twilio call status');
    const safeSid = safeId(callSid, 'call id');
    let result: CallRecord | undefined;
    await withStore(this.file, async (store) => {
      const current = store.calls.find((item) => item.callSid === safeSid);
      if (!current) throw new Error('call not found');
      if (['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(current.status)) { result = current; return; }
      current.status = normalized as VoiceStatus;
      current.outcome = normalized;
      current.updatedAt = this.clock().toISOString();
      result = current;
    });
    await this.eventLogger('twilio.voice.status', { callId: result!.id, callSid: result!.callSid, status: result!.status, outcome: result!.outcome });
    return this.publicCall(result!);
  }

  private publicCall(record: CallRecord) { return { callId: record.id, callSid: record.callSid, status: record.status, outcome: record.outcome, createdAt: record.createdAt, updatedAt: record.updatedAt, toHash: record.toHash, purposeHash: record.purposeHash, scriptHash: record.scriptHash }; }
}

export function createTwilioVoiceBackend(options: TwilioVoiceOptions = {}) { return new TwilioVoiceBackend(options); }
