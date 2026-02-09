import { EnrichmentContext } from '../context.js';
import { validateLinkedInPage } from '../../components/linkedin.js';
import { scrapeUrlWithCost } from '../../../scraper.js';

export async function runLinkedInValidation(ctx: EnrichmentContext): Promise<void> {
  const pass1Result = ctx.pass1Result!;

  await ctx.emitter?.emit({
    stage: 'linkedin_validation',
    message: 'Extracting LinkedIn profile...',
    status: 'started'
  });

  // Extract LinkedIn from scraped content - prioritize company website
  let linkedinFromScrape: string | null = null;
  let linkedinSource: 'website' | 'pass1' | null = null;
  const linkedinRegex = /https?:\/\/(?:www\.)?linkedin\.com\/company\/([a-zA-Z0-9_\-'%]+)\/?/gi;

  // First, try to find LinkedIn on the company's own website (MOST RELIABLE)
  for (const [url, content] of ctx.scrapedContent) {
    if (url.includes(ctx.domain) || url.includes(ctx.domain.replace('www.', ''))) {
      const matches = [...content.matchAll(linkedinRegex)];
      if (matches.length > 0) {
        const validMatches = matches.filter(m => {
          const slug = m[1].toLowerCase();
          return !['crunchbase', 'zoominfo', 'linkedin', 'glassdoor', 'indeed'].includes(slug);
        });
        if (validMatches.length > 0) {
          linkedinFromScrape = validMatches[0][0].replace(/\/$/, '');
          linkedinSource = 'website';
          console.log(`   🔗 Found LinkedIn on company website (authoritative): ${linkedinFromScrape}`);
          break;
        }
      }
    }
  }

  // If no company website was scraped, try to scrape it directly
  if (!linkedinFromScrape && ctx.scrapedContent.size === 0) {
    console.log(`   ⚠️  No pages scraped, trying to scrape company website directly...`);
    const scrapeResult = await scrapeUrlWithCost(`https://${ctx.domain}`, ctx.firecrawlApiKey);
    ctx.costs.addFirecrawlCredits(scrapeResult.creditsUsed);
    if (scrapeResult.content) {
      ctx.scrapedContent.set(`https://${ctx.domain}`, scrapeResult.content);
      const matches = [...scrapeResult.content!.matchAll(linkedinRegex)];
      if (matches.length > 0) {
        const validMatches = matches.filter(m => {
          const slug = m[1].toLowerCase();
          return !['crunchbase', 'zoominfo', 'linkedin', 'glassdoor', 'indeed'].includes(slug);
        });
        if (validMatches.length > 0) {
          linkedinFromScrape = validMatches[0][0].replace(/\/$/, '');
          linkedinSource = 'website';
          console.log(`   🔗 Found LinkedIn on company website (authoritative): ${linkedinFromScrape}`);
        }
      }
    }
  }

  // If not found on company site, check Pass 1 linkedin_url_candidates
  if (!linkedinFromScrape && pass1Result.linkedin_url_candidates && pass1Result.linkedin_url_candidates.length > 0) {
    const bestCandidate = pass1Result.linkedin_url_candidates[0];
    linkedinFromScrape = bestCandidate.url.replace(/\/$/, '');
    linkedinSource = 'pass1';
    console.log(`   🔗 Using LinkedIn from Pass 1 candidates (${bestCandidate.confidence} confidence): ${linkedinFromScrape}`);
  }

  // Fallback: check urls_to_crawl if no candidates found
  if (!linkedinFromScrape && pass1Result.urls_to_crawl) {
    const linkedinUrl = pass1Result.urls_to_crawl.find(u =>
      u.includes('linkedin.com/company/') &&
      !u.includes('/crunchbase') &&
      !u.includes('/zoominfo')
    );
    if (linkedinUrl) {
      linkedinFromScrape = linkedinUrl.replace(/\/$/, '');
      linkedinSource = 'pass1';
      console.log(`   🔗 Using LinkedIn from Pass 1 URLs (needs validation): ${linkedinFromScrape}`);
    }
  }

  // Prepare validation data
  const expectedEmployees = pass1Result.employee_count_found?.amount || null;
  const expectedLocation = pass1Result.headquarters?.city || null;

  // VALIDATE LinkedIn URL (same validation for both pass1 and website sources)
  if (linkedinFromScrape && linkedinSource) {
    const sourceLabel = linkedinSource === 'pass1' ? 'Pass 1, needs verification' : 'company website';
    console.log(`\n🔍 Validating LinkedIn page (from ${sourceLabel})...`);

    const validation = await validateLinkedInPage(
      linkedinFromScrape,
      ctx.domain,
      expectedEmployees,
      expectedLocation,
      ctx.scrapedContent,
      ctx.firecrawlApiKey
    );

    if (!validation.isValid) {
      console.log(`   ⚠️  LinkedIn validation FAILED: ${validation.reason}`);
      if (validation.linkedinWebsite) {
        console.log(`      LinkedIn website: ${validation.linkedinWebsite}`);
      }
      if (validation.linkedinEmployees) {
        console.log(`      LinkedIn employees: ${validation.linkedinEmployees}`);
      }
      console.log(`   ❌ Rejecting LinkedIn URL - likely wrong company`);
      linkedinFromScrape = null;
    } else {
      console.log(`   ✅ LinkedIn validation passed`);
      if (validation.linkedinEmployees) {
        ctx.linkedinEmployeeCount = validation.linkedinEmployees;
        console.log(`   👥 LinkedIn employees: ${ctx.linkedinEmployeeCount}`);
      }
    }
  }

  // Always search for employee count in scraped content if we don't have it yet
  if (!ctx.linkedinEmployeeCount) {
    console.log(`\n🔍 Looking for employee count in scraped content...`);
    for (const [url, content] of ctx.scrapedContent) {
      const employeeMatch = content.match(/(\d+[-–]\d+|\d+,?\d*\+?)\s*employees/i);
      if (employeeMatch) {
        ctx.linkedinEmployeeCount = employeeMatch[1];
        console.log(`   👥 Found employees in ${url}: ${ctx.linkedinEmployeeCount}`);
        break;
      }
    }
    if (!ctx.linkedinEmployeeCount) {
      console.log(`   ⚠️  No employee count found in scraped content`);
    }
  }

  ctx.linkedinUrl = linkedinFromScrape;
  ctx.linkedinSource = linkedinSource;

  await ctx.emitter?.emit({
    stage: 'linkedin_validation',
    message: 'LinkedIn validation complete',
    status: 'complete',
    data: { linkedin_url: linkedinFromScrape || undefined }
  });
}
