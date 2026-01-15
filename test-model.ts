import { gateway } from '@ai-sdk/gateway';
import { generateText } from 'ai';

async function testPrompts() {
  const model = gateway('perplexity/sonar-pro');
  const domain = 'wegmans.com';
  const companyName = 'Wegmans Food Markets';

  // Test 1: Current complex prompt style (simplified)
  console.log('=== TEST 1: COMPLEX JSON PROMPT ===');
  try {
    const result1 = await generateText({
      model,
      prompt: `Research the company at ${domain} (${companyName}).

Find URLs to scrape and extract revenue/employee data.

Return JSON:
{
  "urls_to_scrape": ["url1", "url2"],
  "revenue_found": [{"amount": "$X", "source": "source", "year": "2024", "is_estimate": false}],
  "employee_count_found": {"amount": "X", "source": "source"}
}

Search for revenue on Forbes, company website, press releases.
Return ONLY valid JSON.`
    });
    console.log(result1.text);
  } catch (e: unknown) {
    console.log('Error:', (e as Error).message);
  }

  // Test 2: Simple direct question first, then structure
  console.log('\n=== TEST 2: SIMPLE QUESTION FIRST ===');
  try {
    const result2 = await generateText({
      model,
      prompt: `What is ${companyName}'s annual revenue? Also find their employee count.

After finding the data, format your response as JSON:
{
  "revenue_found": [{"amount": "$12.5 billion", "source": "company website", "year": "2024", "is_estimate": false}],
  "employee_count_found": {"amount": "53000", "source": "LinkedIn"}
}

Search their website, Forbes, LinkedIn for this information.`
    });
    console.log(result2.text);
  } catch (e: unknown) {
    console.log('Error:', (e as Error).message);
  }

  // Test 3: Two-step in one prompt
  console.log('\n=== TEST 3: EXPLICIT TWO-STEP ===');
  try {
    const result3 = await generateText({
      model,
      prompt: `STEP 1: Search and find ${companyName} (${domain}) annual revenue and employee count.
STEP 2: Format the results as JSON.

For revenue, search: "${companyName} revenue", "${companyName} annual sales billion"
For employees, search: "${companyName} LinkedIn employees"

Output JSON only:
{"revenue_found": [{"amount": "...", "source": "...", "year": "...", "is_estimate": true/false}], "employee_count_found": {"amount": "...", "source": "..."}}`
    });
    console.log(result3.text);
  } catch (e: unknown) {
    console.log('Error:', (e as Error).message);
  }
}

testPrompts();
