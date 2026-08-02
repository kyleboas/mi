// Pure safety classification for the focused Mi iMessage runtime.
// This module performs no I/O and never starts a process.

import { redactV2Text } from './mi-imessage-v2.mjs';
import { v2LooksLikeActionText } from './mi-web-chat-action-classifier.mjs';

export function v2CanonicalObjective(value) {
  return redactV2Text(String(value || '')).replace(/\s+/g, ' ').trim();
}

function normalizedMessageText(message) {
  return v2CanonicalObjective(message).toLowerCase();
}

export function messageHasLocalWorkTarget(message) {
  const text = normalizedMessageText(message);
  return /\b(?:mi|diver\s+notes|routing|app|ui|notification|reminder|calendar|cron|schedule|video|watchlist|logo|favicon|chat|pwa|site|service|typing|code|file|repo|branch|github|pull\s*request|\bpr\b|test|daemon|systemd|tailscale|candidate|project|research|worker)\b/.test(text)
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
  return skill ? ['Seth', 'Alex'] : [];
}

export function v2RiskClassification(message) {
  const objective = v2CanonicalObjective(message);
  const text = objective.toLowerCase();
  const rawText = String(message || '').toLowerCase();
  if (!text || /^[^\p{L}\p{N}]+$/u.test(text)) return { kind: 'clarify', objective };
  const prohibited = /(?:\bdelete\b|\berase\b|\bwipe\b|\bpurge\b|\bdestroy\b|\brm\b|\b(?:remove|clear|drop)\s+(?:all\s+)?(?:(?:[a-z0-9_.-]+)\s+){0,2}(?:data|database|account|project)\b|\bformat\s+(?:the\s+)?(?:disk|drive)\b|\bsecret\b|\btoken\b|\bpassword\b|\bpasscode\b|\bcredential\b|\bauth(?:entication)?\b|\blog\s*in\b|\bbuy\b|\bpurchase\b|\bpay\b|\bspend\b|\btransfer\s+(?:money|funds|cash)|\bwire\s+(?:money|funds))/i.test(text)
    || /(?:secret|token|password|credential|api[_-]?key)\s*=/i.test(rawText);
  if (prohibited) return { kind: 'never-delegate', objective };
  const needsConfirmation = /(?:\bdeploy\b|\bproduction\b|\brelease\b|\bpublish\b|\bannouncement\b|\bmerge\b|\brestart\b|\bsystemctl\b|\bservice\b|\binstall\b|\bemail\b|\bmail\b|\btweet\b|\bpost\b|\bsend\b|\bmessage\b|\b(?:tell|contact|notify|forward)\b|\btransfer\b|\bupload\b|\bshare\b)/i.test(text)
    || (/\b(?:book|reserve|order)\b/i.test(text) && !/\brecommend\s+(?:a\s+)?book\b/i.test(text));
  const directContactRequest = /^(?:(?:please\s+)?|(?:(?:can|could|would)\s+you\s+(?:please\s+)?))(?:text|imessage|dm|whatsapp|ping)\s+(?!of\b|in\b|from\b|file\b|files\b|field\b|box\b|editor\b|content\b|contents\b|body\b|string\b)[a-z'’]+\b/i.test(text);
  const externalReplyRequest = /\breply\s+(?:to\s+(?!this\b|that\b|it\b|the\s+(?:message|thread|conversation|reply)\b)(?:[a-z'’]+|@[a-z0-9_.-]+|\+?\d[\d\s().-]*)\b|(?:by|via|over|on|in)\s+(?:email|mail|text|imessage|dm|whatsapp|slack|discord|telegram|x|twitter)\b)/i.test(text);
  if (needsConfirmation || directContactRequest || externalReplyRequest) return { kind: 'confirm', objective, actionClass: 'confirmed-high-impact' };
  return { kind: 'safe', objective };
}

export function v2LooksLikeAction(message) {
  return v2LooksLikeActionText(v2CanonicalObjective(message).toLowerCase());
}

export function v2ActionPlan(message, workspace) {
  const objective = v2CanonicalObjective(message);
  if (!objective) return undefined;
  const text = objective.toLowerCase();
  const advisorSelections = directAdvisorSelections(objective);
  const localWrite = /^(?:please\s+)?(?:fix|implement|update|repair|patch|make|add|create|change|build|wire|adjust|improve|tighten|complete|reopen|append|replace|set|ensure|save)\b/.test(text)
    && messageHasLocalWorkTarget(objective);
  const workspaceInfo = workspace || { root: '', cwd: '' };
  return {
    objective,
    capability: 'coordinator',
    cwd: workspaceInfo.cwd,
    workspaceRoot: workspaceInfo.root,
    allowWrite: localWrite,
    advisorSelections,
  };
}

export function v2Cancellation(message) {
  return /^\s*(?:cancel(?:\s+(?:it|that|the action))?|never mind|nevermind|don['’]t do it)\s*[.!?]*\s*$/i.test(String(message || ''));
}

export function v2ConfirmationCommand(message) {
  return /^\s*(?:confirm|deny)\s+[a-f0-9]{32}\s*$/i.test(String(message || ''));
}

export function v2RouteDecision({ message, workspace, coordinatorObjectiveMaxChars = 4000, confirmationObjectiveMaxChars = 240 }) {
  if (v2Cancellation(message)) return { kind: 'cancel' };
  if (v2ConfirmationCommand(message)) return { kind: 'confirmation-command' };
  const risk = v2RiskClassification(message);
  if (risk.kind === 'clarify') return { kind: 'clarify', objective: risk.objective };
  if (risk.kind === 'never-delegate') return { kind: 'never-delegate', objective: risk.objective };
  if (risk.kind === 'confirm') {
    const fits = risk.objective.length > 0 && risk.objective.length <= coordinatorObjectiveMaxChars && risk.objective.length <= confirmationObjectiveMaxChars;
    return fits ? { kind: 'confirm', objective: risk.objective, actionClass: risk.actionClass } : { kind: 'confirm-too-long', objective: risk.objective };
  }
  const objective = risk.objective;
  if (objective.length > coordinatorObjectiveMaxChars) return { kind: 'objective-too-long', objective };
  if (!workspace) return { kind: 'workspace-refused', objective };
  return {
    kind: 'coordinator',
    objective,
    plan: v2ActionPlan(objective, workspace),
  };
}
