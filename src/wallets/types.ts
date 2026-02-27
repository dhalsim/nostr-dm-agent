export type WalletInfo = {
  balanceSats: number;
};

export type AnyWallet = {
  name: string;
  getInfo(): Promise<WalletInfo>;
  sendToken(amountSats: number): Promise<string>;
  receiveToken(encodedToken: string): Promise<{ receivedSats: number }>;
};

export class InsufficientFundsError extends Error {
  constructor(
    public available: number,
    public required: number,
  ) {
    super(`Insufficient funds: have ${available} sats, need ${required} sats`);
  }
}
