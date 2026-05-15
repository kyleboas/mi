import 'dotenv/config';
import { explainSchedule, runScheduledAssistant } from '../src/scheduler.js';

const command = process.argv[2] || 'run';
const assistant = process.argv[3] || 'production';

if (command === 'run') {
  console.log(JSON.stringify(await runScheduledAssistant(assistant), null, 2));
} else if (command === 'explain') {
  console.log(JSON.stringify(await explainSchedule(assistant), null, 2));
} else {
  throw new Error(`unknown scheduled command: ${command}`);
}
