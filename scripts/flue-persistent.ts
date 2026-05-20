import 'dotenv/config';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const workspace = path.join(root, '.flue');
const output = path.join(root, 'state', 'flue-node');
const serverPath = path.join(output, 'dist', 'server.mjs');
const host = process.env.FLUE_HOST || '127.0.0.1';
const port = process.env.FLUE_PORT || '3583';

function run(cmd: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, env: process.env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function patchServerHost() {
  let source = await readFile(serverPath, 'utf8');
  const replacements = [
    ['const server = serve({ fetch: app.fetch, port });', `const server = serve({ fetch: app.fetch, port, hostname: ${JSON.stringify(host)} });`],
    ['var server = serve({ fetch: app.fetch, port });', `var server = serve({ fetch: app.fetch, port, hostname: ${JSON.stringify(host)} });`],
  ] as const;
  let patched = false;
  for (const [oldText, newText] of replacements) {
    if (source.includes(oldText)) {
      source = source.replace(oldText, newText);
      patched = true;
      break;
    }
    if (source.includes(newText)) patched = true;
  }
  if (!patched) throw new Error('Could not find Flue server listen call to patch');
  await writeFile(serverPath, source);
}

async function build() {
  await mkdir(output, { recursive: true });
  await run(path.join(root, 'node_modules', '.bin', 'flue'), [
    'build',
    '--target',
    'node',
    '--workspace',
    workspace,
    '--output',
    output,
  ]);
  await patchServerHost();
}

async function start() {
  await build();
  console.log(`Starting persistent Flue orchestrator on http://${host}:${port}`);
  const child = spawn('node', [serverPath], {
    cwd: root,
    env: { ...process.env, HOST: host, PORT: port, FLUE_MODE: 'local' },
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

async function status() {
  try {
    const res = await fetch(`http://${host}:${port}/health`);
    console.log(JSON.stringify({ ok: res.ok, status: res.status, url: `http://${host}:${port}` }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, url: `http://${host}:${port}`, error: e instanceof Error ? e.message : String(e) }));
    process.exitCode = 1;
  }
}

const command = process.argv[2] || 'start';
if (command === 'build') await build();
else if (command === 'start') await start();
else if (command === 'status') await status();
else if (command === 'path') console.log(existsSync(serverPath) ? serverPath : '');
else throw new Error(`unknown command: ${command}`);
