// ---------------------------------------------------------------------------
// src/utils.ts — Small shared helpers
// ---------------------------------------------------------------------------

export function assertUnreachable(value: never): never {
  throw new Error(`Unreachable: ${String(value)}`);
}
