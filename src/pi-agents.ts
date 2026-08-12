#!/usr/bin/env node
// Pi Agents borrows the current Mi Agents board primitives; its transport is
// independent local Pi RPC sessions, selected before the shared CLI loads.
process.env.PI_AGENTS_MODE = '1';
process.argv = [...process.argv.slice(0, 2), 'agents'];
await import('./cli.js');
