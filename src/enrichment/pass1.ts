import { generateText } from 'ai';
import { Pass1Result } from '@benriched/types';

const PASS1_PROMPT = `You are a research assistant. Given a company domain, identify the best URLs to scrape AND extract key financial data you find during your search.

Return a JSON object:
{
  "company_name": "Best guess at company name",
  "parent_company": "Parent company name if this is a subsidiary, otherwise null",
  "headquarters": {
    "city": "San Francisco",
    "state": "California",
    "country": "United States",
    "country_code": "US"
  },
  "urls_to_crawl": [
    "https://example.com",
    "https://example.com/about",
    "https://www.linkedin.com/company/example",
    "https://www.zoominfo.com/c/example/123456",
    "https://www.crunchbase.com/organization/example",
    "https://en.wikipedia.org/wiki/Example_Company"
  ],
  "revenue_found": {
    "amount": "$4.2 billion",
    "source": "Colgate-Palmolive 2023 Annual Report",
    "year": "2023"
  },
  "employee_count_found": {
    "amount": "2,300",
    "source": "Wikipedia"
  }
}

Guidelines:
- Include the main company website, LinkedIn, ZoomInfo, Crunchbase, Wikipedia
- **ALSO include Glassdoor and Indeed** - these have valuable employee count, salary data, and company reviews
- Include LinkedIn company page URL if you can find it
- **CRITICAL for LinkedIn:** 
  - Company names with apostrophes (like "Chef's Plate") often have apostrophes in the LinkedIn URL slug (e.g., linkedin.com/company/chef's-plate NOT linkedin.com/company/chefs-plate)
  - ALWAYS verify the LinkedIn URL by visiting it or searching "[company name] LinkedIn" 
  - Check that the LinkedIn page shows the SAME website domain, location, and industry as the company you're researching
  - If unsure, do NOT include a LinkedIn URL - it's better to return no URL than a wrong one

**CRITICAL - YOU MUST SEARCH FOR REVENUE (Multiple Sources Required):**
Step 1: Search web for "[company name] revenue" AND "[company name] annual sales"
Step 2: Check ZoomInfo, Growjo, Owler, Dun & Bradstreet, IBISWorld for revenue estimates
Step 3: Look for press releases, investor reports, or news articles with revenue figures
Step 4: If SUBSIDIARY, search "[parent company] [subsidiary name] segment revenue" and "[parent company] annual report"
Step 5: Record ALL revenue figures you find (not just one), with source and year

- Return revenue_found as an ARRAY of all figures found, not just one
- Each entry must have: amount (string), source (string), year (string), is_estimate (boolean)
- Example: [{"amount": "$42M", "source": "ZoomInfo", "year": "2023", "is_estimate": true}, {"amount": "$38M", "source": "Press release", "year": "2022", "is_estimate": false}]
- For private companies, third-party estimates are acceptable - mark is_estimate: true
- If you find employee count, include it in "employee_count_found"
- If no revenue found after exhaustive search, set revenue_found to empty array []

- Return ONLY valid JSON, no markdown`;

export { PASS1_PROMPT };

export async function pass1_identifyUrls(domain: string, model: any): Promise<Pass1Result> {
  console.log(`\n📋 Pass 1: Identifying URLs to crawl...`);
  
  let text: string = '';
  
  try {
    const response = await generateText({
      model,
      system: PASS1_PROMPT,
      prompt: `Research the company at domain: ${domain}

REQUIRED STEPS:
1. First, identify the company name from the domain
2. Search for "[company name] revenue" to find revenue figures
3. Search for "[company name] employees" to find employee count
4. Check ZoomInfo, Growjo, Owler for revenue/employee estimates
5. Return the URLs to crawl AND any revenue/employee data you found

Return the JSON with company info, URLs, and any revenue/employee data found.`,
      temperature: 0.1,
    });
    
    text = response.text;
    console.log(`   AI Response length: ${text?.length || 0} chars`);
    
    if (!text || text.trim().length === 0) {
      console.log(`   ⚠️  Empty response from AI Gateway`);
      return {
        company_name: domain.replace(/\.(com|io|co|org|net)$/, ''),
        urls_to_crawl: [`https://${domain}`, `https://${domain}/about`, `https://${domain}/contact`],
        search_queries: [`${domain} company headquarters`, `${domain} company revenue employees`]
      };
    }
    
    const cleanText = text.trim().replace(/^```json?\n?/i, '').replace(/\n?```$/i, '');
    const result = JSON.parse(cleanText);
    console.log(`   ✅ Found ${result.urls_to_crawl?.length || 0} URLs to crawl`);
    
    if (result.headquarters?.country_code) {
      console.log(`   🌍 HQ found: ${result.headquarters.city || ''}, ${result.headquarters.country_code}`);
    }
    if (Array.isArray(result.revenue_found) && result.revenue_found.length > 0) {
      const first = result.revenue_found[0];
      console.log(`   💰 Revenue found: ${first.amount} (source: ${first.source}${first.year ? `, ${first.year}` : ''})`);
    }
    if (result.employee_count_found?.amount) {
      console.log(`   👥 Employees found: ${result.employee_count_found.amount} (source: ${result.employee_count_found.source})`);
    }
    if (result.parent_company) {
      console.log(`   🏢 Parent company: ${result.parent_company}`);
    }
    
    return result;
  } catch (error) {
    console.error(`   ❌ Pass 1 error:`, error instanceof Error ? error.message : error);
    return {
      company_name: domain.replace(/\.(com|io|co|org|net)$/, ''),
      urls_to_crawl: [`https://${domain}`, `https://${domain}/about`, `https://${domain}/contact`],
      search_queries: [`${domain} company headquarters`, `${domain} company revenue employees`]
    };
  }
}

export async function pass1_identifyUrlsStrict(domain: string, model: any, previousCompanyName: string): Promise<Pass1Result> {
  console.log(`\n📋 Pass 1 (strict): Re-validating company identity...`);

  const { text } = await generateText({
    model,
    system: PASS1_PROMPT,
    prompt: `Research the company at domain: ${domain}

IMPORTANT:
- A previous attempt identified the company as: ${previousCompanyName}
- You MUST confirm the company name from the actual website content of ${domain} (homepage/footer/about)
- If the website clearly indicates a different company name, use the website-indicated name

REQUIRED STEPS:
1. Use site:${domain} searches for "about", "contact", "copyright", and the company name shown on the site
2. Only then search revenue for the confirmed company name
3. Return the JSON with company info, URLs, and any revenue/employee data found.
`,
    temperature: 0.1,
  });

  try {
    const cleanText = text.trim().replace(/^```json?\n?/i, '').replace(/\n?```$/i, '');
    return JSON.parse(cleanText);
  } catch {
    return {
      company_name: domain.replace(/\.(com|io|co|org|net)$/, ''),
      urls_to_crawl: [`https://${domain}`, `https://${domain}/about`, `https://${domain}/contact`],
      search_queries: [`site:${domain} about`, `site:${domain} contact`, `${domain} company revenue employees`],
      revenue_found: [],
    };
  }
}
