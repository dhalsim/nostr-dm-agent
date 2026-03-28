import type { SimplePool } from 'nostr-tools/pool';

import type { CoreDb } from '../db';
import { getWotRootStats, getWotScoreDetails } from '../db';
import type { BotConfig } from '../env';
import { crawlWot, normalizePubkeyInput } from '../nostr/wot';

function getWotUsage(): string {
  return 'Usage: !wot crawl [--pubkey <pubkey|npub>] [--depth <n>] | !wot score <pubkey|npub> [of <pubkey|npub>] | !wot stats [<pubkey|npub>]';
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function parseWotCrawlArgs(
  args: string[],
  defaultRootPubkey: string,
): {
  rootPubkey: string;
  maxDepth: number;
} {
  let rootPubkey = defaultRootPubkey;
  let maxDepth = 2;
  let index = 1;

  while (index < args.length) {
    const arg = args[index]?.toLowerCase();

    if (arg === '--pubkey') {
      const value = args[index + 1];

      if (!value) {
        throw new Error('Missing value for --pubkey.');
      }

      rootPubkey = normalizePubkeyInput(value);
      index += 2;

      continue;
    }

    if (arg === '--depth') {
      const value = args[index + 1];

      if (!value) {
        throw new Error('Missing value for --depth.');
      }

      maxDepth = parsePositiveInt(value, '--depth');
      index += 2;

      continue;
    }

    throw new Error(`Unknown crawl option: ${args[index]}`);
  }

  return {
    rootPubkey: normalizePubkeyInput(rootPubkey),
    maxDepth,
  };
}

export type HandleWotProps = {
  db: CoreDb;
  pool: SimplePool;
  config: BotConfig;
  args: string[];
};

export async function handleWot({
  db,
  pool,
  config,
  args,
}: HandleWotProps): Promise<string> {
  const subcmd = args[0]?.toLowerCase();

  if (!subcmd) {
    return getWotUsage();
  }

  if (subcmd === 'score') {
    const targetArg = args[1];

    if (!targetArg) {
      return getWotUsage();
    }

    const targetPubkey = normalizePubkeyInput(targetArg);

    const ofIndex = args.findIndex(
      (arg, index) => index >= 2 && arg.toLowerCase() === 'of',
    );

    const rootArg = ofIndex >= 0 ? args[ofIndex + 1] : undefined;
    const rootPubkey = normalizePubkeyInput(rootArg ?? config.masterPubkey);
    const details = getWotScoreDetails(db, targetPubkey, rootPubkey);

    if (!details) {
      return `No WoT entry for ${targetPubkey} under root ${rootPubkey}. Crawl it first with !wot crawl${rootArg ? ` ${rootPubkey}` : ''}.`;
    }

    const scoreLine =
      details.score === null
        ? 'Score: n/a (root node)'
        : `Score: ${details.score.toFixed(2)} / 100`;

    const baseScoreLine =
      details.base_score === null
        ? 'Base score: n/a'
        : `Base score: ${details.base_score.toFixed(2)} / 100`;

    return `WoT score for ${details.pubkey}
Root: ${details.root_pubkey}
Level: ${details.depth}
${baseScoreLine}
Followers in WoT: ${details.follower_count}
Weighted support: ${details.weighted_support.toFixed(3)}
Normalized support: ${details.normalized_support.toFixed(3)}
Following count: ${details.following_count}
${scoreLine}

Support can come from all crawled circles; closer supporters count more.`;
  }

  if (subcmd === 'stats') {
    const rootPubkey = normalizePubkeyInput(args[1] ?? config.masterPubkey);
    const stats = getWotRootStats(db, rootPubkey);

    if (!stats) {
      return `No WoT data for ${rootPubkey}. Crawl it first with !wot crawl${args[1] ? ` ${rootPubkey}` : ''}.`;
    }

    return `WoT stats for ${stats.root_pubkey}
Nodes: ${stats.node_count}
Edges: ${stats.edge_count}
Max depth: ${stats.max_depth}
Last fetched at: ${stats.last_fetched_at}`;
  }

  if (subcmd !== 'crawl') {
    return getWotUsage();
  }

  const { rootPubkey, maxDepth } = parseWotCrawlArgs(args, config.masterPubkey);

  await crawlWot({
    pool,
    db,
    rootPubkey,
    maxDepth,
  });

  const stats = getWotRootStats(db, rootPubkey);

  if (!stats) {
    return `WoT crawl finished for ${rootPubkey}, but no graph data was stored.`;
  }

  return `WoT crawl finished for ${rootPubkey}.
Nodes: ${stats.node_count}
Edges: ${stats.edge_count}
Max depth: ${stats.max_depth}
Last fetched at: ${stats.last_fetched_at}`;
}
