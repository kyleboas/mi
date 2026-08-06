// Pure, current-turn-only access decision for the private Diver Notes vault.
// It deliberately has no thread/history input: a vague follow-up cannot inherit
// an old vault grant.
const noun = /\b(?:task|tasks|project|projects|note|notes)\b/i;
const unsupportedDocument = /\b(?:document|documents|details?|manual|evidence|proofs?|interviews?|lifecycle|raw\s+api)\b/i;
const readVerb = /\b(?:list|read|show|find|search|check|review|what(?:'s| is)?|which)\b/i;
const writeVerb = /^(?:(?:please\s+)?(?:add|create|update|change|complete|reopen|append|replace|set|make|ensure|save)|(?:please\s+)?(?:can|could|would)\s+you\s+(?:please\s+)?(?:add|create|update|change|complete|reopen|append|replace|set|make|ensure|save))\b/i;
// Accept the old spaced spelling as input, but never emit it: the product name
// is Divernote.
const explicitVault = /\bdiver\s*notes?\b/i;
const firstPersonVault = /\b(?:my|mine)\s+(?:tasks?|projects?|notes?|documents?)\b/i;
const contextOnly = /^(?:please\s+)?(?:add|create|update|change|complete|reopen|append|replace|set)\s+(?:it|that|this|those|them)\b[.!?]*$/i;
const explicitContextOnly = /\bdiver\s*notes?\b.*\b(?:add|create|update|change|complete|reopen|append|replace|set)\s+(?:it|that|this|those|them)\b/i;
const supportedSurface = 'tasks, notes, projects, project tasks, and adding, completing, or reopening project subtasks';
const unsupportedReply = `Divernote currently supports ${supportedSurface}; listing subtasks, documents, details, manuals, interviews, lifecycle operations, and raw API access are unavailable.`;
const ambiguousReply = `Which supported Divernote item do you mean: a task, note, project, project task, or subtask?`;

export function diverNotesPreflight({ message, plan, gate = 'allow' } = {}) {
  const text = String(message || '').trim();
  if (gate !== 'allow') return { access: 'none' };
  const mentionsVault = explicitVault.test(text) || firstPersonVault.test(text);
  if (/\bshell\b/i.test(text) && mentionsVault) return { access: 'none' };
  if (unsupportedDocument.test(text) && mentionsVault) return { access: 'none', clarify: true, unsupported: true, reply: unsupportedReply };
  if (/\bsubtasks?\b/i.test(text) && (readVerb.test(text) || /\bsee\b/i.test(text)) && !writeVerb.test(text) && !/\bcheck\s+off\b/i.test(text) && !/\bback\s+on\s+(?:the\s+)?list\b/i.test(text)) return { access: 'none', clarify: true, unsupported: true, reply: unsupportedReply };
  if ((contextOnly.test(text) && !mentionsVault) || explicitContextOnly.test(text)) return { access: 'none', clarify: true, reply: ambiguousReply };
  const target = explicitVault.test(text) || (firstPersonVault.test(text) && noun.test(text));
  if (!target) return { access: 'none' };
  if (writeVerb.test(text)) return plan?.allowWrite === true ? { access: 'write' } : { access: 'read' };
  if (readVerb.test(text)) return { access: 'read' };
  return { access: 'none', clarify: true, reply: ambiguousReply };
}

export function diverNotesIntent(options = {}) {
  const { reply: _reply, unsupported: _unsupported, ...intent } = diverNotesPreflight(options);
  return intent;
}

export const DIVER_NOTES_UNSUPPORTED_REPLY = unsupportedReply;
export const DIVER_NOTES_AMBIGUOUS_REPLY = ambiguousReply;
