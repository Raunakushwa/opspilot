/**
 * Estimated LLM cost.
 *
 * Prices change and vary by region, so this is explicitly an *estimate* from a
 * versioned table, surfaced as such in the UI. An unknown model costs zero
 * rather than a guessed number that would look authoritative.
 */

export const PRICE_TABLE_VERSION = '2026-09';

interface Price {
  inputPerMillion: number;
  outputPerMillion: number;
}

const PRICES: Record<string, Price> = {
  'llama-3.3-70b-versatile': { inputPerMillion: 0.59, outputPerMillion: 0.79 },
  'llama-3.1-8b-instant': { inputPerMillion: 0.05, outputPerMillion: 0.08 },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  'fake-1': { inputPerMillion: 0, outputPerMillion: 0 },
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICES[model];
  if (!price) return 0;
  const cost =
    (inputTokens / 1_000_000) * price.inputPerMillion +
    (outputTokens / 1_000_000) * price.outputPerMillion;
  return Number(cost.toFixed(6));
}
