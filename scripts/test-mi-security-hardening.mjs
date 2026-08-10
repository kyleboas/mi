import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const cronSource = await readFile(new URL('../src/crons.ts', import.meta.url), 'utf8');
const daemonSource = await readFile(new URL('../pi/extensions/mi-daemon.mjs', import.meta.url), 'utf8');
const flueSource = await readFile(new URL('../src/flue.ts', import.meta.url), 'utf8');
const capabilitySource = await readFile(new URL('../src/capabilities.ts', import.meta.url), 'utf8');
const guardSource = await readFile(new URL('../pi/extensions/mi-capability-guard.ts', import.meta.url), 'utf8');
const webChatSource = await readFile(new URL('../scripts/mi-web-chat.mjs', import.meta.url), 'utf8');
const imessageRuntimeSource = await readFile(new URL('../scripts/mi-imessage-runtime.mjs', import.meta.url), 'utf8');
const notifySource = await readFile(new URL('../src/notify.ts', import.meta.url), 'utf8');

assert.doesNotMatch(cronSource, /shell:\s*true/, 'Mi cron must not execute commands through a shell');
assert.match(cronSource, /spawn\(file, args, \{ cwd: cron\.cwd \|\| HOME, shell: false, env: cronEnv\(\) \}\)/, 'Mi cron must spawn parsed executable/args with shell disabled and reduced env');
assert.match(cronSource, /redactSecrets\(record\)/, 'Mi cron logs must redact secrets');
assert.match(cronSource, /writeFile\(CRONS_PATH,[\s\S]*mode: 0o600/, 'Mi cron state file must be written private');
assert.match(cronSource, /chmod\(dirname\(CRONS_PATH\), 0o700\)/, 'Mi cron state directory must be private');

assert.match(daemonSource, /chmod\(SOCKET_PATH, 0o600\)/, 'Mi daemon socket must be owner-only');
assert.match(daemonSource, /open\(LOCK_PATH, "wx", 0o600\)/, 'Mi daemon lock file must be private');
assert.match(daemonSource, /chmod\(dirname\(SOCKET_PATH\), 0o700\)/, 'Mi daemon runtime directory must be private');

assert.match(flueSource, /const flueConfigured = Boolean\(process\.env\.FLUE_URL \|\| process\.env\.FLUE_CHAT_URL \|\| process\.env\.FLUE_CMD/, 'Mi chat must not try slow Flue CLI unless Flue is configured');
assert.match(flueSource, /return runPiChat\(message,[\s\S]*'Flue not configured'/, 'Mi chat must default to the pi fallback when Flue is unconfigured');
assert.match(flueSource, /function directChatReply\(message: string\)/, 'Mi chat must fast-path simple conversational replies');
assert.match(flueSource, /const chatTools = process\.env\.MI_CHAT_TOOLS \|\| 'read,grep,find,ls'/, 'Mi chat fallback must deny raw bash by default');
assert.match(flueSource, /MI_CAPABILITY_GRANTS_FILE: grantsFile/, 'Mi chat fallback must pass an explicit capability grant file');
assert.match(flueSource, /env: reducedPiEnv\(/, 'Mi chat fallback must use a reduced env, not process.env');
assert.match(flueSource, /'--no-extensions', '--extension', guard/, 'Mi chat fallback must disable ambient extensions and load only the capability guard');
assert.doesNotMatch(flueSource, /env: process\.env/, 'Mi chat fallback must not pass full process.env');

assert.match(webChatSource, /MI_WEB_MAINTENANCE/, 'Web chat requires explicit maintenance mode');
assert.match(imessageRuntimeSource, /MI_CAPABILITY_GRANTS_FILE: grants/, 'iMessage runtime passes explicit capability grants');
assert.match(imessageRuntimeSource, /reducedEnvironment\(/, 'iMessage runtime uses a reduced Pi environment');
assert.match(notifySource, /MI_PUSHOVER_NOTIFY \|\| process\.env\.MI_PUSHOVER_FALLBACK/, 'Pushover notifications must be opt-in only');
assert.match(notifySource, /if \(!pushoverEnabled\(\)\) return \{ skipped: true \}/, 'Pushover must skip before reading credentials unless explicitly enabled');
assert.match(webChatSource, /if \(!pushoverEnabled\(\)\) return false/, 'Mi web chat Pushover must be opt-in only');

assert.match(daemonSource, /const SAFE_PI_ENV_KEYS = \[/, 'Mi daemon defines a reduced Pi worker env allowlist');
assert.match(daemonSource, /--no-context-files", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--tools", tools/, 'Mi daemon worker RPC disables ambient context/resources and uses explicit tools');
assert.match(daemonSource, /"--extension", MI_CAPABILITY_GUARD/, 'Mi daemon worker RPC loads the Mi capability guard explicitly');
assert.match(daemonSource, /env: reducedPiEnv\(\{ \.\.\.env, MI_CAPABILITY_PROFILE: profile, MI_CAPABILITY_GRANTS_FILE: grantsFile, MI_CAPABILITY_AUDIT_FILE: auditFile,/, 'Mi daemon worker RPC uses reduced env plus capability metadata');
assert.match(daemonSource, /"read,grep,find,ls"/, 'Mi daemon worker RPC defaults to read/search tools without bash');
assert.match(daemonSource, /worker-write-scoped is only allowed inside the configured Mi workspace/, 'Mi daemon only allows scoped writable workers under its configured workspace');
assert.match(daemonSource, /const MI_WORKFLOWS_DIR = realpathSync\(/, 'Mi daemon canonicalizes its one configured workspace root');
assert.match(daemonSource, /const absolute = realpathSync\(cwd\)/, 'Mi daemon rejects symlinked scoped-write cwd escapes');
assert.match(daemonSource, /request\.type === "worker_state"[\s\S]*activeWorkerCount/, 'Mi daemon exposes only content-free worker counts for restart safety');
assert.match(daemonSource, /requested === "worker-write-scoped"[\s\S]*return "worker-read"/, 'Mi daemon falls back to read-only worker capability unless a scoped write profile is explicitly allowed');
assert.match(daemonSource, /capabilityProfile\S*[\s\S]*worker-write-scoped[\s\S]*MI_CAPABILITY_PROFILE/, 'Mi daemon can preserve an explicit scoped worker capability profile');
assert.doesNotMatch(daemonSource, /env: \{ \.\.\.process\.env, \.\.\.env \}/, 'Mi daemon worker RPC must not pass full process.env');
assert.match(capabilitySource, /'chat-read'[\s\S]*allowBash: false/, 'Capability profiles must deny bash for chat-read');
assert.match(capabilitySource, /SAFE_ENV_ALLOWLIST/, 'Capability model must include env allowlisting');
assert.match(guardSource, /toolName === 'bash'[\s\S]*right: 'execute'[\s\S]*resource: 'tool:\/\/bash'/, 'Capability guard must treat bash as an explicit execute capability');
assert.match(guardSource, /ALLOWED_MI_EXTENSION_TOOLS[\s\S]*mi_orchestrator_delegate/, 'Capability guard must use an explicit reviewed extension-tool allowlist');
assert.match(guardSource, /MI_CAPABILITY_PROFILE === 'mi-main-orchestrator'[\s\S]*MI_TWILIO_TOOL_ENABLED === '1'[\s\S]*MI_TWILIO_ENABLED === '1'/, 'Twilio tool requires the narrow orchestrator profile and both enablement gates');
assert.match(daemonSource, /MI_TWILIO_EXTENSION[\s\S]*--extension/, 'daemon explicitly loads the reviewed Twilio extension');
assert.match(webChatSource, /twilioConfirmationAuthorized\(req\)[\s\S]*x-mi-confirmation-csrf/, 'Twilio confirmation route authenticates and enforces CSRF');
assert.match(webChatSource, /userId: auth\.userId/, 'Twilio confirmations bind ownership to authenticated identity');
assert.match(guardSource, /unreviewed extension tool is denied/, 'Capability guard must deny unknown extension tools by default');
assert.match(guardSource, /global orchestrator controls are not available to Mi/, 'Capability guard must deny unscoped global orchestrator controls');
assert.match(daemonSource, /profile === "advisor-read"[\s\S]*--skill", advisorRoot/, 'advisor workers load only the reviewed skill explicitly after disabling discovery');
assert.match(daemonSource, /trustedAdvisorSkillRoot\(\)[\s\S]*rights: \["read"\]/, 'advisor skill grants are resolved and read-only');
assert.match(guardSource, /isTrustedAdvisorReadGrant[\s\S]*profile === 'advisor-read'/, 'guard makes the narrow trusted advisor read exception explicitly');
assert.match(guardSource, /PROTECTED_PATH_NAMES[\s\S]*credentials[\s\S]*config/, 'Capability guard must exclude credential, configuration, and state paths');
assert.match(imessageRuntimeSource, /MI_IMESSAGE_WORKSPACE_CWD/, 'iMessage runtime uses the durable workspace-specific setting');
assert.match(webChatSource, /url\.pathname === '\/api\/worker-state'[\s\S]*activeCoordinatorCount/, 'web chat exposes only content-free worker counts for maintenance');
assert.match(guardSource, /return \{ block: true, reason: decision\.reason \}/, 'Capability guard must block denied tool calls');
assert.match(guardSource, /appendFileSync\(auditPath/, 'Capability guard must audit allow/deny decisions');

console.log('Mi security hardening checks passed.');
