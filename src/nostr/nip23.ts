// ---------------------------------------------------------------------------
// src/nostr/nip23.ts — NIP-23 long-form (kind 30023) and drafts (kind 30024)
// @see https://nips.nostr.com/23
// ---------------------------------------------------------------------------

import type { Event, EventTemplate, NostrEvent } from 'nostr-tools';

/** Published article (long-form). */
export const NIP23_PUBLISHED_KIND = 30023;

/** Draft — same structure as 30023 per NIP-23. */
export const NIP23_DRAFT_KIND = 30024;

type BuildDraftEventTemplateProps = {
  content: string;
  d: string;
  title: string;
  summary: string;
  image: string | null;
  topicTags: string[];
};

/**
 * Build a kind 30024 draft template. Omits `image` when `image` is null or empty.
 * Topic tags use `t` per NIP-23.
 */
export function buildDraftEventTemplate({
  content,
  d,
  title,
  summary,
  image,
  topicTags,
}: BuildDraftEventTemplateProps): EventTemplate {
  const now = Math.floor(Date.now() / 1000);

  const tags: string[][] = [
    ['d', d],
    ['title', title],
    ['summary', summary],
  ];

  if (image !== null && image !== '') {
    tags.push(['image', image]);
  }

  for (const raw of topicTags) {
    const t = raw.trim();

    if (t !== '') {
      tags.push(['t', t]);
    }
  }

  return {
    kind: NIP23_DRAFT_KIND,
    created_at: now,
    content,
    tags,
  };
}

/**
 * Promote a kind 30024 draft to a kind 30023 published article (same tags and body).
 */
export type ParsedNip23LongForm = {
  content: string;
  title: string;
  summary: string;
  tags: string[];
  slug: string;
  image: string;
};

/** Read NIP-23 metadata tags from a kind 30023/30024 event. */
export function parseNip23LongFormFromEvent(event: Event): ParsedNip23LongForm {
  const dTag = event.tags.find((t) => t[0] === 'd')?.[1] ?? '';
  const title = event.tags.find((t) => t[0] === 'title')?.[1] ?? '';
  const summary = event.tags.find((t) => t[0] === 'summary')?.[1] ?? '';
  const image = event.tags.find((t) => t[0] === 'image')?.[1] ?? '';

  const tags = event.tags
    .filter((t) => t[0] === 't' && t[1])
    .map((t) => String(t[1]));

  return {
    content: event.content,
    title,
    summary,
    tags,
    slug: dTag,
    image,
  };
}

export function publishedTemplateFromDraft(draft: NostrEvent): EventTemplate {
  if (draft.kind !== NIP23_DRAFT_KIND) {
    throw new Error(
      `Expected kind ${NIP23_DRAFT_KIND} draft, got ${draft.kind}`,
    );
  }

  return {
    kind: NIP23_PUBLISHED_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content: draft.content,
    tags: draft.tags,
  };
}

/** Stable `d` identifier: lowercase, hyphens, safe for URLs. */
export function slugifyForDTag(input: string): string {
  const s = input
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (s !== '') {
    return s;
  }

  return `draft-${Date.now().toString(36)}`;
}
