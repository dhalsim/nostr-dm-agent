import type { EventTemplate, NostrEvent } from 'nostr-tools';
import { nip19 } from 'nostr-tools';
import type { SimplePool } from 'nostr-tools/pool';
import { z } from 'zod';

import { getOutputString } from '@src/backends/types';
import type { RunAgentFn, SendReplyFn } from '@src/core/plugin';

import type { CoreDb } from '../db';
import { PROMPT_SESSION_EXIT } from '../prompt-session';

import { bunkerSignEvent } from './bunker';
import {
  getConnection,
  listConnections,
  type ConnectionRow,
} from './connections';

type PromptFn = (message: string) => Promise<string>;

const EditableEventTemplateSchema = z.object({
  kind: z.number().int(),
  created_at: z.number().int(),
  content: z.string(),
  tags: z.array(z.array(z.string())),
});

export type SignWithBunkerInteractiveProps = {
  db: CoreDb;
  pool: SimplePool;
  eventTemplate: EventTemplate;
  sendReply: SendReplyFn;
  promptFn: PromptFn;
  runAgent: RunAgentFn | null;
  bunkerName?: string;
};

function formatPubkey(hex: string): string {
  try {
    return `${nip19.npubEncode(hex)} (${hex})`;
  } catch {
    return hex;
  }
}

async function askPrompt(promptFn: PromptFn, message: string): Promise<string> {
  const answer = (await promptFn(message)).trim();

  if (answer === PROMPT_SESSION_EXIT) {
    throw new Error('Bunker signing cancelled.');
  }

  return answer;
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();

  if (!trimmed.startsWith('```')) {
    return trimmed;
  }

  const withoutStart = trimmed.replace(/^```(?:json)?\s*/i, '');

  return withoutStart.replace(/\s*```$/, '').trim();
}

function formatEventTemplate(eventTemplate: EventTemplate): string {
  return `\`\`\`json
${JSON.stringify(eventTemplate, null, 2)}
\`\`\``;
}

async function editEventTemplateWithAi(props: {
  eventTemplate: EventTemplate;
  instruction: string;
  runAgent: RunAgentFn;
}): Promise<EventTemplate> {
  const { eventTemplate, instruction, runAgent } = props;

  const result =
    await runAgent(`You are editing a Nostr unsigned event template JSON.

Current event template:
${JSON.stringify(eventTemplate, null, 2)}

User instruction:
${instruction}

Return only valid JSON for the full edited event template. Do not use markdown fences. Preserve the existing kind unless the user explicitly asked to change it.`);

  const raw = stripCodeFence(getOutputString(result));

  const parsed = EditableEventTemplateSchema.parse({
    ...eventTemplate,
    ...JSON.parse(raw),
  });

  return parsed;
}

function formatConnectionChoice(
  connection: ConnectionRow,
  index: number,
): string {
  return `${index + 1}. ${connection.name}
User pubkey: ${formatPubkey(connection.data.userPubkey)}
Remote signer: ${formatPubkey(connection.data.remoteSignerPubkey)}
Relays: ${connection.data.relays.join(', ')}`;
}

async function pickConnection(props: {
  connections: ConnectionRow[];
  sendReply: SendReplyFn;
  promptFn: PromptFn;
}): Promise<ConnectionRow> {
  const { connections, sendReply, promptFn } = props;

  await sendReply(
    `Choose bunker signer:\n\n${connections
      .map((connection, index) => formatConnectionChoice(connection, index))
      .join('\n\n')}`,
  );

  while (true) {
    const answer = await askPrompt(
      promptFn,
      'Select bunker number or type quit.',
    );

    const lowered = answer.toLowerCase();

    if (lowered === 'q' || lowered === 'quit') {
      throw new Error('Bunker signing cancelled.');
    }

    const selected = Number(answer);

    if (
      Number.isInteger(selected) &&
      selected >= 1 &&
      selected <= connections.length
    ) {
      return connections[selected - 1];
    }

    await sendReply('Invalid selection.');
  }
}

export async function signWithBunkerInteractive({
  db,
  pool,
  eventTemplate,
  sendReply,
  promptFn,
  runAgent,
  bunkerName,
}: SignWithBunkerInteractiveProps): Promise<NostrEvent> {
  const selectedByName = bunkerName ? getConnection(db, bunkerName) : null;

  if (bunkerName && !selectedByName) {
    throw new Error(`No bunker connection named "${bunkerName}".`);
  }

  const availableConnections = selectedByName
    ? [selectedByName]
    : listConnections(db);

  if (availableConnections.length === 0) {
    await sendReply(
      'No bunker connections found. Add one first with `!bunker add <name> <address>`.',
    );

    throw new Error('No bunker connections available.');
  }

  let currentTemplate = eventTemplate;

  while (true) {
    await sendReply(
      `Plugin requested bunker signing for this event template:\n\n${formatEventTemplate(currentTemplate)}`,
    );

    const answer = await askPrompt(
      promptFn,
      'Continue, edit with AI, or quit? [c/e <prompt>/q]',
    );

    const lowered = answer.toLowerCase();

    if (lowered === 'c' || lowered === 'continue') {
      break;
    }

    if (lowered === 'q' || lowered === 'quit') {
      throw new Error('Bunker signing cancelled.');
    }

    if (lowered.startsWith('e ') || lowered === 'e') {
      if (!runAgent) {
        await sendReply(
          'AI editing requires an agent backend for this session.',
        );

        continue;
      }

      const instruction = answer.slice(1).trim();

      if (!instruction) {
        await sendReply('Provide an edit instruction after `e`.');

        continue;
      }

      currentTemplate = await editEventTemplateWithAi({
        eventTemplate: currentTemplate,
        instruction,
        runAgent,
      });

      continue;
    }

    await sendReply('Invalid choice.');
  }

  const selected = selectedByName
    ? selectedByName
    : await pickConnection({
        connections: availableConnections,
        sendReply,
        promptFn,
      });

  if (selectedByName) {
    await sendReply(
      `Using bunker signer:\n\n${formatConnectionChoice(selectedByName, 0)}`,
    );
  }

  return bunkerSignEvent(pool, selected.data, currentTemplate);
}
