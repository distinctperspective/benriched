import { LinkedInValidation } from '@benriched/types';
import { scrapeUrl } from './scraper';

export function detectEntityMismatch(
  companyName: string,
  domain: string,
  scrapedContent: Map<string, string>
): { mismatch: boolean; signal: 'none' | 'weak' | 'strong' } {
  const companyLower = (companyName || '').toLowerCase();
  const domainBase = domain.replace(/^www\./, '').split('.')[0].toLowerCase();
  const siteText = Array.from(scrapedContent.entries())
    .filter(([url]) => url.includes(domain.replace(/^www\./, '')))
    .map(([, content]) => content)
    .join(' ')
    .toLowerCase();

  if (!siteText) return { mismatch: false, signal: 'none' };
  const hasCompany = companyLower.length > 3 && siteText.includes(companyLower);
  const hasDomainToken = domainBase.length > 2 && siteText.includes(domainBase);
  if (hasCompany) return { mismatch: false, signal: 'none' };
  if (!hasCompany && hasDomainToken) return { mismatch: true, signal: 'strong' };
  if (!hasCompany && !hasDomainToken) return { mismatch: true, signal: 'weak' };
  return { mismatch: false, signal: 'none' };
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
    const slugMatch = linkedinUrl.match(/linkedin\.com\/company\/([^\/]+)/i);
    const slug = slugMatch ? decodeURIComponent(slugMatch[1]).toLowerCase() : '';

    const domainBase = expectedDomain.replace(/\.(com|net|org|io|co)$/, '').replace(/^www\./, '').toLowerCase();

    const slugNormalized = slug.replace(/['-]/g, '').replace(/\s+/g, '');
    const domainNormalized = domainBase.replace(/['-]/g, '').replace(/\s+/g, '');

    if (slugNormalized.includes(domainNormalized) || domainNormalized.includes(slugNormalized)) {
      return { isValid: true, reason: 'URL slug matches domain (could not scrape for full validation)' };
    }

    return { isValid: false, reason: `Could not scrape LinkedIn, and URL slug "${slug}" doesn't match domain "${domainBase}"` };
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
