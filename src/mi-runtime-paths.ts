import { homedir } from 'node:os';
import { join } from 'node:path';

export function miRootPath(environment: NodeJS.ProcessEnv = process.env, home = homedir()) {
  return environment.MI_ROOT || join(home, 'assistant');
}

export function miDaemonPath(environment: NodeJS.ProcessEnv = process.env, home = homedir()) {
  return environment.MI_DAEMON_PATH || join(miRootPath(environment, home), 'pi', 'extensions', 'mi-daemon.mjs');
}
