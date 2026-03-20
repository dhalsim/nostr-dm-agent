#!/usr/bin/env bun

import { readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = process.cwd();

const IGNORE = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.turbo',
  'bun.lock',
  '.DS_Store',
]);

const IGNORE_EXT = new Set(['.sqlite', '.sqlite-wal', '.sqlite-shm']);

function shouldIgnore(name: string): boolean {
  if (IGNORE.has(name)) {
    return true;
  }

  const ext = name.slice(name.lastIndexOf('.'));

  return IGNORE_EXT.has(ext);
}

function printTree(
  dir: string,
  prefix: string,
  maxDepth: number,
  depth = 0,
): void {
  if (depth > maxDepth) {
    return;
  }

  const entries = readdirSync(dir)
    .filter((e) => !shouldIgnore(e))
    .sort((a, b) => {
      // dirs first
      const aIsDir = statSync(join(dir, a)).isDirectory();
      const bIsDir = statSync(join(dir, b)).isDirectory();

      if (aIsDir && !bIsDir) {
        return -1;
      }

      if (!aIsDir && bIsDir) {
        return 1;
      }

      return a.localeCompare(b);
    });

  entries.forEach((entry, i) => {
    const isLast = i === entries.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : '│   ';
    const fullPath = join(dir, entry);
    const isDir = statSync(fullPath).isDirectory();

    console.log(`${prefix}${connector}${entry}${isDir ? '/' : ''}`);

    if (isDir) {
      printTree(fullPath, prefix + childPrefix, maxDepth, depth + 1);
    }
  });
}

const maxDepth = parseInt(process.argv[2] ?? '2', 10);
const targetDir = process.argv[3] ?? ROOT;

console.log(`${relative(ROOT, targetDir) || '.'}/`);
printTree(targetDir, '', maxDepth);
