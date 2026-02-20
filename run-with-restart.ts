#!/usr/bin/env bun
/**
 * Runs the bot and restarts it only when restart.requested is touched.
 * Use this when the agent may edit the bot's code: touch restart.requested to restart (no restart on every save).
 */

import { existsSync, unlinkSync, watch } from 'fs';
import { join } from 'path';

import { spawn } from 'bun';

const DM_BOT_DIR = import.meta.dir ?? process.cwd();
const RESTART_FILE = join(DM_BOT_DIR, 'restart.requested');
const INDEX_TS = join(DM_BOT_DIR, 'index.ts');

let child: ReturnType<typeof spawn>;
let restartRequested = false;

function runBot(): ReturnType<typeof spawn> {
  return spawn({
    cmd: ['bun', 'run', INDEX_TS],
    cwd: DM_BOT_DIR,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env,
  });
}

function start(): void {
  child = runBot();

  child.exited.then((code) => {
    if (restartRequested) {
      restartRequested = false;
      console.log('\n[run-with-restart] Restarting bot...\n');
      start();
    } else if (code !== 0 && code !== null && code !== 130) {
      console.error(`[run-with-restart] Bot exited with code ${code}, respawning...`);
      start();
    }
  });
}

start();

watch(DM_BOT_DIR, (_, filename) => {
  if (filename === 'restart.requested' && existsSync(RESTART_FILE)) {
    restartRequested = true;
    try {
      unlinkSync(RESTART_FILE);
    } catch {
      // Ignore if file was already removed.
    }

    child.kill();
  }
});
