const SECRET_PATTERNS = [
    /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_=-]{12,}\b/g,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    /\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]+@/g,
    /\b(?:api[_-]?key|token|secret|password|passwd|pwd|authorization)\b\s*[:=]\s*[^\s,;)}\]]+/gi,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
];
export function redactSecrets(value) {
    if (typeof value === 'string')
        return redactString(value);
    if (Array.isArray(value))
        return value.map((item) => redactSecrets(item));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, isSensitiveKey(key) ? '[REDACTED]' : redactSecrets(item)]));
    }
    return value;
}
function redactString(value) {
    return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, (match) => match.includes('@') && match.includes(':') ? '[REDACTED]@' : '[REDACTED]'), value);
}
function isSensitiveKey(key) {
    return /(?:api[_-]?key|token|secret|password|passwd|pwd|authorization|cookie|session)/i.test(key);
}
