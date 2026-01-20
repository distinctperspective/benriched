import { generateText } from 'ai';
import { gateway } from '@ai-sdk/gateway';

const TIER_CLASSIFICATION_PROMPT = `You are a precise text classification assistant. You will categorize a person's job title into tiers using an explicit, rule-based framework. Apply the rules deterministically and return the tier label. Additionally, for the normalizedTitle field, preserve the original case of acronyms (e.g., CEO, CFO, CTO, SVP, EVP, QA, QC, R&D, IT, CIO, CDO, COO, SQF, GFSI, HACCP, BRC, PCQI) and convert all other words to Title Case.

**OBJECTIVE**

Classify the provided job title into a tier and return a single JSON object with the originalTitle, a normalizedTitle that preserves acronym casing while making the rest Title Case, and the tierLabel according to the framework.

**INSTRUCTIONS**

1. Read the job title: {{JOB_TITLE}}

2. For matching only, compute t = LOWER(originalTitle). Do not alter originalTitle.

3. Apply the rules in the exact order below. The first matching rule determines the final tierLabel:

   - Tier 4 (Ultimate) if t CONTAINS any of: "chief executive", "ceo", "president", "owner", "co owner", "co-founder", "cofounder", "founder", "managing director", "chief operating officer", "coo", "chief quality officer", "cqo", "chief food safety officer", "chief technology officer", "cto", "chief information officer", "cio", "chief digital officer", "cdo", "vp of quality", "vp quality", "vp of operations", "vp operations", "vp of food safety", "vp food safety", "vp of compliance", "vp compliance", "vp of technology", "vp technology", "vp of it", "vp it", "vp of engineering", "vp engineering", "executive director".

   - Tier 3 (Strong Owner) if t MATCHES any of these full terms/phrases: "senior vice president", "svp", "executive vice president", "evp", "vice president", " vp ", "global head", "head of", "head of quality", "head of food safety", "head of operations", "head of compliance", "head of engineering", "head of production", "head of digital", "head of technology", "general manager", "plant manager", "facility manager", "site manager", "director of quality", "director of food safety", "director of operations", "director of manufacturing", "director of regulatory", "director of compliance", "director of engineering", "director of production", "director of continuous improvement", "director of it", "director of technology", "director of digital transformation", "director of supply chain", "regional quality manager", "regional operations manager", "corporate quality manager", "multi-site manager".

   - Tier 3 (Strong Owner) if t CONTAINS "director". Exception: if the title is exactly or primarily "associate director" or "assistant director" without other senior modifiers (e.g., not "senior associate director"), set Tier 2.

   - Tier 2 (Manager / Recommender) if t CONTAINS any of: "manager", "quality manager", "quality assurance manager", "qa manager", "qc manager", "food safety manager", "fsqa manager", "compliance manager", "regulatory manager", "plant supervisor", "production manager", "production supervisor", "operations manager", "operations supervisor", "engineering manager", "process control manager", "continuous improvement manager", "supply chain manager", "sanitation manager", "facilities manager", "maintenance manager", "lead", "team lead", "shift supervisor", "laboratory manager", "r&d manager", "product development manager", "product quality manager", "it manager", "technology manager", "systems manager", "erp manager", "associate director", "assistant director".

   - Tier 1 (IC / Advisor) if t CONTAINS any of: "quality assurance", " qa ", " qc ", "quality control", "food safety", "fsqa", "fsq", "gfsi", "haccp", "sqf", "sqfi", "brc", "pcqi", "practitioner", "sqf practitioner", "brc practitioner", "compliance", "regulatory", "audit", "auditor", "quality", "product quality", "engineer", "engineering", "process engineer", "quality engineer", "process control", "food scientist", "food technologist", "microbiologist", "scientist", "quality technician", "lab technician", "sanitation", "sanitation specialist", "maintenance", "facilities", "production", "operations", "supply chain", "continuous improvement", "technical specialist", "quality analyst", "regulatory specialist", "compliance specialist", "it specialist", "systems analyst", "business analyst", "spc specialist", "chemist", "sensory specialist".

   - Else -> Tier 0 (Unknown).

4. Matching guidance:

   - Treat matching as case-insensitive using t.
   - For " vp ": ensure it appears with surrounding spaces or clear word boundaries to avoid matching inside other words.
   - For the downgrade rule: if the title is exactly "associate director" or starts with "associate director" without additional senior modifiers, set Tier 2 (Manager / Recommender); otherwise keep Tier 3 (Strong Owner).

5. IMPORTANT - tierLabel must ALWAYS include the full label with description:
   - "Tier 4 (Ultimate)" - NOT just "Tier 4"
   - "Tier 3 (Strong Owner)" - NOT just "Tier 3"
   - "Tier 2 (Manager / Recommender)" - NOT just "Tier 2"
   - "Tier 1 (IC / Advisor)" - NOT just "Tier 1"
   - "Tier 0 (Unknown)" - NOT just "Tier 0"

6. Normalized title formatting (preserve acronyms, Title Case otherwise):

   - Start from originalTitle. Split into tokens by spaces and punctuation while preserving punctuation in the final string.
   - If a token is an acronym in the set {CEO, CFO, CTO, CIO, CDO, COO, CPO, CMO, CHRO, SVP, EVP, VP, QA, QC, R&D, FSQA, FSQ, IT, ERP, SQF, SQFI, GFSI, HACCP, BRC, PCQI, SPC} or matches the regex of 2–6 consecutive uppercase letters (including ampersand in R&D), keep it uppercase.
   - Otherwise, convert the token to Title Case (capitalize first letter, lowercase the rest), but keep common short connectors in lowercase when not first: {of, and, for, in, on, at, to, the, a, an}.
   - Preserve original punctuation and spacing except normalize excessive whitespace to single spaces.

6. Output a single JSON object with camelCase keys only. Do not include commentary. Always include: originalTitle, normalizedTitle, tierLabel.

**INPUT**:
Job Title: {{JOB_TITLE}}

**OUTPUT** (JSON only):`;

export interface TierClassificationResult {
  originalTitle: string;
  normalizedTitle: string;
  tierLabel: string;
  cost?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
  };
}

export async function classifyTier(title: string): Promise<TierClassificationResult> {
  console.log(`\n🎯 Classifying tier for title: ${title}`);

  if (!title || title.trim() === '') {
    return {
      originalTitle: '',
      normalizedTitle: '',
      tierLabel: 'Tier 0 (Unknown)'
    };
  }

  // Build prompt
  const prompt = TIER_CLASSIFICATION_PROMPT.replace(/{{JOB_TITLE}}/g, title);

  // Call OpenAI via AI Gateway
  const model = gateway('openai/gpt-4o-mini');

  const startTime = Date.now();
  const { text: aiResponse, usage } = await generateText({
    model,
    system: 'You are a precise text classification assistant. Return only valid JSON.',
    prompt,
    temperature: 0.1, // Very low temperature for deterministic classification
  });

  const aiTime = Date.now() - startTime;

  if (!aiResponse) {
    throw new Error('AI returned empty response for tier classification');
  }

  // Strip markdown code blocks if present
  let cleanedResponse = aiResponse.trim();
  if (cleanedResponse.startsWith('```')) {
    cleanedResponse = cleanedResponse.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  // Parse AI response
  const result = JSON.parse(cleanedResponse);
  console.log(`   🏆 Tier: ${result.tierLabel}`);
  console.log(`   📝 Normalized: ${result.normalizedTitle}`);

  // Calculate cost
  const inputTokens = usage?.inputTokens || 0;
  const outputTokens = usage?.outputTokens || 0;
  const totalTokens = usage?.totalTokens || (inputTokens + outputTokens);
  const inputCost = inputTokens * 0.00000015;
  const outputCost = outputTokens * 0.0000006;
  const totalCost = inputCost + outputCost;

  console.log(`   ⏱️  AI time: ${aiTime}ms`);
  console.log(`   💰 Cost: $${totalCost.toFixed(6)}`);

  return {
    originalTitle: result.originalTitle,
    normalizedTitle: result.normalizedTitle,
    tierLabel: result.tierLabel,
    cost: {
      inputTokens,
      outputTokens,
      totalTokens,
      costUsd: totalCost
    }
  };
}
