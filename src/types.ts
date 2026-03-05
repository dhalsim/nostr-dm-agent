const MSATS_TAG = Symbol('Msats');
const SATS_TAG = Symbol('Sats');

export interface Msats {
  readonly [MSATS_TAG]: true;
  readonly _v: number;
}

export interface Sats {
  readonly [SATS_TAG]: true;
  readonly _v: number;
}

export function msats(n: number): Msats {
  return { _v: n } as Msats;
}

export function sats(n: number): Sats {
  return { _v: n } as Sats;
}

function formatWithUnderscores(n: number): string {
  const str = Math.floor(n).toString();

  return str.replace(/\B(?=(\d{3})+(?!\d))/g, '_');
}

export function msatsToSats(m: Msats): Sats {
  return sats(Math.floor(m._v / 1000));
}

export function satsToMsats(s: Sats): Msats {
  return msats(s._v * 1000);
}

export function formatMsats(m: Msats): string {
  return `${formatWithUnderscores(m._v)} msats`;
}

export function formatSats(s: Sats): string {
  return `${formatWithUnderscores(s._v)} sats`;
}

export function msatsRaw(m: Msats): number {
  return m._v;
}

export function satsRaw(s: Sats): number {
  return s._v;
}

export type Brand<T, B> = T & { readonly __brand: B };
