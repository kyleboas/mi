import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { createTwilioVoiceBackend } from '../../dist/src/twilio-voice.js';

const MAX_SCRIPT_CHARS = 1200;
const inputSchema = Type.Object({
  confirmationId: Type.String({ pattern: '^[a-f0-9]{32}$', maxLength: 32 }),
  idempotencyKey: Type.String({ pattern: '^[A-Za-z0-9._:-]+$', maxLength: 160 }),
  to: Type.String({ maxLength: 40 }),
  purpose: Type.String({ maxLength: 240 }),
  script: Type.String({ maxLength: MAX_SCRIPT_CHARS }),
  disclosure: Type.String({ maxLength: 240, description: 'Must explicitly identify the caller as an AI assistant.' }),
  userId: Type.Optional(Type.String({ maxLength: 120, pattern: '^[A-Za-z0-9._:-]+$' })),
}, { additionalProperties: false });

export default function miTwilio(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'mi_twilio_voice',
    label: 'Twilio voice call',
    description: 'Initiate one approved outbound Twilio call. Requires a final, unexpired, single-use confirmation bound to every call detail; never records or transcribes.',
    parameters: inputSchema,
    async execute(_toolCallId, params) {
      if (process.env.MI_CAPABILITY_PROFILE !== 'mi-main-orchestrator' || process.env.MI_TWILIO_TOOL_ENABLED !== '1' || process.env.MI_TWILIO_ENABLED !== '1') {
        return { content: [{ type: 'text', text: 'Twilio voice is not enabled for this capability profile.' }], details: { failed: true } };
      }
      try {
        const result = await createTwilioVoiceBackend().initiate(params as any);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      } catch (error) {
        return { content: [{ type: 'text', text: error instanceof Error ? error.message : 'Twilio voice call was not started.' }], details: { failed: true } };
      }
    },
  });
}
