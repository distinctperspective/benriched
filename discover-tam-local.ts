import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { createClient } from '@supabase/supabase-js';
import { gateway } from '@ai-sdk/gateway';
import { generateText } from 'ai';

// Load environment variables
dotenv.config({ path: '.env.local' });

const SEARCH_MODEL_ID = 'perplexity/sonar-pro';

// Load target ICP NAICS codes from database
let CORE_TAM_NAICS: string[] = [];
let NAICS_DESCRIPTIONS: Record<string, string> = {};

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
  process.env.SUPABASE_ANON_KEY || ''
);

async function loadTargetNAICSCodes(): Promise<void> {
  const { data, error } = await supabase
    .from('naics_codes')
    .select('naics_code, naics_industry_title')
    .eq('target_icp', true)
    .order('naics_code');

  if (error) {
    console.error('Error loading NAICS codes:', error);
    throw error;
  }

  if (data) {
    CORE_TAM_NAICS = data.map(n => n.naics_code);
    NAICS_DESCRIPTIONS = data.reduce((acc, n) => {
      acc[n.naics_code] = n.naics_industry_title;
      return acc;
    }, {} as Record<string, string>);
    console.log(`✅ Loaded ${CORE_TAM_NAICS.length} target ICP NAICS codes from database`);
  }
}

async function getExistingDomains(): Promise<Set<string>> {
  const domains = new Set<string>();

  // Load all domains from database
  const { data } = await supabase
    .from('companies')
    .select('domain')
    .limit(10000);

  data?.forEach(c => domains.add(c.domain.toLowerCase()));

  return domains;
}

async function discoverCoreTAMCompanies(
  naicsCode: string,
  strategy: 'industry' | 'geographic' | 'supply-chain' | 'regulatory' | 'regional' | 'private-label' | 'co-manufacturers'
): Promise<DiscoveredCompany[]> {
  const description = NAICS_DESCRIPTIONS[naicsCode];

  let prompt = '';

  switch (strategy) {
    case 'industry':
      prompt = `List 50 major US companies in the ${description} industry (NAICS ${naicsCode}). 
Include company names, headquarters location, and estimated employee count. 
Format each as: Company Name | Location | Employee Count`;
      break;

    case 'geographic':
      prompt = `List 50 ${description} companies (NAICS ${naicsCode}) in California, Illinois, Texas, Iowa, North Carolina, Minnesota, Wisconsin, and Pennsylvania.
Include company names, headquarters location, and estimated employee count.
Format each as: Company Name | Location | Employee Count`;
      break;

    case 'supply-chain':
      prompt = `Which ${description} companies (NAICS ${naicsCode}) supply to major retailers like Walmart, Costco, Target, Amazon Fresh, and regional grocery chains?
List 50 companies with names, locations, and estimated employee counts.
Format each as: Company Name | Location | Employee Count`;
      break;

    case 'regulatory':
      prompt = `List 50 ${description} companies (NAICS ${naicsCode}) that are FSMA compliant and SQF/BRC certified.
Include company names, headquarters location, and estimated employee count.
Format each as: Company Name | Location | Employee Count`;
      break;

    case 'regional':
      prompt = `List 50 regional and mid-market ${description} companies (NAICS ${naicsCode}) with 50-5000 employees.
Include company names, headquarters location, and estimated employee count.
Format each as: Company Name | Location | Employee Count`;
      break;

    case 'private-label':
      prompt = `List 50 private label and contract ${description} manufacturers (NAICS ${naicsCode}) that produce for retailers and food brands.
Include company names, headquarters location, and estimated employee count.
Format each as: Company Name | Location | Employee Count`;
      break;

    case 'co-manufacturers':
      prompt = `List 50 co-manufacturers and contract manufacturers in the ${description} sector (NAICS ${naicsCode}).
Include company names, headquarters location, and estimated employee count.
Format each as: Company Name | Location | Employee Count`;
      break;
  }

  try {
    console.log(`\n🔍 [${strategy}] Searching for ${description} companies...`);
    const { text } = await generateText({
      model: gateway(SEARCH_MODEL_ID),
      prompt,
      temperature: 0.1,
    });

    // Parse results - extract company names from various formats
    const companies: DiscoveredCompany[] = [];
    const lines = text.split('\n').filter(l => l.trim());

    for (const line of lines) {
      // Skip headers, empty lines, and non-company lines
      if (line.includes('Company') || line.includes('---') || line.length < 3) continue;
      if (line.match(/^(List|Format|Include|Which|The|However|To obtain|No |Limited|Search|The search|Results|Note|Source)/i)) continue;

      // Remove markdown formatting and citations
      let cleanLine = line.replace(/\[.*?\]/g, '').trim();
      
      // Skip lines that are clearly not company names
      if (cleanLine.includes('gov.uk') || cleanLine.includes('service.gov') || cleanLine.includes('data') || 
          cleanLine.includes('supply chain') || cleanLine.includes('retail') || cleanLine.includes('information')) continue;

      // Try to parse "Company Name | Location | Employee Count" format
      if (cleanLine.includes('|')) {
        const parts = cleanLine.split('|').map(p => p.trim());
        if (parts.length >= 1 && parts[0].length > 3) {
          // Clean company name
          let companyName = parts[0]
            .replace(/^[-•*]\s*/, '') // Remove bullets
            .replace(/^[0-9]+\.\s*/, '') // Remove numbering
            .replace(/\*\*/g, '') // Remove bold markers
            .replace(/^-\s*/, '') // Remove dashes
            .trim();
          
          // Skip if it looks like a sentence or non-company text
          if (companyName.length > 3 && 
              !companyName.match(/^(The|A|An|List|Format|Include|No|Limited|Search|Results)/i) &&
              !companyName.includes('supply chain') &&
              !companyName.includes('retail') &&
              !companyName.includes('data')) {
            companies.push({
              name: companyName,
              location: parts[1]?.replace(/\*\*/g, '').trim() || undefined,
              estimatedEmployees: parts[2]?.replace(/\*\*/g, '').trim() || undefined,
              naicsCode,
              source: strategy,
            });
          }
        }
      } else if (cleanLine.match(/^[-•*]\s*\*\*.*?\*\*/)) {
        // Handle "- **Company Name**" format
        const match = cleanLine.match(/^[-•*]\s*\*\*([^*]+)\*\*/);
        if (match && match[1].length > 3 && !match[1].match(/^(The|A|An|List|No|Limited)/i)) {
          companies.push({
            name: match[1].trim(),
            location: undefined,
            estimatedEmployees: undefined,
            naicsCode,
            source: strategy,
          });
        }
      }
    }

    // Deduplicate by name
    const uniqueCompanies = new Map<string, DiscoveredCompany>();
    companies.forEach(c => {
      const key = c.name.toLowerCase();
      if (!uniqueCompanies.has(key)) {
        uniqueCompanies.set(key, c);
      }
    });

    console.log(`   Found ${uniqueCompanies.size} unique companies`);
    return Array.from(uniqueCompanies.values());
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

    let domain = text.trim().toLowerCase()
      .replace(/^(https?:\/\/)?(www\.)?/, '') // Remove protocol and www
      .replace(/\/$/, '') // Remove trailing slash
      .replace(/\[.*?\]/g, '') // Remove citations
      .trim();
    
    // Validate it looks like a domain
    if (domain.includes('.') && !domain.includes(' ') && domain.length > 4) {
      return domain;
    }
    return null;
  } catch (error) {
    console.error(`Error finding domain for ${companyName}:`, error);
    return null;
  }
}

async function discoverTAM(
  naicsCode: string,
  strategy: string = 'all',
  limit: number = 50
) {
  // Load NAICS codes if not already loaded
  if (CORE_TAM_NAICS.length === 0) {
    await loadTargetNAICSCodes();
  }

  if (!CORE_TAM_NAICS.includes(naicsCode)) {
    console.error(`Invalid NAICS code. Must be one of the ${CORE_TAM_NAICS.length} target ICP codes in the database.`);
    console.error(`Use --list to see all available NAICS codes.`);
    return;
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`🎯 Discovering Core TAM Companies`);
  console.log(`NAICS: ${naicsCode} (${NAICS_DESCRIPTIONS[naicsCode]})`);
  console.log(`Strategy: ${strategy}`);
  console.log(`Limit: ${limit}`);
  console.log(`${'='.repeat(70)}`);

  // Get existing domains from database
  const existingDomains = await getExistingDomains();
  console.log(`\n📊 Excluding ${existingDomains.size} domains already in database`);

  // Determine which strategies to use
  const strategies: Array<'industry' | 'geographic' | 'supply-chain' | 'regulatory' | 'regional' | 'private-label' | 'co-manufacturers'> = 
    strategy === 'all' 
      ? ['industry', 'geographic', 'supply-chain', 'regulatory', 'regional', 'private-label', 'co-manufacturers']
      : [strategy as any];

  // Discover companies from all strategies in parallel
  console.log(`\n🔍 Running ${strategies.length} discovery strategies in parallel...`);
  const allDiscovered: DiscoveredCompany[] = [];
  
  const results = await Promise.all(
    strategies.map(s => discoverCoreTAMCompanies(naicsCode, s))
  );

  results.forEach(companies => {
    allDiscovered.push(...companies);
  });

  // Deduplicate by company name
  const uniqueCompanies = new Map<string, DiscoveredCompany>();
  allDiscovered.forEach(c => {
    const key = c.name.toLowerCase();
    if (!uniqueCompanies.has(key)) {
      uniqueCompanies.set(key, c);
    }
  });

  const discovered = Array.from(uniqueCompanies.values());
  console.log(`\n✅ Total unique companies discovered: ${discovered.length}`);

  // Find domains and filter out existing ones
  const newCompanies: DiscoveredCompany[] = [];
  console.log(`\n🔗 Looking up domains (this may take a while)...`);
  
  for (let i = 0; i < Math.min(limit, discovered.length); i++) {
    const company = discovered[i];
    process.stdout.write(`   [${i + 1}/${Math.min(limit, discovered.length)}] ${company.name.substring(0, 40)}... `);
    
    const domain = await findDomainForCompany(company.name);
    
    if (domain) {
      // Normalize domain for comparison
      const normalizedDomain = domain.toLowerCase()
        .replace(/^www\./, '')
        .replace(/\/$/, '');
      
      // Check if domain or common variants exist in database
      const exists = Array.from(existingDomains).some(existingDomain => {
        const normalized = existingDomain.toLowerCase()
          .replace(/^www\./, '')
          .replace(/\/$/, '');
        return normalized === normalizedDomain || 
               normalized.includes(normalizedDomain) ||
               normalizedDomain.includes(normalized);
      });
      
      if (!exists) {
        newCompanies.push({
          ...company,
          domain,
        });
        console.log(`✅ ${domain}`);
      } else {
        console.log(`⏭️  already in DB`);
      }
    } else {
      console.log(`❌ domain not found`);
    }

    // Rate limiting
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Summary
  console.log(`\n${'='.repeat(70)}`);
  console.log(`📋 RESULTS`);
  console.log(`${'='.repeat(70)}`);
  console.log(`New companies found: ${newCompanies.length}`);
  
  if (newCompanies.length > 0) {
    console.log(`\n📝 New Companies to Import:`);
    newCompanies.forEach((c, i) => {
      console.log(`\n${i + 1}. ${c.name}`);
      console.log(`   Domain: ${c.domain}`);
      console.log(`   Location: ${c.location || 'N/A'}`);
      console.log(`   Employees: ${c.estimatedEmployees || 'N/A'}`);
      console.log(`   Strategy: ${c.source}`);
    });

    console.log(`\n💡 To import these companies, use the import modal in the frontend:`);
    newCompanies.forEach(c => {
      console.log(`   - ${c.domain}`);
    });
  } else {
    console.log(`\n⚠️  No new companies found. All discovered companies are already in your database.`);
  }
}

async function listNAICSCodes() {
  await loadTargetNAICSCodes();
  
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🎯 Target ICP NAICS Codes (${CORE_TAM_NAICS.length} total)`);
  console.log(`${'='.repeat(70)}\n`);
  
  CORE_TAM_NAICS.forEach(code => {
    console.log(`${code} - ${NAICS_DESCRIPTIONS[code]}`);
  });
  
  console.log(`\n${'='.repeat(70)}`);
  console.log(`\n💡 Usage: npx tsx discover-tam-local.ts <naics_code> [strategy] [limit]`);
  console.log(`   Example: npx tsx discover-tam-local.ts 311615 all 50\n`);
}

// Run discovery
const args = process.argv.slice(2);

if (args[0] === '--list' || args[0] === '-l') {
  listNAICSCodes().catch(console.error);
} else {
  const naicsCode = args[0] || '311615'; // Default to Poultry Processing
  const strategy = (args[1] as any) || 'all'; // Default to all strategies
  const limit = parseInt(args[2] || '50');
  
  discoverTAM(naicsCode, strategy, limit).catch(console.error);
}
