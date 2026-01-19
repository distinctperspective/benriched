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

const NAICS_SELECTION_PROMPT = `#CONTEXT#

You are an AI-powered web researcher tasked with assigning accurate 2022 six-digit NAICS codes to a company using only verifiable public information. Inputs may be partial or incorrect and must be validated before use. Only use static, public, non-authenticated sources. Return only codes and descriptions that appear verbatim in the provided approved 2022 NAICS list.

#OBJECTIVE#

Determine the most specific, accurate 2022 six-digit NAICS code(s) for the company represented by the provided columns, based strictly on verified public evidence.

#INSTRUCTIONS#

1) Input validation and primary identifier selection (strict order):
   - If domain or website exists and is non-empty, treat as primary identifier (registrable domain).
   - Use the domain to identify the company's official website and business activities.
   - If no valid official domain can be identified, proceed using other verified public descriptions only but do not infer beyond what is stated.

2) Allowed sources and prioritization:
   - Prioritize company-owned static pages: About, Products/Services, Solutions, Industries, Careers, Certifications, Compliance, Legal/Privacy, Press/News.
   - Then public business directories (e.g., ZoomInfo public pages), other open directories, and other public web pages that clearly describe activities.
   - Do not use paywalled, authenticated, or dynamic content. Do not rely on user-generated or ambiguous sources.

3) Evidence collection and business activity derivation:
   - Extract concise, verifiable descriptions of what the company produces, sells, or services from the allowed sources.
   - Identify distinct business segments if multiple lines of business are clearly evidenced.
   - Ignore marketing fluff; focus on concrete activities and offerings. Do not infer or guess.

3b) Multi-line business analysis:
   - For companies with physical products: Check if they MANUFACTURE what they sell (not just retail). Look for evidence of production facilities, roasting plants, manufacturing sites, factories, or "made by" language.
   - For food/beverage companies: Separately check for: (1) production/manufacturing, (2) wholesale/distribution, (3) retail operations.
   - For each distinct activity type found, map to appropriate codes even if they span different NAICS categories.
   - Example: A coffee shop chain that roasts its own beans needs BOTH retail (722xxx) AND manufacturing (311920) codes.

3c) Manufacturing detection checklist (check these explicitly):
   - Does the company describe "roasting," "brewing," "baking," "processing," "manufacturing," "producing," or "making" products?
   - Do they mention facilities like: plants, factories, roasteries, kitchens, production facilities, manufacturing sites?
   - Do they sell packaged/branded products under their own name in grocery stores or wholesale?
   - If YES to any: Include appropriate 311xxx or 312xxx manufacturing codes in addition to any retail codes.

4) Mapping to the approved NAICS list:
   - Use the provided "APPROVED NAICS LIST" as the sole taxonomy. Return only 6-digit 2022 codes and their exact descriptions as listed.
   - For each evidenced business activity, map to ALL applicable NAICS codes that match verified activities. Include codes for:
     * Manufacturing/production activities (if they make/process products)
     * Wholesale/distribution activities (if they distribute to other businesses)
     * Retail/service activities (if they sell directly to consumers)
   - A single company may legitimately have codes across multiple categories (31x, 42x, 72x, etc.).
   - De-duplicate any repeated codes.
   - If a NAICS code is seen on the web, only accept it if it exactly matches a code+description in the approved list and matches the evidenced activity.

5) Last-resort NAICS discovery (only if direct mapping from descriptions to the list is not confident):
   - Step 1 — Derive business function: From verified information already collected, extract a concise generic function (e.g., "manufactures baby food", "wholesale distribution of industrial chemicals").
   - Step 2 — Form search query: <business function> + "6-digit NAICS code" (do NOT include the company name).
   - Step 3 — Execute web search: Review educational resources, government/industry explanations, and classification guides.
   - Step 4 — Extract candidate codes: Only 6-digit codes.
   - Step 5 — Acceptance filter: Accept a candidate code only if (a) the NAICS description clearly matches the verified activities, (b) the exact code+description exists in the approved list, and (c) it does not contradict any public information.
   - Step 6 — Termination: If codes pass, return them; otherwise return [].

6) Validation before returning:
   - De-duplicate codes.
   - Cross-check alignment with the verified official domain/website and public descriptions.
   - If provided URLs are incorrect, attempt to find and use the correct official source.

7) Output format (strict):
   - Return JSON only, no explanations or extra text.
   - Each item must be: { "code": "string", "description": "string" }
   - If no valid NAICS codes are found, return []

8) Final validation for food/beverage companies:
   - If ANY retail food codes (722xxx) were found, explicitly check website for evidence of manufacturing/production
   - If company describes making their own products: Add appropriate 311xxx or 312xxx codes
   - If company mentions wholesale or grocery distribution: Add appropriate 424xxx codes

#APPROVED NAICS LIST#
{{APPROVED_NAICS_LIST}}

#COMPANY INFORMATION#
Domain: {{DOMAIN}}
Company Name: {{COMPANY_NAME}}
Business Description: {{BUSINESS_DESCRIPTION}}
Scraped Content: {{SCRAPED_CONTENT}}

Return ONLY valid JSON array of NAICS codes with exact descriptions from the approved list.`;

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
  console.log(`\n🏭 Selecting NAICS codes with comprehensive validation...`);
  
  // Load approved NAICS codes
  await loadApprovedNaicsCodes();
  
  // Format approved NAICS list for prompt
  const approvedListText = approvedNaicsCodes
    .map(n => `${n.code} - ${n.description}`)
    .join('\n');
  
  // Format scraped content (limit to avoid token overflow)
  let scrapedText = '';
  for (const [url, content] of scrapedContent) {
    const truncated = content.slice(0, 3000);
    scrapedText += `--- ${url} ---\n${truncated}\n\n`;
  }
  
  // Build prompt
  const prompt = NAICS_SELECTION_PROMPT
    .replace('{{APPROVED_NAICS_LIST}}', approvedListText)
    .replace('{{DOMAIN}}', domain)
    .replace('{{COMPANY_NAME}}', companyName)
    .replace('{{BUSINESS_DESCRIPTION}}', businessDescription || 'Not provided')
    .replace('{{SCRAPED_CONTENT}}', scrapedText || 'No content available');
  
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
