import type { Database } from 'bun:sqlite';

import { log } from '../logger';
import { logSpend } from '../wallet-db';
import type { AnyWallet } from '../wallets/types';
import { InsufficientFundsError } from '../wallets/types';

import type { AnyProvider, ProviderEnv, PrepareRunOptions, FinalizeRunOptions } from './types';

export type CreateRoutstrProviderProps = {
  wallet: AnyWallet;
  baseUrl: string;
  walletDb: Database;
};

export function createRoutstrProvider(props: CreateRoutstrProviderProps): AnyProvider {
  return {
    name: 'routstr',

    async prepareRun(opts: PrepareRunOptions): Promise<ProviderEnv> {
      const budgetSats = opts.budgetSats ?? 2000;
      const { balanceSats } = await props.wallet.getInfo();

      if (balanceSats < budgetSats) {
        throw new InsufficientFundsError(balanceSats, budgetSats);
      }

      const token = await props.wallet.sendToken(budgetSats);

      return {
        ROUTSTR_TOKEN: token,
        ROUTSTR_BUDGET: String(budgetSats),
        ROUTSTR_API_KEY: token,
      };
    },

    async finalizeRun(env: ProviderEnv, opts: FinalizeRunOptions): Promise<void> {
      const token = env.ROUTSTR_TOKEN;
      const budgetSats = Number(env.ROUTSTR_BUDGET);
      let refundSats = 0;

      try {
        const res = await fetch(`${props.baseUrl}/balance/refund`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });

        if (res.status === 402) {
          log('Routstr: token fully consumed, no change to recover');
        } else if (res.ok) {
          const data = await res.json();

          const refundToken: string | undefined = data.token ?? data.cashu_token ?? data.cashu;

          if (refundToken) {
            const { receivedSats } = await props.wallet.receiveToken(refundToken);
            refundSats = receivedSats;
            log(`Routstr: recovered ${refundSats} sats change`);
          }
        } else {
          log(`Routstr: refund returned HTTP ${res.status}`);
        }
      } catch (e) {
        log(`Routstr: refund failed — ${e}. Unspent sats may be lost.`);
      }

      const spentSats = Math.max(0, budgetSats - refundSats);

      logSpend(
        props.walletDb,
        'routstr',
        budgetSats,
        refundSats,
        spentSats,
        opts.model,
        opts.sessionId,
        opts.promptPrefix,
      );
    },

    async getStatus(): Promise<string> {
      const { balanceSats } = await props.wallet.getInfo();

      return `routstr | wallet: ${balanceSats} sats | base: ${props.baseUrl}`;
    },
  };
}
