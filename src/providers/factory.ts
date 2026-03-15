import type { CoreDb } from '../db';
import type { BotConfig } from '../env';
import type { WalletDb } from '../wallets/db';

import type { ProviderDb } from './db';
import { createLocalProvider } from './local';
import { createRoutstrProvider } from './routstr';
import type { AnyProvider, ProviderName } from './types';

export type CreateProviderProps = {
  name: ProviderName;
  walletDb: WalletDb | null;
  seenDb: CoreDb | null;
  providerDb: ProviderDb | null;
  config: BotConfig;
  routstrBaseUrl?: string;
};

export function createProvider(props: CreateProviderProps): AnyProvider {
  if (props.name === 'local') {
    return createLocalProvider();
  }

  if (props.name === 'routstr') {
    if (!props.walletDb || !props.seenDb || !props.providerDb || !props.routstrBaseUrl) {
      throw new Error('Routstr provider requires walletDb, seenDb, providerDb, and routstrBaseUrl');
    }

    return createRoutstrProvider({
      baseUrl: props.routstrBaseUrl,
      providerDb: props.providerDb,
      seenDb: props.seenDb,
      config: props.config,
    });
  }

  throw new Error(`Unknown provider: ${props.name}`);
}
