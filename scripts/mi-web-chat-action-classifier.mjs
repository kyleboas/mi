// Shared iMessage v2 action classifier. It lives in its own module so the
// behavior can be tested directly instead of by matching server source text.

// A bare imperative is action-looking on its own: “fix it” must still reach the
// clarification path rather than a chat reply.
const imperativeAction = /^(?:please\s+)?(?:fix|debug|investigate|inspect|check|verify|implement|update|repair|patch|make|add|create|change|remove|build|set\s*up|wire|adjust|improve|tighten|save|remember|remind|schedule|start|stop|run|handle|do|clean|move|copy|rename|configure)\b/i;

// A courtesy request only counts when it *begins* the message and names
// something to act on. An unanchored alternation made “What can you do” match
// the embedded “can you do”, which turned a capability question into a canned
// clarification instead of a coordinator answer.
const courtesyAction = /^(?:(?:hey|hi|hello|yo|ok|okay)[,\s]+)?(?:please[,\s]+)?(?:can|could|would)\s+you\s+(?:please\s+)?(?:fix|implement|update|repair|patch|make|add|create|change|build|handle|do|clean|move|copy|rename|configure)\b\s+\S/i;

// A leading verb followed by a pronoun subject is a question about Mi, not an
// imperative: “Do you have access to my calendar?” must reach a real answer
// instead of the canned clarification. Courtesy requests (“can you fix …”) are
// the one question form that is genuinely an action, so they are excluded.
const questionSubject = /^(?:please\s+)?[a-z]+\s+(?:you|i|we|they|he|she)\b/i;

// `text` must already be the canonical (redacted, whitespace-collapsed)
// objective; casing does not matter.
export function v2LooksLikeActionText(text) {
  const value = String(text || '').trim();
  if (!value || value.toLowerCase().startsWith('/skill:')) return false;
  if (courtesyAction.test(value)) return true;
  if (questionSubject.test(value)) return false;
  return imperativeAction.test(value);
}
