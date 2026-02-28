import type { Database } from 'bun:sqlite';

import { createLocalProvider } from './local';
import { createRoutstrProvider } from './routstr';
import type { AnyProvider, ProviderName } from './types';

export type CreateProviderProps = {
  name: ProviderName;
  walletDb?: Database;
  seenDb?: Database;
  routstrBaseUrl?: string;
};

export function createProvider(props: CreateProviderProps): AnyProvider {
  if (props.name === 'local') {
    return createLocalProvider();
  }

  if (props.name === 'routstr') {
    if (!props.walletDb || !props.seenDb || !props.routstrBaseUrl) {
      throw new Error('Routstr provider requires walletDb, seenDb, and routstrBaseUrl');
    }

    return createRoutstrProvider({
      baseUrl: props.routstrBaseUrl,
      walletDb: props.walletDb,
      seenDb: props.seenDb,
    });
  }

  throw new Error(`Unknown provider: ${props.name}`);
}
