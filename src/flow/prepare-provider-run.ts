// ---------------------------------------------------------------------------
// src/flow/prepare-provider-run.ts — Prepare provider before agent run
// ---------------------------------------------------------------------------

import {
  NoRoutstrSessionError,
  ZeroRoutstrBalanceError,
} from '../providers/routstr';
import type { AnyProvider } from '../providers/types';
import { InsufficientFundsError } from '../wallets/types';

export type PrepareProviderRunProps = {
  provider: AnyProvider;
  budgetSats: number;
};

export async function prepareProviderRun({
  provider,
  budgetSats,
}: PrepareProviderRunProps): Promise<string | null> {
  try {
    await provider.prepareRun({ budgetSats });

    return null;
  } catch (e) {
    if (
      e instanceof NoRoutstrSessionError ||
      e instanceof ZeroRoutstrBalanceError
    ) {
      return e.message;
    }

    if (e instanceof InsufficientFundsError) {
      return `Wallet balance too low. Have ${e.available} sats, need ${e.required} sats. Top up with: !wallet receive <cashuXXX>`;
    }

    throw e;
  }
}
