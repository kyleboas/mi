// Pure iMessage v2 routing decision. The web chat server calls
// v2RouteDecision for every inbound message, so this module is the single
// place that decides refusal, confirmation, clarification, and coordinator
// handoff. It performs no I/O and never spawns anything.

import { redactV2Text } from './mi-imessage-v2.mjs';
import { v2LooksLikeActionText } from './mi-web-chat-action-classifier.mjs';

export function v2CanonicalObjective(value) {
  // This is the exact bounded form that can be displayed and stored. Do not
  // slice it: callers must refuse an objective that does not fit a store.
  return redactV2Text(String(value || '')).replace(/\s+/g, ' ').trim();
}

function normalizedMessageText(message) {
  return String(message || '').trim().toLowerCase();
}

export function messageHasLocalWorkTarget(message) {
  const text = normalizedMessageText(message);
  return /\b(?:mi|diver\s+notes|routing|app|ui|notification|notifications|reminder|reminders|calendar|cron|schedule|scheduling|video|videos|watchlist|watch\s+list|videos?\s+to\s+watch|logo|favicon|chat|pwa|site|service|typing|code|file|repo|branch|github|pull\s*request|\bpr\b|test|tests|daemon|systemd|tailscale|detect\s+candidate|detect\s+candidates|candidate|candidates|project|tacticsjournal|research|plus|icon|button|centered|aligned|alignment|background\s*worker|worker)\b/.test(text)
    || /\b(?:code|repo|project)\/[a-z0-9_.-]+|~\/code\/[a-z0-9_.-]+|\/home\/\w+\/(?:code\/)?[a-z0-9_.-]+/.test(text);
}

export function directAdvisorSelections(message) {
  const text = v2CanonicalObjective(message).toLowerCase();
  const skill = /^\/skill:advisor\b/.test(text);
  const asksAll = /\bask\s+(?:the\s+)?advisors?\b|\bseth\s+(?:and|&)\s+(?:alex|hormozi)\b|\b(?:alex|hormozi)\s+(?:and|&)\s+seth\b/.test(text);
  const asksSeth = /\bask\s+seth\b|\bwhat\s+would\s+seth\b/.test(text) || (skill && /\bseth\b/.test(text));
  const asksAlex = /\bask\s+(?:alex|hormozi)\b|\bwhat\s+would\s+(?:alex|hormozi)\b/.test(text) || (skill && /\b(?:alex|hormozi)\b/.test(text));
  if (asksAll || (asksSeth && asksAlex)) return ['Seth', 'Alex'];
  if (asksSeth) return ['Seth'];
  if (asksAlex) return ['Alex'];
  // The advisor skill says a direct invocation without a named person may use
  // its multi-advisor mode when independent lenses help. Use that safe,
  // deterministic mode instead of silently choosing an identity.
  return skill ? ['Seth', 'Alex'] : [];
}

export function v2RiskClassification(message) {
  const objective = v2CanonicalObjective(message);
  const text = objective.toLowerCase();
  if (!text || /^[^\p{L}\p{N}]+$/u.test(text)) return { kind: 'clarify', objective };
  const neverDelegate = /(?:\bdelete\b|\berase\b|\bwipe\b|\bpurge\b|\bdestroy\b|\brm\b|\b(?:remove|clear|drop)\s+(?:all\s+)?(?:(?:[a-z0-9_.-]+)\s+){0,2}(?:data|database|account|project)\b|\bformat\s+(?:the\s+)?(?:disk|drive)\b|\bsecret\b|\btoken\b|\bpassword\b|\bpasscode\b|\bcredential\b|\bauth(?:entication)?\b|\blog\s*in\b|\bbuy\b|\bpurchase\b|\bpay\b|\bspend\b|\btransfer\s+(?:money|funds|cash)|\bwire\s+(?:money|funds))/i.test(text);
  if (neverDelegate) return { kind: 'never-delegate', objective };
  const needsConfirmation = /(?:\bdeploy\b|\bproduction\b|\brelease\b|\bpublish\b|\bannouncement\b|\bmerge\b|\brestart\b|\bsystemctl\b|\bservice\b|\binstall\b|\bemail\b|\bmail\b|\btweet\b|\bpost\b|\bsend\b|\bmessage\b|\b(?:tell|contact|notify|forward)\b|\btransfer\b|\bupload\b|\bshare\b)/i.test(text)
    || (/\b(?:book|reserve|order)\b/i.test(text) && !/\brecommend\s+(?:a\s+)?book\b/i.test(text));
  // Outbound personal messaging verbs name a recipient rather than a noun such
  // as “text file”. Without this, “Text mom happy birthday” skipped the
  // confirmation gate entirely and went straight to a coordinator.
  const contactsSomeone = /\b(?:text|imessage|dm|whatsapp|ping)\s+(?!of\b|in\b|from\b|file\b|files\b|field\b|box\b|editor\b|content\b|contents\b|body\b|string\b)[a-z'’]+\b/i.test(text);
  if (needsConfirmation || contactsSomeone) return { kind: 'confirm', objective, actionClass: 'confirmed-high-impact' };
  return { kind: 'safe', objective };
}

export function v2LooksLikeAction(message) {
  return v2LooksLikeActionText(v2CanonicalObjective(message).toLowerCase());
}

// Static replies are deliberately exact so they cannot absorb a request,
// recipient, target, or confirmation-sensitive payload. Keep this pure: the
// caller still owns pending-confirmation precedence and thread persistence.
export function v2LocalReply(message) {
  const text = v2CanonicalObjective(message).toLowerCase().replace(/[.!?]+$/g, '').trim();
  if (['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening'].includes(text)) return 'Hi. What can I help with?';
  if (['what can you do', 'how can you help', 'what can you help with'].includes(text)) {
    return 'I can answer questions, research, write or edit approved local files, and run guarded technical work. You can explicitly ask Terra, Luna, Seth, or Alex. I need confirmation before consequential actions.';
  }
  return '';
}

export function v2ActionPlan(message, workspace) {
  const objective = v2CanonicalObjective(message);
  const text = objective.toLowerCase();
  const advisorSelections = directAdvisorSelections(objective);
  const asksCoordinator = /\b(?:ask|have)\s+(?:terra|sol|luna|claude)\b/.test(text) || advisorSelections.length > 0;
  const safeRead = /\b(?:read|inspect|check|verify|list|find|research|explain|summarize)\b/.test(text);
  // Reminders and timers are routed for an honest coordinator reply, but they
  // never receive scoped write capability: proactive scheduling remains off.
  const reminderRequest = /\b(?:remind me|set (?:a )?reminder|start (?:a )?timer|schedule (?:a )?reminder)\b/.test(text)
    || /^(?:do that reminder again|remind me again|what time was that reminder|move it to tomorrow|cancel the reminder)\b/.test(text);
  // Writing is available only for a clear local-work request. A broad phrase
  // such as “make dinner” or “create an announcement” must not gain project
  // write tools merely because it contains an old routing verb.
  const imperativeWrite = /^(?:please\s+)?(?:fix|implement|update|repair|patch|make|add|create|change|build|wire|adjust|improve|tighten|complete|reopen|append|replace|set|ensure|save)\b/.test(text);
  const courtesyAction = /^(?:(?:hey|hi|hello|yo|ok|okay)[,\s]+)?(?:please[,\s]+)?(?:can|could|would)\s+you\s+(?:please\s+)?(?:fix|implement|update|repair|patch|make|add|create|change|build|wire|adjust|improve|tighten)\b/.test(text);
  const localAction = (imperativeWrite || courtesyAction) && messageHasLocalWorkTarget(objective);
  const safeWrite = imperativeWrite && messageHasLocalWorkTarget(objective);
  if (!asksCoordinator && !safeRead && !localAction && !reminderRequest) return undefined;
  return { objective, capability: 'coordinator', cwd: workspace.cwd, workspaceRoot: workspace.root, allowWrite: reminderRequest ? false : safeWrite, advisorSelections };
}

export function v2Cancellation(message) {
  return /^\s*(?:cancel(?:\s+(?:it|that|the action))?|never mind|nevermind|don['’]t do it)\s*[.!?]*\s*$/i.test(String(message || ''));
}

export function v2ConfirmationCommand(message) {
  return /^\s*(?:confirm|deny)\s+[a-f0-9]{32}\s*$/i.test(String(message || ''));
}

// The single deterministic routing decision for an inbound v2 message.
// `workspace` is the already-validated scoped workspace, or undefined when no
// approved workspace exists. Pending-confirmation state is handled by the
// caller between the `cancel` and `confirmation-command` classes, which is why
// both appear here in their real evaluation order.
export function v2RouteDecision({ message, workspace, coordinatorObjectiveMaxChars, confirmationObjectiveMaxChars }) {
  if (v2Cancellation(message)) return { kind: 'cancel' };
  if (v2ConfirmationCommand(message)) return { kind: 'confirmation-command' };
  const risk = v2RiskClassification(message);
  // An empty-ish message has nothing to store or act on, so ask instead of
  // handing an empty objective to a coordinator.
  if (risk.kind === 'clarify') return { kind: 'clarify', objective: risk.objective };
  if (risk.kind === 'never-delegate') return { kind: 'never-delegate', objective: risk.objective };
  if (risk.kind === 'confirm') {
    const fits = risk.objective.length > 0
      && risk.objective.length <= coordinatorObjectiveMaxChars
      && risk.objective.length <= confirmationObjectiveMaxChars;
    if (!fits) return { kind: 'confirm-too-long', objective: risk.objective };
    return { kind: 'confirm', objective: risk.objective, actionClass: risk.actionClass };
  }
  const plan = v2ActionPlan(message, workspace || { root: '', cwd: '' });
  if (v2LooksLikeAction(message) && !plan) return { kind: 'clarify', objective: risk.objective };
  const reply = v2LocalReply(message);
  if (reply) return { kind: 'local-reply', objective: risk.objective, reply };
  if (!workspace) return { kind: 'workspace-refused', objective: risk.objective };
  return {
    kind: 'coordinator',
    objective: risk.objective,
    plan: plan || { objective: risk.objective, capability: 'coordinator', workspace, allowWrite: false, advisorSelections: [] },
  };
}
