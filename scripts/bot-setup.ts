// ---------------------------------------------------------------------------
// scripts/bot-setup.ts — Interactive bot configuration setup
//
// Usage: bun run bot:setup
//
// Reads current state from DB, shows current values as defaults,
// lets user reconfigure workspace, backend, provider, mode, lint, ready.
// If workspace is "parent", symlinks .opencode/tools, AGENTS.md, opencode.json
// into the parent project root.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, symlinkSync, unlinkSync, lstatSync, readFileSync, writeFileSync } from 'fs';
import { basename, join, resolve } from 'path';
import * as readline from 'readline';

import { dmBotRoot } from '../src/paths';
import { Linting, openCoreDb } from '../src/db';

// Re-use the same state getters/setters as the bot uses
import {
  getWorkspaceTarget,
  setWorkspaceTarget,
  getAgentBackend,
  setAgentBackend,
  getDefaultMode,
  setDefaultMode,
  getLinting,
  setLinting,
  getProviderName,
  setProviderName,
} from '../src/db';
import { setEnvInFile } from '../src/env-file';

const PARENT_ROOT = resolve(join(dmBotRoot, '..'));
const BOT_DIR_NAME = basename(dmBotRoot);

const SYMLINK_TARGETS = [
  {
    label: 'opencode.json',
    src: join(dmBotRoot, 'opencode.json'),
    dest: join(PARENT_ROOT, 'opencode.json'),
  },
  {
    label: '.opencode/tools',
    src: join(dmBotRoot, '.opencode', 'tools'),
    dest: join(PARENT_ROOT, '.opencode', 'tools'),
  },
  {
    label: 'AGENTS.md',
    src: join(dmBotRoot, 'AGENTS.md'),
    dest: join(PARENT_ROOT, 'AGENTS.md'),
  },
];

const PARENT_GITIGNORE_ENTRIES = [
  `${BOT_DIR_NAME}/`,
  'opencode.json',
  '.opencode/',
  'AGENTS.md',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

function askWithDefault<T extends string>(
  question: string,
  current: T,
  options: T[],
): Promise<T> {
  const optionStr = options.map((o) => (o === current ? `[${o}]` : o)).join(' | ');
  return ask(`${question} (${optionStr}): `).then((ans) => {
    if (!ans) return current;
    if (options.includes(ans as T)) return ans as T;
    console.log(`  Invalid option. Keeping: ${current}`);
    return current;
  });
}

function askYesNo(question: string, current: boolean): Promise<boolean> {
  const opts = current ? '[yes] | no' : 'yes | [no]';
  return ask(`${question} (${opts}): `).then((ans) => {
    if (!ans) return current;
    if (ans === 'yes' || ans === 'y') return true;
    if (ans === 'no' || ans === 'n') return false;
    console.log(`  Invalid option. Keeping: ${current ? 'yes' : 'no'}`);
    return current;
  });
}

function isSymlink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function fileOrDirExists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

function updateParentGitignore(): void {
  const gitignorePath = join(PARENT_ROOT, '.gitignore');
  let existing = '';

  if (existsSync(gitignorePath)) {
    existing = readFileSync(gitignorePath, 'utf-8').replace(/\r\n/g, '\n');
  }

  const lines = existing === '' ? [] : existing.split('\n');
  const lineSet = new Set(lines.filter((l) => l !== ''));
  const added: string[] = [];

  for (const entry of PARENT_GITIGNORE_ENTRIES) {
    if (!lineSet.has(entry)) {
      lines.push(entry);
      lineSet.add(entry);
      added.push(entry);
    }
  }

  writeFileSync(gitignorePath, lines.join('\n') + (lines.length > 0 ? '\n' : ''), 'utf-8');

  if (added.length > 0) {
    console.log('  Updated parent .gitignore with:');
    for (const entry of added) {
      console.log(`    - ${entry}`);
    }
  } else {
    console.log('  Parent .gitignore already contains required entries.');
  }
}

function removeParentGitignoreEntries(): void {
  const gitignorePath = join(PARENT_ROOT, '.gitignore');

  if (!existsSync(gitignorePath)) {
    return;
  }

  const existing = readFileSync(gitignorePath, 'utf-8').replace(/\r\n/g, '\n');
  const lines = existing.split('\n');
  const entries = new Set(PARENT_GITIGNORE_ENTRIES);

  const kept: string[] = [];
  const removed: string[] = [];

  for (const line of lines) {
    if (entries.has(line)) {
      if (line !== '') {
        removed.push(line);
      }
    } else {
      kept.push(line);
    }
  }

  writeFileSync(gitignorePath, kept.join('\n') + (kept.length > 0 ? '\n' : ''), 'utf-8');

  if (removed.length > 0) {
    console.log('  Removed entries from parent .gitignore:');
    for (const entry of removed) {
      console.log(`    - ${entry}`);
    }
  }
}

async function removeSymlinks(): Promise<void> {
  for (const target of SYMLINK_TARGETS) {
    if (isSymlink(target.dest)) {
      unlinkSync(target.dest);
      console.log(`  ✓ Removed symlink: ${target.label}`);
    }
  }
}

async function createSymlinks(): Promise<void> {
  console.log(`\nParent project root: ${PARENT_ROOT}\n`);

  for (const target of SYMLINK_TARGETS) {
    if (!existsSync(target.src)) {
      console.log(`  ⚠ Source not found, skipping: ${target.label}`);
      continue;
    }

    if (isSymlink(target.dest)) {
      console.log(`  ✓ Already symlinked: ${target.label}`);
      continue;
    }

    if (fileOrDirExists(target.dest)) {
      const overwrite = await ask(`  "${target.label}" already exists in parent. Replace with symlink? (y/N): `);
      if (overwrite.toLowerCase() !== 'y') {
        console.log(`  Skipped: ${target.label}`);
        continue;
      }
      unlinkSync(target.dest);
    }

    // Ensure parent .opencode dir exists
    if (target.label === '.opencode/tools') {
      const opencodeDir = join(PARENT_ROOT, '.opencode');
      if (!existsSync(opencodeDir)) mkdirSync(opencodeDir, { recursive: true });
    }

    symlinkSync(target.src, target.dest);
    console.log(`  ✓ Symlinked: ${target.label}`);
    console.log(`    ${target.dest} → ${target.src}`);
  }

  updateParentGitignore();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n── Bot Setup ──\n');
  console.log('Press Enter to keep the current value shown in [brackets].\n');

  const db = openCoreDb();

  // Read current state
  const currentWorkspace = getWorkspaceTarget(db) ?? 'parent';
  const currentBackend = getAgentBackend(db) ?? 'opencode-sdk';
  const currentProvider = getProviderName(db) ?? 'local';
  const currentMode = getDefaultMode(db) ?? 'ask';
  const currentLintAuto = getLinting(db) ?? 'off';
  const currentReady = (process.env.READY_ENABLED ?? '1') !== '0';

  // ---------------------------------------------------------------------------
  // 1. Workspace
  // ---------------------------------------------------------------------------

  console.log('── Workspace ──');
  console.log('  parent — agent works on your project (bot is a subfolder)');
  console.log('  bot    — agent works only on the bot itself (standalone)\n');

  const workspace = await askWithDefault(
    'Workspace',
    currentWorkspace as 'parent' | 'bot',
    ['parent', 'bot'],
  );

  setWorkspaceTarget(db, workspace);

  const wasParent = currentWorkspace === 'parent';
  const isParent = workspace === 'parent';

  if (isParent) {
    console.log('\nSetting up symlinks for parent workspace...');
    await createSymlinks();
  } else if (wasParent && !isParent) {
    const remove = await ask(
      '\nWorkspace changed from parent to bot. Remove symlinks from parent project? (y/N): ',
    );
    
    if (remove.toLowerCase() === 'y') {
      await removeSymlinks();

      const removeGitignore = await ask(
        'Also remove dm-bot entries from parent .gitignore? (y/N): ',
      );
      if (removeGitignore.toLowerCase() === 'y') {
        removeParentGitignoreEntries();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Backend
  // ---------------------------------------------------------------------------

  console.log('\n── Backend ──');
  console.log('  opencode-sdk — in-process OpenCode server (recommended)');
  console.log('  opencode     — shells out to opencode CLI');
  console.log('  cursor       — shells out to Cursor agent CLI\n');

  const backend = await askWithDefault(
    'Backend',
    currentBackend as 'opencode-sdk' | 'opencode' | 'cursor',
    ['opencode-sdk', 'opencode', 'cursor'],
  );

  setAgentBackend(db, backend);

  // ---------------------------------------------------------------------------
  // 3. Provider
  // ---------------------------------------------------------------------------

  console.log('\n── Provider ──');
  console.log('  local   — use models local to the backend selected');
  console.log('  routstr — (opencode / opencode-sdk only) routstr models, pay per request with sats via Cashu\n');

  const provider = await askWithDefault(
    'Provider',
    currentProvider as 'local' | 'routstr',
    ['local', 'routstr'],
  );

  setProviderName(db, provider);

  // ---------------------------------------------------------------------------
  // 4. Mode
  // ---------------------------------------------------------------------------

  console.log('\n── Mode ──');
  console.log('  ask   — read-only, agent answers questions');
  console.log('  plan  — proposes changes without applying them');
  console.log('  agent — applies changes, commits, pushes\n');

  const mode = await askWithDefault(
    'Mode',
    currentMode as 'ask' | 'plan' | 'agent',
    ['ask', 'plan', 'agent'],
  );

  setDefaultMode(db, mode);

  // ---------------------------------------------------------------------------
  // 5. Lint auto
  // ---------------------------------------------------------------------------

  console.log('\n── Lint Auto (agent mode only) ──');
  console.log('  off    — never run lint automatically');
  console.log('  on     — run lint after agent responses in agent mode\n');

  const lintAuto = await askWithDefault(
    'Lint auto',
    currentLintAuto as Linting,
    ['off', 'on'],
  );

  setLinting(db, lintAuto);

  // ---------------------------------------------------------------------------
  // 6. Ready notification
  // ---------------------------------------------------------------------------

  console.log('\n── Ready Notification ──');
  console.log('  Send "Agent is ready" DM when the bot starts up.\n');

  const ready = await askYesNo('Send ready notification on startup', currentReady);

  const envPathForReady = join(dmBotRoot, '.env');
  if (ready !== currentReady) {
    setEnvInFile(envPathForReady, 'READY_ENABLED', ready ? '1' : '0');
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  console.log('\n── Configuration saved ──\n');
  console.log(`  Workspace:         ${workspace}`);
  console.log(`  Backend:           ${backend}`);
  console.log(`  Provider:          ${provider}`);
  console.log(`  Mode:              ${mode}`);
  console.log(`  Lint auto:         ${lintAuto}`);
  console.log(`  Ready notification: ${ready ? 'on' : 'off'}`);

  if (isParent) {
    console.log(`\n  Parent root:       ${PARENT_ROOT}`);
    console.log('  Symlinks created for opencode.json, .opencode/tools, AGENTS.md');
  }

  console.log('\n✓ Setup complete. Run `bun run start` to start the bot.\n');

  db.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
