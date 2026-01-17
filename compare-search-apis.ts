import * as dotenv from 'dotenv';
import { gateway } from '@ai-sdk/gateway';
import { generateText } from 'ai';

dotenv.config({ path: '.env.local' });

interface SearchResult {
  api: string;
  query: string;
  companiesFound: number;
  companies: string[];
  executionTime: number;
  quality: 'high' | 'medium' | 'low';
}

const NAICS_CODE = '311615'; // Poultry Processing
const NAICS_DESC = 'Poultry Processing';

async function searchWithPerplexity(query: string): Promise<SearchResult> {
  const startTime = Date.now();
  try {
    const { text } = await generateText({
      model: gateway('perplexity/sonar-pro'),
      prompt: query,
      temperature: 0.1,
    });

    const companies = extractCompanies(text);
    const executionTime = Date.now() - startTime;

    return {
      api: 'Perplexity (Sonar)',
      query,
      companiesFound: companies.length,
      companies,
      executionTime,
      quality: companies.length > 15 ? 'high' : companies.length > 8 ? 'medium' : 'low',
    };
  } catch (error) {
    console.error('Perplexity error:', error);
    return {
      api: 'Perplexity (Sonar)',
      query,
      companiesFound: 0,
      companies: [],
      executionTime: Date.now() - startTime,
      quality: 'low',
    };
  }
}

async function searchWithExa(query: string): Promise<SearchResult> {
  const startTime = Date.now();
  try {
    // Exa through Vercel AI Gateway
    const { text } = await generateText({
      model: gateway('exa/search'),
      prompt: query,
      temperature: 0.1,
    });

    const companies = extractCompanies(text);
    const executionTime = Date.now() - startTime;

    return {
      api: 'Exa',
      query,
      companiesFound: companies.length,
      companies,
      executionTime,
      quality: companies.length > 15 ? 'high' : companies.length > 8 ? 'medium' : 'low',
    };
  } catch (error) {
    console.error('Exa error:', error);
    return {
      api: 'Exa',
      query,
      companiesFound: 0,
      companies: [],
      executionTime: Date.now() - startTime,
      quality: 'low',
    };
  }
}

async function searchWithTavily(query: string): Promise<SearchResult> {
  const startTime = Date.now();
  try {
    // Tavily through Vercel AI Gateway
    const { text } = await generateText({
      model: gateway('tavily/search'),
      prompt: query,
      temperature: 0.1,
    });

    const companies = extractCompanies(text);
    const executionTime = Date.now() - startTime;

    return {
      api: 'Tavily',
      query,
      companiesFound: companies.length,
      companies,
      executionTime,
      quality: companies.length > 15 ? 'high' : companies.length > 8 ? 'medium' : 'low',
    };
  } catch (error) {
    console.error('Tavily error:', error);
    return {
      api: 'Tavily',
      query,
      companiesFound: 0,
      companies: [],
      executionTime: Date.now() - startTime,
      quality: 'low',
    };
  }
}

function extractCompanies(text: string): string[] {
  const companies = new Set<string>();
  
  // Extract company names from various formats
  const lines = text.split('\n');
  
  for (const line of lines) {
    // Skip non-company lines
    if (line.includes('---') || line.length < 3) continue;
    if (line.match(/^(List|Format|Include|Which|The|However|To obtain|No |Limited|Search)/i)) continue;
    
    // Extract company names
    const cleanLine = line.replace(/\[.*?\]/g, '').trim();
    
    // Match "- Company Name" or "1. Company Name" or "Company Name |"
    const matches = cleanLine.match(/^[-•*]?\s*(?:\d+\.\s*)?(?:\*\*)?([A-Z][^|,\n]+?)(?:\*\*)?(?:\s*[|,]|$)/);
    if (matches && matches[1]) {
      const company = matches[1].trim();
      if (company.length > 3 && !company.match(/^(The|A|An|List|No|Limited|Search)/i)) {
        companies.add(company);
      }
    }
  }
  
  return Array.from(companies);
}

async function runComparison() {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`🔍 COMPARING SEARCH APIS FOR CORE TAM DISCOVERY`);
  console.log(`NAICS: ${NAICS_CODE} (${NAICS_DESC})`);
  console.log(`${'='.repeat(80)}\n`);

  const queries = [
    {
      name: 'Industry Search',
      query: `List 20 major US companies in the ${NAICS_DESC} industry (NAICS ${NAICS_CODE}). Include company names, headquarters location, and estimated employee count.`,
    },
    {
      name: 'Geographic Search',
      query: `List 20 ${NAICS_DESC} companies (NAICS ${NAICS_CODE}) in California, Illinois, Texas, Iowa, and North Carolina. Include company names, headquarters location, and estimated employee count.`,
    },
    {
      name: 'Supply Chain Search',
      query: `Which ${NAICS_DESC} companies (NAICS ${NAICS_CODE}) supply to major retailers like Walmart, Costco, and regional grocery chains? List 20 companies with names, locations, and estimated employee counts.`,
    },
  ];

  const allResults: SearchResult[] = [];

  for (const queryItem of queries) {
    console.log(`\n📊 Testing: ${queryItem.name}`);
    console.log(`Query: ${queryItem.query.substring(0, 80)}...`);
    console.log(`${'─'.repeat(80)}`);

    // Test all three APIs
    const results = await Promise.all([
      searchWithPerplexity(queryItem.query),
      searchWithExa(queryItem.query),
      searchWithTavily(queryItem.query),
    ]);

    for (const result of results) {
      allResults.push(result);
      console.log(`\n${result.api}:`);
      console.log(`  Companies found: ${result.companiesFound}`);
      console.log(`  Execution time: ${result.executionTime}ms`);
      console.log(`  Quality: ${result.quality}`);
      if (result.companies.length > 0) {
        console.log(`  Examples: ${result.companies.slice(0, 3).join(', ')}`);
      }
    }

    // Rate limiting between queries
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // Summary
  console.log(`\n${'='.repeat(80)}`);
  console.log(`📈 SUMMARY`);
  console.log(`${'='.repeat(80)}\n`);

  const byApi = new Map<string, SearchResult[]>();
  allResults.forEach(r => {
    if (!byApi.has(r.api)) byApi.set(r.api, []);
    byApi.get(r.api)!.push(r);
  });

  for (const [api, results] of byApi) {
    const totalCompanies = results.reduce((sum, r) => sum + r.companiesFound, 0);
    const avgTime = Math.round(results.reduce((sum, r) => sum + r.executionTime, 0) / results.length);
    const highQuality = results.filter(r => r.quality === 'high').length;

    console.log(`${api}:`);
    console.log(`  Total companies found: ${totalCompanies}`);
    console.log(`  Average execution time: ${avgTime}ms`);
    console.log(`  High quality results: ${highQuality}/${results.length}`);
    console.log();
  }

  // Recommendation
  console.log(`${'='.repeat(80)}`);
  console.log(`💡 RECOMMENDATION`);
  console.log(`${'='.repeat(80)}\n`);

  const perplexityTotal = allResults
    .filter(r => r.api === 'Perplexity (Sonar)')
    .reduce((sum, r) => sum + r.companiesFound, 0);
  const exaTotal = allResults
    .filter(r => r.api === 'Exa')
    .reduce((sum, r) => sum + r.companiesFound, 0);
  const tavilyTotal = allResults
    .filter(r => r.api === 'Tavily')
    .reduce((sum, r) => sum + r.companiesFound, 0);

  console.log(`Perplexity: ${perplexityTotal} companies`);
  console.log(`Exa: ${exaTotal} companies`);
  console.log(`Tavily: ${tavilyTotal} companies`);

  const best = Math.max(perplexityTotal, exaTotal, tavilyTotal);
  if (best === perplexityTotal) {
    console.log(`\n✅ Perplexity is the best performer for Core TAM discovery.`);
  } else if (best === exaTotal) {
    console.log(`\n✅ Exa is the best performer for Core TAM discovery.`);
  } else {
    console.log(`\n✅ Tavily is the best performer for Core TAM discovery.`);
  }
}

runComparison().catch(console.error);
