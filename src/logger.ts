// ---------------------------------------------------------------------------
// logger.ts — Debug/log helpers and ANSI colors
// ---------------------------------------------------------------------------

export const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  greenBright: '\x1b[92m',
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
let INFO_ENABLED = (process.env.INFO_ENABLED ?? '1') !== '0';

export function setInfoLogsEnabled(enabled: boolean): void {
  INFO_ENABLED = enabled;
}

export function getInfoLogsEnabled(): boolean {
  return INFO_ENABLED;
}

export function debug(msg: string, ...args: unknown[]): void {
  if (DEBUG) {
    console.log('[debug]', msg, ...args);
  }
}

export async function debugAsync(fn: () => Promise<string>, ...args: unknown[]): Promise<void> {
  if (DEBUG) {
    const result = await fn();
    debug(result, ...args);
  }
}

export const log = {
  info: (msg: string) => {
    if (LOG_ENABLED && INFO_ENABLED) {
      console.log(`  [info]  ${msg}`);
    }
  },
  ok: (msg: string) => {
    if (LOG_ENABLED) {
      console.log(`  ${C.greenBright}[✓]${C.reset}     ${msg}`);
    }
  },
  warn: (msg: string) => {
    if (LOG_ENABLED) {
      console.log(`  ${C.magenta}[warn]  ${msg}${C.reset}`);
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
