#!/usr/bin/env node
// Pi Agents uses the current Mi Agents board directly. Its only different
// dependency is the independent local Pi RPC-session manager selected by env.
process.env.PI_AGENTS_MODE = '1';
const args = process.argv.slice(2);
const launchBoard = args.length === 0 || args[0] === 'tui';
if (launchBoard) process.argv = [...process.argv.slice(0, 2), 'agents'];
else if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
  console.log(`Pi Agents\n\nRun \`pi-agents\` to open the session board.\n\nIn the board:\n  /new <name> <prompt>       start a writable Pi session\n  /readonly <name> <prompt>  start a read-only Pi session\n  Enter                       send a follow-up to the selected session\n  Esc                         stop the selected running session\n\nOnly one writable Pi Agent may run in a checkout. Use worktrees for parallel writes.`);
} else {
  console.error('Pi Agents starts from its board. Run `pi-agents`, then use /new <name> <prompt>.');
  process.exitCode = 1;
}
if (launchBoard) await import('./cli.js');
