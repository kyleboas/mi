#!/usr/bin/env node
/** Install/check only durable production aliases in the non-secret Pi registry. */
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { EVAL_ALIASES, uninstallEvalModels } from './install-mi-model-eval-models.mjs';

export const PRODUCTION_ALIASES = ['mi-concierge'];
const configDir = resolve(process.env.MI_GATEWAY_CONFIG_DIR || '/home/kyle/.pi/agent');

async function atomicJson(path, value) {
  const mode = (await stat(path)).mode & 0o777;
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await rename(temporary, path);
}

export async function installProductionModels({ directory = configDir, checkOnly = false } = {}) {
  const settingsPath = join(directory, 'settings.json');
  const modelsPath = join(directory, 'models.json');
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  const models = JSON.parse(await readFile(modelsPath, 'utf8'));
  const provider = models.providers?.['vps-gateway'];
  if (!provider || !Array.isArray(provider.models)) throw new Error('vps-gateway model registry is missing');
  const baseline = provider.models.find((model) => model?.id === 'coding-main');
  if (!baseline) throw new Error('vps-gateway/coding-main registry entry is missing');
  if (!Array.isArray(settings.enabledModels)) throw new Error('enabledModels is missing');
  const missing = PRODUCTION_ALIASES.filter((alias) => !settings.enabledModels.includes(`vps-gateway/${alias}`) || !provider.models.some((model) => model?.id === alias));
  const evalPresent = EVAL_ALIASES.filter((alias) => settings.enabledModels.includes(`vps-gateway/${alias}`) || provider.models.some((model) => model?.id === alias));
  if (checkOnly) return { changed: false, missing, evalPresent };
  if (evalPresent.length > 0) await uninstallEvalModels({ directory });
  if (missing.length === 0) return { changed: evalPresent.length > 0, missing, evalPresent };
  // Re-read after eval restoration: its exact rollback may have restored an
  // earlier production registry snapshot.
  if (evalPresent.length > 0) return installProductionModels({ directory, checkOnly: false });
  for (const alias of PRODUCTION_ALIASES) {
    if (!provider.models.some((model) => model?.id === alias)) provider.models.push({ ...baseline, id: alias, name: `VPS Gateway ${alias}` });
    const scoped = `vps-gateway/${alias}`;
    if (!settings.enabledModels.includes(scoped)) settings.enabledModels.push(scoped);
  }
  await atomicJson(modelsPath, models);
  await atomicJson(settingsPath, settings);
  return { changed: true, missing, evalPresent };
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  if (args.some((arg) => arg !== '--check')) throw new Error('usage: install-mi-gateway-models.mjs [--check]');
  const result = await installProductionModels({ checkOnly });
  if (checkOnly && (result.missing.length || result.evalPresent.length)) {
    throw new Error('production aliases are incomplete or eval aliases remain installed');
  }
  console.log(result.changed ? `restored production gateway aliases: ${PRODUCTION_ALIASES.join(', ')}` : 'production gateway aliases already present; eval aliases absent');
}
if (import.meta.main) main().catch((error) => { console.error(`Mi gateway model registry: ${error.message}`); process.exitCode = 1; });
