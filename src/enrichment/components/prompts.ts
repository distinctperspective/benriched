// Pass 1 Prompt - Web Search for initial company data
export const PASS1_PROMPT = `What is this company's annual revenue and how many employees do they have?

Search their website, Forbes, press releases, news articles, and SEC filings for revenue.
Check LinkedIn and their website for employee count.
For PUBLIC companies, check SEC 10-K filings.
Mark ZoomInfo/Growjo/Owler figures as estimates.

After finding the data, format as JSON:
{
  "company_name": "Company Name",
  "parent_company": "Parent company if subsidiary, otherwise null",
  "headquarters": {"city": "City", "state": "State", "country": "Country", "country_code": "US"},
  "urls_to_crawl": ["https://company.com", "https://linkedin.com/company/..."],
  "revenue_found": [
    {"amount": "$1.4 billion", "source": "company website", "year": "2024", "is_estimate": false}
  ],
  "employee_count_found": {"amount": "4,000", "source": "LinkedIn"}
}

Return ALL revenue figures found. Return ONLY valid JSON.`;

// Pass 2 Prompt - Content Analysis
export const PASS2_PROMPT = `You are a data extraction specialist. Analyze the provided scraped web content and extract structured company information.

Extract the following fields:
- **business_description**: 2-4 sentence comprehensive description of what the company does. CRITICAL: Identify their PRIMARY business activity (what they DO, not who they sell to):
  * If they MAKE/PRODUCE products (have factories, production facilities, roast, brew, manufacture), state: "manufacturer of [products]" or "producer of [products]"
  * If they operate PHYSICAL STORES where consumers shop, state: "retailer of [products]" or "operates [type] stores"
  * If they DISTRIBUTE products to other businesses (no manufacturing, no retail stores), state: "wholesaler of [products]" or "distributor of [products]"
  * If they operate RESTAURANTS/CAFES where customers eat, state: "operates [type] restaurants" or "provides [type] food service"
  IMPORTANT: Use "serving" or "targeting" when describing customer markets, NOT "catering to" (which implies catering business)
  NOTE: "Sells to retail markets" means they are a MANUFACTURER/WHOLESALER, NOT a retailer
  Include: specific products/services, target markets, and key differentiators
- **city**: Main office or HQ city of THIS SPECIFIC ENTITY (not the parent company)
- **state**: For US companies, full state name (e.g., "Massachusetts", "California"); for non-US, main region or null
- **hq_country**: 2-letter ISO country code of THIS SPECIFIC ENTITY's HQ (e.g., "US", "CA", "DE", "GR")
- **is_us_hq**: Boolean - true if THIS ENTITY's global HQ is in the United States
- **is_us_subsidiary**: Boolean - true if EITHER:
  1. This company has US operations/subsidiary (even if HQ is outside US), OR
  2. This is a franchisee/subsidiary of a US-based parent company (even if located outside US)
  
  Examples:
  - Solina (France HQ) has Solina USA → is_us_subsidiary: true
  - Ajinomoto (Japan HQ) has Ajinomoto Foods North America → is_us_subsidiary: true
  - Cinnabon Greece (Greece HQ, franchisee of US-based Cinnabon) → is_us_subsidiary: true
  - McDonald's Japan (Japan HQ, subsidiary of US-based McDonald's) → is_us_subsidiary: true
- **linkedin_url**: Official LinkedIn company page URL (null if not found)
- **company_revenue**: Annual revenue using ONLY these exact bands:
  "0-500K", "500K-1M", "1M-5M", "5M-10M", "10M-25M", "25M-75M", 
  "75M-200M", "200M-500M", "500M-1B", "1B-10B", "10B-100B", "100B-1T"
  (null if not found)
  
  **CRITICAL FOR REVENUE - Show your work:** 
  - Extract ALL revenue figures from BOTH web search context AND scraped content
  - Normalize amounts to USD (e.g., "$42M" = 42,000,000)
  - **PRIORITY BY SOURCE AUTHORITY** (highest to lowest):
    1. SEC filing / annual report / audited financial statement
    2. Investor relations / earnings release
    3. Company press release
    4. Reputable media (Forbes, Bloomberg, Reuters, WSJ)
    5. Wikipedia (as pointer, not primary source)
    6. Directory / estimate sites (Growjo, Owler, Zippia, ZoomInfo, RocketReach)
  - **SCOPE-AWARE CONFLICT DETECTION (CRITICAL — READ CAREFULLY)**:
    * Check if revenue figures have "scope" labels (operating_company vs ultimate_parent)
    * **HARD RULE: NEVER use ultimate_parent revenue as the operating company's revenue.**
      Parent revenue ($3.3B from Rich Products) is NOT SeaPak's revenue ($6.5M).
      If the only operating_company figures are from estimate sites, USE THEM — they are correct for this entity.
      Source authority ranking ONLY applies within the SAME scope.
    * ONLY apply 5x conflict rule within the SAME scope
    * Subsidiary $200M vs Parent $11B is NOT a conflict - they're different entities
    * If figures are for different scopes, ALWAYS use the operating_company figure
    * If only ultimate_parent revenue is available and NO operating_company revenue exists, set company_revenue to null
  - If multiple figures exist in SAME scope, use the most recent and highest authority source
  - If conflicting figures within same scope differ by more than 5x, set company_revenue to null
  - If only vague phrases like "multi-million" or "8-figure", choose the LOWEST compatible band
  - If no explicit figure found, set company_revenue to null (do NOT estimate from employee count)
  - Map your normalized amount to the appropriate band based on the range
  - Example: $42M → "25M-75M" band, $11.6B → "10B-100B" band
- **company_size**: Employee count using ONLY these exact bands:
  "0-1 Employees", "2-10 Employees", "11-50 Employees", "51-200 Employees", 
  "201-500 Employees", "501-1,000 Employees", "1,001-5,000 Employees", 
  "5,001-10,000 Employees", "10,001+ Employees"
  
  **IMPORTANT FOR COMPANY SIZE:**
  - Check Glassdoor and Indeed pages for employee count ranges
  - Glassdoor shows "Company Size" field and employee reviews
  - Indeed shows number of open jobs and company reviews
  - LinkedIn shows employee count in the "About" section
  - Cross-reference multiple sources for accuracy
- **naics_codes_6_digit**: Array of up to 3 objects with code and description. Example:
  [
    {"code": "311991", "description": "Perishable Prepared Food Manufacturing"},
    {"code": "424490", "description": "Other Grocery and Related Products Merchant Wholesalers"}
  ]
- **source_urls**: Array of URLs you used to extract information (include Glassdoor/Indeed if available)
- **quality**: Object containing confidence and reasoning for four key data points:
  - location: confidence and reasoning for city/state/country
  - revenue: confidence and reasoning for revenue band selection
  - size: confidence and reasoning for company size band selection
  - industry: confidence and reasoning for NAICS code selection

Return ONLY valid JSON with revenue evidence shown in reasoning:
{
  "business_description": "...",
  "city": "San Francisco",
  "state": "California",
  "hq_country": "US",
  "is_us_hq": true,
  "is_us_subsidiary": false,
  "linkedin_url": "https://www.linkedin.com/company/xxx/",
  "company_revenue": "10B-100B",
  "company_size": "51-200 Employees",
  "naics_codes_6_digit": [
    {"code": "311991", "description": "Perishable Prepared Food Manufacturing"},
    {"code": "424490", "description": "Other Grocery and Related Products Merchant Wholesalers"}
  ],
  "source_urls": ["https://...", "https://..."],
  "quality": {
    "location": {"confidence": "high", "reasoning": "Found on company website About page"},
    "revenue": {"confidence": "high", "reasoning": "Found explicit revenue of $42M in 2023 press release, maps to 25M-75M band"},
    "size": {"confidence": "high", "reasoning": "Confirmed from Indeed and Glassdoor employee counts"},
    "industry": {"confidence": "high", "reasoning": "NAICS codes determined from company's primary business activities"}
  }
}

IMPORTANT:
- Only include LinkedIn URL if you actually found it in the scraped content
- Determine NAICS codes based on what the company actually does
- Return null for fields not found, not "unknown"
- Include all URLs you used to extract information in source_urls`;
