import { spawn } from 'node:child_process';

export type PiRun = { text: string; trace: string[] };
export type PiStreamEvent =
  | { type: 'trace'; text: string }
  | { type: 'text'; text: string }
  | { type: 'done'; text: string; trace: string[] }
  | { type: 'error'; text: string };

function summarizeEvent(event: any): string | undefined {
  if (event.type === 'agent_start') return 'pi started';
  if (event.type === 'turn_start') return 'thinking';
  if (event.type === 'tool_execution_start') {
    const args = event.args ? ` ${JSON.stringify(event.args).slice(0, 240)}` : '';
    return `tool: ${event.toolName}${args}`;
  }
  if (event.type === 'tool_execution_end') return `tool done: ${event.toolName}${event.isError ? ' error' : ''}`;
  if (event.type === 'auto_retry_start') return `retrying: ${event.errorMessage || ''}`;
  if (event.type === 'compaction_start') return 'compacting context';
  if (event.type === 'agent_end') return 'pi finished';
  return undefined;
}

function piArgs(prompt: string) {
  const safePrompt = `Read-only task. Do not edit files. Do not deploy. Do not publish. Do not merge. Do not delete. Do not expose secrets.\n\nUser request:\n${prompt}`;
  const model = process.env.PI_MODEL || process.env.PI_CHAT_MODEL;
  return model ? ['--mode', 'json', '--model', model, '--tools', 'read,grep,find,ls', safePrompt] : ['--mode', 'json', '--tools', 'read,grep,find,ls', safePrompt];
}

export async function runPiReadOnlyStream(prompt: string, emit: (event: PiStreamEvent) => void): Promise<PiRun> {
  const cmd = process.env.PI_CMD || 'pi';
  return await new Promise((resolve) => {
    const child = spawn(cmd, piArgs(prompt), {
      cwd: process.env.HOME || process.cwd(),
      env: process.env,
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let text = '';
    const trace: string[] = [];

    const addTrace = (line: string) => {
      trace.push(line);
      emit({ type: 'trace', text: line });
    };

    const consume = () => {
      const lines = stdout.split('\n');
      stdout = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          const summary = summarizeEvent(event);
          if (summary) addTrace(summary);
          if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
            const delta = event.assistantMessageEvent.delta || '';
            text += delta;
            emit({ type: 'text', text: delta });
          }
        } catch {
          addTrace(line.slice(0, 300));
        }
      }
    };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      consume();
      const finalText = `${text}\n\n[Timed out after 120s]${stderr ? `\n${stderr}` : ''}`.trim();
      emit({ type: 'done', text: finalText, trace });
      resolve({ text: finalText, trace });
    }, 120_000);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
      consume();
    });
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      const finalText = `Failed to run pi: ${e.message}`;
      emit({ type: 'error', text: finalText });
      resolve({ text: finalText, trace });
    });
    child.on('close', () => {
      clearTimeout(timer);
      consume();
      const finalText = (text || stderr || 'pi completed with no output').trim();
      emit({ type: 'done', text: finalText, trace });
      resolve({ text: finalText, trace });
    });
  });
}

export async function runPiReadOnly(prompt: string): Promise<PiRun> {
  let latest: PiRun = { text: '', trace: [] };
  latest = await runPiReadOnlyStream(prompt, () => {});
  return latest;
}
