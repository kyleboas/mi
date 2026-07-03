import { spawn } from 'node:child_process';
import net from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const HOME = homedir();
const MI_RUNTIME_DIR = process.env.MI_RUNTIME_DIR || join(HOME, '.pi', 'agent', 'mi');
const MI_SOCKET_PATH = process.env.MI_SOCKET_PATH || join(MI_RUNTIME_DIR, 'main.sock');
const MI_DAEMON_PATH = process.env.MI_DAEMON_PATH || join(HOME, '.pi', 'agent', 'extensions', 'mi-daemon.mjs');
const MI_DAEMON_SYSTEMD_UNIT = process.env.MI_DAEMON_SYSTEMD_UNIT || 'mi-daemon.service';
const MI_DAEMON_HOST = process.env.MI_DAEMON_HOST || join(HOME, 'bin', 'mi-daemon-host');

export type MiDaemonResponse = {
  ok?: boolean;
  error?: string;
  text?: string;
  state?: unknown;
  tasks?: unknown[];
  taskId?: string;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  model?: unknown;
};

export function sendSocketRequest(payload: unknown, timeoutMs = 120000): Promise<MiDaemonResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(MI_SOCKET_PATH);
    let data = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timed out waiting for Mi main'));
    }, timeoutMs);
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (!data.includes('\n')) return;
      clearTimeout(timer);
      socket.end();
      try {
        const response = JSON.parse(data.slice(0, data.indexOf('\n'))) as MiDaemonResponse;
        if (response.ok) resolve(response);
        else reject(new Error(response.error || 'Mi main returned an error'));
      } catch (error) {
        reject(error);
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function isStaleMiSocketError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('ECONNREFUSED') || message.includes('ENOENT') || message.includes('Timed out waiting for Mi main');
}

function runQuiet(command: string, args: string[], timeoutMs = 10000): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve(false);
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

async function waitForMiDaemonHealth(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await sendSocketRequest({ type: 'health' }, 500);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return false;
}

async function startMiDaemonWithSystemd() {
  const unit = String(MI_DAEMON_SYSTEMD_UNIT || '').trim();
  if (!unit || process.env.MI_DAEMON_SYSTEMD === '0' || !existsSync('/usr/bin/systemctl')) return false;
  if (!await runQuiet('/usr/bin/systemctl', ['--user', 'cat', unit], 3000)) return false;
  if (!await runQuiet('/usr/bin/systemctl', ['--user', 'start', unit], 10000)) return false;
  return waitForMiDaemonHealth(30000);
}

export async function startMiDaemon() {
  await mkdir(dirname(MI_SOCKET_PATH), { recursive: true });
  if (existsSync(MI_DAEMON_HOST) && await runQuiet(MI_DAEMON_HOST, [], 30000) && await waitForMiDaemonHealth(5000)) return;
  if (await startMiDaemonWithSystemd()) return;
  const child = spawn(process.execPath, [MI_DAEMON_PATH], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, MI_SOCKET_PATH, MI_RUNTIME_DIR },
  });
  child.unref();
  if (await waitForMiDaemonHealth(30000)) return;
  throw new Error('Mi main did not start');
}

export async function sendTaskSocketRequest(payload: unknown, timeoutMs = 30000) {
  try {
    return await sendSocketRequest(payload, timeoutMs);
  } catch (error) {
    if (existsSync(MI_SOCKET_PATH) && !isStaleMiSocketError(error)) throw error;
    if (isStaleMiSocketError(error)) await rm(MI_SOCKET_PATH, { force: true }).catch(() => undefined);
    await startMiDaemon();
    return await sendSocketRequest(payload, timeoutMs);
  }
}
