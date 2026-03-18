import type { OperationCounters } from '@cashu/cashu-ts';
import { getDecodedToken, getEncodedToken, Wallet } from '@cashu/cashu-ts';
import * as bip39 from '@scure/bip39';

import { debug, log } from '../logger';

import type { WalletDb } from './db';
import {
  loadProofs,
  saveProofs,
  deleteProofs,
  totalBalance,
  openWalletDb,
  loadCounters,
  persistCounter,
} from './db';
import { InsufficientFundsError } from './types';

export function decodeToken(encodedToken: string): string {
  const decoded = getDecodedToken(encodedToken);

  if (!decoded) {
    throw new Error('Invalid token: no token data');
  }

  return `Decoded token: ${JSON.stringify(decoded, null, 2)}`;
}

export type CreateCashuWalletProps = {
  mnemonic: string;
  mintUrl: string;
};

export class CashuWallet {
  readonly mnemonic: string;
  readonly mintUrl: string;
  readonly db: WalletDb;
  readonly seed: Uint8Array;

  constructor({ mnemonic, mintUrl }: CreateCashuWalletProps) {
    this.mnemonic = mnemonic;
    this.mintUrl = mintUrl;
    this.db = openWalletDb(mnemonic);
    this.seed = bip39.mnemonicToSeedSync(mnemonic);
  }

  async getWallet(): Promise<Wallet> {
    const counters = loadCounters(this.db);

    const wallet = new Wallet(this.mintUrl, {
      unit: 'sat',
      bip39seed: this.seed,
      counterInit: counters,
    });

    await wallet.loadMint();

    return wallet;
  }

  async sendToken(amountSats: number): Promise<{ token: string; fee: number }> {
    const proofs = loadProofs(this.db, this.mintUrl);
    const balance = totalBalance(proofs);

    if (balance < amountSats) {
      throw new InsufficientFundsError(balance, amountSats);
    }

    log.info(`Sending ${amountSats} sats from ${balance} sats balance`);

    const wallet = await this.getWallet();

    wallet.on.countersReserved((op: OperationCounters) => {
      log.info(`countersReserved event fired:`);

      persistCounter(this.db, op);
    });

    const { keep, send } = await wallet.ops
      .send(amountSats, proofs)
      .asDeterministic()
      .run();

    log.info(`keep: ${keep.length}, send: ${send.length}`);

    log.info(
      `keep total: ${totalBalance(keep)} sats, send total: ${totalBalance(send)} sats`,
    );

    deleteProofs(this.db, proofs);

    if (keep.length > 0) {
      saveProofs(this.db, this.mintUrl, keep);
    }

    const encoded = getEncodedToken({
      mint: this.mintUrl,
      proofs: send,
      unit: 'sat',
    });

    return { token: encoded, fee: totalBalance(send) - amountSats };
  }

  async receiveToken(
    encodedToken: string,
  ): Promise<{ actuallyReceived: number; fee: number }> {
    const decoded = getDecodedToken(encodedToken);

    if (!decoded) {
      throw new Error('Invalid token: no token data');
    }

    if (decoded.mint !== this.mintUrl) {
      debug('Invalid token: mint URL mismatch', decoded.mint, this.mintUrl);

      throw new Error('Invalid token: mint URL mismatch');
    }

    if (decoded.unit !== 'sat') {
      throw new Error('Invalid token: unit is not sat');
    }

    if (decoded.proofs.length === 0) {
      throw new Error('Invalid token: no proofs');
    }

    const wallet = await this.getWallet();

    wallet.on.countersReserved((op: OperationCounters) => {
      log.info(`countersReserved event fired:`);

      persistCounter(this.db, op);
    });

    const wouldReceive = totalBalance(decoded.proofs);

    const newProofs = await wallet.ops
      .receive(encodedToken)
      .asDeterministic()
      .run();

    const actuallyReceived = totalBalance(newProofs);

    log.info(`newProofs: ${newProofs.length}`);

    saveProofs(this.db, this.mintUrl, newProofs);

    return { actuallyReceived, fee: wouldReceive - actuallyReceived };
  }
}
