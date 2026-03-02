// ---------------------------------------------------------------------------
// logger.ts — Debug/log helpers and ANSI colors
// ---------------------------------------------------------------------------

export function assertUnreachable(value: never): never {
  throw new Error(`Unreachable: ${String(value)}`);
}

export const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  white: '\x1b[97m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const;

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

const DEBUG = process.env.DEBUG === '1';
const LOG_ENABLED = (process.env.LOG ?? '1') !== '0';

export function debug(msg: string, ...args: unknown[]): void {
  if (DEBUG) {
    console.log('[debug]', msg, ...args);
  }
}

export const log = {
  info: (msg: string) => {
    if (LOG_ENABLED) {
      console.log(`  [info]  ${msg}`);
    }
  },
  ok: (msg: string) => {
    if (LOG_ENABLED) {
      console.log(`  [✓]     ${msg}`);
    }
  },
  warn: (msg: string) => {
    if (LOG_ENABLED) {
      console.log(`  [warn]  ${msg}`);
    }
  },
  error: (msg: string) => {
    if (LOG_ENABLED) {
      console.error(`  [✗]     ${msg}`);
    }
  },
  sep: () => {
    if (LOG_ENABLED) {
      console.log('─'.repeat(60));
    }
  },
  title: (msg: string) => {
    log.sep();

    if (LOG_ENABLED) {
      console.log(`  ${msg}`);
    }

    log.sep();
  },
};
