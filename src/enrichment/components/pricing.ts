// AI Model Pricing (per 1M tokens)
// Perplexity sonar: $1/1M input, $1/1M output (company enrichment via AI Gateway)
// Perplexity sonar-pro: $3/1M input, $15/1M output (contact research via direct Perplexity API)
// GPT-4o-mini: $0.15/1M input, $0.60/1M output
// Note: Perplexity also charges a per-request search fee (~$0.005-0.006) not captured here

const AI_PRICING: Record<string, { input: number; output: number }> = {
  'perplexity/sonar': { input: 1.0, output: 1.0 },
  'perplexity/sonar-pro': { input: 3.0, output: 15.0 },
  'openai/gpt-4o-mini': { input: 0.15, output: 0.60 },
};

export function calculateAICost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = AI_PRICING[model] || { input: 0.15, output: 0.60 }; // default to gpt-4o-mini
  return (inputTokens * pricing.input / 1_000_000) + (outputTokens * pricing.output / 1_000_000);
}

export { AI_PRICING };
