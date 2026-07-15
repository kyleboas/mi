#!/usr/bin/env node
/** Install only user-level, non-secret Pi registry entries for Mi eval aliases. */
import { rename, stat, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const aliases = ['mi-eval-luna-low', 'mi-eval-sol-low', 'mi-eval-terra-low', 'mi-eval-sol-medium', 'mi-eval-sol-high'];
const configDir = resolve(process.env.MI_MODEL_EVAL_CONFIG_DIR || '/home/kyle/.pi/agent');
const settingsPath = join(configDir, 'settings.json');
const modelsPath = join(configDir, 'models.json');

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeJsonPreservingMode(path, value) {
  const info = await stat(path);
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: info.mode & 0o777 });
  await rename(temporary, path);
}

function missingEntries(settings, models) {
  const enabled = new Set(Array.isArray(settings.enabledModels) ? settings.enabledModels : []);
  const provider = models.providers?.['vps-gateway'];
  const registered = new Set(Array.isArray(provider?.models) ? provider.models.map((model) => model?.id) : []);
  return aliases.filter((alias) => !enabled.has(`vps-gateway/${alias}`) || !registered.has(alias));
}

export async function installEvalModels({ directory = configDir, checkOnly = false } = {}) {
  const settings = await readJson(join(directory, 'settings.json'));
  const models = await readJson(join(directory, 'models.json'));
  const provider = models.providers?.['vps-gateway'];
  if (!provider || !Array.isArray(provider.models)) throw new Error('vps-gateway model registry is missing');
  const baseline = provider.models.find((model) => model?.id === 'coding-main');
  if (!baseline) throw new Error('vps-gateway/coding-main registry entry is missing');
  if (!Array.isArray(settings.enabledModels)) throw new Error('enabledModels is missing');
  const missing = missingEntries(settings, models);
  if (checkOnly || missing.length === 0) return { changed: false, missing };
  for (const alias of aliases) {
    if (!provider.models.some((model) => model?.id === alias)) {
      provider.models.push({ ...baseline, id: alias, name: `VPS Gateway ${alias}` });
    }
    const scoped = `vps-gateway/${alias}`;
    if (!settings.enabledModels.includes(scoped)) settings.enabledModels.push(scoped);
  }
  // Defaults, provider credentials, and production coding-main remain untouched.
  await writeJsonPreservingMode(join(directory, 'models.json'), models);
  await writeJsonPreservingMode(join(directory, 'settings.json'), settings);
  return { changed: true, missing };
}

async function main() {
  const checkOnly = process.argv.slice(2).includes('--check');
  if (process.argv.slice(2).some((arg) => arg !== '--check')) throw new Error('usage: install-mi-model-eval-models.mjs [--check]');
  const result = await installEvalModels({ checkOnly });
  console.log(result.changed ? `installed user-level eval aliases: ${aliases.join(', ')}` : 'user-level eval aliases already present');
}

if (import.meta.main) main().catch((error) => { console.error(`eval model registry: ${error.message}`); process.exitCode = 1; });
