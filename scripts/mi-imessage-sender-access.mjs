// The Photon bridge is the trust boundary for inbound iMessage events. Keep the
// configured sender comparison in one small module so privileged per-turn
// grants can independently require that same explicit identity.
export function senderForIMessage(space, message) {
  return String(message?.sender?.id || space?.phone || message?.space?.phone || '').trim();
}

export function configuredIMessageSenders(env = process.env) {
  return String(env.PHOTON_ALLOWED_USERS || '')
    .split(',')
    .map((sender) => sender.trim())
    .filter(Boolean);
}

export function isConfiguredIMessageSender(space, message, env = process.env) {
  const sender = senderForIMessage(space, message);
  return Boolean(sender) && configuredIMessageSenders(env).includes(sender);
}

// PHOTON_ALLOW_ALL_USERS is an unsafe development override for the transport.
// It never expands private Divernote access: that always needs a named sender.
export function authorizedForDivernote({ space, message, senderAuthorized = false, env = process.env } = {}) {
  return senderAuthorized === true && isConfiguredIMessageSender(space, message, env);
}
