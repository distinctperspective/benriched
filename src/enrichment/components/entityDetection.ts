/**
 * Detect if there's a mismatch between the company name from Pass 1
 * and what's actually on the company's website
 */
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
