const ANNOTATION_RE = /\s*!!(\d+)(?:sats?)?\s*$/i;

export type ParsedPrompt = {
  prompt: string;
  budgetSats: number | null;
};

export function parseBudgetAnnotation(input: string): ParsedPrompt {
  const match = input.match(ANNOTATION_RE);

  if (!match) {
    return { prompt: input.trim(), budgetSats: null };
  }

  return {
    prompt: input.slice(0, input.length - match[0].length).trimEnd(),
    budgetSats: parseInt(match[1], 10),
  };
}
