import 'dotenv/config';

/**
 * Promote legacy `MI_*` environment variables to the canonical `DIVER_*`
 * namespace. `DIVER_*` always wins when both are present.
 *
 * This is a temporary compatibility alias; new configuration should use
 * `DIVER_*`.
 */
export function normalizeLegacyMiEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('MI_')) continue;
    const diverKey = `DIVER_${key.slice(3)}`;
    if (!(diverKey in env)) env[diverKey] = value;
  }
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('DIVER_')) continue;
    const legacyKey = `MI_${key.slice(6)}`;
    if (!(legacyKey in env)) env[legacyKey] = value;
  }
}

normalizeLegacyMiEnv();

/**
 * Read a Diver environment variable. `DIVER_*` takes precedence over legacy
 * `MI_*`.
 */
export function diverEnv(name: string, fallback?: string): string | undefined {
  const diverKey = `DIVER_${name}`;
  if (diverKey in process.env) return process.env[diverKey];
  return process.env[`MI_${name}`] ?? fallback;
}
