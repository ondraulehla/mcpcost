/**
 * The monthly reports: one entry per report page under /report. A report is dated:
 * it reads the run that its dataset was written from, so the page and the file say the same.
 */
export interface Report {
  /** YYYY-MM, the path under /report. */
  month: string;
  title: string;
  /** The day of the run the report and the dataset are built from (ISO date). */
  run: string;
  /** The day the page first went out (ISO date): datePublished in the JSON-LD; dateModified is the run day. */
  published: string;
  /** The first full run the report compares against (ISO date). */
  from: string;
  /** The dataset: a static file of the site, gzip of a JSON document, CC BY 4.0. */
  dataset: { path: string; size: string };
  /** The same run as re-check evidence for the registry, in the shape agreed in modelcontextprotocol/registry#1715. */
  evidence?: { path: string; size: string };
}

export const REPORTS: Report[] = [
  {
    month: '2026-10',
    title: 'The state of the MCP registry, October 2026',
    run: '2026-10-31',
    published: '2026-10-24',
    from: '2026-10-03',
    dataset: { path: '/data/mcpcost-2026-10.json.gz', size: '1.6 MB' },
    evidence: { path: '/data/mcpcost-evidence-2026-10.json.gz', size: '2.1 MB' }
  }
];

/** The next month as an ISO prefix, for the end of a half-open range. */
export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** The day after an ISO date, for the end of a half-open range. */
export function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** "October 2026" for 2026-10. */
export function monthName(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]} ${y}`;
}
