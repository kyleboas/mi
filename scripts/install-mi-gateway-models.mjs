#!/usr/bin/env node
/** Install user-level, non-secret Pi registry entries for Mi's local gateway aliases. */
import { GATEWAY_ALIASES, installGatewayModels } from './install-mi-model-eval-models.mjs';

async function main() {
  const checkOnly = process.argv.slice(2).includes('--check');
  if (process.argv.slice(2).some((arg) => arg !== '--check')) throw new Error('usage: install-mi-gateway-models.mjs [--check]');
  const result = await installGatewayModels({ checkOnly, aliases: GATEWAY_ALIASES });
  console.log(result.changed ? `installed user-level Mi gateway aliases: ${GATEWAY_ALIASES.join(', ')}` : 'user-level Mi gateway aliases already present');
}

if (import.meta.main) main().catch((error) => { console.error(`Mi gateway model registry: ${error.message}`); process.exitCode = 1; });
