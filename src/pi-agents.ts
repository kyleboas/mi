#!/usr/bin/env node
import { AssistantMessageComponent, getMarkdownTheme, getSelectListTheme, initTheme, UserMessageComponent } from '@mariozechner/pi-coding-agent';
import { CURSOR_MARKER, Editor, ProcessTerminal, TUI, type Component, type Focusable } from '@mariozechner/pi-tui';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { PiAgentsManager, type PiAgent } from './pi-agents-manager.js';

initTheme(process.env.PI_THEME, false);
const manager = new PiAgentsManager();
const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function usage() {
  return `Pi Agents — manage independent Pi sessions

Usage:
  pi-agents                              Open the Pi Agents TUI
  pi-agents start <name> -- <prompt>     Start a writable Pi agent
  pi-agents start <name> --read-only -- <prompt>
  pi-agents list
  pi-agents stop <id>
  pi-agents resume <session.jsonl> [--cwd <path>]

Safety: only one write-capable agent may run in a checkout. Use a git worktree
for parallel implementation work, or use --read-only for review/research.`;
}

function arg(args: string[], flag: string) { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; }
function agentLabel(agent: PiAgent) { return agent.name || agent.id.slice(0, 8); }
function text(message: any) {
  if (typeof message?.content === 'string') return message.content;
  return Array.isArray(message?.content) ? message.content.filter((p: any) => p?.type === 'text').map((p: any) => p.text || '').join('') : '';
}

async function cli(args: string[]) {
  const command = args[0];
  if (!command || command === 'tui') return runTui();
  if (command === 'help' || command === '--help' || command === '-h') return console.log(usage());
  if (command === 'list') {
    const agents = manager.list();
    if (!agents.length) return console.log('No Pi Agents.');
    for (const agent of agents) console.log(`${agent.id.slice(0, 8)}  ${agent.status.padEnd(8)}  ${agentLabel(agent)}  ${agent.cwd}`);
    return;
  }
  if (command === 'start') {
    const name = args[1];
    const separator = args.indexOf('--');
    const prompt = separator < 0 ? '' : args.slice(separator + 1).join(' ').trim();
    if (!name || !prompt) throw new Error('usage: pi-agents start <name> [--cwd <path>] [--model <model>] [--read-only] -- <prompt>');
    await manager.start({ name, prompt, cwd: resolve(arg(args, '--cwd') || process.cwd()), model: arg(args, '--model'), readOnly: args.includes('--read-only') });
    // Session children are owned by this process. Keep the board open so this
    // invocation remains the manager rather than orphaning the newly-created Pi.
    return runTui();
  }
  if (command === 'stop') { await manager.stop(args[1] || ''); return; }
  if (command === 'resume') {
    const file = args[1];
    if (!file) throw new Error('usage: pi-agents resume <session.jsonl> [--cwd <path>]');
    await manager.resume(resolve(file), resolve(arg(args, '--cwd') || process.cwd()), arg(args, '--name') || basename(file), arg(args, '--model'));
    return runTui();
  }
  throw new Error(`Unknown command: ${command}`);
}

function ansiWidth(value: string) { return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').length; }
function trim(value: string, width: number) { return value.replace(/[\r\n]+/g, ' ').slice(0, Math.max(0, width)); }
function accent(value: string) { return getMarkdownTheme().code(value); }
function muted(value: string) { return getMarkdownTheme().linkUrl(value); }
function assistantLines(value: string, width: number) {
  const lines = new AssistantMessageComponent({ content: [{ type: 'text', text: value }] } as any, false, getMarkdownTheme()).render(width);
  return lines.filter((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim());
}
function userLines(value: string, width: number) { return new UserMessageComponent(value, getMarkdownTheme()).render(width); }
function statusIcon(agent: PiAgent, frame: number) { return agent.status === 'running' ? accent(spinner[frame % spinner.length]) : agent.status === 'error' ? '\x1b[31m!\x1b[39m' : agent.status === 'complete' ? '\x1b[32m○\x1b[39m' : '○'; }

class Screen implements Component, Focusable {
  focused = true;
  constructor(private renderFn: (width: number) => string[], private input: (data: string) => void) {}
  render(width: number) { return this.renderFn(width).map((line) => trim(line, width)); }
  handleInput(data: string) { this.input(data); }
  invalidate() {}
}

async function runTui() {
  let agents = manager.list();
  let selected = 0;
  let status = ' /new <name> <prompt> • Enter reply • Esc stop • q quit';
  let frame = 0;
  let closing = false;
  let tui: TUI | undefined;
  const editorTui = { terminal: { rows: process.stdout.rows || 24 }, requestRender() { tui?.requestRender(); } } as any;
  const editor = new Editor(editorTui, { borderColor: muted, selectList: getSelectListTheme() });
  editor.focused = true;
  editor.onSubmit = (value) => void submit(value);

  const refresh = () => { agents = manager.list(); selected = Math.max(0, Math.min(selected, agents.length - 1)); tui?.requestRender(); };
  const selectedAgent = () => agents[selected];
  const close = () => { if (closing) return; closing = true; clearInterval(timer); tui?.stop(); manager.dispose(); };
  const submit = async (value: string) => {
    const input = value.trim();
    if (!input) return;
    try {
      if (input === '/quit') return close();
      if (input.startsWith('/new ')) {
        const [, name, ...prompt] = input.split(/\s+/);
        if (!name || !prompt.length) throw new Error('Use /new <name> <prompt>.');
        const agent = await manager.start({ name, prompt: prompt.join(' '), cwd: process.cwd() });
        status = `Started ${agent.name}`;
      } else if (input.startsWith('/readonly ')) {
        const [, name, ...prompt] = input.split(/\s+/);
        if (!name || !prompt.length) throw new Error('Use /readonly <name> <prompt>.');
        const agent = await manager.start({ name, prompt: prompt.join(' '), cwd: process.cwd(), readOnly: true });
        status = `Started read-only ${agent.name}`;
      } else {
        const agent = selectedAgent();
        if (!agent) throw new Error('Use /new <name> <prompt> first.');
        await manager.send(agent.id, input);
        status = `Sent to ${agent.name}`;
      }
      editor.setText(''); refresh();
    } catch (error) { status = error instanceof Error ? error.message : String(error); refresh(); }
  };

  const render = (width: number) => {
    const height = process.stdout.rows || 24;
    const lines = [accent('pi agents') + muted(status), ''];
    if (!agents.length) lines.push(muted('No Pi Agents. Start one with /new <name> <prompt>.'));
    else {
      for (const [index, agent] of agents.entries()) {
        const cursor = index === selected ? accent('→ ') : '  ';
        const mode = agent.readOnly ? ' read-only' : '';
        lines.push(`${cursor}${statusIcon(agent, frame)} ${trim(agentLabel(agent), 28).padEnd(28)} ${muted(trim(agent.progress || agent.status, Math.max(10, width - 43)))}${muted(mode)}`);
      }
      const agent = selectedAgent();
      if (agent) {
        lines.push('', muted(`${agent.status} • ${agent.cwd}${agent.sessionFile ? ` • ${agent.sessionFile}` : ''}`));
        if (agent.lastInput) lines.push('', ...userLines(agent.lastInput, width));
        if (agent.text) lines.push('', ...assistantLines(agent.text, width));
        else if (agent.error) lines.push('', ...assistantLines(agent.error, width));
      }
    }
    const editorLines = editor.render(width).map((line) => line.replaceAll(CURSOR_MARKER, ''));
    const footer = [...editorLines, muted('Enter send • ↑↓ select • Esc stop selected • /readonly read-only • /quit').padStart(Math.max(0, width))];
    const content = lines.slice(0, Math.max(0, height - footer.length));
    while (content.length < Math.max(0, height - footer.length)) content.push('');
    return [...content, ...footer];
  };

  const onInput = (data: string) => {
    if (data === 'q' && !editor.getText()) return close();
    if (data === '\x1b' && !editor.getText()) {
      const agent = selectedAgent();
      if (agent?.status === 'running') void manager.stop(agent.id).then(refresh, (error) => { status = String(error); refresh(); });
      return;
    }
    if (!editor.getText() && (data === '\x1b[A' || data === '\x1bOA')) { selected = Math.max(0, selected - 1); return refresh(); }
    if (!editor.getText() && (data === '\x1b[B' || data === '\x1bOB')) { selected = Math.min(Math.max(0, agents.length - 1), selected + 1); return refresh(); }
    editor.handleInput(data);
  };

  const terminal = new ProcessTerminal();
  tui = new TUI(terminal);
  const screen = new Screen(render, onInput);
  tui.addChild(screen);
  tui.setFocus(screen);
  tui.start();
  const timer = setInterval(() => { frame++; refresh(); }, 250);
  process.once('SIGINT', close);
  refresh();
}

cli(process.argv.slice(2)).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }).finally(() => { if (!process.stdin.isTTY) manager.dispose(); });
