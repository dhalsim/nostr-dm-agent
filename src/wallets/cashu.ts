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
import { InsufficientFundsError, type WalletInfo } from './types';

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

  async getBalanceByMint(): Promise<WalletInfo> {
    const proofs = loadProofs(this.db, this.mintUrl);

    log.info(`Total balance on mint ${this.mintUrl}: ${totalBalance(proofs)} sats`);

    const byKeyset: Record<string, { count: number; sats: number }> = {};
    for (const p of proofs) {
      if (!byKeyset[p.id]) {
        byKeyset[p.id] = { count: 0, sats: 0 };
      }

      byKeyset[p.id].count++;
      byKeyset[p.id].sats += p.amount;
    }

    for (const [id, info] of Object.entries(byKeyset)) {
      log.info(`  keyset ${id}: ${info.count} proof(s) = ${info.sats} sats`);
    }

    return { balanceSats: totalBalance(proofs) };
  }

  async sendToken(amountSats: number): Promise<string> {
    const proofs = loadProofs(this.db, this.mintUrl);
    const balance = totalBalance(proofs);

    if (balance < amountSats) {
      throw new InsufficientFundsError(balance, amountSats);
    }

    log.info(`Sending ${amountSats} sats from ${balance} sats balance`);

    const wallet = await this.getWallet();

    const { keep, send } = await wallet.ops.send(amountSats, proofs).asDeterministic().run();

    wallet.on.countersReserved((op: OperationCounters) => {
      log.info(`countersReserved event fired:`);

      persistCounter(this.db, op);
    });

    deleteProofs(this.db, proofs);

    if (keep.length > 0) {
      saveProofs(this.db, this.mintUrl, keep);
    }

    const encoded = getEncodedToken({
      mint: this.mintUrl,
      proofs: send,
      unit: 'sat',
    });

    return encoded;
  }

  decodeToken(encodedToken: string): string {
    const decoded = getDecodedToken(encodedToken);

    if (!decoded) {
      throw new Error('Invalid token: no token data');
    }

    return `Decoded token: ${JSON.stringify(decoded, null, 2)}`;
  }

  async receiveToken(encodedToken: string): Promise<{ receivedSats: number }> {
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

    const newProofs = await wallet.ops.receive(encodedToken).asDeterministic().run();

    wallet.on.countersReserved((op: OperationCounters) => {
      log.info(`countersReserved event fired:`);

      persistCounter(this.db, op);
    });

    saveProofs(this.db, this.mintUrl, newProofs);

    return { receivedSats: totalBalance(newProofs) };
  }
}
