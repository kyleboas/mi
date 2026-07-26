import { lstatSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function miRootPath(environment: NodeJS.ProcessEnv = process.env, home = homedir()) {
  return environment.MI_ROOT || join(home, 'assistant');
}

/** Returns the requested path without trusting it. Use reviewedMiPaths before spawning it. */
export function miDaemonPath(environment: NodeJS.ProcessEnv = process.env, home = homedir()) {
  return environment.MI_DAEMON_PATH || join(miRootPath(environment, home), 'pi', 'extensions', 'mi-daemon.mjs');
}

function checkedRealPath(value: string, label: string) {
  if (!value || /[\0\r\n]/.test(value)) throw new Error(`${label} is unavailable`);
  let entry: ReturnType<typeof lstatSync>;
  try { entry = lstatSync(value); } catch { throw new Error(`${label} is unavailable`); }
  if (entry.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  try { return realpathSync(value); } catch { throw new Error(`${label} is unavailable`); }
}

export function reviewedMiPaths(environment: NodeJS.ProcessEnv = process.env, home = homedir()) {
  const root = checkedRealPath(miRootPath(environment, home), 'Mi root');
  if (!statSync(root).isDirectory()) throw new Error('Mi root is not a directory');
  const extensionRoot = checkedRealPath(join(root, 'pi', 'extensions'), 'Mi extension root');
  if (extensionRoot !== join(root, 'pi', 'extensions') || !statSync(extensionRoot).isDirectory()) throw new Error('Mi extension root escapes the private Mi tree');

  const verify = (value: string | undefined, filename: string, label: string) => {
    const expected = join(extensionRoot, filename);
    const chosen = value || expected;
    const canonical = checkedRealPath(chosen, label);
    if (canonical !== expected || resolve(chosen) !== expected || !statSync(canonical).isFile()) {
      throw new Error(`${label} must be the reviewed file under the private Mi extension root`);
    }
    return canonical;
  };

  return {
    root,
    extensionRoot,
    daemonPath: verify(environment.MI_DAEMON_PATH, 'mi-daemon.mjs', 'Mi daemon'),
    capabilityGuardPath: verify(environment.MI_CAPABILITY_GUARD, 'mi-capability-guard.ts', 'Mi capability guard'),
    capabilityAdapterPath: verify(environment.MI_CAPABILITY_ADAPTER, 'mi-orchestrator-adapter.ts', 'Mi capability adapter'),
  };
}
