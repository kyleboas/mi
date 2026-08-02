import { lstatSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

function checkedRealPath(value, label) {
  if (!value || /[\0\r\n]/.test(value)) throw new Error(`${label} is unavailable`);
  let entry;
  try { entry = lstatSync(value); } catch { throw new Error(`${label} is unavailable`); }
  if (entry.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  try { return realpathSync(value); } catch { throw new Error(`${label} is unavailable`); }
}

export function reviewedMiExtensionPaths({ root, daemonPath, capabilityGuardPath, capabilityAdapterPath, diverNotesPath, requireDaemon = false, requireGuard = false, requireAdapter = false, requireDiverNotes = false } = {}) {
  const canonicalRoot = checkedRealPath(root, 'Mi root');
  if (!statSync(canonicalRoot).isDirectory()) throw new Error('Mi root is not a directory');
  const expectedExtensionRoot = join(canonicalRoot, 'pi', 'extensions');
  const extensionRoot = checkedRealPath(expectedExtensionRoot, 'Mi extension root');
  if (extensionRoot !== expectedExtensionRoot || !statSync(extensionRoot).isDirectory()) throw new Error('Mi extension root escapes the private Mi tree');

  const verify = (value, filename, label, required) => {
    if (!required && !value) return undefined;
    const expected = join(extensionRoot, filename);
    const chosen = value || expected;
    const canonical = checkedRealPath(chosen, label);
    if (canonical !== expected || resolve(chosen) !== expected || !statSync(canonical).isFile()) {
      throw new Error(`${label} must be the reviewed file under the private Mi extension root`);
    }
    return canonical;
  };

  return {
    root: canonicalRoot,
    extensionRoot,
    daemonPath: verify(daemonPath, 'mi-daemon.mjs', 'Mi daemon', requireDaemon),
    capabilityGuardPath: verify(capabilityGuardPath, 'mi-capability-guard.ts', 'Mi capability guard', requireGuard),
    capabilityAdapterPath: verify(capabilityAdapterPath, 'mi-orchestrator-adapter.ts', 'Mi capability adapter', requireAdapter),
    diverNotesPath: verify(diverNotesPath, 'mi-diver-notes.ts', 'Mi Diver Notes extension', requireDiverNotes),
  };
}
