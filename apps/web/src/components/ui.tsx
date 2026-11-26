import {
  Button, Card, Switch, ColorSwatchPicker, confirmAction, DateInput, Field, Modal, requestReason, SearchSelect, Select, TextField, Textarea, type SelectOption,
} from '@iverto-org/core-ui';
import { Check, Clock, Minus, X } from 'lucide-react';
import { useId, useState, type MouseEvent, type ReactNode } from 'react';
import { post, useAction, useDepartments, useEmployeeOptions, useSites } from '../lib/api';
import { WEEKDAYS } from '../lib/format';

/** Tables sit in `<Card padding="none">` (core-ui page recipe). */
export const Panel = ({ children, className = '' }: { children: ReactNode; className?: string }) => (
  <Card padding="none" className={`overflow-hidden ${className}`}>
    <div className="overflow-auto">{children}</div>
  </Card>
);

/** Page filter selects (`w-full sm:w-56`, core-ui convention). */
export function SiteSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data } = useSites();
  return (
    <Select hideLabel label="Site" placeholder="All sites" containerClassName="w-full sm:w-56" value={value} onChange={(e) => onChange(e.target.value)}
      options={(data ?? []).map((s) => ({ value: s.id, label: s.name }))} />
  );
}

export function DepartmentSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data } = useDepartments();
  return (
    <Select hideLabel label="Department" placeholder="All departments" containerClassName="w-full sm:w-56" value={value} onChange={(e) => onChange(e.target.value)}
      options={(data ?? []).map((d) => ({ value: d.id, label: d.name }))} />
  );
}

/** At or below this many options there is nothing to search: a native select, whose popup is never clipped by a modal. */
const NATIVE_MAX = 8;

/**
 * The dropdown for modal forms: a type-to-search combobox (core-ui SearchSelect) in a labelled Field.
 * Takes Select-style options. `placeholder` doubles as the meaning of "nothing picked" ("No department").
 * Short fixed lists (kind, type, role…) render as a native select instead: SearchSelect's list is an
 * absolutely-positioned box that a scrolling modal body clips.
 */
export function Pick({ label, value, onChange, options, placeholder, required, hint, avatar = false, emptyText }: {
  label: ReactNode; value: string; onChange: (v: string) => void; options: (SelectOption & { description?: string; keywords?: string })[];
  placeholder?: string; required?: boolean; hint?: ReactNode; avatar?: boolean; emptyText?: string;
}) {
  if (!avatar && options.length > 0 && options.length <= NATIVE_MAX) {
    return (
      <Select label={label} hint={hint} required={required} value={value} onChange={(e) => onChange(e.target.value)}
        // Keep an empty choice when nothing is picked yet, or when "nothing" is a valid answer ("No department").
        placeholder={!value || placeholder ? (placeholder && placeholder !== 'Search…' ? placeholder : 'Choose…') : undefined}
        options={options.map((o) => ({ value: o.value, label: o.description ? `${o.label} — ${o.description}` : o.label, disabled: o.disabled }))} />
    );
  }
  return (
    <Field label={label} required={required} hint={hint}>
      {({ id }) => (
        <div className="relative">
          <SearchSelect id={id} showAvatar={avatar} placeholder={placeholder ?? 'Search…'} value={value} onChange={onChange} emptyText={emptyText}
            options={options.filter((o) => !o.disabled).map((o) => ({ id: o.value, label: o.label, description: o.description, keywords: o.keywords }))} />
          {/* SearchSelect has no native input to mark required; this keeps the browser's "please fill in" check. */}
          {required && <input tabIndex={-1} aria-hidden required value={value} onChange={() => {}} className="pointer-events-none absolute inset-x-0 bottom-0 h-px opacity-0" />}
        </div>
      )}
    </Field>
  );
}

export function EmployeePicker({ value, onChange, label = 'Employee', required }: { value: string; onChange: (id: string) => void; label?: string; required?: boolean }) {
  const { data } = useEmployeeOptions();
  return (
    <Pick label={label} required={required} avatar placeholder="Search by name or code" value={value} onChange={onChange}
      options={(data?.items ?? []).map((e) => ({ value: e.id, label: e.fullName, description: e.employeeCode, keywords: e.email ?? '' }))} />
  );
}

/**
 * Pick several employees: a summary button that opens an inline list (search, Select all for what is
 * shown, site/department filters). Inline rather than a floating popup, so a modal never clips it.
 */
export function EmployeeMultiPicker({ value, onChange, label = 'Employees', required }: { value: string[]; onChange: (ids: string[]) => void; label?: string; required?: boolean }) {
  const employees = useEmployeeOptions().data?.items ?? [];
  const sites = useSites().data ?? [];
  const departments = useDepartments().data ?? [];
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [siteId, setSiteId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const chosen = new Set(value);
  const shown = employees.filter((e) =>
    (!siteId || e.siteId === siteId) && (!departmentId || e.departmentId === departmentId) &&
    (!q || `${e.fullName} ${e.employeeCode} ${e.email ?? ''}`.toLowerCase().includes(q.toLowerCase())));
  const allShown = shown.length > 0 && shown.every((e) => chosen.has(e.id));
  const toggleAll = () => onChange(allShown ? value.filter((id) => !shown.some((e) => e.id === id)) : [...new Set([...value, ...shown.map((e) => e.id)])]);
  const toggle = (id: string) => onChange(chosen.has(id) ? value.filter((x) => x !== id) : [...value, id]);
  const names = employees.filter((e) => chosen.has(e.id)).map((e) => e.fullName);
  const summary = !names.length ? 'Choose employees' : names.length <= 3 ? names.join(', ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;

  return (
    <Field label={label} required={required} hint={value.length ? `${value.length} selected` : undefined}>
      {({ id }) => (
        <div className="relative">
          <button id={id} type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}
            className="field flex w-full items-center justify-between gap-2 text-left">
            <span className={`truncate ${names.length ? 'text-fg' : 'text-fg-subtle'}`}>{summary}</span>
            <span className="flex shrink-0 items-center gap-2">
              {value.length > 0 && <span className="rounded-full bg-brand-soft px-2 py-0.5 text-xs font-semibold text-brand">{value.length}</span>}
              <span className={`text-fg-subtle transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
            </span>
          </button>
          {required && <input tabIndex={-1} aria-hidden required value={value.length ? 'x' : ''} onChange={() => {}} className="pointer-events-none absolute inset-x-0 bottom-0 h-px opacity-0" />}
          {open && (
            <div className="mt-2 overflow-hidden rounded-2xl border border-line bg-surface-raised shadow-soft">
              <div className="space-y-2 border-b border-line-soft p-3">
                <TextField hideLabel label="Search employees" placeholder="Search name or code" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
                <div className="grid grid-cols-2 gap-2">
                  <Select hideLabel label="Site" placeholder="All sites" value={siteId} onChange={(e) => setSiteId(e.target.value)} options={sites.map((s) => ({ value: s.id, label: s.name }))} />
                  <Select hideLabel label="Department" placeholder="All departments" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} options={departments.map((d) => ({ value: d.id, label: d.name }))} />
                </div>
              </div>
              <label className="flex cursor-pointer items-center gap-3 border-b border-line-soft bg-surface-subtle px-4 py-2.5 text-sm font-semibold text-fg">
                <input type="checkbox" className="size-4 accent-[var(--color-brand)]" checked={allShown} onChange={toggleAll} disabled={!shown.length} />
                Select all{q || siteId || departmentId ? ' shown' : ''} ({shown.length})
                {value.length > 0 && <button type="button" className="ml-auto text-xs font-semibold text-brand hover:underline" onClick={(e) => { e.preventDefault(); onChange([]); }}>Clear</button>}
              </label>
              <ul className="max-h-64 overflow-y-auto py-1">
                {shown.map((e) => (
                  <li key={e.id}>
                    <label className="flex cursor-pointer items-center gap-3 px-4 py-2 hover:bg-surface-subtle">
                      <input type="checkbox" className="size-4 accent-[var(--color-brand)]" checked={chosen.has(e.id)} onChange={() => toggle(e.id)} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-fg">{e.fullName}</span>
                        <span className="block truncate text-xs text-fg-muted">{e.employeeCode}</span>
                      </span>
                    </label>
                  </li>
                ))}
                {!shown.length && <li className="px-4 py-3 text-sm text-fg-muted">No one matches</li>}
              </ul>
              <div className="flex justify-end border-t border-line-soft px-3 py-2">
                <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>Done</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Field>
  );
}

/** Office locations, searchable, with each one's timezone underneath. */
export function SitePicker({ value, onChange, label = 'Location', required, placeholder = 'Search locations' }: { value: string; onChange: (id: string) => void; label?: string; required?: boolean; placeholder?: string }) {
  const { data } = useSites();
  return (
    <Pick label={label} required={required} placeholder={placeholder} value={value} onChange={onChange}
      options={(data ?? []).map((s) => ({ value: s.id, label: s.name, description: [s.address, s.timezone].filter(Boolean).join(' · ') }))} />
  );
}

/** A short form in a Modal, primary action last (core-ui). */
export function FormModal({
  open, onClose, title, description, onSubmit, saving, submitLabel, children, size,
}: {
  open: boolean; onClose: () => void; title: string; description?: string; onSubmit: () => void; saving?: boolean;
  submitLabel: string; children: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' | 'drawer';
}) {
  const id = useId();
  return (
    <Modal open={open} onClose={onClose} title={title} description={description} size={size}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" form={id} loading={saving}>{submitLabel}</Button>
        </>
      }>
      <form id={id} className="space-y-4 p-5 sm:p-6" onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
        {children}
      </form>
    </Modal>
  );
}

/** Flat form state: `const [f, set] = useForm({...}); set('name')(value)`. */
export function useForm<T extends Record<string, unknown>>(initial: T) {
  const [form, setForm] = useState(initial);
  const set = <K extends keyof T>(key: K) => (value: T[K]) => setForm((f) => ({ ...f, [key]: value }));
  return [form, set, setForm] as const;
}

// ── Declarative fields (Crud and a few hand-written forms) ──────────────────

export interface FieldSpec {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'time' | 'date' | 'color' | 'bool' | 'select' | 'weekdays' | 'textarea' | 'email' | 'employee';
  options?: SelectOption[];
  placeholder?: string;
  required?: boolean;
  hint?: string;
  /** Hide unless this returns true for the current form. */
  when?: (form: Record<string, any>) => boolean;
}

const SWATCHES = ['#cd0447', '#2563eb', '#059669', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#4b5563'];

export function Fields({ specs, form, set }: { specs: FieldSpec[]; form: Record<string, any>; set: (k: string) => (v: any) => void }) {
  return (
    <>
      {specs.filter((s) => !s.when || s.when(form)).map((s) => {
        const v = form[s.key];
        switch (s.type) {
          case 'bool':
            return <Switch key={s.key} label={s.label} description={s.hint} checked={Boolean(v)} onChange={set(s.key)} />;
          case 'select':
            return <Pick key={s.key} label={s.label} hint={s.hint} required={s.required} placeholder={s.placeholder ?? 'Search…'} options={s.options ?? []} value={v ?? ''} onChange={set(s.key)} />;
          case 'color':
            return <ColorSwatchPicker key={s.key} label={s.label} max={1} swatches={SWATCHES} value={v ? [v] : []} onChange={(c) => set(s.key)(c[c.length - 1] ?? null)} />;
          case 'weekdays':
            return (
              <Field key={s.key} label={s.label} hint={s.hint}>
                {() => (
                  <div className="flex flex-wrap gap-3">
                    {WEEKDAYS.map((d, i) => (
                      <Switch key={d} label={d} checked={(v ?? []).includes(i)}
                        onChange={(on) => set(s.key)(on ? [...(v ?? []), i].sort() : (v ?? []).filter((x: number) => x !== i))} />
                    ))}
                  </div>
                )}
              </Field>
            );
          case 'employee':
            return <EmployeePicker key={s.key} label={s.label} required={s.required} value={v ?? ''} onChange={set(s.key)} />;
          case 'textarea':
            return <Textarea key={s.key} label={s.label} hint={s.hint} required={s.required} value={v ?? ''} onChange={(e) => set(s.key)(e.target.value)} />;
          case 'time':
          case 'date':
            return <DateInput key={s.key} mode={s.type} label={s.label} hint={s.hint} required={s.required} value={v ?? ''} onChange={(e) => set(s.key)(e.target.value)} />;
          default:
            return (
              <TextField key={s.key} label={s.label} hint={s.hint} required={s.required} placeholder={s.placeholder}
                type={s.type === 'number' ? 'number' : s.type === 'email' ? 'email' : 'text'} value={v ?? ''}
                onChange={(e) => set(s.key)(s.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)} />
            );
        }
      })}
    </>
  );
}

/** Approve / reject / cancel for a request (`${path}/${id}/approve|reject|cancel`); reject asks why. */
export function Decide({ path, id, noun, canDecide, canCancel }: { path: string; id: string; noun: string; canDecide: boolean; canCancel?: boolean }) {
  const act = useAction(({ verb, note }: { verb: string; note?: string }) => post(`${path}/${id}/${verb}`, note ? { note } : {}), {
    invalidate: [path.split('/').slice(0, 2).join('/'), '/attendance'],
    success: `${noun} updated`,
  });
  const stop = (e: MouseEvent) => e.stopPropagation();
  return (
    <div className="flex gap-2" onClick={stop}>
      {canDecide && <Button size="sm" loading={act.isPending} onClick={() => act.mutate({ verb: 'approve' })}>Approve</Button>}
      {canDecide && (
        <Button size="sm" variant="danger" onClick={async () => {
          const note = await requestReason({ title: `Reject this ${noun.toLowerCase()}?`, message: 'The employee sees your reason.', confirmLabel: 'Reject', tone: 'danger', minLength: 3 });
          if (note) act.mutate({ verb: 'reject', note });
        }}>Reject</Button>
      )}
      {canCancel && (
        <Button size="sm" variant="ghost" onClick={async () => {
          if (await confirmAction({ title: `Cancel this ${noun.toLowerCase()}?`, confirmLabel: `Cancel ${noun.toLowerCase()}` })) act.mutate({ verb: 'cancel' });
        }}>Cancel</Button>
      )}
    </div>
  );
}

/** Drops '' so optional fields are omitted rather than sent empty (the API validates types strictly). */
export const clean = (form: Record<string, unknown>) => Object.fromEntries(Object.entries(form).filter(([, v]) => v !== ''));

// ── Approval tracker ────────────────────────────────────────────────────────

export interface TrackStep { key: string; label: string; state: 'done' | 'current' | 'upcoming' | 'rejected' | 'cancelled' | 'skipped'; at: string | null; by: string | null; note: string | null }
export interface Progress { levels: 1 | 2; stage: string; steps: TrackStep[] }

const DOT: Record<TrackStep['state'], string> = {
  done: 'bg-success text-white',
  current: 'bg-brand text-on-brand ring-4 ring-brand-soft animate-pulse',
  upcoming: 'bg-surface-subtle text-fg-subtle',
  rejected: 'bg-danger-soft text-danger-fg',
  cancelled: 'bg-surface-subtle text-fg-muted',
  skipped: 'bg-surface-subtle text-fg-muted',
};
const GLYPH: Record<TrackStep['state'], ReactNode> = { done: <Check size={14} />, current: <Clock size={14} />, upcoming: null, rejected: <X size={14} />, cancelled: <X size={14} />, skipped: <Minus size={14} /> };
const STATE_TEXT: Partial<Record<TrackStep['state'], string>> = { current: 'Waiting', skipped: 'Not needed', cancelled: 'Cancelled', rejected: 'Rejected' };

/** Order-tracking style: Submitted → Manager → (HR) → Approved, with who, when and any reason. */
export function ApprovalTracker({ progress }: { progress: Progress }) {
  const { steps } = progress;
  // The bar fills up to the last step that is no longer upcoming.
  const reached = steps.reduce((n, s, i) => (s.state !== 'upcoming' ? i : n), 0);
  const stopped = steps.some((s) => s.state === 'rejected' || s.state === 'cancelled');
  return (
    <div className="space-y-4" role="list" aria-label="Approval progress">
      <div className="relative mx-4">
        <div className="absolute inset-x-0 top-4 h-1 rounded-full bg-surface-subtle" />
        <div className={`absolute left-0 top-4 h-1 rounded-full transition-all ${stopped ? 'bg-danger-soft' : 'bg-success'}`} style={{ width: `${(reached / (steps.length - 1)) * 100}%` }} />
        <div className="relative flex justify-between">
          {steps.map((s) => (
            <div key={s.key} role="listitem" aria-label={`${s.label}: ${STATE_TEXT[s.state] ?? s.state}`}
              className={`grid size-9 place-items-center rounded-full text-sm font-semibold ${DOT[s.state]}`}>
              {GLYPH[s.state]}
            </div>
          ))}
        </div>
      </div>
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
        {steps.map((s, i) => (
          <div key={s.key} className={`text-xs ${i === 0 ? 'text-left' : i === steps.length - 1 ? 'text-right' : 'text-center'}`}>
            <div className={`font-semibold ${s.state === 'rejected' ? 'text-danger-fg' : s.state === 'upcoming' ? 'text-fg-subtle' : 'text-fg'}`}>{s.label}</div>
            {STATE_TEXT[s.state] && s.label !== STATE_TEXT[s.state] && <div className="text-fg-muted">{STATE_TEXT[s.state]}</div>}
            {s.by && <div className="text-fg-muted">{s.by}</div>}
            {s.at && <div className="text-fg-subtle">{new Date(s.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</div>}
          </div>
        ))}
      </div>
      {steps.filter((s) => s.note && (s.state === 'rejected' || s.state === 'cancelled')).map((s) => (
        <div key={s.key} className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg"><span className="font-semibold">Reason: </span>{s.note}</div>
      ))}
    </div>
  );
}
