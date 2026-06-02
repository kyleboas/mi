import 'dotenv/config';
import { runMiCheck } from '../src/proactive.js';

const job = process.argv[2] || 'all';
const aliases: Record<string, string[]> = {
  all: ['all'],
  'daily-brief': ['dailyBrief'],
  brief: ['dailyBrief'],
  'approval-reminders': ['pendingApprovals'],
  approvals: ['pendingApprovals'],
  'pending-approvals': ['pendingApprovals'],
  'failed-crons': ['failedCrons'],
  crons: ['failedCrons'],
};

const checkIds = aliases[job] || [job];
console.log(JSON.stringify(await runMiCheck({ checkIds }), null, 2));
