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

// Prices are per million tokens, taken from the provider's public pricing and
// dated by PRICE_TABLE_VERSION. They move, so this is an estimate and is
// labelled as one wherever it is shown.
const PRICES: Record<string, Price> = {
  'llama-3.3-70b-versatile': { inputPerMillion: 0.59, outputPerMillion: 0.79 },
  'llama-3.1-8b-instant': { inputPerMillion: 0.05, outputPerMillion: 0.08 },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  'fake-1': { inputPerMillion: 0, outputPerMillion: 0 },
};

/**
 * Returns null for a model with no published price in this table, rather than
 * zero: "unknown" and "free" are different claims, and showing 0.00 for a paid
 * model is the kind of number that gets believed.
 */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const price = PRICES[model];
  if (!price) return null;
  const cost =
    (inputTokens / 1_000_000) * price.inputPerMillion +
    (outputTokens / 1_000_000) * price.outputPerMillion;
  return Number(cost.toFixed(6));
}
