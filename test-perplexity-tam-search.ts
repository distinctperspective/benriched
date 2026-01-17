import { gateway } from '@ai-sdk/gateway';
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

interface SearchResult {
  strategy: string;
  query: string;
  companies: string[];
  count: number;
}

async function testSearchStrategy(
  strategy: string,
  query: string
): Promise<SearchResult> {
  console.log(`\n🔍 Testing: ${strategy}`);
  console.log(`   Query: ${query}`);

  try {
    const { text } = await generateText({
      model: gateway('perplexity/sonar-pro'),
      prompt: query,
      temperature: 0.1,
    });

    // Extract company names from response (simple extraction)
    const companyMatches = text.match(/(?:company|companies?|manufacturer|producer):\s*([^.\n]+)/gi) || [];
    const companies = companyMatches
      .map(m => m.replace(/(?:company|companies?|manufacturer|producer):\s*/i, '').trim())
      .filter(c => c.length > 0 && c.length < 100);

    console.log(`   Found: ${companies.length} companies`);
    if (companies.length > 0) {
      console.log(`   Examples: ${companies.slice(0, 3).join(', ')}`);
    }

    return {
      strategy,
      query,
      companies,
      count: companies.length,
    };
  } catch (error) {
    console.error(`   Error: ${error}`);
    return {
      strategy,
      query,
      companies: [],
      count: 0,
    };
  }
}

async function runTests() {
  console.log('🧪 Testing Perplexity Search Strategies for Core TAM Companies\n');
  console.log('='.repeat(70));

  const results: SearchResult[] = [];

  // Strategy 1: Direct NAICS search
  results.push(
    await testSearchStrategy(
      'Direct NAICS Codes',
      `List major US companies in NAICS codes ${CORE_TAM_NAICS.join(', ')}. Include company names, headquarters location, and estimated employee count.`
    )
  );

  // Strategy 2: Industry description search
  results.push(
    await testSearchStrategy(
      'Industry Description',
      `List the top 50 perishable prepared food manufacturers, meat processing companies, and poultry processors in the United States. Include company names and headquarters.`
    )
  );

  // Strategy 3: Specific product focus
  results.push(
    await testSearchStrategy(
      'Product-Focused Search',
      `Which companies manufacture prepared meals, processed meats, slaughtered animals, or poultry products in the US? List the largest 30 companies by revenue.`
    )
  );

  // Strategy 4: Supply chain search
  results.push(
    await testSearchStrategy(
      'Supply Chain Search',
      `List major food processing facilities and meat packing plants in the United States. Include company names, locations, and facility types.`
    )
  );

  // Strategy 5: Regulatory/Compliance angle
  results.push(
    await testSearchStrategy(
      'Compliance/Audit Angle',
      `Which food manufacturing companies are subject to FSMA (Food Safety Modernization Act) and SQF audits? List major perishable food and meat processing companies.`
    )
  );

  // Strategy 6: Geographic + Industry
  results.push(
    await testSearchStrategy(
      'Geographic + Industry',
      `List meat processing plants, poultry processors, and prepared food manufacturers in California, Illinois, Texas, and the Northeast US.`
    )
  );

  // Strategy 7: B2B supplier search
  results.push(
    await testSearchStrategy(
      'B2B Supplier Search',
      `Which companies supply prepared foods, processed meats, and poultry to retailers like Walmart, Costco, and regional grocery chains?`
    )
  );

  // Strategy 8: Detailed industry breakdown
  results.push(
    await testSearchStrategy(
      'Detailed Industry Breakdown',
      `Provide a comprehensive list of:
1. Animal slaughtering facilities (NAICS 311611)
2. Meat processing companies (NAICS 311612)
3. Poultry processing plants (NAICS 311615)
4. Prepared food manufacturers (NAICS 311991)
5. Other food manufacturers (NAICS 311999)
Include company names, HQ locations, and employee counts.`
    )
  );

  // Print summary
  console.log('\n' + '='.repeat(70));
  console.log('📊 RESULTS SUMMARY\n');

  results.forEach((r, i) => {
    console.log(`${i + 1}. ${r.strategy}: ${r.count} companies found`);
  });

  const bestStrategy = results.reduce((a, b) => (a.count > b.count ? a : b));
  console.log(`\n✅ Best Strategy: ${bestStrategy.strategy} (${bestStrategy.count} companies)`);
  console.log(`\n💡 Recommendation: Use "${bestStrategy.strategy}" approach for Core TAM discovery`);

  // Detailed output
  console.log('\n' + '='.repeat(70));
  console.log('📋 DETAILED RESULTS\n');
  results.forEach((r) => {
    console.log(`\n${r.strategy}:`);
    console.log(`Query: ${r.query}`);
    console.log(`Companies found: ${r.count}`);
    if (r.companies.length > 0) {
      console.log('Examples:');
      r.companies.slice(0, 5).forEach(c => console.log(`  - ${c}`));
    }
  });
}

runTests().catch(console.error);
