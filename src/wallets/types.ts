export type WalletInfo = {
  balanceSats: number;
};

export class InsufficientFundsError extends Error {
  constructor(
    public available: number,
    public required: number,
  ) {
    super(`Insufficient funds: have ${available} sats, need ${required} sats`);
  }
}
