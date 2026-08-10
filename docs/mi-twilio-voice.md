# Mi Twilio voice

Outbound voice is disabled by default. Enable `MI_TWILIO_ENABLED=true` and the reviewed Pi tool with `MI_TWILIO_TOOL_ENABLED=true` only after reviewing the confirmation flow.

Required runtime configuration:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_API_KEY_SID` and `TWILIO_API_KEY_SECRET` (use a restricted Twilio API key; never commit values)
- `TWILIO_AUTH_TOKEN` for `X-Twilio-Signature` validation
- `MI_TWILIO_FROM_NUMBER`
- `MI_TWILIO_WEBHOOK_BASE_URL` (a public `https://` URL in production)

`MI_TWILIO_ALLOWED_COUNTRY_CODES` defaults to `1`; configure it explicitly before calling other countries. Premium/service prefixes remain blocked unless premium use and the exact prefixes are configured. Calls are capped by `MI_TWILIO_MAX_SCRIPT_CHARS` and `MI_TWILIO_MAX_CALL_SECONDS`, and are rate-limited with the `MI_TWILIO_MAX_CALLS_*` variables.

The web API `POST /api/twilio/confirmation` requires `confirm: true` and creates a short-lived, single-use confirmation bound to the normalized number, purpose, script, disclosure, and user. The reviewed `mi_twilio_voice` Pi tool consumes it. State and events persist hashes, call IDs, statuses, timestamps, outcomes, and idempotency data only; phone numbers and scripts are not persisted. TwiML is sent inline to Twilio, recording and transcription are not enabled, and `/api/twilio/status` accepts only valid signed Twilio requests.
