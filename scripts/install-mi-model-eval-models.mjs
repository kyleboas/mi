#!/usr/bin/env node
/** Opt-in, reversible setup for non-secret Pi registry entries used by Mi evals. */
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

export const EVAL_ALIASES = ['mi-eval-luna-low', 'mi-eval-sol-low', 'mi-eval-sol-medium', 'mi-eval-terra-low', 'mi-eval-sol-high'];
const configDir = resolve(process.env.MI_MODEL_EVAL_CONFIG_DIR || '/home/kyle/.pi/agent');
const stateName = '.mi-model-eval-overlay';

function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function encode(value) { return `${JSON.stringify(value, null, 2)}\n`; }
async function readRegistry(directory) {
  const settingsBuffer = await readFile(join(directory, 'settings.json'));
  const modelsBuffer = await readFile(join(directory, 'models.json'));
  return { settingsBuffer, modelsBuffer, settings: JSON.parse(settingsBuffer), models: JSON.parse(modelsBuffer) };
}
async function atomicWrite(path, value, mode) {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(temporary, value, { mode });
  await rename(temporary, path);
}
function validate(settings, models) {
  const provider = models.providers?.['vps-gateway'];
  if (!provider || !Array.isArray(provider.models)) throw new Error('vps-gateway model registry is missing');
  const baseline = provider.models.find((model) => model?.id === 'coding-main');
  if (!baseline) throw new Error('vps-gateway/coding-main registry entry is missing');
  if (!Array.isArray(settings.enabledModels)) throw new Error('enabledModels is missing');
  return { provider, baseline };
}
function missingEntries(settings, models, aliases) {
  const enabled = new Set(settings.enabledModels);
  const registered = new Set(models.providers['vps-gateway'].models.map((model) => model?.id));
  return aliases.filter((alias) => !enabled.has(`vps-gateway/${alias}`) || !registered.has(alias));
}

export async function installEvalModels({ directory = configDir, checkOnly = false } = {}) {
  const registry = await readRegistry(directory);
  const { provider, baseline } = validate(registry.settings, registry.models);
  const missing = missingEntries(registry.settings, registry.models, EVAL_ALIASES);
  if (checkOnly || missing.length === 0) return { changed: false, missing };
  const stateDir = join(directory, stateName);
  try {
    await stat(stateDir);
    throw new Error('eval registry restore state is inconsistent');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  for (const alias of EVAL_ALIASES) {
    if (!provider.models.some((model) => model?.id === alias)) provider.models.push({ ...baseline, id: alias, name: `VPS Gateway ${alias}` });
    const scoped = `vps-gateway/${alias}`;
    if (!registry.settings.enabledModels.includes(scoped)) registry.settings.enabledModels.push(scoped);
  }
  const settingsAfter = Buffer.from(encode(registry.settings));
  const modelsAfter = Buffer.from(encode(registry.models));
  await mkdir(stateDir, { recursive: false, mode: 0o700 });
  await chmod(stateDir, 0o700);
  await atomicWrite(join(stateDir, 'settings.before'), registry.settingsBuffer, 0o600);
  await atomicWrite(join(stateDir, 'models.before'), registry.modelsBuffer, 0o600);
  await atomicWrite(join(stateDir, 'manifest.json'), encode({ settingsAfter: hash(settingsAfter), modelsAfter: hash(modelsAfter) }), 0o600);
  const settingsMode = (await stat(join(directory, 'settings.json'))).mode & 0o777;
  const modelsMode = (await stat(join(directory, 'models.json'))).mode & 0o777;
  await atomicWrite(join(directory, 'models.json'), modelsAfter, modelsMode);
  await atomicWrite(join(directory, 'settings.json'), settingsAfter, settingsMode);
  return { changed: true, missing };
}

export async function uninstallEvalModels({ directory = configDir } = {}) {
  const registry = await readRegistry(directory);
  validate(registry.settings, registry.models);
  const stateDir = join(directory, stateName);
  let restoredExact = false;
  let stateExists = false;
  try { await stat(stateDir); stateExists = true; } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (stateExists) {
    try {
      const manifest = JSON.parse(await readFile(join(stateDir, 'manifest.json'), 'utf8'));
      if (manifest.settingsAfter === hash(registry.settingsBuffer) && manifest.modelsAfter === hash(registry.modelsBuffer)) {
        const settingsMode = (await stat(join(directory, 'settings.json'))).mode & 0o777;
        const modelsMode = (await stat(join(directory, 'models.json'))).mode & 0o777;
        await atomicWrite(join(directory, 'models.json'), await readFile(join(stateDir, 'models.before')), modelsMode);
        await atomicWrite(join(directory, 'settings.json'), await readFile(join(stateDir, 'settings.before')), settingsMode);
        restoredExact = true;
      }
    } catch {
      throw new Error('eval registry restore state is invalid');
    }
  }
  let changed = restoredExact;
  if (!restoredExact) {
    const evalIds = new Set(EVAL_ALIASES);
    const present = registry.models.providers['vps-gateway'].models.some((model) => evalIds.has(model?.id))
      || registry.settings.enabledModels.some((model) => EVAL_ALIASES.some((alias) => model === `vps-gateway/${alias}`));
    if (present) {
      registry.models.providers['vps-gateway'].models = registry.models.providers['vps-gateway'].models.filter((model) => !evalIds.has(model?.id));
      registry.settings.enabledModels = registry.settings.enabledModels.filter((model) => !EVAL_ALIASES.some((alias) => model === `vps-gateway/${alias}`));
      const settingsMode = (await stat(join(directory, 'settings.json'))).mode & 0o777;
      const modelsMode = (await stat(join(directory, 'models.json'))).mode & 0o777;
      await atomicWrite(join(directory, 'models.json'), encode(registry.models), modelsMode);
      await atomicWrite(join(directory, 'settings.json'), encode(registry.settings), settingsMode);
      changed = true;
    }
  }
  await rm(stateDir, { recursive: true, force: true });
  return { changed, restoredExact };
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  if (args.some((arg) => arg !== '--check')) throw new Error('usage: install-mi-model-eval-models.mjs [--check]');
  const result = await installEvalModels({ checkOnly });
  console.log(result.changed ? 'installed temporary user-level eval aliases' : 'user-level eval aliases already present');
}
if (import.meta.main) main().catch((error) => { console.error(`eval model registry: ${error.message}`); process.exitCode = 1; });
