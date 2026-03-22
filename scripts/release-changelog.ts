#!/usr/bin/env bun
/**
 * Writes CHANGELOG.md from annotated/lightweight semver tags (vX.Y.Z).
 * Each section lists commits since the previous tag (or full history for the first tag).
 */

import { join } from 'path';

function resolveRepoRoot(): string {
  const r = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (!r.success) {
    return join(import.meta.dir, '..');
  }

  return r.stdout.toString().trimEnd();
}

const REPO_ROOT = resolveRepoRoot();
const DEFAULT_OUT = join(REPO_ROOT, 'CHANGELOG.md');

const SEMVER_TAG = /^v\d+\.\d+\.\d+$/;

function git(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = Bun.spawnSync(['git', ...args], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  return {
    ok: r.success,
    stdout: r.stdout.toString().trimEnd(),
    stderr: r.stderr.toString().trimEnd(),
  };
}

function listSemverTagsAscending(): string[] {
  const listed = git(['tag', '-l', 'v*', '--sort=v:refname']);

  if (!listed.ok) {
    return [];
  }

  return listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => SEMVER_TAG.test(name));
}

type SectionProps = {
  tag: string;
  prev: string | null;
};

function commitLinesForSection({ tag, prev }: SectionProps): string {
  const args =
    prev === null
      ? ['log', '--reverse', '--format=- %s (%h)', tag]
      : ['log', '--reverse', '--format=- %s (%h)', `${prev}..${tag}`];

  const log = git(args);

  if (!log.ok) {
    return `_(could not read git log: ${log.stderr})_`;
  }

  if (log.stdout.length === 0) {
    return '_No commits in this range._';
  }

  return log.stdout;
}

function tagDate(tag: string): string {
  const d = git(['log', '-1', '--format=%cs', tag]);

  return d.ok && d.stdout.length > 0 ? d.stdout : 'unknown';
}

type BuildChangelogProps = {
  tagsAscending: string[];
};

function buildChangelogMarkdown({
  tagsAscending,
}: BuildChangelogProps): string {
  const lines: string[] = [
    '# Changelog',
    '',
    'All notable changes for each version are listed under the corresponding `v*.*.*` tag.',
    'Tags and this file are updated by the post-commit hook when you commit with `--patch`, `--minor`, or `--major` (see CONTRIBUTING.md).',
    'You can also run `bun run release:changelog` to rewrite this file from tags.',
    '',
  ];

  if (tagsAscending.length === 0) {
    lines.push('_No semver tags (`v*.*.*`) found yet._', '');

    return lines.join('\n');
  }

  for (let i = tagsAscending.length - 1; i >= 0; i--) {
    const tag = tagsAscending[i];
    const prev = i > 0 ? tagsAscending[i - 1] : null;
    const body = commitLinesForSection({ tag, prev });
    const date = tagDate(tag);

    lines.push(`## [${tag}] - ${date}`, '', body, '');
  }

  return lines.join('\n').trimEnd() + '\n';
}

function main(): void {
  const argv = process.argv.slice(2);
  const outPath = argv[0] ?? DEFAULT_OUT;

  const tagsAscending = listSemverTagsAscending();
  const md = buildChangelogMarkdown({ tagsAscending });

  Bun.write(outPath, md);
  console.log(`Wrote ${outPath}`);
}

main();
