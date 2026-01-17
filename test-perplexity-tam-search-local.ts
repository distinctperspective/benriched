import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: '.env.local' });

// Core TAM NAICS codes
const CORE_TAM_NAICS = [
  '311991', // Perishable Prepared Food Manufacturing
  '311612', // Meat Processed from Carcasses
  '311611', // Animal Slaughtering
  '311615', // Poultry Processing
  '311999', // All Other Miscellaneous Food Manufacturing
];

interface SearchResult {
  strategy: string;
  query: string;
  companiesFound: number;
  enrichmentCost: number;
}

async function testSearchStrategy(
  strategy: string,
  domain: string
): Promise<SearchResult> {
  console.log(`\n🔍 Testing: ${strategy}`);
  console.log(`   Domain: ${domain}`);

  try {
    const response = await fetch('http://localhost:8787/enrich', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer amlink21',
      },
      body: JSON.stringify({
        domain,
        api_key: 'amlink21',
      }),
    });

    const data = await response.json();

    if (data.success) {
      console.log(`   ✅ Enriched successfully`);
      console.log(`   Cost: $${data.cost?.toFixed(4) || 'N/A'}`);
      console.log(`   Company: ${data.company_name || 'N/A'}`);
      return {
        strategy,
        query: domain,
        companiesFound: 1,
        enrichmentCost: data.cost || 0,
      };
    } else {
      console.log(`   ❌ Error: ${data.error}`);
      return {
        strategy,
        query: domain,
        companiesFound: 0,
        enrichmentCost: 0,
      };
    }
  } catch (error) {
    console.error(`   Error: ${error}`);
    return {
      strategy,
      query: domain,
      companiesFound: 0,
      enrichmentCost: 0,
    };
  }
}

async function analyzeCoreTAMCoverage() {
  console.log('🧪 Analyzing Core TAM Company Coverage\n');
  console.log('='.repeat(70));

  const supabase = createClient(
    process.env.SUPABASE_URL || '',
    process.env.SUPABASE_ANON_KEY || ''
  );

  // Get companies by NAICS code
  const { data: companies } = await supabase
    .from('companies')
    .select('domain, company_name, naics_codes_6_digit')
    .limit(1000);

  if (!companies) {
    console.log('No companies found in database');
    return;
  }

  // Analyze coverage
  const coreTAMCompanies = companies.filter(c => {
    if (!c.naics_codes_6_digit || !Array.isArray(c.naics_codes_6_digit)) return false;
    return c.naics_codes_6_digit.some((n: any) => 
      CORE_TAM_NAICS.includes(n.code || n)
    );
  });

  console.log(`\n📊 Current Database Coverage:`);
  console.log(`   Total companies: ${companies.length}`);
  console.log(`   Core TAM companies: ${coreTAMCompanies.length}`);
  console.log(`   Coverage: ${((coreTAMCompanies.length / companies.length) * 100).toFixed(1)}%`);

  // Breakdown by NAICS
  console.log(`\n📋 Core TAM Breakdown by NAICS:`);
  const naicsBreakdown: Record<string, number> = {};
  coreTAMCompanies.forEach(c => {
    if (c.naics_codes_6_digit && Array.isArray(c.naics_codes_6_digit)) {
      c.naics_codes_6_digit.forEach((n: any) => {
        const code = n.code || n;
        if (CORE_TAM_NAICS.includes(code)) {
          naicsBreakdown[code] = (naicsBreakdown[code] || 0) + 1;
        }
      });
    }
  });

  Object.entries(naicsBreakdown).forEach(([code, count]) => {
    const names: Record<string, string> = {
      '311991': 'Perishable Prepared Food Manufacturing',
      '311612': 'Meat Processed from Carcasses',
      '311611': 'Animal Slaughtering',
      '311615': 'Poultry Processing',
      '311999': 'All Other Miscellaneous Food Manufacturing',
    };
    console.log(`   ${code} (${names[code]}): ${count} companies`);
  });

  // Test different search strategies with Perplexity
  console.log(`\n\n🔬 Testing Perplexity Search Strategies\n`);
  console.log('='.repeat(70));

  const testDomains = [
    { strategy: 'Direct NAICS Search', domain: 'tyson.com' },
    { strategy: 'Meat Processing', domain: 'jbs.com' },
    { strategy: 'Poultry Processing', domain: 'perdue.com' },
    { strategy: 'Prepared Foods', domain: 'hormel.com' },
    { strategy: 'Regional Processor', domain: 'lincolnpremiumpoultry.com' },
  ];

  const results: SearchResult[] = [];
  for (const test of testDomains) {
    results.push(await testSearchStrategy(test.strategy, test.domain));
    // Add delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log('📊 ANALYSIS SUMMARY\n');

  console.log('Key Findings:');
  console.log(`1. Current Core TAM coverage: ${coreTAMCompanies.length}/${companies.length} companies`);
  console.log(`2. Largest gaps: ${CORE_TAM_NAICS.filter(n => !naicsBreakdown[n]).join(', ')}`);

  console.log('\n💡 Recommendations to Improve Core TAM Discovery:');
  console.log('1. Use industry-specific search queries (e.g., "meat processing", "poultry processor")');
  console.log('2. Include NAICS codes in Perplexity search context');
  console.log('3. Search for company types: "co-manufacturers", "contract manufacturers", "private label producers"');
  console.log('4. Geographic targeting: Focus on meat processing hubs (Iowa, Texas, North Carolina)');
  console.log('5. Supply chain angle: Search for "suppliers to Walmart", "Costco suppliers", etc.');
  console.log('6. Regulatory angle: "FSMA compliant", "SQF certified" companies');

  console.log('\n🎯 Next Steps:');
  console.log('- Implement industry-specific search prompts in pass1_identifyUrlsWithUsage');
  console.log('- Add NAICS code context to Perplexity queries');
  console.log('- Create targeted search for each Core TAM NAICS code');
}

analyzeCoreTAMCoverage().catch(console.error);
