/**
 * What the report route logs from a browser's CSP violation report
 * (`application/csp-report`, sent for the page policy's `report-uri`).
 * Every field is reduced before it is logged: a query string can carry a
 * token, and a blocked URL's path is the sender's to choose.
 */
export const CSP_REPORT_PATH = '/api/csp-report';
export const MAX_CSP_REPORT_BYTES = 8 * 1024;

const MAX_PATH = 256;
const DIRECTIVE = /^[a-z-]{1,64}$/;
const KEYWORD = /^[a-z-]{1,32}$/;

export interface CspReportSummary {
  directive: string;
  blockedUri: string;
  documentPath: string;
  disposition: 'enforce' | 'report' | 'unknown';
}

function field(report: Record<string, unknown>, name: string): string | undefined {
  const value = report[name];
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function blockedOrigin(raw: string | undefined): string {
  if (raw === undefined || raw === '') return 'none';
  if (KEYWORD.test(raw)) return raw;
  try {
    const url = new URL(raw);
    return url.host === '' ? url.protocol : `${url.protocol}//${url.host}`;
  } catch {
    return 'other';
  }
}

function documentPath(raw: string | undefined): string {
  if (raw === undefined) return 'unknown';
  try {
    return new URL(raw).pathname.slice(0, MAX_PATH);
  } catch {
    return 'unknown';
  }
}

/** The loggable summary of a parsed report body, or null when it is not a CSP report. */
export function summariseCspReport(body: unknown): CspReportSummary | null {
  if (!isRecord(body)) return null;
  const report = body['csp-report'];
  if (!isRecord(report)) return null;
  const directive = field(report, 'effective-directive') ?? field(report, 'violated-directive');
  if (directive === undefined || !DIRECTIVE.test(directive)) return null;
  const disposition = field(report, 'disposition');
  return {
    directive,
    blockedUri: blockedOrigin(field(report, 'blocked-uri')),
    documentPath: documentPath(field(report, 'document-uri')),
    disposition: disposition === 'enforce' || disposition === 'report' ? disposition : 'unknown',
  };
}
