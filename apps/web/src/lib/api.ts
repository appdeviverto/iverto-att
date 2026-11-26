import { toast } from '@iverto-org/core-ui';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import { MutationCache, QueryCache, QueryClient, useInfiniteQuery, useMutation, useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { removeOldestQuery } from '@tanstack/react-query-persist-client';
import { supabase, tenantOverride } from './auth';

const BASE = import.meta.env.VITE_API_URL ?? '/v1';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

type Params = Record<string, string | number | boolean | string[] | null | undefined>;


async function request(path: string, init: { method?: string; body?: unknown; query?: Params }) {
  const { data } = await supabase.auth.getSession();
  const url = new URL(BASE + path, window.location.origin);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const headers: Record<string, string> = {};
  if (data.session) headers.Authorization = `Bearer ${data.session.access_token}`;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const override = tenantOverride();
  if (override) headers['X-Tenant-Id'] = override;
  const res = await fetch(url, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    const err = new ApiError(res.status, json?.code ?? 'ERROR', json?.message ?? res.statusText, json?.details);
    if (['UNAUTHORIZED', 'TENANT_SUSPENDED', 'PASSWORD_CHANGE_REQUIRED', 'MFA_REQUIRED'].includes(err.code)) {
      window.dispatchEvent(new CustomEvent('iverto:auth', { detail: err.code }));
    }
    // The platform switched a module off since /org was cached: refetch it so the nav and pages catch up.
    if (err.code === 'FEATURE_DISABLED') void queryClient.invalidateQueries({ queryKey: keyOf('/org') });
    throw err;
  }
  return res;
}

/** Every error leaves the API as { statusCode, code, message, details? } (§14). */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; query?: Params } = {}): Promise<T> {
  const res = await request(path, init);
  return (res.status === 204 ? null : await res.json().catch(() => null)) as T;
}

/** A file the API streams (xlsx, csv, pdf) → saved under the name it sends. Confidential files never touch the cache. */
export async function downloadFile(path: string, query?: Params, fallbackName = 'download') {
  const res = await request(path, { query });
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A picked file as base64 (no data: prefix), for the JSON upload endpoints. */
export const fileToBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

export const post = <T = unknown>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
export const patch = <T = unknown>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body });
export const put = <T = unknown>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body });
export const del = <T = unknown>(path: string, body?: unknown) => api<T>(path, { method: 'DELETE', body });

/**
 * Changing the password revokes every session server-side, so the old refresh token is dead.
 * Sign straight back in with the new password: the fresh token also has must_change_password = false.
 */
export async function changeOwnPassword(email: string, currentPassword: string, newPassword: string) {
  await post('/auth/password', { currentPassword, newPassword });
  const { error } = await supabase.auth.signInWithPassword({ email, password: newPassword });
  if (error) throw error;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

// ── Caching ───────────────────────────────────────────────────────────────
// TanStack Query is the cache: stale-while-revalidate in memory, persisted to
// localStorage so a reload paints instantly from the last snapshot, then
// revalidates. The persisted cache is keyed to the user (buster) and wiped on
// sign-out. Socket deltas patch it in place (lib/live.ts).

const DAY = 24 * 60 * 60_000;
export const CACHE_MAX_AGE = DAY;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: DAY, // must be ≥ the persister maxAge, or restored entries are dropped at once
      retry: (count, e) => !(e instanceof ApiError && e.status < 500) && count < 2,
    },
  },
  // Only a failed first load is worth a toast; a failed background refetch keeps showing cached data.
  queryCache: new QueryCache({ onError: (e, q) => q.state.data === undefined && !(e instanceof ApiError && e.status === 401) && toast.error('Could not load', errorText(e)) }),
  mutationCache: new MutationCache({ onError: (e) => toast.error('That didn’t work', errorText(e)) }),
});

export const persister = createSyncStoragePersister({
  storage: window.localStorage,
  key: 'iverto-att-cache',
  throttleTime: 1000,
  retry: removeOldestQuery, // localStorage full → drop the oldest queries rather than fail
});

/**
 * Kept in memory only, never written to localStorage: pay and bank details, PAN, documents, the people
 * directory and logins. A persisted copy would outlive the tab (24 h) and sit within reach of any XSS.
 */
const NOT_PERSISTED = new Set(['payroll', 'employees', 'documents', 'users', 'expenses', 'profile-requests', 'letter-templates', 'audit-logs']);
export const persistable = (q: { queryKey: readonly unknown[]; state: { status: string } }) =>
  q.state.status === 'success' && !NOT_PERSISTED.has(String(q.queryKey[0]));

export function clearCache() {
  queryClient.clear();
  window.localStorage.removeItem('iverto-att-cache');
}

/** Reference data (sites, shifts, leave types…) changes rarely: serve from cache for 10 minutes. */
export const REFERENCE = { staleTime: 10 * 60_000 } as const;

/** Query keys are the path's segments + params, so invalidating '/employees' also covers '/employees/:id'. */
export const keyOf = (path: string, params?: Params) => [...path.split('/').filter(Boolean), params ?? {}];

export function useApi<T>(path: string | null, params?: Params, options: Partial<UseQueryOptions<T>> = {}) {
  return useQuery<T>({
    queryKey: keyOf(path ?? '', params),
    queryFn: () => api<T>(path!, { query: params }),
    enabled: path !== null && options.enabled !== false,
    ...options,
  } as UseQueryOptions<T>);
}

/** The paid modules the platform switched on for this tenant (tenant.settings.features); off until `loaded`. */
export function useFeatures() {
  const org = useApi<{ settings?: { features?: { hr?: boolean; payroll?: boolean } } }>('/org').data;
  return { loaded: Boolean(org), hr: org?.settings?.features?.hr === true, payroll: org?.settings?.features?.payroll === true };
}

/** Cursor-paginated lists ({ data, nextCursor }) behind a "Load more" ListFooter. */
export function useCursor<T>(path: string, params: Params = {}) {
  const q = useInfiniteQuery({
    queryKey: [...keyOf(path, params), 'pages'],
    queryFn: ({ pageParam }) => api<Cursor<T>>(path, { query: { ...params, cursor: pageParam } }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  return { ...q, rows: q.data?.pages.flatMap((p) => p.data) ?? [] };
}

export const invalidate = (...paths: string[]) =>
  Promise.all(paths.map((p) => queryClient.invalidateQueries({ queryKey: p.split('/').filter(Boolean) })));

/** A mutation that refreshes the given lists and says what happened. Errors toast globally. */
export function useAction<V = void, R = unknown>(
  fn: (vars: V) => Promise<R>,
  opts: { invalidate?: string[]; success?: string | ((r: R) => string); onSuccess?: (r: R, vars: V) => void } = {},
) {
  return useMutation<R, Error, V>({
    mutationFn: fn,
    onSuccess: async (r, vars) => {
      await invalidate(...(opts.invalidate ?? []));
      const msg = typeof opts.success === 'function' ? opts.success(r) : opts.success;
      if (msg) toast.success(msg);
      opts.onSuccess?.(r, vars);
    },
  });
}

// ── Shapes used across pages (the API has no response DTOs to generate from) ──

export interface Page<T> { items: T[]; total: number; page: number; size: number }
export interface Cursor<T> { data: T[]; nextCursor: string | null }
export interface Named { id: string; name: string }
export interface Site extends Named { timezone: string; address?: string | null; holidayCalendarId?: string | null }
export interface Shift extends Named { code: string; color: string | null; kind: string; startTime: string; endTime: string; breakMinutes: number; requiredMinutes: number; isNight: boolean; isDefault: boolean; active: boolean }
export interface LeaveType extends Named { code: string; color: string | null; active: boolean; allowHalfDay: boolean; unit: 'DAYS' | 'HOURS' }
export interface EmployeeLite { id: string; fullName: string; employeeCode: string; email?: string | null; siteId: string; departmentId: string | null }
export interface UserProfile { userId: string; email: string; displayName: string; role: string; status: string; employeeId: string | null; siteIds: string[]; mustChangePassword: boolean; createdAt: string }

export const useSites = () => useApi<Site[]>('/sites', undefined, REFERENCE);
export const useDepartments = () => useApi<(Named & { code?: string })[]>('/departments', undefined, REFERENCE);
export const useProjects = () => useApi<Named[]>('/projects', undefined, REFERENCE);
export const useShifts = () => useApi<Shift[]>('/shifts', undefined, REFERENCE);
export const useLeaveTypes = () => useApi<LeaveType[]>('/leave/types', undefined, REFERENCE);

/** The organisation's employee categories (Settings → Organisation), defaulting like the API does. */
export const DEFAULT_EMPLOYMENT_TYPES = [
  { code: 'FULL_TIME', label: 'Full time' }, { code: 'PART_TIME', label: 'Part time' }, { code: 'CONTRACT', label: 'Contract' }, { code: 'INTERN', label: 'Intern' },
];
export const useEmploymentTypes = (): { code: string; label: string }[] => {
  const list = useApi<{ settings: Record<string, any> }>('/org', undefined, REFERENCE).data?.settings.employmentTypes;
  return list?.length ? list : DEFAULT_EMPLOYMENT_TYPES;
};
export const usePolicies = () => useApi<Named[]>('/attendance-policies', undefined, REFERENCE);
export const useCalendars = () => useApi<Named[]>('/holiday-calendars', undefined, REFERENCE);
export const useUsers = (enabled = true) => useApi<UserProfile[]>('/users', undefined, { ...REFERENCE, enabled });
// ponytail: pickers load the first 500 in-scope employees; switch to server search when a tenant outgrows that.
export const useEmployeeOptions = (enabled = true) =>
  useApi<Page<EmployeeLite>>('/employees', { size: 500 }, { ...REFERENCE, enabled });

/** Signed 5-minute URL → browser download (§11.2). */
export async function downloadExport(jobId: string) {
  const { url } = await api<{ url: string }>(`/reports/exports/${jobId}/download`, { query: { redirect: false } });
  window.location.assign(url);
}

/** The employee directory's field registry (API employees/fields.ts): labels, rules, sections, accepted header spellings. */
export interface ImportColumn {
  key: string; label: string; section: string; required: boolean; rule: string; example: string; aka: string[];
  type: 'text' | 'date' | 'int' | 'money' | 'email' | 'enum' | 'ref'; values: string[] | null;
  /** Import-only (site/department by name, manager code, salary), not an employee field. */
  virtual: boolean; sensitive: boolean; selfEditable: boolean;
}
export const useImportColumns = () => useApi<ImportColumn[]>('/employees/import/columns', undefined, REFERENCE);

/** ₹ with Indian grouping: 3512345.5 → "₹35,12,345.50". */
export const inr = (rupees: number | null | undefined, decimals = 2) =>
  rupees === null || rupees === undefined ? '—' : `₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
/** Paise (payroll run detail) → "₹35,123.45". */
export const inrPaise = (paise: number) => inr(paise / 100);
