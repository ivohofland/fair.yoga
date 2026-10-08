import { describe, it, expect } from 'vitest';
import { summariseCspReport } from './csp-report';

const report = (fields: Record<string, unknown>) => ({ 'csp-report': fields });

describe('summariseCspReport', () => {
  it('keeps the directive, the keyword, the path and the disposition', () => {
    expect(
      summariseCspReport(
        report({
          'document-uri': 'https://fair.yoga/verify?token=secret-token',
          'effective-directive': 'script-src-elem',
          'violated-directive': 'script-src-elem',
          'blocked-uri': 'inline',
          disposition: 'enforce',
        }),
      ),
    ).toEqual({ directive: 'script-src-elem', blockedUri: 'inline', documentPath: '/verify', disposition: 'enforce' });
  });

  it('reduces a blocked URL to its scheme and host', () => {
    const s = summariseCspReport(report({ 'effective-directive': 'script-src-elem', 'blocked-uri': 'https://evil.example:8443/x.js?k=v' }));
    expect(s?.blockedUri).toBe('https://evil.example:8443');
  });

  it('reduces a non-network URL to its scheme', () => {
    const s = summariseCspReport(report({ 'effective-directive': 'img-src', 'blocked-uri': 'data:image/png;base64,AAAA' }));
    expect(s?.blockedUri).toBe('data:');
  });

  it('falls back to violated-directive, then refuses a report with neither', () => {
    expect(summariseCspReport(report({ 'violated-directive': 'img-src' }))?.directive).toBe('img-src');
    expect(summariseCspReport(report({ 'blocked-uri': 'inline' }))).toBeNull();
  });

  it('prefers effective-directive over violated-directive', () => {
    const s = summariseCspReport(report({ 'effective-directive': 'script-src-elem', 'violated-directive': 'script-src' }));
    expect(s?.directive).toBe('script-src-elem');
  });

  it('takes the first token of a violated-directive that carries sources', () => {
    const s = summariseCspReport(report({ 'violated-directive': "script-src 'self' 'nonce-abc'" }));
    expect(s?.directive).toBe('script-src');
  });

  it('marks an empty blocked-uri as none', () => {
    expect(summariseCspReport(report({ 'effective-directive': 'img-src', 'blocked-uri': '' }))?.blockedUri).toBe('none');
  });

  it('keeps a report-only disposition', () => {
    expect(summariseCspReport(report({ 'effective-directive': 'img-src', disposition: 'report' }))?.disposition).toBe('report');
  });

  it('refuses a directive that is not a directive name', () => {
    expect(summariseCspReport(report({ 'effective-directive': 'script-src;forged' }))).toBeNull();
    expect(summariseCspReport(report({ 'effective-directive': '\nforged log line' }))).toBeNull();
    expect(summariseCspReport(report({ 'effective-directive': 'script-src\nforged log line' }))?.directive).toBe('script-src');
  });

  it('marks missing or unparseable fields rather than passing them through', () => {
    expect(summariseCspReport(report({ 'effective-directive': 'img-src', 'document-uri': 'not a url', 'blocked-uri': '%%%', disposition: 'weird' }))).toEqual({
      directive: 'img-src',
      blockedUri: 'other',
      documentPath: 'unknown',
      disposition: 'unknown',
    });
    expect(summariseCspReport(report({ 'effective-directive': 'img-src' }))?.blockedUri).toBe('none');
  });

  it('caps the path', () => {
    const s = summariseCspReport(report({ 'effective-directive': 'img-src', 'document-uri': `https://fair.yoga/${'a'.repeat(1000)}` }));
    expect(s?.documentPath.length).toBe(256);
  });

  it('refuses anything that is not a csp-report object', () => {
    for (const body of [null, 'x', [], {}, { 'csp-report': 'x' }, { 'csp-report': null }]) {
      expect(summariseCspReport(body)).toBeNull();
    }
  });
});
