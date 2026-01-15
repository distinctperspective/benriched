// Firecrawl pricing: $99 for 100k credits = $0.00099/credit
// Scrape uses 1 credit per page (basic proxy)
// Stealth proxy uses up to 5 credits per page
const FIRECRAWL_COST_PER_CREDIT = 0.00099;

export interface ScrapeResult {
  content: string | null;
  creditsUsed: number;
}

export async function scrapeUrl(url: string, apiKey?: string): Promise<string | null> {
  const result = await scrapeUrlWithCost(url, apiKey);
  return result.content;
}

export async function scrapeUrlWithCost(url: string, apiKey?: string): Promise<ScrapeResult> {
  if (!apiKey) {
    return { content: null, creditsUsed: 0 };
  }

  try {
    const fullUrl = url.startsWith('http') ? url : `https://${url}`;

    const response = await fetch('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        url: fullUrl,
        formats: ['markdown'],
        onlyMainContent: false
      }),
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      return { content: null, creditsUsed: 0 };
    }

    const data = await response.json();
    // Each successful scrape uses 1 credit (basic proxy)
    const creditsUsed = data.success ? 1 : 0;
    return { 
      content: data.success ? (data.data?.markdown || '') : null,
      creditsUsed
    };
  } catch {
    return { content: null, creditsUsed: 0 };
  }
}

export interface ScrapeMultipleResult {
  content: Map<string, string>;
  totalCreditsUsed: number;
  scrapeCount: number;
}

export async function scrapeMultipleUrls(urls: string[], apiKey?: string): Promise<Map<string, string>> {
  const result = await scrapeMultipleUrlsWithCost(urls, apiKey);
  return result.content;
}

export async function scrapeMultipleUrlsWithCost(urls: string[], apiKey?: string): Promise<ScrapeMultipleResult> {
  const content = new Map<string, string>();
  let totalCreditsUsed = 0;
  let scrapeCount = 0;

  if (!apiKey) {
    return { content, totalCreditsUsed, scrapeCount };
  }

  const chunks = [];
  for (let i = 0; i < urls.length; i += 3) {
    chunks.push(urls.slice(i, i + 3));
  }

  for (const chunk of chunks) {
    const promises = chunk.map(async (url) => {
      const result = await scrapeUrlWithCost(url, apiKey);
      totalCreditsUsed += result.creditsUsed;
      if (result.content) {
        content.set(url, result.content);
        scrapeCount++;
      }
    });
    await Promise.all(promises);
  }

  return { content, totalCreditsUsed, scrapeCount };
}

export function calculateFirecrawlCost(creditsUsed: number): number {
  return creditsUsed * FIRECRAWL_COST_PER_CREDIT;
}
