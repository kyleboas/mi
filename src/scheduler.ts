import { readFile } from 'node:fs/promises';
import { parseAssistantMarkdown, type TriggerConfig } from './assistant.js';
import { notify } from './notify.js';
import { runAssistant } from './runner.js';

function intervalToMs(value: string): number | undefined {
  const match = value.trim().match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 's') return amount * 1000;
  if (unit === 'm') return amount * 60_000;
  if (unit === 'h') return amount * 60 * 60_000;
  if (unit === 'd') return amount * 24 * 60 * 60_000;
  return undefined;
}

export function scheduledTriggers(triggers: TriggerConfig[]) {
  return triggers.filter((trigger): trigger is { every: string } => 'every' in trigger);
}

export async function runScheduledAssistant(name: string) {
  const markdown = await readFile(`assistants/${name}.md`, 'utf8');
  const assistant = parseAssistantMarkdown(markdown, `assistants/${name}.md`);
  const schedules = scheduledTriggers(assistant.triggers);
  if (schedules.length === 0) return { skipped: true, reason: 'assistant has no scheduled triggers' };

  const result = await runAssistant({ name: assistant.name, trigger: 'timer' });
  if (result.status !== 'ok') {
    await notify(`Mi ${assistant.name} needs attention`, `${result.status}: ${result.summary}`);
  }
  return { skipped: false, assistant: assistant.name, schedules, result };
}

export async function explainSchedule(name: string) {
  const markdown = await readFile(`assistants/${name}.md`, 'utf8');
  const assistant = parseAssistantMarkdown(markdown, `assistants/${name}.md`);
  return scheduledTriggers(assistant.triggers).map((trigger) => ({ every: trigger.every, ms: intervalToMs(trigger.every) }));
}
