import { generateText } from 'ai';
import { gateway } from '@ai-sdk/gateway';
import { calculateAICost } from '../enrichment/components/pricing.js';

export interface ContactResearchRequest {
  prospect_name: string;
  company_name: string;
  linkedin_url?: string;
}

export interface ContactResearchResult {
  prospect_name: string;
  prospect_title: string;
  prospect_seniority: string;
  company_name: string;
  industry_segment: string;
  company_size_and_profile: string;
  known_trigger_or_context: string;
  role_specific_priorities_and_pains: string[];
  notable_quotes_or_initiatives: string[];
  recommended_case_study_filters: {
    industry_filter: string;
    role_filter: string;
    size_filter: string;
    key_outcome_focus: string[];
  };
  supporting_links: Array<{
    url: string;
    description: string;
  }>;
}

export interface ResearchResponse {
  data: ContactResearchResult;
  rawResponse: string;
  cost: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
  };
}

const RESEARCH_PROMPT = `# Research a Person for Outbound Sales Personalization
You are my research assistant for outbound sales personalization.

## TASK
Given the information I provide about a prospect (name, company, LinkedIn URL), research and return a structured summary that an outbound email–writing assistant can use to generate:
- A highly targeted intro email
- A 5-email follow-up cadence

## RESEARCH SOURCES
Use publicly available sources in this priority order:
1. Company website and press releases
2. Credible business databases, news articles, industry publications
3. Recent funding, hiring, expansion news
4. Public company information (if available)

**IMPORTANT**: You cannot access LinkedIn profiles directly. Use the LinkedIn URL only as a reference.
If specific prospect details are not publicly available, write \`Unknown\` for those fields.
Do **not** guess or fabricate details.
Focus on company-level information and role-based insights that can be inferred from the title and company context.

## REQUIRED OUTPUT (STRICT)
Return **only one Markdown code block** containing a **single valid JSON object** with the **exact keys listed below**.
- No text before or after the code block
- No markdown inside JSON values
- Use plain strings and arrays only

---

## REQUIRED JSON FIELDS (FLAT STRUCTURE)

Return a single JSON object with these exact keys at the root level:

{
  "prospect_name": "Full name",
  "prospect_title": "Current title (include seniority, e.g., VP of Operations)",
  "prospect_seniority": "One of: C-level, VP, Director, Manager, IC, or Other (specify)",
  "company_name": "Full or commonly used company name",
  "industry_segment": "Concise industry description (e.g., Meat & poultry processor, Frozen prepared meals manufacturer)",
  "company_size_and_profile": "Snapshot including employee range, revenue band, key locations, primary products",
  "known_trigger_or_context": "Recent trigger that could justify outreach (1-2 sentences with source link if possible)",
  "role_specific_priorities_and_pains": ["3-5 bullet points about likely priorities based on title and company context"],
  "notable_quotes_or_initiatives": ["1-3 bullets with quotes/paraphrases from press releases or public sources"],
  "recommended_case_study_filters": {
    "industry_filter": "string",
    "role_filter": "string", 
    "size_filter": "string",
    "key_outcome_focus": ["1-3 outcome phrases"]
  },
  "supporting_links": [
    {"url": "string", "description": "what it supports"}
  ]
}

---

## IMPORTANT CONSTRAINTS
- Output **only** the Markdown code block containing the JSON
- Do **not** generate email copy
- Do **not** add commentary or explanations
- Accuracy > completeness

---

I will now provide:
- Prospect name: {{PROSPECT_NAME}}
- Company name: {{COMPANY_NAME}}
- LinkedIn URL: {{LINKEDIN_URL}}

Use that information to populate the JSON fields exactly as specified.`;

export async function researchContact(
  request: ContactResearchRequest
): Promise<ResearchResponse> {
  const { prospect_name, company_name, linkedin_url } = request;

  console.log(`\n🔍 Researching contact: ${prospect_name} at ${company_name}`);

  // Use Perplexity Sonar Pro for research
  const researchModel = gateway('perplexity/sonar-pro');

  // Build the prompt with actual values
  const prompt = RESEARCH_PROMPT
    .replace('{{PROSPECT_NAME}}', prospect_name)
    .replace('{{COMPANY_NAME}}', company_name)
    .replace('{{LINKEDIN_URL}}', linkedin_url || 'Not provided');

  const result = await generateText({
    model: researchModel,
    prompt,
    temperature: 0.1,
  });

  // Extract JSON from markdown code block
  let researchData: ContactResearchResult;
  try {
    const jsonMatch = result.text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    const jsonString = jsonMatch ? jsonMatch[1].trim() : result.text.trim();
    researchData = JSON.parse(jsonString);
  } catch (parseError) {
    console.error('Failed to parse AI response:', parseError);
    console.error('Raw response:', result.text);
    throw new Error(`Failed to parse research results: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`);
  }

  // Calculate cost
  const cost = calculateAICost(
    'perplexity/sonar-pro',
    result.usage.inputTokens || 0,
    result.usage.outputTokens || 0
  );

  console.log(`✅ Research complete for ${prospect_name}`);
  console.log(`💰 Cost: $${cost.toFixed(6)}`);
  console.log(`🔢 Tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out`);

  return {
    data: researchData,
    rawResponse: result.text,
    cost: {
      inputTokens: result.usage.inputTokens || 0,
      outputTokens: result.usage.outputTokens || 0,
      totalTokens: result.usage.totalTokens || 0,
      costUsd: cost
    }
  };
}
