# Mi Twilio voice

Outbound voice is disabled by default. Enable `MI_TWILIO_ENABLED=true` and the reviewed Pi tool with `MI_TWILIO_TOOL_ENABLED=true` only after reviewing the confirmation flow.

Required runtime configuration:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_API_KEY_SID` and `TWILIO_API_KEY_SECRET` (use a restricted Twilio API key; never commit values)
- `TWILIO_AUTH_TOKEN` for `X-Twilio-Signature` validation
- `MI_TWILIO_FROM_NUMBER`
- `MI_TWILIO_WEBHOOK_BASE_URL` (an explicit public `https://` URL in production; malformed, credentialed, private, and loopback hosts are rejected)
- `MI_TWILIO_CONFIRMATION_TOKEN` and `MI_TWILIO_CONFIRMATION_USER_ID` for the authenticated web confirmation route
- `MI_WEB_ORIGIN` and `MI_WEB_CSRF_TOKEN` for same-origin confirmation requests

`MI_TWILIO_ALLOWED_COUNTRY_CODES` defaults to `1`; configure it explicitly before calling other countries. Mandatory premium/service protections cannot be removed by configuration; custom prohibited prefixes may only be allowed with explicit premium settings. Calls are capped by `MI_TWILIO_MAX_SCRIPT_CHARS` and `MI_TWILIO_MAX_CALL_SECONDS`, and are rate-limited with the `MI_TWILIO_MAX_CALLS_*` variables.

In development, callback URLs may be HTTPS or HTTP on loopback only. Production requires HTTPS with a public hostname. The confirmation route requires `Authorization: Bearer ...`, a matching `Origin`, `X-Mi-Confirmation-CSRF`, and a fresh `X-Mi-Confirmation-Nonce`; the nonce rejects replayed HTTP requests. A lost Twilio response is recoverable by retrying the exact same call details with the same idempotency key, which lets Twilio reconcile the original request.

The web API `POST /api/twilio/confirmation` requires authenticated same-origin access, CSRF protection, a fresh request nonce, and `confirm: true`; it creates a short-lived, single-use confirmation bound to the normalized number, purpose, script, disclosure, and authenticated user. The reviewed `mi_twilio_voice` Pi tool consumes it. State and events persist hashes, call IDs, statuses, timestamps, outcomes, and idempotency data only; phone numbers and scripts are not persisted. TwiML is sent inline to Twilio, recording and transcription are not enabled, and `/api/twilio/status` accepts only valid signed Twilio requests.
