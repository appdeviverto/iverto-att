// Web-app security checks. Each test asserts the secure behaviour; a failure is an open finding.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { excelCsv, parseCsv, toCsv } from './csv';

// api.ts opens a Supabase client and localStorage on import; stub those for the pure cache filter.
vi.mock('./auth', () => ({ supabase: {}, tenantOverride: null }));
vi.mock('@iverto-org/core-ui', () => ({ toast: {} }));
vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }, location: { origin: 'http://x' } });
const { persistable } = await import('./api');

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('CSV for Excel', () => {
  it.each(['=HYPERLINK("https://evil.example","x")', '+cmd|" /C calc"!A0', '-2+3', '@SUM(A1)'])('neutralises formula cell %s', (v) => {
    expect(excelCsv([[v]]).replace(/^"/, '')).toMatch(/^'/);
  });
  it('leaves the import payload untouched (+91 phones survive)', () => {
    expect(parseCsv(toCsv([['+91 98450 10003']]))).toEqual([['+91 98450 10003']]);
  });
});

describe('deployment headers (vercel.json)', () => {
  const headers = JSON.stringify(JSON.parse(read('../../vercel.json')).headers ?? []);
  it('forbids framing (clickjacking)', () => {
    expect(headers).toMatch(/frame-ancestors 'none'/);
    expect(headers).toMatch(/X-Frame-Options/);
  });
  it('sets a Content-Security-Policy', () => {
    expect(headers).toMatch(/Content-Security-Policy/);
  });
  it('sets nosniff and a referrer policy', () => {
    expect(headers).toMatch(/X-Content-Type-Options/);
    expect(headers).toMatch(/Referrer-Policy/);
  });
});

describe('persisted query cache', () => {
  // Was: after HR opened one payroll run, localStorage held every bank account, PAN and salary for 24 h.
  const q = (...queryKey: unknown[]) => ({ queryKey, state: { status: 'success' } });
  it.each(['payroll', 'employees', 'documents', 'users', 'expenses', 'profile-requests'])('never writes %s queries to localStorage', (k) => {
    expect(persistable(q(k, 'runs', {}))).toBe(false);
  });
  it('still persists reference data', () => {
    expect(persistable(q('sites', {}))).toBe(true);
  });
  it('main.tsx wires the filter into the persister', () => {
    expect(read('../main.tsx')).toMatch(/shouldDehydrateQuery: persistable/);
  });
});
