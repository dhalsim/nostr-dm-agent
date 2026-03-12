// ---------------------------------------------------------------------------
// src/cli/local-cli.ts — Readline-based local terminal chat
// ---------------------------------------------------------------------------

import readline from 'readline';

import { C, log } from '../logger';

export type StartLocalCliProps = {
  onMessage: (content: string) => Promise<void>;
  setRedrawPrompt: (fn: (() => void) | null) => void;
};

export function startLocalCli({ onMessage, setRedrawPrompt }: StartLocalCliProps): void {
  console.log(
    `${C.dim}Type a prompt or ${C.reset}${C.white}!help${C.reset}${C.dim} to list commands.${C.reset}\n`,
  );

  const localCli = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.bold}>${C.reset} `,
  });

  setRedrawPrompt(() => localCli.prompt());

  let localQueue = Promise.resolve();

  localCli.on('line', (line) => {
    const input = line.trim();

    if (!input) {
      localCli.prompt();

      return;
    }

    localQueue = localQueue
      .then(() => onMessage(input))
      .catch((err) => log.error(`Local CLI message processing failed: ${String(err)}`))
      .finally(() => localCli.prompt());
  });

  localCli.on('close', () => {
    setRedrawPrompt(null);
    log.ok('Local terminal chat closed. Nostr DM listener continues running.');
  });

  localCli.prompt();
}
