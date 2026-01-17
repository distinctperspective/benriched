import { Hono } from 'hono';
import { gateway } from '@ai-sdk/gateway';
import { createClient } from '@supabase/supabase-js';
import { generateText } from 'ai';

const SEARCH_MODEL_ID = 'perplexity/sonar-pro';

// Core TAM NAICS codes
const CORE_TAM_NAICS = [
  '311991', // Perishable Prepared Food Manufacturing
  '311612', // Meat Processed from Carcasses
  '311611', // Animal Slaughtering
  '311615', // Poultry Processing
  '311999', // All Other Miscellaneous Food Manufacturing
];

const NAICS_DESCRIPTIONS: Record<string, string> = {
  '311991': 'Perishable Prepared Food Manufacturing',
  '311612': 'Meat Processed from Carcasses',
  '311611': 'Animal Slaughtering',
  '311615': 'Poultry Processing',
  '311999': 'All Other Miscellaneous Food Manufacturing',
};

interface DiscoveredCompany {
  name: string;
  domain?: string;
  location?: string;
  estimatedEmployees?: string;
  naicsCode: string;
  source: string;
}

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ''
);

async function getExistingDomains(): Promise<Set<string>> {
  const { data } = await supabase
    .from('companies')
    .select('domain')
    .limit(10000);

  return new Set(data?.map(c => c.domain.toLowerCase()) || []);
}

async function discoverCoreTAMCompanies(
  naicsCode: string,
  strategy: 'industry' | 'geographic' | 'supply-chain' | 'regulatory'
): Promise<DiscoveredCompany[]> {
  const description = NAICS_DESCRIPTIONS[naicsCode];

  let prompt = '';

  switch (strategy) {
    case 'industry':
      prompt = `List 20 major US companies in the ${description} industry (NAICS ${naicsCode}). 
Include company names, headquarters location, and estimated employee count. 
Format each as: Company Name | Location | Employee Count`;
      break;

    case 'geographic':
      prompt = `List 20 major ${description} companies (NAICS ${naicsCode}) in California, Illinois, Texas, Iowa, and North Carolina.
Include company names, headquarters location, and estimated employee count.
Format each as: Company Name | Location | Employee Count`;
      break;

    case 'supply-chain':
      prompt = `Which ${description} companies (NAICS ${naicsCode}) supply to major retailers like Walmart, Costco, and regional grocery chains?
List 20 companies with names, locations, and estimated employee counts.
Format each as: Company Name | Location | Employee Count`;
      break;

    case 'regulatory':
      prompt = `List 20 ${description} companies (NAICS ${naicsCode}) that are FSMA compliant and SQF certified.
Include company names, headquarters location, and estimated employee count.
Format each as: Company Name | Location | Employee Count`;
      break;
  }

  try {
    const { text } = await generateText({
      model: gateway(SEARCH_MODEL_ID),
      prompt,
      temperature: 0.1,
    });

    // Parse results
    const companies: DiscoveredCompany[] = [];
    const lines = text.split('\n').filter(l => l.trim());

    for (const line of lines) {
      // Try to parse "Company Name | Location | Employee Count" format
      const parts = line.split('|').map(p => p.trim());
      if (parts.length >= 1 && parts[0].length > 0) {
        companies.push({
          name: parts[0],
          location: parts[1] || undefined,
          estimatedEmployees: parts[2] || undefined,
          naicsCode,
          source: strategy,
        });
      }
    }

    return companies;
  } catch (error) {
    console.error(`Error discovering companies for ${naicsCode} (${strategy}):`, error);
    return [];
  }
}

async function findDomainForCompany(companyName: string): Promise<string | null> {
  try {
    const { text } = await generateText({
      model: gateway(SEARCH_MODEL_ID),
      prompt: `What is the official website domain for ${companyName}? Return only the domain (e.g., example.com), nothing else.`,
      temperature: 0.1,
    });

    const domain = text.trim().toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/$/, '');
    
    // Validate it looks like a domain
    if (domain.includes('.') && !domain.includes(' ')) {
      return domain;
    }
    return null;
  } catch (error) {
    console.error(`Error finding domain for ${companyName}:`, error);
    return null;
  }
}

const router = new Hono();

router.post('/', async (c) => {
  const { naicsCode, strategy = 'industry', limit = 10 } = await c.req.json();

  if (!naicsCode) {
    return c.json({ error: 'naicsCode is required' }, 400);
  }

  if (!CORE_TAM_NAICS.includes(naicsCode)) {
    return c.json({ 
      error: `Invalid NAICS code. Must be one of: ${CORE_TAM_NAICS.join(', ')}` 
    }, 400);
  }

  try {
    console.log(`[Discover TAM] Starting discovery for NAICS ${naicsCode} using ${strategy} strategy`);

    // Get existing domains to avoid duplicates
    const existingDomains = await getExistingDomains();
    console.log(`[Discover TAM] Found ${existingDomains.size} existing domains in database`);

    // Discover companies
    const discovered = await discoverCoreTAMCompanies(naicsCode, strategy as any);
    console.log(`[Discover TAM] Discovered ${discovered.length} companies`);

    // Find domains and filter out existing ones
    const newCompanies = [];
    for (const company of discovered.slice(0, limit)) {
      const domain = await findDomainForCompany(company.name);
      
      if (domain && !existingDomains.has(domain.toLowerCase())) {
        newCompanies.push({
          ...company,
          domain,
        });
      } else if (domain) {
        console.log(`[Discover TAM] Skipping ${company.name} - already in database`);
      }

      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`[Discover TAM] Found ${newCompanies.length} new companies not in database`);

    return c.json({
      success: true,
      naicsCode,
      strategy,
      discovered: newCompanies.length,
      companies: newCompanies,
    });
  } catch (error) {
    console.error('[Discover TAM] Error:', error);
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

export default router;
