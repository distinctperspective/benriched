import { EnrichmentContext } from '../context.js';
import { gateway } from '@ai-sdk/gateway';
import { generateText } from 'ai';

export async function runLinkedInSearch(ctx: EnrichmentContext): Promise<void> {
  const pass1Result = ctx.pass1Result!;

  // Only run if Pass 1 didn't find LinkedIn candidates
  if (pass1Result.linkedin_url_candidates && pass1Result.linkedin_url_candidates.length > 0) {
    return;
  }

  await ctx.emitter?.emit({
    stage: 'linkedin_search',
    message: 'Searching for LinkedIn company page...',
    status: 'started'
  });

  console.log(`\n🔍 Searching for LinkedIn page...`);

  const firecrawlApiKey = ctx.firecrawlApiKey || process.env.FIRECRAWL_API_KEY;
  let linkedinSearchResults: any[] = [];
  let firecrawlSearchCredits = 0;

  // Primary: Use Firecrawl Google search (most accurate)
  if (firecrawlApiKey) {
    try {
      const firecrawlQuery = `"${pass1Result.company_name}" site:linkedin.com/company`;
      console.log(`   🔎 Using Firecrawl Google search: "${firecrawlQuery}"`);

      const response = await fetch('https://api.firecrawl.dev/v1/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${firecrawlApiKey}`
        },
        body: JSON.stringify({
          query: firecrawlQuery,
          limit: 5
        })
      });

      if (response.ok) {
        const data = await response.json();
        linkedinSearchResults = data.data || [];
        firecrawlSearchCredits += 1; // Firecrawl search uses 1 credit
        console.log(`   ✅ Firecrawl found ${linkedinSearchResults.length} results`);
      } else {
        console.log(`   ⚠️  Firecrawl search failed: ${response.status}`);
      }
    } catch (error) {
      console.log(`   ⚠️  Firecrawl search error: ${error}`);
    }
  }

  // Fallback: Try Gemini if Firecrawl didn't find anything
  if (linkedinSearchResults.length === 0 && process.env.GEMINI_API_KEY) {
    try {
      const linkedinSearchQuery = `${pass1Result.company_name} LinkedIn`;
      console.log(`   🔎 Fallback to Gemini search: "${linkedinSearchQuery}"`);
      const geminiModel = gateway('google/gemini-2.0-flash-exp');

      const { text } = await generateText({
        model: geminiModel,
        prompt: `Search the web and find the official LinkedIn company page URL for "${pass1Result.company_name}".

Return ONLY a JSON object with this structure:
{
  "linkedin_url": "https://linkedin.com/company/...",
  "confidence": "high" or "medium" or "low"
}

If no LinkedIn page found, return:
{
  "linkedin_url": null,
  "confidence": "none"
}`,
        temperature: 0
      });

      // Parse Gemini response
      const cleanText = text.trim().replace(/^```json?\n?/i, '').replace(/\n?```$/i, '');
      const geminiResult = JSON.parse(cleanText);

      if (geminiResult.linkedin_url && geminiResult.linkedin_url.includes('linkedin.com/company/')) {
        linkedinSearchResults = [{
          url: geminiResult.linkedin_url,
          confidence: geminiResult.confidence || 'medium'
        }];
        console.log(`   ✅ Gemini found LinkedIn: ${geminiResult.linkedin_url} (${geminiResult.confidence} confidence)`);
      } else {
        console.log(`   ⚠️  Gemini did not find LinkedIn page`);
      }
    } catch (error) {
      console.log(`   ⚠️  Gemini search failed: ${error}`);
    }
  }

  // Last resort: Try Firecrawl again with simpler query (without site: filter)
  if (linkedinSearchResults.length === 0 && firecrawlApiKey) {
    try {
      const simpleQuery = `${pass1Result.company_name} LinkedIn company page`;
      console.log(`   🔎 Firecrawl simple search: "${simpleQuery}"`);
      const response = await fetch('https://api.firecrawl.dev/v1/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${firecrawlApiKey}`
        },
        body: JSON.stringify({
          query: simpleQuery,
          limit: 5
        })
      });

      if (response.ok) {
        const data = await response.json();
        linkedinSearchResults = data.data || [];
        firecrawlSearchCredits += 1; // Firecrawl search uses 1 credit
        console.log(`   ✅ Firecrawl simple search found ${linkedinSearchResults.length} results`);
      } else {
        console.log(`   ⚠️  Firecrawl simple search failed: ${response.status}`);
      }
    } catch (error) {
      console.log(`   ⚠️  Firecrawl simple search error: ${error}`);
    }
  }

  // Track Firecrawl search credits
  if (firecrawlSearchCredits > 0) {
    ctx.costs.addFirecrawlCredits(firecrawlSearchCredits);
  }

  // Extract LinkedIn URLs from search results and rank by follower count
  if (linkedinSearchResults.length > 0) {
    const linkedinCandidates: Array<{ url: string; followers: number; source: string }> = [];

    for (const result of linkedinSearchResults) {
      const url = result.url || result.link || '';
      if (url.includes('linkedin.com/company/') && !url.includes('/posts') && !url.includes('/jobs')) {
        const text = `${result.title || ''} ${result.description || ''}`;
        const followerMatch = text.match(/(\d+(?:\.\d+)?)\s*([KM])?\+?\s*followers/i);

        let followerCount = 0;
        if (followerMatch) {
          const num = parseFloat(followerMatch[1]);
          const multiplier = followerMatch[2] === 'K' ? 1000 : followerMatch[2] === 'M' ? 1000000 : 1;
          followerCount = num * multiplier;
        }

        linkedinCandidates.push({
          url: url.replace(/\/$/, ''),
          followers: followerCount,
          source: followerCount > 0 ? `${followerMatch![0]}` : 'unknown'
        });
      }
    }

    if (linkedinCandidates.length > 0) {
      linkedinCandidates.sort((a, b) => b.followers - a.followers);
      const bestCandidate = linkedinCandidates[0];
      pass1Result.linkedin_url_candidates = [{
        url: bestCandidate.url,
        confidence: 'medium'
      }];

      if (linkedinCandidates.length > 1) {
        console.log(`   ✅ Found ${linkedinCandidates.length} LinkedIn pages, picked highest followers:`);
        linkedinCandidates.forEach(c => {
          console.log(`      ${c.followers > 0 ? '👥 ' + c.source : '   ?'} - ${c.url}${c.url === bestCandidate.url ? ' ← SELECTED' : ''}`);
        });
      } else {
        console.log(`   ✅ Found LinkedIn via search: ${bestCandidate.url}${bestCandidate.followers > 0 ? ` (${bestCandidate.source})` : ''}`);
      }
    } else {
      console.log(`   ⚠️  No LinkedIn URL found in search results`);
    }
  }

  await ctx.emitter?.emit({
    stage: 'linkedin_search',
    message: linkedinSearchResults.length > 0 ? 'LinkedIn search complete' : 'No LinkedIn page found',
    status: 'complete'
  });
}
