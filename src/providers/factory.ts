import type { Database } from 'bun:sqlite';

import type { AnyWallet } from '../wallets/types';

import { createLocalProvider } from './local';
import { createRoutstrProvider } from './routstr';
import type { AnyProvider, ProviderName } from './types';

export type CreateProviderProps = {
  name: ProviderName;
  wallet?: AnyWallet;
  walletDb?: Database;
  routstrBaseUrl?: string;
};

export function createProvider(props: CreateProviderProps): AnyProvider {
  if (props.name === 'local') {
    return createLocalProvider();
  }

  if (props.name === 'routstr') {
    if (!props.wallet || !props.walletDb || !props.routstrBaseUrl) {
      throw new Error('Routstr provider requires wallet, walletDb, and routstrBaseUrl');
    }

    return createRoutstrProvider({
      wallet: props.wallet,
      baseUrl: props.routstrBaseUrl,
      walletDb: props.walletDb,
    });
  }

  throw new Error(`Unknown provider: ${props.name}`);
}
