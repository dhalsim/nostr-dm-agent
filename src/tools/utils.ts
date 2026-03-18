// ---------------------------------------------------------------------------
// tools/utils.ts — shared parsing/validation helpers for AI tool output
// ---------------------------------------------------------------------------
import type { z } from 'zod';

/** Result of parsing one item: either a value or an error. Caller decides how to handle. */
export type ParseSettledFulfilled<T> = { status: 'fulfilled'; value: T };
export type ParseSettledRejected = { status: 'rejected'; reason: Error };
export type ParseSettledResult<T> =
  | ParseSettledFulfilled<T>
  | ParseSettledRejected;

function stripCodeFences(s: string): string {
  return s
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extractOneJson(raw: string): string | null {
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  return raw.slice(firstBrace, lastBrace + 1);
}

type ParseToolCallsProps<T> = {
  raw: string;
  schema: z.ZodType<T>;
};

/**
 * Parse raw model output as either a single JSON object or JSONL (one JSON per line).
 * Returns an array of settled results so the caller can handle partial success.
 */
export function parseToolCalls<T>({
  raw,
  schema,
}: ParseToolCallsProps<T>): ParseSettledResult<T>[] {
  const stripped = stripCodeFences(raw);
  const results: ParseSettledResult<T>[] = [];

  // Try whole string as single JSON first (handles pretty-printed single object)
  const wholeJson = extractOneJson(stripped);

  if (wholeJson !== null) {
    const single = tryParseOne(wholeJson, schema);

    if (single.status === 'fulfilled') {
      return [single];
    }
  }

  // JSONL: one JSON object per line
  const lines = stripped.split(/\n/);
  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      continue;
    }

    const jsonStr = extractOneJson(trimmed);

    if (jsonStr === null) {
      continue;
    }

    results.push(tryParseOne(jsonStr, schema));
  }

  return results;
}

function tryParseOne<T>(
  jsonStr: string,
  schema: z.ZodType<T>,
): ParseSettledResult<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    return {
      status: 'rejected',
      reason: new Error(
        `Invalid JSON: ${e instanceof Error ? e.message : String(e)}. First 200 chars: ${jsonStr.slice(0, 200)}`,
      ),
    };
  }

  const parsedResult = schema.safeParse(parsed);

  if (parsedResult.success) {
    return { status: 'fulfilled', value: parsedResult.data };
  }

  return {
    status: 'rejected',
    reason: new Error(parsedResult.error.message),
  };
}
