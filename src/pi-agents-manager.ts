import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

type RpcResponse = { type?: string; command?: string; success?: boolean; error?: string; data?: any };

export type PiAgent = {
  id: string;
  name: string;
  cwd: string;
  model?: string;
  readOnly: boolean;
  status: 'running' | 'complete' | 'paused' | 'stopped' | 'error';
  startedAt: string;
  updatedAt: string;
  sessionFile?: string;
  sessionId?: string;
  lastInput?: string;
  progress?: string;
  text?: string;
  error?: string;
};

type StartOptions = { name: string; cwd: string; prompt?: string; model?: string; readOnly?: boolean; sessionFile?: string };

function statePath() {
  return process.env.PI_AGENTS_STATE_PATH || join(homedir(), '.pi', 'agent', 'pi-agents', 'agents.json');
}

function messageText(message: any) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content.filter((part: any) => part?.type === 'text').map((part: any) => part.text || '').join('');
}

function timestamp() { return new Date().toISOString(); }

/** A local, process-owned pool of real Pi RPC sessions. */
export class PiAgentsManager {
  private agents = new Map<string, PiAgent>();
  private processes = new Map<string, ChildProcessWithoutNullStreams>();
  private buffers = new Map<string, string>();

  constructor() {
    try {
      const saved = JSON.parse(readFileSync(statePath(), 'utf8')) as PiAgent[];
      for (const agent of saved) {
        // An RPC child belongs to its parent process. Never lie that a saved,
        // orphaned process remains controllable after Pi Agents restarts.
        this.agents.set(agent.id, agent.status === 'running' ? { ...agent, status: 'stopped', progress: 'Pi Agents restarted; resume this session.' } : agent);
      }
    } catch {}
  }

  list() { return [...this.agents.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  get(id: string) { return this.agents.get(id); }

  async save() {
    const file = statePath();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(this.list(), null, 2)}\n`, { mode: 0o600 });
  }

  private update(id: string, patch: Partial<PiAgent>) {
    const current = this.agents.get(id);
    if (!current) return;
    this.agents.set(id, { ...current, ...patch, updatedAt: timestamp() });
    void this.save();
  }

  private assertSafeCwd(options: StartOptions) {
    if (options.readOnly) return;
    const collision = this.list().find((agent) => agent.status === 'running' && !agent.readOnly && agent.cwd === options.cwd);
    if (collision) throw new Error(`A write-capable Pi Agent is already running in ${options.cwd} (${collision.name}). Use a git worktree, or start this agent read-only.`);
  }

  async start(options: StartOptions) {
    this.assertSafeCwd(options);
    const id = randomUUID();
    const agent: PiAgent = {
      id, name: options.name, cwd: options.cwd, model: options.model, readOnly: options.readOnly === true,
      status: 'running', startedAt: timestamp(), updatedAt: timestamp(), lastInput: options.prompt,
      progress: options.sessionFile ? 'Resuming Pi session…' : 'Starting Pi session…', sessionFile: options.sessionFile,
    };
    this.agents.set(id, agent);
    await this.save();

    const command = process.env.PI_AGENTS_PI_COMMAND || 'pi';
    const commandArgs = process.env.PI_AGENTS_PI_ARGS ? JSON.parse(process.env.PI_AGENTS_PI_ARGS) as string[] : [];
    const args = [...commandArgs, '--mode', 'rpc', '--name', options.name];
    if (options.model) args.push('--model', options.model);
    if (options.readOnly) args.push('--tools', 'read,grep,find,ls');
    if (options.sessionFile) args.push('--session', options.sessionFile);
    const child = spawn(command, args, { cwd: options.cwd, stdio: 'pipe' });
    this.processes.set(id, child);
    this.buffers.set(id, '');
    child.stdout.on('data', (chunk) => this.consume(id, chunk.toString('utf8')));
    // A child can exit between an abort request and stdin.write(). The error is
    // expected during cleanup and must not turn into an unhandled process error.
    child.stdin.on('error', () => undefined);
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (text) this.update(id, { progress: text.slice(-240) });
    });
    child.on('error', (error) => this.update(id, { status: 'error', error: error.message, progress: undefined }));
    child.on('exit', (code, signal) => {
      if (this.get(id)?.status === 'running') this.update(id, { status: code === 0 ? 'stopped' : 'error', error: code && code !== 0 ? `Pi exited (${code}${signal ? `, ${signal}` : ''})` : undefined, progress: undefined });
      this.processes.delete(id);
      this.buffers.delete(id);
    });
    // Prompt responses only acknowledge acceptance. Query state as well so the
    // durable session file is available to the board immediately.
    this.sendRpc(id, { type: 'get_state' });
    if (options.prompt) this.sendRpc(id, { type: 'prompt', message: options.prompt });
    return agent;
  }

  async resume(sessionFile: string, cwd: string, name = 'resumed Pi session', model?: string) {
    return this.start({ name, cwd, model, sessionFile });
  }

  async send(id: string, message: string) {
    const agent = this.get(id);
    if (!agent) throw new Error('Pi Agent not found.');
    if (!this.processes.has(id)) throw new Error('That Pi Agent is not running. Resume its session first.');
    this.update(id, { status: 'running', lastInput: message, progress: 'Sending…', error: undefined });
    this.sendRpc(id, { type: 'prompt', message, streamingBehavior: 'steer' });
  }

  async stop(id: string) {
    const child = this.processes.get(id);
    if (!child) throw new Error('That Pi Agent is not running.');
    this.sendRpc(id, { type: 'abort' });
    child.kill('SIGTERM');
    this.update(id, { status: 'paused', progress: 'Stopped by Pi Agents.' });
  }

  dispose() {
    for (const [id, child] of this.processes) {
      this.sendRpc(id, { type: 'abort' });
      child.kill('SIGTERM');
    }
  }

  private sendRpc(id: string, command: Record<string, unknown>) {
    const child = this.processes.get(id);
    if (!child?.stdin.writable || child.stdin.destroyed) return;
    try { child.stdin.write(`${JSON.stringify(command)}\n`); } catch { /* child exited during cleanup */ }
  }

  private consume(id: string, text: string) {
    let buffer = (this.buffers.get(id) || '') + text;
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      try { this.handleEvent(id, JSON.parse(line)); } catch { /* RPC stdout is JSONL; ignore malformed provider diagnostics. */ }
    }
    this.buffers.set(id, buffer);
  }

  private handleEvent(id: string, event: RpcResponse & Record<string, any>) {
    if (event.type === 'response') {
      if (!event.success) this.update(id, { status: 'error', error: event.error || `${event.command} failed`, progress: undefined });
      const state = event.data;
      if (state?.sessionFile) this.update(id, { sessionFile: state.sessionFile, sessionId: state.sessionId, name: state.sessionName || this.get(id)?.name || 'Pi Agent' });
      return;
    }
    if (event.type === 'agent_start') this.update(id, { status: 'running', progress: 'Thinking…' });
    if (event.type === 'agent_settled') this.update(id, { status: 'complete', progress: undefined });
    if (event.type === 'tool_execution_start') this.update(id, { status: 'running', progress: `Using ${event.toolName || 'tool'}…` });
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
      const current = this.get(id)?.text || '';
      this.update(id, { status: 'running', progress: 'Writing…', text: `${current}${event.assistantMessageEvent.delta}`.slice(-12_000) });
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const final = messageText(event.message);
      if (final) this.update(id, { text: final });
    }
  }
}

export function piAgentsStateFile() { return statePath(); }
export function piAgentStateExists() { return existsSync(statePath()); }
