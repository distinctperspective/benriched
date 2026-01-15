import { gateway } from '@ai-sdk/gateway';
import { generateText } from 'ai';

async function testMonogram() {
  const model = gateway('perplexity/sonar-pro');

  console.log('=== MONOGRAM FOODS TEST ===');
  try {
    const result = await generateText({
      model,
      prompt: `What is Monogram Foods annual revenue? They are a Memphis-based meat snacks and food manufacturer.

Search for their revenue on their website, press releases, news articles.

After finding this information, format your response as JSON:
{
  "revenue_found": [{"amount": "$X", "source": "source", "year": "2024", "is_estimate": false}],
  "employee_count_found": {"amount": "X", "source": "source"}
}

Return ONLY valid JSON, no markdown.`
    });
    console.log(result.text);
  } catch (e: unknown) {
    console.log('Error:', (e as Error).message);
  }
}

testMonogram();
