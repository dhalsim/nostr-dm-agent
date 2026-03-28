import type { SimplePool } from 'nostr-tools/pool';

import type { CoreDb } from '../db';
import { getWotRootStats } from '../db';
import type { BotConfig } from '../env';
import { crawlWot, normalizePubkeyInput } from '../nostr/wot';

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
    return 'Usage: !wot crawl [<pubkey>]';
  }

  if (subcmd !== 'crawl') {
    return 'Usage: !wot crawl [<pubkey>]';
  }

  const rootPubkey = normalizePubkeyInput(args[1] ?? config.masterPubkey);

  await crawlWot({
    pool,
    db,
    rootPubkey,
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
