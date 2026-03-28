// ---------------------------------------------------------------------------
// src/cli/local-cli.ts — Readline-based local terminal chat
// ---------------------------------------------------------------------------

import readline from 'readline';

import { C, log } from '../logger';

export let redrawPrompt: (() => void) | null = null;

export type StartLocalCliProps = {
  onMessage: (content: string) => Promise<void>;
  /**
   * When a plugin interactive session is waiting on `promptFn`, the next line must resolve
   * that prompt **without** waiting behind `onMessage`'s queue — otherwise the CLI deadlocks
   * (the handler is blocked inside `await promptFn()` until the next line is processed).
   */
  resolvePendingPromptFirst?: (line: string) => Promise<boolean>;
};

export function startLocalCli({
  onMessage,
  resolvePendingPromptFirst,
}: StartLocalCliProps): void {
  console.log(
    `${C.dim}Type a prompt or ${C.reset}${C.white}!help${C.reset}${C.dim} to list commands.${C.reset}\n`,
  );

  const localCli = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.bold}>${C.reset} `,
  });

  redrawPrompt = () => localCli.prompt();

  let localQueue = Promise.resolve();

  localCli.on('line', (line) => {
    void (async () => {
      if (resolvePendingPromptFirst) {
        try {
          const handled = await resolvePendingPromptFirst(line);

          if (handled) {
            localCli.prompt();

            return;
          }
        } catch (err) {
          log.error(`Local CLI pending-prompt handler failed: ${String(err)}`);

          localCli.prompt();

          return;
        }
      }

      const input = line.trim();

      if (!input) {
        localCli.prompt();

        return;
      }

      localQueue = localQueue
        .then(() => onMessage(input))
        .catch((err) =>
          log.error(`Local CLI message processing failed: ${String(err)}`),
        )
        .finally(() => localCli.prompt());
    })();
  });

  localCli.on('close', () => {
    redrawPrompt = null;
    log.ok('Local terminal chat closed. Nostr DM listener continues running.');
  });

  localCli.prompt();
}
