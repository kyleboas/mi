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
  return /\b(?:mi|diver\s*notes?|routing|apps?|ui|notifications?|reminders?|calendars?|crons?|schedules?|videos?|watchlists?|logos?|favicons?|chats?|pwa|sites?|services?|typing|code|files?|repos?|branches?|github|pull\s*requests?|\bprs?\b|tests?|daemons?|systemd|tailscale|candidates?|projects?|research|workers?)\b/.test(text)
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
  const adviceQuestion = /^(?:how|what|why|when|where|which)\b|^(?:should|can|could|would)\s+(?:i|we)\b/i.test(text);
  const destructiveAction = /^(?:(?:please\s+)?|(?:can|could|would)\s+you\s+(?:please\s+)?|i\s+want\s+you\s+to\s+)(?:delete|erase|wipe|purge|destroy|rm|format)\b/i.test(text)
    || /\brm\s+-rf\b/i.test(text)
    || /(?:&&|;)\s*(?:delete|erase|wipe|purge|destroy|rm|format)\b/i.test(text)
    || /\b(?:remove|clear|drop)\s+(?:all\s+)?(?:(?:[a-z0-9_.-]+)\s+){0,2}(?:data|database|account|project)\b/i.test(text);
  const credentialAction = !adviceQuestion && (/\b(?:show|tell|give|read|reveal|find|print|copy|send|share|expose|dump)\b[\s\S]{0,80}\b(?:secret|token|password|passcode|credential|api[ _-]?key)s?\b/i.test(text)
    || /\b(?:use|change|reset|rotate|update|set|create|delete|remove|replace)\s+(?:me\s+)?(?:(?:my|the|a|an)\s+)?(?:secret|token|password|passcode|credential|api[ _-]?key)s?\b/i.test(text)
    || /^(?:(?:please\s+)?|(?:can|could|would)\s+you\s+(?:please\s+)?)(?:log\s*in|login|sign\s*in|authenticate)\b/i.test(text)
    || /(?:secret|token|password|credential|api[_-]?key)\s*=/i.test(rawText));
  const financialAction = !adviceQuestion && /^(?:(?:please\s+)?|(?:can|could|would)\s+you\s+(?:please\s+)?|i\s+want\s+you\s+to\s+)(?:buy|purchase|pay|spend|transfer|wire)\b/i.test(text);
  const privateInstructionExtraction = /\b(?:show|reveal|print|repeat|quote|dump|expose|give|tell)\b[\s\S]{0,80}\b(?:system\s+prompt|hidden\s+instructions?|internal\s+(?:files?|paths?|identifiers?|details?))\b/i.test(text);
  if (destructiveAction || credentialAction || financialAction || privateInstructionExtraction) return { kind: 'never-delegate', objective };
  const highImpactVerb = /\b(?:deploy|release|publish|merge|restart|systemctl|install|email|mail|tweet|post|send|message|contact|notify|forward|transfer|upload|share|approve|deny|reject|accept|ban|block|suspend|mute|hide|moderate)\b/i.test(text);
  const scheduledAction = /\b(?:book|reserve|order|schedule)\b/i.test(text)
    || /\b(?:set\s+up|create|add)\s+(?:(?:a|an|the)\s+)?(?:meeting|call|appointment|calendar\s+event|reminder)\b/i.test(text)
    || /\bremind\s+me\b/i.test(text);
  const moderationRemoval = /\bremove\s+(?:(?:the|a|an|this|that)\s+)?(?:post|comment|member|user|thread|application)\b/i.test(text);
  const needsConfirmation = !adviceQuestion && (highImpactVerb || scheduledAction || moderationRemoval);
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
    && (messageHasLocalWorkTarget(objective) || /\b(?:a|an|the)?\s*(?:task|note|project|project\s+task|subtask)s?\b/i.test(text));
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
