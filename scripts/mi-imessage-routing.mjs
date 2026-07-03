function normalizedMessageText(message) {
  return String(message || '').trim().toLowerCase();
}

function textWithoutUrls(message) {
  return normalizedMessageText(message).replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function imessageExtractUrls(message) {
  return Array.from(String(message || '').matchAll(/https?:\/\/[^\s<>"']+/gi), (match) => match[0].replace(/[).,;!?]+$/g, ''));
}

export function imessageIsBareUrl(message) {
  const text = String(message || '').trim();
  return Boolean(text && /^(?:https?:\/\/\S+\s*)+$/i.test(text));
}

export function imessageLooksLikeQuestion(message) {
  const text = textWithoutUrls(message);
  if (!text) return false;
  if (/[?？]\s*$/.test(String(message || '').trim())) return true;
  return /^(?:can|could|would|will|should|did|do|does|is|are|was|were|have|has|what|why|when|where|who|how)\b/.test(text);
}

export function imessageHasExplicitGoAhead(message) {
  const text = normalizedMessageText(message);
  return /\b(?:go ahead|do it|please do|yes[, ]+do|you can|you do that|take care of it|handle it|start it|go for it)\b/.test(text);
}

export function imessageNormalizeDisplayText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]{2,}/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function imessageLooksLikeConfirmation(message) {
  const text = textWithoutUrls(message);
  return /^(?:yes|yep|yeah|sure|ok(?:ay)?|please do|do it|go ahead|go for it|you do that|handle it|take care of it|start it)[.!\s]*$/.test(text);
}

export function imessageLooksActionable(message) {
  const text = textWithoutUrls(message);
  if (!text || text.startsWith('/')) return false;
  if (imessageLooksLikeQuestion(message) || imessageLooksLikeConfirmation(message)) return false;
  return /\b(?:fix|debug|investigate|inspect|check|verify|implement|update|repair|patch|make|add|create|change|remove|build|set\s*up|install|deploy|wire|hook\s*up|adjust|improve|tighten|route|restart|run|rescore|approve|reject|discard|edit|save|remember|remind|schedule|monitor|look at|look up|show|get|pull)\b/.test(text);
}

function levenshteinDistance(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  const dp = Array.from({ length: left.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= right.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[left.length][right.length];
}

function tokenLooksLikeCandidate(token) {
  const t = String(token || '').replace(/s$/, '');
  if (!t) return false;
  if (/^can(?:did|id)/.test(t)) return true;
  return levenshteinDistance(t, 'candidate') <= 2 || levenshteinDistance(t, 'candidates') <= 3;
}

function tokenLooksLikeDetect(token) {
  const t = String(token || '');
  if (!t) return false;
  return t === 'detect' || levenshteinDistance(t, 'detect') <= 1;
}

export function imessageDetectCandidatesQuery(message) {
  const text = textWithoutUrls(message);
  if (!text) return false;
  if (/\b(?:add|approve|reject|discard|rescore|delete|remove|edit|run|start)\b/.test(text)) return false;
  const tokens = text.match(/[a-z0-9]+/g) || [];
  const hasCandidate = tokens.some(tokenLooksLikeCandidate);
  if (!hasCandidate) return false;
  const hasDetectContext = tokens.some(tokenLooksLikeDetect) || /\b(?:research|pipeline|tactics\s*journal|tacticsjournal)\b/.test(text);
  const hasLookupCue = /\b(?:list|show|get|pull|what|which|any|new|current|active)\b/.test(text);
  return hasDetectContext && hasLookupCue;
}

export function imessageLooksLikePriorWorkStatusQuestion(message) {
  const text = textWithoutUrls(message);
  if (!text || !imessageLooksLikeQuestion(message)) return false;
  return /\b(?:did|have|has|is|was)\b[\s\S]{0,80}\b(?:add(?:ed)?|do(?:ne)?|handle(?:d)?|start(?:ed)?|finish(?:ed)?|complete(?:d)?|work(?:ing)?|check(?:ed)?)\b/.test(text)
    || /\b(?:did you|have you)\b[\s\S]{0,80}\b(?:it|this|that)\b/.test(text)
    || /\bwhy\b[\s\S]{0,80}\bpending\b/.test(text);
}

function entryText(entry) {
  return String(entry?.text || '').trim();
}

function assistantOfferAsPendingWork(text) {
  const normalized = normalizedMessageText(text);
  if (!/\bi can\b[\s\S]{0,160}\bif you want\b/.test(normalized)) return '';
  if (/\b(?:check|pull|get|show|list|look up|look at)\b[\s\S]{0,120}\b(?:current list|list|candidates|research pipeline|pipeline candidates)\b/.test(normalized)) {
    if (/\bresearch pipeline\b|\btactics journal\b|\bcandidates\b/.test(normalized)) return 'Check the current Tactics Journal research pipeline candidates list.';
    return 'Check the current list.';
  }
  return '';
}

function lastPendingDirective(threadMessages = []) {
  let pending = '';
  let pendingUrl = '';
  for (const entry of threadMessages || []) {
    const source = String(entry?.source || '');
    if (entry?.role === 'assistant' && source !== 'imessage-confirm') {
      const offeredWork = assistantOfferAsPendingWork(entryText(entry));
      if (offeredWork) pending = offeredWork;
      else {
        pending = '';
        pendingUrl = '';
      }
      continue;
    }
    if (entry?.role !== 'user' || source !== 'imessage') continue;
    const text = entryText(entry);
    if (!text) continue;
    const urls = imessageExtractUrls(text);
    if (imessageIsBareUrl(text)) {
      if (pending) pendingUrl = urls[0] || text;
      else pendingUrl = urls[0] || text;
      continue;
    }
    if (imessageLooksActionable(text) || imessageHasExplicitGoAhead(text)) {
      pending = text;
      if (urls.length) pendingUrl = urls[0];
    }
  }
  if (!pending) return '';
  if (pendingUrl && !imessageExtractUrls(pending).length) return `${pending}\n\n${pendingUrl}`;
  return pending;
}

function recentBareUrl(threadMessages = []) {
  for (let i = (threadMessages || []).length - 1; i >= 0; i -= 1) {
    const entry = threadMessages[i];
    const source = String(entry?.source || '');
    if (entry?.role === 'assistant' && ['imessage-work-ack', 'mi-worker-result', 'mi-worker-error', 'imessage-status'].includes(source)) return '';
    if (entry?.role !== 'user' || source !== 'imessage') continue;
    const text = entryText(entry);
    if (imessageIsBareUrl(text)) return imessageExtractUrls(text)[0] || text;
    if (text && !imessageLooksLikeConfirmation(text)) return '';
  }
  return '';
}

export function recentPendingImessageWork(threadMessages = []) {
  return lastPendingDirective(threadMessages);
}

export function imessagePriorWorkStatusReply(threadMessages = [], message = '') {
  if (/\bwhy\b[\s\S]{0,80}\bpending\b/i.test(String(message || ''))) {
    return 'Pending means it is saved for review and report consideration. It does not mean the request failed.';
  }
  let ackAt = 0;
  let result = null;
  let errorAt = 0;
  for (const entry of threadMessages || []) {
    if (entry?.role !== 'assistant') continue;
    const ts = Date.parse(entry.ts || '') || 0;
    if (entry.source === 'imessage-work-ack') ackAt = Math.max(ackAt, ts || 1);
    if (entry.source === 'mi-worker-result' && (!result || (ts || 1) >= result.ts)) result = { ts: ts || 1, text: entryText(entry) };
    if (entry.source === 'mi-worker-error') errorAt = Math.max(errorAt, ts || 1);
  }
  if (errorAt && errorAt >= ackAt && errorAt >= (result?.ts || 0)) return 'It hit an error. I’ll need another pass to finish it.';
  if (result && result.ts >= ackAt) return result.text ? `Yes. ${result.text}` : 'Yes, I followed up here with the result.';
  if (ackAt) return 'Not yet, I’m still on it and will follow up here.';
  return '';
}

function imessageClearDirective(message) {
  const text = textWithoutUrls(message);
  if (!text || imessageLooksLikeQuestion(message) || imessageLooksLikeConfirmation(message)) return false;
  if (/\badd\b[\s\S]{0,120}\b(?:detect\s+)?(?:candidate|canidate)s?\b/.test(text)) return true;
  if (/\b(?:check|inspect|look up|look at|get|pull|show)\b[\s\S]{0,120}\b(?:status|logs?|current list|candidate list|candidates|research pipeline)\b/.test(text)) return true;
  return false;
}

export function imessageWorkDecision(message, threadMessages = [], options = {}) {
  const askFirst = Boolean(options.askFirst);
  const actionable = imessageLooksActionable(message);
  const explicitGoAhead = imessageHasExplicitGoAhead(message);
  const question = imessageLooksLikeQuestion(message);
  const pending = recentPendingImessageWork(threadMessages);
  const urls = imessageExtractUrls(message);

  if (imessageDetectCandidatesQuery(message)) {
    return { action: 'fetch', kind: 'detect-candidates', targetMessage: message, reason: 'iMessage detect candidates lookup' };
  }

  if (imessageLooksLikeConfirmation(message)) {
    if (pending) return { action: 'start', targetMessage: pending, reason: 'iMessage confirmation of pending work' };
    return { action: 'chat', reason: 'confirmation without pending work' };
  }

  if (imessageIsBareUrl(message)) {
    if (pending) {
      const targetMessage = imessageExtractUrls(pending).length ? pending : `${pending}\n\n${urls[0] || String(message).trim()}`;
      return { action: 'ask', targetMessage, reason: 'iMessage URL attached to pending work' };
    }
    return { action: 'chat', reason: 'bare url' };
  }

  if (question && !explicitGoAhead) {
    if (actionable) return { action: 'ask', targetMessage: message, reason: 'iMessage question about work' };
    return { action: 'chat', reason: 'question' };
  }

  if (actionable || explicitGoAhead) {
    const orphanUrl = urls.length ? '' : recentBareUrl(threadMessages);
    const targetMessage = orphanUrl ? `${message}\n\n${orphanUrl}` : message;
    if (askFirst && !explicitGoAhead) return { action: 'ask', targetMessage, reason: 'iMessage ask-first' };
    if (explicitGoAhead) return { action: 'start', targetMessage: pending || targetMessage, reason: pending ? 'iMessage explicit go-ahead for pending work' : 'iMessage explicit go-ahead' };
    if (imessageClearDirective(message)) return { action: 'start', targetMessage, reason: 'iMessage clear directive' };
    return { action: 'ask', targetMessage, reason: 'iMessage confirm before work' };
  }

  return { action: 'chat', reason: 'chat' };
}

export function imessageWorkAck() {
  return 'On it. I’ll follow up here.';
}

export function imessageAskFirstReply() {
  return 'Want me to do that now?';
}

export const _test = { normalizedMessageText, textWithoutUrls, recentBareUrl, lastPendingDirective, assistantOfferAsPendingWork, imessageClearDirective, imessageDetectCandidatesQuery };
