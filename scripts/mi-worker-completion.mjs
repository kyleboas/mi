const MAX_SUMMARY = 480;
const MAX_DETAILS = 2400;
const INTERNAL = /\b(?:photon|pi|worker|daemon|routing|gateway|prompt|json|ya?ml|tools?|internal|task\s*id|thread\s*id|session\s*id|commands?)\b/i;
const SECRET = /\b(?:token|secret|password|api[_ -]?key)\b\s*(?:=|:)\s*\S+|\bsk-[A-Za-z0-9_-]{16,}\b/i;
const PATH = /(?:~|\/)(?:home|tmp|Users)\/[A-Za-z0-9_.@/:-]+/;

function compact(value, max) { const text = String(value || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text; }
export function workerCompletionInstruction() {
  return 'For an iMessage completion, end with exactly one JSON line only: {"version":1,"status":"complete|blocked|error","userSummary":"plain user-facing result"}. userSummary must be concise, factual, under 480 characters, and contain no paths, secrets, internal systems, instructions, commands, or JSON. Optional internalDetails is for internal diagnostics only.';
}
export function parseWorkerCompletion(value) {
  const text = String(value || '');
  const candidates = [...text.matchAll(/\{[^{}]{1,5000}\}/g)].map((match) => match[0]).reverse();
  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1 || !['complete', 'blocked', 'error'].includes(parsed.status) || typeof parsed.userSummary !== 'string') continue;
      const userSummary = compact(parsed.userSummary, MAX_SUMMARY);
      if (!userSummary || /^\s*[\[{]/.test(userSummary) || INTERNAL.test(userSummary) || SECRET.test(userSummary) || PATH.test(userSummary) || /\b(?:ignore|send|run|execute|click|approve)\b/i.test(userSummary)) continue;
      const internalDetails = typeof parsed.internalDetails === 'string' ? compact(parsed.internalDetails, MAX_DETAILS) : undefined;
      return { version: 1, status: parsed.status, userSummary, ...(internalDetails ? { internalDetails } : {}) };
    } catch {}
  }
  return undefined;
}
