#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = process.cwd();
const skipDirs = new Set(['.git', 'node_modules']);
const skipFiles = new Set(['package-lock.json']);
const term = (...parts) => parts.join('');
const literal = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordPattern = (...parts) => new RegExp(`\\b${literal(term(...parts))}\\b`, 'i');

const secretPatterns = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['github token', /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ['openai-style key', /\bsk-[A-Za-z0-9]{20,}\b/],
  ['aws access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['google api key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['slack token', /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/],
  ['overlay-network auth key', /\btskey-[A-Za-z0-9_-]{20,}\b/],
  ['npm token', /\bnpm_[A-Za-z0-9]{30,}\b/],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/],
  ['credential URL', /\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:/]+:[^\s@]+@[^\s]+/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
];

const privateContextPatterns = [
  ['personal username', wordPattern('ky', 'le')],
  ['personal home path', new RegExp(`${literal(term('/', 'home', '/'))}${literal(term('ky', 'le'))}\\b`, 'i')],
  ['systemd personal user', new RegExp(`\\bUser=${literal(term('ky', 'le'))}\\b`, 'i')],
  ['personal research repo', wordPattern('research', '-', 'pr')],
  ['personal research project', wordPattern('tactics', 'journal')],
  ['personal wiki path', wordPattern('pi', '-', 'docs')],
  ['machine-specific nvm path', new RegExp(literal(term('.', 'nvm', '/', 'versions', '/', 'node')), 'i')],
  ['private database service name', wordPattern('pg', 'vector')],
  ['removed upload worker surface', new RegExp(`\\b${literal(term('MI', '_', 'UPLOAD'))}\\b|\\b${literal(term('wrang', 'ler'))}\\b`, 'i')],
  ['overlay-network-specific terminology', new RegExp(`\\b${literal(term('tail', 'net'))}\\b|\\b${literal(term('tail', 'scale'))}\\b`, 'i')],
  ['removed web UI source', /\bsrc\/public\b/i],
];

function isBinary(buffer) {
  return buffer.subarray(0, 4096).includes(0);
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) yield* walk(join(dir, entry.name));
      continue;
    }
    if (!entry.isFile()) continue;
    const path = join(dir, entry.name);
    const rel = relative(root, path);
    if (skipFiles.has(rel)) continue;
    yield path;
  }
}

const findings = [];
for await (const path of walk(root)) {
  const rel = relative(root, path);
  const buffer = await readFile(path);
  if (isBinary(buffer)) continue;
  const text = buffer.toString('utf8');
  const lines = text.split(/\r?\n/);
  for (const [name, pattern] of [...secretPatterns, ...privateContextPatterns]) {
    for (let i = 0; i < lines.length; i++) {
      pattern.lastIndex = 0;
      if (pattern.test(lines[i])) findings.push(`${rel}:${i + 1}: ${name}`);
    }
  }
}

if (findings.length) {
  console.error('Public-readiness audit failed:');
  console.error(findings.join('\n'));
  process.exit(1);
}

console.log('Public-readiness audit passed.');
