#!/usr/bin/env node
import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { draftAssistant, proposeAssistantEdit } from './builder.js';
import { assistantPath } from './assistant.js';
import { checkAssistant, runAssistant } from './runner.js';
import { readRecentEvents, logEvent } from './state.js';
function usage() {
    return `Mi — tiny private assistant harness

Usage:
  mi make <description> [--name <name>]
  mi run <assistant>
  mi edit <assistant> <change>
  mi check <assistant>
  mi logs <assistant> [limit]
`;
}
function argValue(args, flag) {
    const index = args.indexOf(flag);
    if (index === -1)
        return undefined;
    return args[index + 1];
}
async function writeAssistantFile(path, markdown) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, markdown);
}
async function makeCommand(args) {
    const name = argValue(args, '--name');
    const description = args.filter((arg, i) => arg !== '--name' && args[i - 1] !== '--name').join(' ').trim();
    if (!description)
        throw new Error('description required');
    const draft = draftAssistant({ description, name });
    await writeAssistantFile(draft.path, draft.markdown);
    await logEvent('mi.make', { name: draft.name, path: draft.path });
    console.log(`Created ${draft.path}`);
}
async function runCommand(args) {
    const name = args[0];
    if (!name)
        throw new Error('assistant name required');
    const result = await runAssistant({ name, trigger: 'manual' });
    await logEvent('mi.run', result);
    console.log(`${name}: ${result.status}`);
    console.log(result.summary);
    if (result.status === 'error')
        process.exitCode = 1;
}
async function editCommand(args) {
    const name = args[0];
    const change = args.slice(1).join(' ').trim();
    if (!name)
        throw new Error('assistant name required');
    if (!change)
        throw new Error('change required');
    const path = assistantPath(name);
    const currentMarkdown = await readFile(path, 'utf8');
    const draft = proposeAssistantEdit({ name, change, currentMarkdown });
    await writeAssistantFile(draft.path, draft.markdown);
    await logEvent('mi.edit', { name, path: draft.path, change });
    console.log(`Updated ${draft.path}`);
}
async function checkCommand(args) {
    const name = args[0];
    if (!name)
        throw new Error('assistant name required');
    const result = await checkAssistant(name);
    console.log(`${result.path}: ${result.ok ? 'ok' : 'needs work'}`);
    for (const issue of result.issues)
        console.log(`- ${issue}`);
    if (!result.ok)
        process.exitCode = 1;
}
async function logsCommand(args) {
    const name = args[0];
    if (!name)
        throw new Error('assistant name required');
    const limit = Number(args[1] || 20);
    const events = await readRecentEvents(Number.isFinite(limit) ? limit : 20);
    const matching = events.filter((event) => JSON.stringify(event).includes(name));
    for (const event of matching)
        console.log(JSON.stringify(event));
}
async function main() {
    const [command, ...args] = process.argv.slice(2);
    if (!command || command === 'help' || command === '--help' || command === '-h') {
        console.log(usage());
        return;
    }
    if (command === 'make')
        return makeCommand(args);
    if (command === 'run')
        return runCommand(args);
    if (command === 'edit')
        return editCommand(args);
    if (command === 'check')
        return checkCommand(args);
    if (command === 'logs')
        return logsCommand(args);
    throw new Error(`unknown command: ${command}`);
}
try {
    await main();
}
catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
}
