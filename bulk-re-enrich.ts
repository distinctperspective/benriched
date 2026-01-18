import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const API_URL = 'https://benriched.vercel.app/enrich';
const API_KEY = process.env.BENRICHED_API_KEY || 'amlink21';

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_ANON_KEY || ''
);

async function findCompaniesWithIncorrectNames(): Promise<string[]> {
  const { data, error } = await supabase
    .from('companies')
    .select('domain, company_name')
    .limit(10000);

  if (error) {
    console.error('Error fetching companies:', error);
    return [];
  }

  const incorrectNames = data?.filter(c => {
    const normalizedDomain = c.domain
      .toLowerCase()
      .replace(/\.(com|ca|io|org|net)$/, '')
      .replace(/\./g, '');
    const normalizedName = c.company_name?.toLowerCase().replace(/\s/g, '') || '';
    
    // Check if company name is just the domain without proper formatting
    return normalizedName === normalizedDomain;
  }).map(c => c.domain) || [];

  return incorrectNames;
}

async function fixCompanyName(domain: string) {
  console.log(`\n🔄 Re-enriching ${domain}...`);
  
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api_key': API_KEY
      },
      body: JSON.stringify({
        domain,
        force_refresh: true
      })
    });

    const data = await response.json();
    
    if (data.success && data.data?.company_name) {
      console.log(`   ✅ ${domain} → ${data.data.company_name}`);
      return { domain, success: true, company_name: data.data.company_name };
    } else {
      console.log(`   ❌ ${domain} → Failed: ${data.error || 'Unknown error'}`);
      return { domain, success: false, error: data.error };
    }
  } catch (error) {
    console.log(`   ❌ ${domain} → Error: ${error}`);
    return { domain, success: false, error: String(error) };
  }
}

async function main() {
  let domainsToFix: string[] = [];
  
  // Check if domains provided via command line
  const args = process.argv.slice(2);
  
  if (args.length > 0 && args[0] !== '--auto') {
    domainsToFix = args;
    console.log(`🚀 Re-enriching ${domainsToFix.length} specified domains...\n`);
  } else {
    // Auto-detect companies with incorrect names
    console.log('🔍 Scanning database for companies with incorrect names...\n');
    domainsToFix = await findCompaniesWithIncorrectNames();
    
    if (domainsToFix.length === 0) {
      console.log('✅ No companies found with incorrect names!');
      return;
    }
    
    console.log(`Found ${domainsToFix.length} companies with incorrect names:`);
    domainsToFix.forEach(d => console.log(`   - ${d}`));
    console.log('\n🚀 Starting re-enrichment...\n');
  }
  
  const results = [];
  
  // Process sequentially to avoid rate limits
  for (const domain of domainsToFix) {
    const result = await fixCompanyName(domain);
    results.push(result);
    
    // Wait 2 seconds between requests to avoid overwhelming the API
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  console.log('\n\n📊 Summary:');
  console.log(`   ✅ Success: ${results.filter(r => r.success).length}`);
  console.log(`   ❌ Failed: ${results.filter(r => !r.success).length}`);
  
  const failed = results.filter(r => !r.success);
  if (failed.length > 0) {
    console.log('\n❌ Failed domains:');
    failed.forEach(f => console.log(`   - ${f.domain}: ${f.error}`));
  }
}

main().catch(console.error);
