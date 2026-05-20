import 'dotenv/config';
import { notify } from '../src/notify.js';
import { runFlueProactive } from '../src/proactive.js';
import { logEvent, readApprovals, readRecentEvents } from '../src/state.js';
import { appendThreadMessage } from '../src/threads.js';

async function assistantHealth() {
  const host = process.env.HOST || '127.0.0.1';
  const port = process.env.PORT || '8787';
  try {
    const res = await fetch(`http://${host}:${port}/health`);
    return { reachable: res.ok, status: res.status, body: await res.json().catch(() => null) };
  } catch (error) {
    return { reachable: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function approvalReminders() {
  const pending = (await readApprovals()).filter((a) => a.status === 'pending');
  const result = await runFlueProactive('approval-reminders', { pending });
  await logEvent('proactive.approval-reminders', result);
  const data = result.result;
  if (result.ok && data?.should_notify) {
    const message = data.message || `${pending.length} approvals need review.`;
    await appendThreadMessage('main', 'assistant', message, { unread: true, source: 'approval-reminders' });
    await notify(data.title || 'Mi approval needed', message);
  }
  return result;
}

async function healthCheck() {
  const health = await assistantHealth();
  const result = await runFlueProactive('health-check', { health });
  await logEvent('proactive.health-check', result);
  const data = result.result;
  if (result.ok && data?.should_notify) {
    const message = data.message || 'Mi health needs attention.';
    await appendThreadMessage('main', 'assistant', message, { unread: true, source: 'health-check' });
    await notify(data.title || 'Mi health', message);
  }
  return result;
}

async function dailyBrief() {
  const context = {
    health: await assistantHealth(),
    pendingApprovals: (await readApprovals()).filter((a) => a.status === 'pending').slice(0, 10),
    recentEvents: await readRecentEvents(25),
  };
  const result = await runFlueProactive('brief', { focus: process.env.BRIEF_FOCUS, context });
  await logEvent('proactive.daily-brief', result);
  const data = result.result;
  if (result.ok && data?.summary) {
    await appendThreadMessage('main', 'assistant', data.summary, { unread: true, source: 'daily-brief' });
    await notify('Daily Mi brief', data.summary.slice(0, 900));
  }
  return result;
}

const job = process.argv[2] || 'all';
const jobs: Record<string, () => Promise<unknown>> = {
  'approval-reminders': approvalReminders,
  'health-check': healthCheck,
  'daily-brief': dailyBrief,
};

if (job === 'all') {
  const results: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(jobs)) results[name] = await fn();
  console.log(JSON.stringify(results, null, 2));
} else if (jobs[job]) {
  console.log(JSON.stringify(await jobs[job](), null, 2));
} else {
  console.error(`Unknown proactive job: ${job}`);
  process.exit(1);
}
