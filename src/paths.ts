// ---------------------------------------------------------------------------
// paths.ts — Shared path utilities
// ---------------------------------------------------------------------------
import { join } from 'path';

const srcDir = import.meta.dir;
const dmBotRootDir = join(srcDir, '..');

export const dmBotRoot = dmBotRootDir;
export const SEEN_DB_PATH = join(dmBotRootDir, 'dm-bot.sqlite');
export const RESTART_REQUESTED_PATH = join(dmBotRootDir, 'restart.requested');
