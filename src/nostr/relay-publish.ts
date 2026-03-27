// ---------------------------------------------------------------------------
// src/nostr/relay-publish.ts — per-relay publish with nostr-tools Relay (logging-friendly)
// ---------------------------------------------------------------------------

import type { VerifiedEvent } from 'nostr-tools';
import { Relay } from 'nostr-tools';

export type PublishError = {
  type: 'error';
  message: string;
  code?: string;
  data?: unknown;
};

export type PublishSuccess = {
  type: 'success';
  result: string;
};

export type RelaySuccess = {
  relay: string;
  result: PublishSuccess;
};

export type RelayFailure = {
  relay: string;
  result: PublishError;
};

export type RelayResult = RelaySuccess | RelayFailure;

export function isRelaySuccess(r: RelayResult): r is RelaySuccess {
  return r.result.type === 'success';
}

export function isRelayFailure(r: RelayResult): r is RelayFailure {
  return r.result.type === 'error';
}

/**
 * Connect to each relay, publish the signed event, collect per-relay success or error.
 */
export async function publishSignedEventToRelays(
  relays: string[],
  signed: VerifiedEvent,
): Promise<RelayResult[]> {
  return Promise.all(
    relays.map(async (relay) => {
      const r = new Relay(relay);

      await r.connect();

      try {
        const result = await r.publish(signed);

        return {
          relay,
          result: {
            type: 'success' as const,
            result,
          },
        };
      } catch (err) {
        return {
          relay,
          result: {
            type: 'error' as const,
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    }),
  );
}

export function summarizeRelayOutcomes(outcomes: RelayResult[]): {
  accepted: RelaySuccess[];
  rejected: { relay: string; error: string }[];
} {
  const accepted = outcomes.filter(isRelaySuccess);

  const rejected = outcomes.filter(isRelayFailure).map((o) => ({
    relay: o.relay,
    error: o.result.message,
  }));

  return { accepted, rejected };
}
