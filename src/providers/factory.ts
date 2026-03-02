import type { SeenDb } from '../db';
import type { WalletDb } from '../wallets/db';

import { createLocalProvider } from './local';
import { createRoutstrProvider } from './routstr';
import type { AnyProvider, ProviderName } from './types';

export type CreateProviderProps = {
  name: ProviderName;
  walletDb: WalletDb | null;
  seenDb: SeenDb | null;
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
