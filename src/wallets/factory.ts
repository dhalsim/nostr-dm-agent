import { createCashuWallet } from './cashu';
import type { AnyWallet } from './types';

export function createWallet(props: { mnemonic: string; mintUrl: string }): AnyWallet {
  return createCashuWallet(props);
}
