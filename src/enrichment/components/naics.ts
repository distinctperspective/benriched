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
 * Retrieve top candidate NAICS codes based on keywords from business description
 * This reduces token usage by ~90% compared to injecting all 1,013 codes
 */
function retrieveCandidateNAICS(
  businessDescription: string,
  scrapedContent: Map<string, string>,
  maxCandidates: number = 50
): Array<{ code: string; description: string; score: number }> {
  
  // Combine all text for keyword extraction
  const combinedText = `${businessDescription} ${Array.from(scrapedContent.values()).join(' ')}`.toLowerCase();
  
  // Identify primary industry sectors from text
  const sectorIndicators = {
    food_manufacturing: ['food', 'beverage', 'brewing', 'roasting', 'baking', 'canning', 'processing', 'manufacturing'],
    retail: ['retail', 'store', 'shop', 'supermarket', 'grocery'],
    restaurant: ['restaurant', 'cafe', 'coffee shop', 'dining', 'eatery', 'food service'],
    wholesale: ['wholesale', 'distributor', 'distribution'],
    software: ['software', 'technology', 'saas', 'platform', 'digital'],
    automotive: ['automotive', 'car', 'vehicle', 'auto'],
    construction: ['construction', 'building', 'contractor'],
    healthcare: ['healthcare', 'medical', 'hospital', 'clinic'],
    health_supplements: ['supplement', 'vitamin', 'nutraceutical', 'wellness', 'health product', 'dietary', 'redox'],
    alcohol_beverage: ['liquor', 'wine', 'beer', 'spirits', 'vodka', 'whiskey', 'gin', 'rum', 'tequila', 'cocktail', 'bartender', 'distillery', 'brewery', 'winery']
  };
  
  const detectedSectors = new Set<string>();
  for (const [sector, keywords] of Object.entries(sectorIndicators)) {
    if (keywords.some(kw => combinedText.includes(kw))) {
      detectedSectors.add(sector);
    }
  }
  
  // Extract keywords and score each NAICS code
  const scoredCodes = approvedNaicsCodes.map(naics => {
    const description = naics.description.toLowerCase();
    const code = naics.code;
    let score = 0;
    
    // NEGATIVE SCORING: Penalize clearly unrelated industries
    const unrelatedPenalties = [
      { sector: 'automotive', codes: ['811'], keywords: ['automotive', 'car', 'vehicle', 'auto', 'oil change', 'repair'] },
      { sector: 'construction', codes: ['23'], keywords: ['construction', 'building', 'contractor'] },
      { sector: 'healthcare', codes: ['621', '622', '623'], keywords: ['healthcare', 'medical', 'hospital'] },
      { sector: 'mining', codes: ['21'], keywords: ['mining', 'extraction', 'quarry'] },
      { sector: 'utilities', codes: ['221'], keywords: ['electric', 'gas utility', 'water utility'] }
    ];
    
    // SPECIAL CASE: If company is health supplements/wellness, penalize food retail codes
    // (prevents "Baked Goods Retailers" for supplement companies incorrectly tagged as "Food & Beverage")
    if (detectedSectors.has('health_supplements')) {
      const foodRetailCodes = ['445291', '445298', '445110', '445120', '445230', '445292'];
      if (foodRetailCodes.includes(code)) {
        score -= 150; // Heavy penalty for food retail when it's clearly supplements
      }
      // Also penalize general food manufacturing if it's supplements
      if (code.startsWith('311') && !description.includes('supplement') && !description.includes('vitamin')) {
        score -= 100;
      }
    }
    
    // SPECIAL CASE: If company is alcohol/liquor, penalize food retail codes
    // (prevents "Baked Goods Retailers" for liquor retailers)
    if (detectedSectors.has('alcohol_beverage')) {
      const foodRetailCodes = ['445291', '445298', '445110', '445120', '445230', '445292', '456199'];
      if (foodRetailCodes.includes(code)) {
        score -= 150; // Heavy penalty for food retail when it's clearly alcohol
      }
      // Penalize general food manufacturing for alcohol companies
      if (code.startsWith('311') && !description.toLowerCase().includes('beverage')) {
        score -= 100;
      }
    }
    
    for (const penalty of unrelatedPenalties) {
      const hasCodePrefix = penalty.codes.some(prefix => code.startsWith(prefix));
      const hasKeyword = penalty.keywords.some(kw => description.includes(kw));
      const textHasSector = detectedSectors.has(penalty.sector);
      
      // If NAICS is in unrelated sector but text doesn't mention that sector, penalize heavily
      if (hasCodePrefix && hasKeyword && !textHasSector) {
        score -= 100;
      }
    }
    
    // Skip if already heavily penalized
    if (score < -50) {
      return { ...naics, score };
    }
    
    // POSITIVE SCORING: Match relevant terms
    
    // Exact phrase match in description (highest score)
    if (combinedText.includes(description)) {
      score += 100;
    }
    
    // Exact keyword-to-NAICS matching (very high score for specific matches)
    const exactMatches: Record<string, string[]> = {
      '722320': ['catering', 'caterer', 'caterers'],
      '722310': ['food service contractor'],
      '311811': ['bakery', 'bakeries'],
      '445291': ['baked goods store'],
      '312140': ['distillery', 'distilleries'],
      '312120': ['brewery', 'breweries'],
      '312130': ['winery', 'wineries']
    };
    
    if (exactMatches[code]) {
      for (const keyword of exactMatches[code]) {
        if (combinedText.includes(keyword)) {
          score += 50; // Very high boost for exact keyword match
        }
      }
    }
    
    // Multi-word phrase matching (more specific than single words)
    const phrases = [
      'food manufacturing', 'beverage manufacturing', 'bottled water',
      'coffee shop', 'full-service restaurant', 'limited-service restaurant',
      'grocery retail', 'convenience store', 'gas station',
      'software publisher', 'wholesale distribution'
    ];
    
    for (const phrase of phrases) {
      if (description.includes(phrase) && combinedText.includes(phrase)) {
        score += 20;
      }
    }
    
    // Check for key industry terms (more selective)
    const industryTerms = [
      'manufacturing', 'wholesale', 'retail', 'restaurant', 'food', 'beverage',
      'software', 'service', 'distribution', 'processing',
      'brewing', 'roasting', 'baking', 'canning', 'bottling', 'packaging'
    ];
    
    for (const term of industryTerms) {
      if (description.includes(term) && combinedText.includes(term)) {
        score += 8;
      }
    }
    
    // Word overlap scoring (only for significant words)
    const descWords = description.split(/\s+/).filter(w => w.length > 4);
    const textWords = new Set(combinedText.split(/\s+/).filter(w => w.length > 4));
    
    for (const word of descWords) {
      if (textWords.has(word)) {
        score += 3;
      }
    }
    
    // NAICS prefix alignment with detected sectors
    if (detectedSectors.has('food_manufacturing')) {
      if (code.startsWith('311') || code.startsWith('312')) score += 15;
      if (code.startsWith('424')) score += 10; // wholesale food
    }
    
    if (detectedSectors.has('retail')) {
      if (code.startsWith('44') || code.startsWith('45')) score += 15;
    }
    
    if (detectedSectors.has('restaurant')) {
      if (code.startsWith('722')) score += 15;
    }
    
    if (detectedSectors.has('wholesale')) {
      if (code.startsWith('42')) score += 15;
    }
    
    if (detectedSectors.has('software')) {
      if (code.startsWith('511') || code.startsWith('541')) score += 15;
    }
    
    if (detectedSectors.has('health_supplements')) {
      // Boost health supplement stores (446191)
      if (code.startsWith('446191')) score += 25;
      // Boost vitamin/supplement manufacturing (325411, 325412)
      if (code.startsWith('3254')) score += 20;
      // Boost health product wholesale (424210)
      if (code.startsWith('424210')) score += 15;
    }
    
    return { ...naics, score };
  });
  
  // Sort by score and return top candidates (only positive scores)
  const candidates = scoredCodes
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxCandidates);
  
  console.log(`   🔍 Retrieved ${candidates.length} candidate NAICS codes (from ${approvedNaicsCodes.length} total)`);
  console.log(`   🎯 Detected sectors: ${Array.from(detectedSectors).join(', ') || 'none'}`);
  if (candidates.length > 0) {
    console.log(`   📊 Top 3 candidates:`);
    candidates.slice(0, 3).forEach((c, i) => {
      console.log(`      ${i + 1}. ${c.code} - ${c.description} (score: ${c.score})`);
    });
  }
  
  return candidates;
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
   - **CRITICAL**: Use ONLY the provided "APPROVED NAICS LIST" below. Return only 6-digit 2022 codes and their exact descriptions as listed.
   - **DO NOT** use any NAICS codes that are not in the approved list, even if you find them on the web or in your training data.
   - **BEFORE RETURNING**: Search the approved list below to find the exact code and description that matches the company's activities.
   - **MAXIMUM 6 CODES**: Return a MAXIMUM of 6 NAICS codes. Prioritize the PRIMARY business activities.
   - For diversified companies, select the 6 MOST SIGNIFICANT business lines based on:
     * Primary products/services mentioned most prominently on website
     * Core business activities that generate majority of revenue
     * Main industry the company is known for
   - Include codes for different activity types ONLY if they are core to the business:
     * Manufacturing/production activities (if they make/process products)
     * Wholesale/distribution activities (if they distribute to other businesses)
     * Retail/service activities (if they sell directly to consumers)
   - De-duplicate any repeated codes.
   - **EXAMPLE**: For a gas station with convenience store, search the approved list for "Gasoline" or "Convenience" and use the EXACT code found (e.g., 457110), NOT any other code like 447110.
   - **EXAMPLE**: For Kraft Heinz (condiments, sauces, packaged foods), return 3 codes like: 311421 (Fruit/Vegetable Canning), 311999 (Other Food Manufacturing), 424450 (Confectionery Wholesalers) - NOT 16 codes covering every product line.

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
