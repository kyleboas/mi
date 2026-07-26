#!/usr/bin/env node
/** Install the tracked, non-secret Pi registry baseline for the local gateway. */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

const configDir = resolve(process.env.MI_GATEWAY_CONFIG_DIR || '/home/kyle/.pi/agent');
export const BASELINE_MODEL = {
  id: 'coding-main',
  name: 'VPS Gateway coding-main',
  reasoning: true,
  input: ['text'],
  contextWindow: 128000,
  maxTokens: 16384,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
export const BASELINE_PROVIDER = {
  baseUrl: 'http://127.0.0.1:4000/v1',
  api: 'openai-completions',
  apiKey: '!cat ~/.config/agent/gateway.token',
  models: [BASELINE_MODEL],
};

function encode(value) { return `${JSON.stringify(value, null, 2)}\n`; }
async function readJsonOrMissing(path, fallback) {
  try {
    const content = await readFile(path, 'utf8');
    return { value: JSON.parse(content), exists: true };
  } catch (error) {
    if (error?.code === 'ENOENT') return { value: fallback, exists: false };
    throw error;
  }
}
async function atomicJson(path, value, mode) {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(temporary, encode(value), { mode });
  await rename(temporary, path);
}

export async function installGatewayBaseline({ directory = configDir } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const settingsPath = join(directory, 'settings.json');
  const modelsPath = join(directory, 'models.json');
  const [settingsFile, modelsFile] = await Promise.all([
    readJsonOrMissing(settingsPath, { enabledModels: [] }),
    readJsonOrMissing(modelsPath, { providers: {} }),
  ]);
  const settings = settingsFile.value;
  const models = modelsFile.value;
  if (!Array.isArray(settings.enabledModels)) throw new Error('enabledModels is missing');
  if (!models.providers || typeof models.providers !== 'object' || Array.isArray(models.providers)) throw new Error('providers is missing');

  let changed = !settingsFile.exists || !modelsFile.exists;
  let provider = models.providers['vps-gateway'];
  if (provider === undefined) {
    provider = structuredClone(BASELINE_PROVIDER);
    models.providers['vps-gateway'] = provider;
    changed = true;
  } else if (!provider || typeof provider !== 'object' || !Array.isArray(provider.models)) {
    throw new Error('vps-gateway model registry is invalid');
  }
  if (!provider.models.some((model) => model?.id === 'coding-main')) {
    provider.models.push(structuredClone(BASELINE_MODEL));
    changed = true;
  }
  if (!settings.enabledModels.includes('vps-gateway/coding-main')) {
    settings.enabledModels.push('vps-gateway/coding-main');
    changed = true;
  }
  if (!changed) return { changed: false };

  const [settingsMode, modelsMode] = await Promise.all([
    settingsFile.exists ? stat(settingsPath).then((entry) => entry.mode & 0o777) : Promise.resolve(0o600),
    modelsFile.exists ? stat(modelsPath).then((entry) => entry.mode & 0o777) : Promise.resolve(0o600),
  ]);
  await atomicJson(modelsPath, models, modelsMode);
  await atomicJson(settingsPath, settings, settingsMode);
  return { changed: true };
}

async function main() {
  if (process.argv.length !== 2) throw new Error('usage: install-mi-gateway-baseline-models.mjs');
  const result = await installGatewayBaseline();
  console.log(result.changed ? 'installed local gateway registry baseline' : 'local gateway registry baseline already present');
}
if (import.meta.main) main().catch((error) => { console.error(`Mi gateway baseline registry: ${error.message}`); process.exitCode = 1; });
