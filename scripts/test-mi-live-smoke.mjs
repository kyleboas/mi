#!/usr/bin/env node
import assert from 'node:assert/strict';

function enabled(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || ''));
}

function present(name) {
  return Boolean(String(process.env[name] || '').trim());
}

function report(name, value) {
  console.log(`${name}: ${value ? 'present/enabled' : 'missing/disabled'}`);
}

if (!enabled('MI_LIVE_SMOKE')) {
  console.error('Refusing live Mi smoke tests unless MI_LIVE_SMOKE=1');
  process.exit(1);
}

console.log('Mi live smoke preflight. Secret values are never printed.');
report('MI_WEB_URL', present('MI_WEB_URL'));
report('MI_LIVE_WEB_HEALTH', enabled('MI_LIVE_WEB_HEALTH'));
report('MI_LIVE_WEB_CHAT', enabled('MI_LIVE_WEB_CHAT'));
report('MI_LIVE_IMESSAGE_SMOKE', enabled('MI_LIVE_IMESSAGE_SMOKE'));
report('MI_LIVE_DAEMON_HEALTH', enabled('MI_LIVE_DAEMON_HEALTH'));

let checks = 0;

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { res, text, json };
}

const webUrl = String(process.env.MI_WEB_URL || '').replace(/\/$/, '');
if (webUrl && (enabled('MI_LIVE_WEB_HEALTH') || enabled('MI_LIVE_WEB_CHAT') || enabled('MI_LIVE_IMESSAGE_SMOKE'))) {
  checks += 1;
  const { res, json, text } = await fetchJson(`${webUrl}/api/health`);
  assert.equal(res.ok, true, `Mi web health failed: ${res.status} ${text.slice(0, 200)}`);
  assert.equal(json?.ok, true, 'Mi web health did not return ok=true');
  console.log('Mi web health: ok');
}

if (webUrl && enabled('MI_LIVE_WEB_CHAT')) {
  checks += 1;
  const prompt = String(process.env.MI_LIVE_WEB_CHAT_PROMPT || 'Say hello in one short sentence.').trim();
  const { res, json, text } = await fetchJson(`${webUrl}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thread: 'live-smoke', message: prompt }),
  });
  assert.ok(res.status === 200 || res.status === 202, `Mi web chat failed: ${res.status} ${text.slice(0, 200)}`);
  assert.equal(json?.ok, true, 'Mi web chat did not return ok=true');
  console.log('Mi web chat enqueue: ok');
}

if (webUrl && enabled('MI_LIVE_IMESSAGE_SMOKE')) {
  checks += 1;
  const prompt = String(process.env.MI_LIVE_IMESSAGE_PROMPT || 'hello').trim();
  const { res, json, text } = await fetchJson(`${webUrl}/api/imessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thread: 'live-smoke-imessage', message: prompt }),
  });
  assert.equal(res.ok, true, `Mi iMessage API smoke failed: ${res.status} ${text.slice(0, 200)}`);
  assert.equal(json?.ok, true, 'Mi iMessage API did not return ok=true');
  assert.equal(typeof json?.reply, 'string', 'Mi iMessage API must return a reply string');
  console.log('Mi iMessage API smoke: ok');
}

if (enabled('MI_LIVE_DAEMON_HEALTH')) {
  checks += 1;
  console.log('Mi daemon live health: not implemented in this smoke script; use Mi web health or targeted daemon tooling.');
}

if (checks === 0) {
  console.log('No live checks selected. Set MI_WEB_URL plus MI_LIVE_WEB_HEALTH=1, MI_LIVE_WEB_CHAT=1, or MI_LIVE_IMESSAGE_SMOKE=1.');
}

console.log('Mi live smoke completed.');
