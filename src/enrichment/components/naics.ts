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
 * Filter NAICS codes using major category matching
 * Returns all codes in relevant NAICS categories based on business description
 */
function retrieveCandidateNAICS(
  businessDescription: string,
  scrapedContent: Map<string, string>,
  maxCandidates: number = 300
): Array<{ code: string; description: string; score: number }> {

  const descLower = businessDescription.toLowerCase();

  // Map keywords to NAICS major categories (2-digit prefixes)
  const categoryMap: Record<string, { prefixes: string[]; keywords: string[] }> = {
    'food_manufacturing': {
      prefixes: ['311'], // Food Manufacturing
      keywords: ['food', 'beverage', 'snack', 'sauce', 'dairy', 'meat', 'beef', 'pork', 'chicken', 'bakery', 'bread', 'cake', 'pastry', 'cheese', 'milk', 'chocolate', 'candy', 'confection', 'canned', 'frozen', 'meal kit', 'meal delivery', 'meal subscription', 'prepared meal']
    },
    'textile': {
      prefixes: ['313', '314', '315', '316'], // Textile, Apparel, Leather
      keywords: ['textile', 'fabric', 'cloth', 'apparel', 'clothing', 'garment', 'leather']
    },
    'paper': {
      prefixes: ['322'], // Paper Manufacturing
      keywords: ['paper', 'cardboard', 'corrugated', 'pulp', 'paperboard']
    },
    'chemical': {
      prefixes: ['325'], // Chemical Manufacturing
      keywords: ['chemical', 'pharmaceutical', 'medicine', 'drug', 'soap', 'detergent', 'cosmetic', 'toiletries']
    },
    'plastics': {
      prefixes: ['326'], // Plastics & Rubber
      keywords: ['plastic', 'polymer', 'foam', 'polystyrene', 'rubber']
    },
    'machinery': {
      prefixes: ['333'], // Machinery Manufacturing
      keywords: ['machinery', 'machine', 'equipment', 'industrial equipment']
    },
    'electronics': {
      prefixes: ['334', '335'], // Electronics, Electrical Equipment
      keywords: ['electronic', 'semiconductor', 'circuit', 'computer', 'electrical', 'appliance']
    },
    'retail': {
      prefixes: ['44', '45'], // Retail Trade
      // Only match if company OPERATES stores, not if they just sell to retail
      keywords: ['operates stores', 'operates convenience', 'retail chain', 'store operator', 'supermarket chain', 'grocery chain', 'convenience store chain', 'runs stores', 'retail operator', 'store owner', 'convenience retailer']
    },
    'wholesale': {
      prefixes: ['42'], // Wholesale Trade
      keywords: ['wholesal', 'distributor', 'distribut', 'supply chain', 'marketer and distributor']
    },
    'restaurant': {
      prefixes: ['722'], // Food Services
      // Only match if company OPERATES food service, not if they just serve food service markets
      keywords: ['operates restaurants', 'operates fast-food', 'fast-food restaurant', 'fast food restaurant', 'restaurant chain', 'cafe chain', 'coffee shop chain', 'catering company', 'food service provider', 'runs restaurants', 'restaurant operator', 'quick service restaurant', 'qsr']
    },
    'agriculture': {
      prefixes: ['111', '112'], // Agriculture, Ranching
      keywords: ['farm', 'farming', 'agriculture', 'crop', 'cattle', 'livestock', 'ranch', 'grow']
    },
    'construction': {
      prefixes: ['236', '237', '238'], // Construction
      keywords: ['construction', 'contractor', 'builder', 'plumbing', 'electrical contractor', 'hvac']
    },
    'auto_repair': {
      prefixes: ['811'], // Repair & Maintenance
      keywords: ['auto repair', 'collision', 'automotive repair', 'mechanic', 'body shop']
    }
  };

  // Detect which categories match the business description
  const matchedPrefixes: Set<string> = new Set();
  const matchedCategories: string[] = [];

  for (const [category, { prefixes, keywords }] of Object.entries(categoryMap)) {
    if (keywords.some(kw => descLower.includes(kw))) {
      prefixes.forEach(p => matchedPrefixes.add(p));
      matchedCategories.push(category);
    }
  }

  // If no categories matched, return all codes (fallback)
  if (matchedPrefixes.size === 0) {
    console.log(`   🔍 No industry categories detected, passing all ${approvedNaicsCodes.length} NAICS codes`);
    return approvedNaicsCodes.map(naics => ({ ...naics, score: 1 }));
  }

  console.log(`   🔍 Detected categories: ${matchedCategories.join(', ')}`);
  console.log(`   📋 Matching NAICS prefixes: ${Array.from(matchedPrefixes).join(', ')}`);

  // Filter codes that start with matched prefixes
  const filtered = approvedNaicsCodes
    .filter(naics => {
      return Array.from(matchedPrefixes).some(prefix => naics.code.startsWith(prefix));
    })
    .map(naics => ({ ...naics, score: 1 }));

  console.log(`   📝 Filtered from ${approvedNaicsCodes.length} to ${filtered.length} candidate NAICS codes`);

  return filtered.slice(0, maxCandidates);
}

const NAICS_SELECTION_PROMPT = `You are assigning accurate 2022 NAICS codes to a company.

**TASK**: Read the business description below and match it to the most accurate NAICS code descriptions from the approved list.

**CRITICAL RULES**:
1. Use ONLY codes from the APPROVED NAICS LIST below - return the exact code and description as listed
2. Focus ONLY on what the company PRODUCES or DOES - ignore mentions of customers/markets/who they sell to
3. Return MAXIMUM 3-6 codes for the PRIMARY business activities only
4. Return JSON array only: [{ "code": "string", "description": "string" }]

**IGNORE CUSTOMER/MARKET MENTIONS**:
The business description may mention target markets like "serves restaurants" or "targets retail" - **IGNORE THESE**.
Only classify based on what the company MAKES or DOES, not who they sell to.

Examples of text to IGNORE:
- ❌ "serves food service markets" (this is who they sell to)
- ❌ "targets restaurants, convenience stores" (these are customers)
- ❌ "used in retail and grocery sectors" (these are distribution channels)

**BUSINESS TYPE IDENTIFICATION** (PRIORITY ORDER - check from top to bottom):

1. **FIRST: Check if they OPERATE stores/restaurants** (highest priority)
   - "operates stores", "operates convenience stores", "retail chain" → Use 44-45xxxx retail codes
   - "operates restaurants", "fast-food chain", "restaurant operator" → Use 722xxx food service codes
   - If they OPERATE retail/restaurants, IGNORE any food/product keywords (they SELL products, don't MAKE them)

2. **SPECIAL CASE: Meal Kit/Delivery Companies** (before general manufacturing)
   - "meal kit", "meal delivery", "meal subscription", "prepared meal delivery"
   - Companies like HelloFresh, Blue Apron, Purple Carrot, Factor
   - These are MANUFACTURERS → Use 311991 (Perishable Prepared Food Manufacturing)
   - They prepare/package meals in facilities and ship to customers
   - NOT food service (722xxx) - they don't operate restaurants/cafeterias/catering services
   - NOT retail (44-45xxxx) - they don't operate physical stores

3. **THEN: Check if they're a manufacturer** (only if NOT operating stores/restaurants)
   - "manufactures", "produces", "factory", "production facility" → Use 31-33xxxx manufacturing codes
   - NEVER use retail/wholesale codes for manufacturers

4. **THEN: Check if they're a wholesaler** (only if NOT manufacturing or retailing)
   - "distributes", "wholesaler", "supply chain" → Use 42xxxx wholesale codes
   - NEVER use manufacturing codes for wholesalers

**KEY RULE**: If description says "operates stores" OR "operates restaurants", they are RETAIL/FOOD SERVICE even if they mention food/products. They SELL, not MAKE.

**PRODUCT/MATERIAL IDENTIFICATION** (for manufacturers):
- "packaging", "containers", "bowls", "cups" → 326xxx (plastics), 322xxx (paper containers)
- "food products", "sauces", "beverages" → 311xxx (food manufacturing)
- "machinery", "equipment" → 333xxx (machinery manufacturing)
- "electronics", "semiconductors" → 334xxx (electronics manufacturing)

**EXAMPLES**:
✅ CORRECT:
- "Manufacturer of food packaging products. Serves food service, restaurants, retail."
  → 326199 (Plastics Packaging), 322215 (Food Containers)
  → Reasoning: Company MAKES packaging. Ignore "food service, restaurants, retail" (those are customers)

- "Operates convenience stores selling fuel, snacks, and beverages."
  → 445131 (Convenience Retailers), 447110 (Gasoline Stations with Convenience Stores)
  → Reasoning: Company OPERATES STORES. They SELL products (snacks/beverages), don't MAKE them. Use retail codes.

- "Operates fast-food restaurants specializing in burgers and fries."
  → 722513 (Limited-Service Restaurants)
  → Reasoning: Company OPERATES RESTAURANTS. Use food service codes, not food manufacturing.

❌ INCORRECT:
- "Operates convenience stores selling snacks and beverages."
  → ❌ 311919 (Snack Food Manufacturing), 312111 (Beverage Manufacturing) - WRONG! They don't MAKE food
  → ✅ 445131 (Convenience Retailers) - CORRECT! They OPERATE STORES

#APPROVED NAICS LIST#
{{APPROVED_NAICS_LIST}}

#COMPANY INFORMATION#
Domain: {{DOMAIN}}
Company Name: {{COMPANY_NAME}}
Business Description: {{BUSINESS_DESCRIPTION}}

**YOUR TASK**: Extract what the company PRODUCES/DOES (ignore customers/markets), then match to NAICS codes.
Return ONLY valid JSON array.`;

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

  // RETRIEVAL STEP: Get top candidate NAICS codes based on keywords
  // This reduces token usage by filtering from ~1000 codes to ~100-200 relevant codes
  const candidates = retrieveCandidateNAICS(businessDescription, scrapedContent, 200);
  
  if (candidates.length === 0) {
    console.log(`   ⚠️  No candidate NAICS codes found - using fallback`);
    return {
      naicsCodes: [],
      confidence: 'low',
      reasoning: 'No relevant NAICS codes found in candidate retrieval',
      costUsd: 0
    };
  }
  
  // Format candidate NAICS list for prompt
  const approvedListText = candidates
    .map(c => `${c.code} - ${c.description}`)
    .join('\n');

  console.log(`   📝 Sending ${candidates.length} filtered candidate codes to AI (reduced from ${approvedNaicsCodes.length} total)`);
  
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
    console.log(`   🤖 AI returned: ${cleanText.substring(0, 200)}`); // Debug: show what AI returned
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

    // Codes that require specific keywords in business description to be valid
    // This prevents AI from incorrectly assigning codes based on target markets vs actual business
    const RESTRICTED_CODES: Record<string, string[]> = {
      '311111': ['pet food', 'dog food', 'cat food', 'pet treats', 'animal feed', 'pet nutrition'],
      '311119': ['pet food', 'dog food', 'cat food', 'pet treats', 'animal feed', 'pet nutrition'],
    };

    const descLower = businessDescription.toLowerCase();

    // BLOCKING RULES: Prevent common category mismatches based on business type indicators
    // Use context-aware patterns to avoid false positives (e.g., "serves retail" vs "operates retail stores")
    const BLOCKING_RULES: Array<{
      pattern: RegExp;
      antiPattern?: RegExp; // If this matches, DON'T block
      blockedPrefixes: string[];
      reason: string
    }> = [
      {
        // If description says "manufacturer" or "producer", block wholesaler codes
        // But NOT if they also say "distributor" (some companies do both)
        pattern: /\b(manufactur|producer|production|factory|plant)\b/i,
        antiPattern: /\b(distribut|wholesal)\b/i,
        blockedPrefixes: ['42'], // All wholesale trade (42xxxx)
        reason: 'company is a manufacturer, not a wholesaler'
      },
      {
        // If description says "packaging" or "container", block food manufacturing codes
        pattern: /\b(packaging|container|box|bag|wrapper|bottle)\b/i,
        blockedPrefixes: ['3119'], // Food manufacturing (311xxx)
        reason: 'company makes packaging, not food products'
      },
      {
        // If description says "wholesaler" or "distributor" (NOT "distribution"),  block manufacturing codes
        // But NOT if they also say "manufacturer" (some companies do both)
        pattern: /\b(wholesal|distribut(?!ion))\b/i,
        antiPattern: /\b(manufactur|producer|production|factory)\b/i,
        blockedPrefixes: ['31', '32', '33'], // All manufacturing (31-33xxxx)
        reason: 'company is a wholesaler/distributor, not a manufacturer'
      },
      {
        // ONLY block if company OPERATES retail stores, not if they just SELL TO retail
        // Look for: "operates stores", "retail chain", "store operator", "runs stores"
        // NOT: "serves retail", "targets retail", "retail markets", "retail customers"
        pattern: /\b(operates? stores?|retail chain|store operator|runs? stores?|operates? retail|retail operator)\b/i,
        blockedPrefixes: ['31', '32', '33', '42'], // Manufacturing and wholesale
        reason: 'company is a retailer, not a manufacturer/wholesaler'
      },
      {
        // Block food service codes (722) for meal kit/delivery companies
        // Companies like HelloFresh, Blue Apron, Purple Carrot are MANUFACTURERS (311991)
        // They prepare/package meals for delivery, not operate restaurants/cafeterias
        pattern: /\b(meal kit|meal delivery|meal subscription|prepared meal delivery|meal prep delivery)\b/i,
        blockedPrefixes: ['722'], // All food services (722xxx)
        reason: 'company is a meal kit manufacturer (311991), not a food service operator'
      }
    ];

    for (const item of parsed) {
      const approved = approvedNaicsCodes.find(n => n.code === item.code);
      if (approved) {
        // Check blocking rules first
        let blocked = false;
        for (const rule of BLOCKING_RULES) {
          // Check if pattern matches
          if (rule.pattern.test(businessDescription)) {
            // If antiPattern exists and matches, skip this blocking rule
            if (rule.antiPattern && rule.antiPattern.test(businessDescription)) {
              continue; // Don't block - company does both activities
            }
            // Apply blocking rule
            if (rule.blockedPrefixes.some(prefix => item.code.startsWith(prefix))) {
              console.log(`   🚫 NAICS code ${item.code} (${approved.description}) blocked - ${rule.reason}`);
              blocked = true;
              break;
            }
          }
        }
        if (blocked) continue;

        // Check if this is a restricted code (requires specific keywords)
        const requiredKeywords = RESTRICTED_CODES[item.code];
        if (requiredKeywords) {
          const hasKeyword = requiredKeywords.some(kw => descLower.includes(kw));
          if (!hasKeyword) {
            console.log(`   ⚠️  NAICS code ${item.code} (${approved.description}) blocked - requires keywords: ${requiredKeywords.join(', ')}`);
            continue;
          }
        }

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
