import { scrapeUrl } from '../../scraper.js';

export interface LinkedInValidation {
  isValid: boolean;
  reason?: string;
  linkedinEmployees?: string;
  linkedinWebsite?: string;
  linkedinLocation?: string;
}

export async function validateLinkedInPage(
  linkedinUrl: string,
  expectedDomain: string,
  expectedEmployeeCount: string | null,
  expectedLocation: string | null,
  scrapedContent: Map<string, string>,
  firecrawlApiKey?: string
): Promise<LinkedInValidation> {
  let linkedinContent: string | null = null;
  for (const [url, content] of scrapedContent) {
    if (url.includes('linkedin.com')) {
      linkedinContent = content;
      break;
    }
  }
  
  if (!linkedinContent) {
    linkedinContent = await scrapeUrl(linkedinUrl, firecrawlApiKey);
  }
  
  if (!linkedinContent) {
    // LinkedIn requires auth and can't be scraped directly
    // Trust Pass 1 (Perplexity) since it has access to LinkedIn data
    return { isValid: true, reason: `LinkedIn page could not be scraped (auth required), trusting Pass 1` };
  }
  
  const websiteMatch = linkedinContent.match(/Website[:\s]*\n?\s*(https?:\/\/[^\s\n]+|www\.[^\s\n]+)/i);
  const linkedinWebsite = websiteMatch ? websiteMatch[1].toLowerCase() : null;
  const employeeMatch = linkedinContent.match(/(\d+[-–]\d+|\d+\+?)\s*employees/i);
  const linkedinEmployees = employeeMatch ? employeeMatch[1] : null;
  const locationMatch = linkedinContent.match(/(Fort Worth|Dallas|Toronto|San Francisco|New York|Chicago|Los Angeles|Boston|Seattle|Austin|Denver|Miami|Atlanta|Houston|Phoenix)/i);
  const linkedinLocation = locationMatch ? locationMatch[1] : null;
  
  const issues: string[] = [];
  
  if (linkedinWebsite) {
    const normalizedExpected = expectedDomain.replace(/^www\./, '').toLowerCase();
    const normalizedLinkedin = linkedinWebsite.replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/$/, '').toLowerCase();
    if (!normalizedLinkedin.includes(normalizedExpected) && !normalizedExpected.includes(normalizedLinkedin.split('/')[0])) {
      issues.push(`Website mismatch: LinkedIn shows ${linkedinWebsite}, expected ${expectedDomain}`);
    }
  }
  
  if (linkedinEmployees && expectedEmployeeCount) {
    const linkedinEmpNum = parseInt(linkedinEmployees.replace(/[^\d]/g, ''));
    const expectedEmpNum = parseInt(expectedEmployeeCount.replace(/[^\d]/g, ''));
    if (linkedinEmpNum < 50 && expectedEmpNum > 100) {
      issues.push(`Employee count mismatch: LinkedIn shows ${linkedinEmployees}, expected ~${expectedEmployeeCount}`);
    }
    if (linkedinEmpNum <= 10 && expectedEmpNum > 50) {
      issues.push(`Major employee mismatch: LinkedIn shows ${linkedinEmployees}, expected ~${expectedEmployeeCount}`);
    }
  }
  
  if (linkedinLocation && expectedLocation) {
    const normalizedExpected = expectedLocation.toLowerCase();
    const normalizedLinkedin = linkedinLocation.toLowerCase();
    if (normalizedExpected.includes('toronto') && !normalizedLinkedin.includes('toronto')) {
      if (normalizedLinkedin.includes('fort worth') || normalizedLinkedin.includes('dallas') || normalizedLinkedin.includes('texas')) {
        issues.push(`Location mismatch: LinkedIn shows ${linkedinLocation}, expected ${expectedLocation}`);
      }
    }
  }
  
  if (issues.length > 0) {
    return {
      isValid: false,
      reason: issues.join('; '),
      linkedinEmployees: linkedinEmployees || undefined,
      linkedinWebsite: linkedinWebsite || undefined,
      linkedinLocation: linkedinLocation || undefined
    };
  }
  
  return { isValid: true, linkedinEmployees: linkedinEmployees || undefined, linkedinWebsite: linkedinWebsite || undefined };
}

/**
 * Extract employee count from scraped content
 */
export function extractEmployeeCountFromContent(scrapedContent: Map<string, string>): string | null {
  for (const [url, content] of scrapedContent) {
    // Look for LinkedIn-style employee counts
    const patterns = [
      /(\d{1,3}(?:,\d{3})*)\s*(?:employees|team members|staff)/i,
      /company\s*size[:\s]*(\d{1,3}(?:,\d{3})*)/i,
      /(\d{1,3}(?:,\d{3})*)\s*(?:\+)?\s*employees/i,
    ];
    
    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) {
        return match[1];
      }
    }
  }
  return null;
}
