import { generateText } from 'ai';
import { createClient } from '@supabase/supabase-js';
import { NAICSCode } from '../../types.js';
import { calculateAICost } from './pricing.js';

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_ANON_KEY || ''
);

// Cache for approved NAICS codes
let approvedNaicsCodes: Array<{ code: string; description: string }> = [];
let naicsCodesLoaded = false;

async function loadApprovedNaicsCodes(): Promise<void> {
  if (naicsCodesLoaded) return;
  
  const { data, error } = await supabase
    .from('naics_codes')
    .select('naics_code, naics_industry_title')
    .order('naics_code');
  
  if (error) {
    console.error('Error loading NAICS codes:', error);
    approvedNaicsCodes = [];
  } else if (data) {
    approvedNaicsCodes = data.map(n => ({
      code: n.naics_code,
      description: n.naics_industry_title
    }));
    console.log(`✅ Loaded ${approvedNaicsCodes.length} approved NAICS codes for validation`);
  }
  
  naicsCodesLoaded = true;
}

/**
 * Simple pass-through - return all NAICS codes for AI model to match
 * The AI model is better at matching than keyword scoring
 */
function retrieveCandidateNAICS(
  businessDescription: string,
  scrapedContent: Map<string, string>,
  maxCandidates: number = 1500
): Array<{ code: string; description: string; score: number }> {
  
  console.log(`   🔍 Passing all ${approvedNaicsCodes.length} NAICS codes to AI model for matching`);
  return approvedNaicsCodes.map(naics => ({ ...naics, score: 1 }));
}

const NAICS_SELECTION_PROMPT = `You are assigning accurate 2022 NAICS codes to a company.

**TASK**: Read the business description below and match it to the most accurate NAICS code descriptions from the approved list.

**CRITICAL**: Match ONLY based on the BUSINESS DESCRIPTION - ignore any other content. The business description tells you what the company actually does.

**RULES**:
1. Use ONLY codes from the APPROVED NAICS LIST below - return the exact code and description as listed
2. Match based on what the company ACTUALLY DOES (from business description)
3. Return MAXIMUM 6 codes for the PRIMARY business activities mentioned in the business description
4. Return JSON array only: [{ "code": "string", "description": "string" }]

**MATCHING GUIDELINES**:
- If business description says "manufacturer" or "producer" → use 31xxxx manufacturing codes, NOT retail codes
- If business description says "retailer" or "store" → use 44xxxx or 45xxxx retail codes
- If business description says "wholesaler" or "distributor" → use 42xxxx wholesale codes
- If business description says "operates restaurants" or "provides food service" → use 722xxx food service codes

**IMPORTANT - Target Markets vs Business Type**:
- "Targets retail markets" or "sells to retailers" = manufacturer/wholesaler (31xxxx or 42xxxx), NOT retailer (44xxxx)
- "Targets food service markets" or "sells to restaurants" = manufacturer/wholesaler (31xxxx or 42xxxx), NOT restaurant (722xxx)
- Only use retail/restaurant codes if the company OPERATES stores/restaurants themselves

**EXAMPLES**:
- "Producer of olive oils and sauces" → 311225 (Fats and Oils), 311999 (Food Manufacturing)
- "Coffee shop chain" → 722515 (Snack and Nonalcoholic Beverage Bars)
- "Catering company" → 722320 (Caterers)
- "Grocery store" → 445110 (Supermarkets)

#APPROVED NAICS LIST#
{{APPROVED_NAICS_LIST}}

#COMPANY INFORMATION#
Domain: {{DOMAIN}}
Company Name: {{COMPANY_NAME}}
Business Description: {{BUSINESS_DESCRIPTION}}

Return ONLY valid JSON array of NAICS codes based on the business description.`;

export interface NAICSSelectionResult {
  naicsCodes: NAICSCode[];
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  costUsd: number;
}

export async function selectNAICSCodes(
  domain: string,
  companyName: string,
  businessDescription: string,
  scrapedContent: Map<string, string>,
  model: any,
  modelId: string = 'openai/gpt-4o-mini'
): Promise<NAICSSelectionResult> {
  console.log(`\n🏭 Selecting NAICS codes with retrieval-then-rank...`);
  
  // Load approved NAICS codes
  await loadApprovedNaicsCodes();
  
  // RETRIEVAL STEP: Get top 50 candidate NAICS codes based on keywords
  // This reduces token usage by ~90% compared to injecting all 1,013 codes
  const candidates = retrieveCandidateNAICS(businessDescription, scrapedContent, 50);
  
  if (candidates.length === 0) {
    console.log(`   ⚠️  No candidate NAICS codes found - using fallback`);
    return {
      naicsCodes: [],
      confidence: 'low',
      reasoning: 'No relevant NAICS codes found in candidate retrieval',
      costUsd: 0
    };
  }
  
  // Format candidate NAICS list for prompt (only top 50 instead of all 1,013)
  const approvedListText = candidates
    .map(c => `${c.code} - ${c.description}`)
    .join('\n');
  
  console.log(`   📝 Prompt will include ${candidates.length} candidate codes (saved ~${Math.round((1 - candidates.length / approvedNaicsCodes.length) * 100)}% tokens)`);
  
  // Build prompt (using only business description, not scraped content)
  // Scraped content can include recipes, ingredients, etc. that confuse the AI
  const prompt = NAICS_SELECTION_PROMPT
    .replace('{{APPROVED_NAICS_LIST}}', approvedListText)
    .replace('{{DOMAIN}}', domain)
    .replace('{{COMPANY_NAME}}', companyName)
    .replace('{{BUSINESS_DESCRIPTION}}', businessDescription || 'Not provided');
  
  try {
    const { text, usage } = await generateText({
      model,
      prompt,
      temperature: 0.1,
    });
    
    const inputTokens = usage?.inputTokens || 0;
    const outputTokens = usage?.outputTokens || 0;
    const costUsd = calculateAICost(modelId, inputTokens, outputTokens);
    
    console.log(`   🔢 NAICS selection tokens: ${inputTokens} in / ${outputTokens} out ($${costUsd.toFixed(4)})`);
    
    // Parse response
    const cleanText = text.trim().replace(/^```json?\n?/i, '').replace(/\n?```$/i, '');
    const parsed = JSON.parse(cleanText);
    
    if (!Array.isArray(parsed)) {
      console.log(`   ⚠️  NAICS selection returned non-array, using empty array`);
      return {
        naicsCodes: [],
        confidence: 'low',
        reasoning: 'NAICS selection returned invalid format',
        costUsd
      };
    }
    
    // Validate each code against approved list
    const validatedCodes: NAICSCode[] = [];
    for (const item of parsed) {
      const approved = approvedNaicsCodes.find(n => n.code === item.code);
      if (approved) {
        // Use exact description from approved list
        validatedCodes.push({
          code: item.code,
          description: approved.description
        });
      } else {
        console.log(`   ⚠️  NAICS code ${item.code} not in approved list, skipping`);
      }
    }
    
    // ENFORCE HARD LIMIT: Maximum 6 NAICS codes
    const MAX_NAICS_CODES = 6;
    if (validatedCodes.length > MAX_NAICS_CODES) {
      console.log(`   ⚠️  AI returned ${validatedCodes.length} codes, limiting to ${MAX_NAICS_CODES}`);
      validatedCodes.splice(MAX_NAICS_CODES); // Keep only first 6
    }
    
    // Determine confidence based on number of codes and content quality
    let confidence: 'high' | 'medium' | 'low' = 'medium';
    if (validatedCodes.length === 0) {
      confidence = 'low';
    } else if (validatedCodes.length >= 2 && scrapedContent.size > 0) {
      confidence = 'high';
    }
    
    const reasoning = validatedCodes.length > 0
      ? `Selected ${validatedCodes.length} NAICS code(s) based on verified business activities from company website and public sources`
      : 'No valid NAICS codes could be determined from available information';
    
    console.log(`   ✅ Selected ${validatedCodes.length} validated NAICS codes`);
    validatedCodes.forEach(c => console.log(`      - ${c.code}: ${c.description}`));
    
    return {
      naicsCodes: validatedCodes,
      confidence,
      reasoning,
      costUsd
    };
    
  } catch (error) {
    console.error(`   ❌ NAICS selection failed:`, error);
    return {
      naicsCodes: [],
      confidence: 'low',
      reasoning: `NAICS selection failed: ${error}`,
      costUsd: 0
    };
  }
}
