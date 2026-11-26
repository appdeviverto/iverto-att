import { Button, Callout, Card, IconButton, Select, Switch, Textarea, TextField } from '@iverto-org/core-ui';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { put, useAction, useApi } from '../lib/api';
import { Pick } from './ui';

const Heading = ({ title, subtitle }: { title: string; subtitle?: string }) => (
  <div>
    <h2 className="text-lg font-bold text-fg">{title}</h2>
    {subtitle && <p className="text-sm text-fg-muted">{subtitle}</p>}
  </div>
);

// ── Payroll ─────────────────────────────────────────────────────────────────

interface PtSlab { min: number; amount: number; febAmount?: number }
interface PayrollSettings {
  cycleStartDay: number; payDay: number; lockOn: 'APPROVED' | 'PAID' | 'MANUAL'; lockMode: 'BLOCK' | 'SNAPSHOT_ONLY'; lockGraceDays: number;
  otEnabled: boolean; otMultiplier: number; otBase: 'GROSS' | 'BASIC'; standardHoursPerDay: number;
  pfRate: number; pfWageCap: number; esiEmployeeRate: number; esiEmployerRate: number; esiThreshold: number;
  ptSlabs: Record<string, PtSlab[]>; defaultPtState: string | null;
}

/** States and UTs that levy professional tax (state code = what salaries store as their PT state). */
const PT_STATES: Record<string, string> = {
  AP: 'Andhra Pradesh', AS: 'Assam', BR: 'Bihar', GJ: 'Gujarat', JH: 'Jharkhand', KA: 'Karnataka', KL: 'Kerala', MP: 'Madhya Pradesh',
  MH: 'Maharashtra', MN: 'Manipur', ML: 'Meghalaya', MZ: 'Mizoram', NL: 'Nagaland', OD: 'Odisha', PB: 'Punjab', PY: 'Puducherry',
  SK: 'Sikkim', TN: 'Tamil Nadu', TG: 'Telangana', TR: 'Tripura', WB: 'West Bengal',
};
const stateName = (code: string) => PT_STATES[code] ?? code;
type Amount = number | '';
/**
 * A slab as HR thinks of it: an upper limit and the tax up to it. Each slab starts one rupee
 * above the previous one's limit (the first at ₹0); the last has no limit ("and above").
 * Stored by the API as starting amounts (`min`).
 */
interface SlabRow { upTo: Amount; amount: Amount; febAmount: Amount }
interface StateSlabs { state: string; slabs: SlabRow[] }
const inr0 = (n: number) => `₹${n.toLocaleString('en-IN')}`;
const toRows = (slabs: PtSlab[]): SlabRow[] => {
  const sorted = [...slabs].sort((x, y) => x.min - y.min);
  return sorted.map((x, i) => ({ upTo: i < sorted.length - 1 ? sorted[i + 1].min - 1 : '', amount: x.amount, febAmount: x.febAmount ?? '' }));
};
/** Where slab k starts: ₹0, or one rupee above the previous slab's limit. */
const fromOf = (rows: SlabRow[], k: number) => (k === 0 ? 0 : rows[k - 1].upTo === '' ? null : Number(rows[k - 1].upTo) + 1);
const toPtSlabs = (rows: SlabRow[]): PtSlab[] =>
  rows.map((r, k) => ({ min: fromOf(rows, k) ?? 0, amount: Number(r.amount), ...(r.febAmount !== '' ? { febAmount: Number(r.febAmount) } : {}) }));

/** Problems that would make the slabs ambiguous; empty = fine. */
function slabProblems(rows: SlabRow[]): string[] {
  const out: string[] = [];
  if (!rows.length) out.push('Add at least one slab');
  if (rows.some((r) => r.amount === '')) out.push('Every slab needs a tax amount (0 for no tax)');
  if (rows.slice(0, -1).some((r) => r.upTo === '')) out.push('Every slab except the last needs an “up to” amount');
  if (rows.length && rows[rows.length - 1].upTo !== '') out.push('Clear the last slab’s “up to” (it means “and above”) or add a slab after it');
  for (let k = 0; k < rows.length - 1; k++) {
    const from = fromOf(rows, k);
    if (rows[k].upTo !== '' && from !== null && Number(rows[k].upTo) < from) {
      out.push(`Slab ${k + 1}’s limit must be at least ${inr0(from)}`);
      break;
    }
  }
  return out;
}

function taxFor(rows: SlabRow[], gross: number, february: boolean) {
  const slab = rows.find((r, k) => k === rows.length - 1 || (r.upTo !== '' && gross <= Number(r.upTo)));
  if (!slab) return 0;
  return february && slab.febAmount !== '' ? Number(slab.febAmount) : Number(slab.amount || 0);
}

/**
 * Professional tax: one card per state with its monthly slabs as a small table.
 * Each salary names its PT state (or uses the default); the slab is picked by
 * the gross earned that month.
 */
function ProfessionalTaxEditor({ value, onChange, defaultState, onDefaultState }: {
  value: StateSlabs[]; onChange: (v: StateSlabs[]) => void; defaultState: string | null; onDefaultState: (v: string | null) => void;
}) {
  const [adding, setAdding] = useState('');
  const [tryGross, setTryGross] = useState<Amount>(30000);
  const used = new Set(value.map((s) => s.state));
  const editState = (i: number, patch: Partial<StateSlabs>) => onChange(value.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const editRow = (i: number, r: number, patch: Partial<SlabRow>) => editState(i, { slabs: value[i].slabs.map((x, k) => (k === r ? { ...x, ...patch } : x)) });
  const amt = (v: string): Amount => (v === '' ? '' : Math.max(0, Number(v)));
  const gross = Number(tryGross || 0);

  return (
    <div className="space-y-5">
      <p className="text-sm text-fg-muted">
        Professional tax (PT) is a state tax deducted from salary every month. Add each state your employees work in and enter its slabs:
        the <b className="text-fg">gross earned in the month</b> decides which slab applies. Each employee’s salary names its PT state;
        anyone without one uses the default state below.
      </p>
      <Callout tone="warning" title="Check the amounts against your state’s current PT notification">
        The Karnataka and Maharashtra slabs filled in to start with are examples. Rates change, and some states (Maharashtra, Tamil Nadu…) have rules this table doesn’t cover, such as separate slabs for women or half-yearly collection.
      </Callout>

      <div className="grid gap-4 sm:grid-cols-2">
        <Pick label="Default state" hint="For salaries that don’t name a PT state" value={defaultState ?? ''} onChange={(v) => onDefaultState(v || null)}
          placeholder="None — no PT unless the salary names a state" options={value.map((s) => ({ value: s.state, label: stateName(s.state) }))} />
        <div className="rounded-xl border border-line-soft bg-surface-subtle p-3">
          <TextField label="Try a monthly gross (₹)" type="number" min={0} value={tryGross} onChange={(e) => setTryGross(amt(e.target.value))} />
          <ul className="mt-2 space-y-0.5 text-sm">
            {value.length === 0 && <li className="text-fg-muted">Add a state to see the deduction.</li>}
            {value.map((s) => {
              const normal = taxFor(s.slabs, gross, false);
              const feb = taxFor(s.slabs, gross, true);
              return (
                <li key={s.state} className="flex justify-between gap-3">
                  <span className="text-fg-muted">{stateName(s.state)}</span>
                  <span className="font-semibold text-fg">
                    {inr0(normal)} a month{feb !== normal && <span className="font-normal text-fg-muted"> · {inr0(feb)} in February</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {value.map((s, i) => {
        const problems = slabProblems(s.slabs);
        return (
          <div key={s.state} className="rounded-2xl border border-line">
            <div className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-3">
              <div>
                <div className="font-semibold text-fg">
                  {stateName(s.state)} <span className="ml-1 rounded bg-surface-subtle px-1.5 py-0.5 font-mono text-xs text-fg-muted">{s.state}</span>
                </div>
                {defaultState === s.state && <div className="text-xs text-brand">Default state</div>}
              </div>
              <Button type="button" size="sm" variant="ghost" leftIcon={<Trash2 size={14} />}
                onClick={() => { onChange(value.filter((_, j) => j !== i)); if (defaultState === s.state) onDefaultState(null); }}>Remove state</Button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-fg-subtle">
                    <th className="px-4 py-2 font-medium">Monthly gross from</th>
                    <th className="px-2 py-2 font-medium">Up to (₹)</th>
                    <th className="px-2 py-2 font-medium">Tax each month (₹)</th>
                    <th className="px-2 py-2 font-medium">February (₹) <span className="normal-case">— only if different</span></th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody>
                  {s.slabs.map((r, k) => {
                    const from = fromOf(s.slabs, k);
                    const last = k === s.slabs.length - 1;
                    return (
                      <tr key={k} className="border-t border-line-soft align-middle">
                        <td className="whitespace-nowrap px-4 py-2 font-medium text-fg">{from === null ? <span className="text-fg-subtle">—</span> : inr0(from)}</td>
                        <td className="px-2 py-2">
                          <TextField hideLabel label={`Slab ${k + 1}: up to`} type="number" min={from ?? 0} containerClassName="w-36"
                            placeholder={last ? 'and above' : 'e.g. 24999'} value={r.upTo}
                            onChange={(e) => {
                              const upTo = amt(e.target.value);
                              // Giving the last slab a limit opens a new "and above" slab after it.
                              const rows = s.slabs.map((x, n) => (n === k ? { ...x, upTo } : x));
                              editState(i, { slabs: last && upTo !== '' ? [...rows, { upTo: '', amount: '', febAmount: '' }] : rows });
                            }} />
                        </td>
                        <td className="px-2 py-2">
                          <TextField hideLabel label={`Slab ${k + 1}: tax each month`} type="number" min={0} placeholder="0" containerClassName="w-28" value={r.amount} onChange={(e) => editRow(i, k, { amount: amt(e.target.value) })} />
                        </td>
                        <td className="px-2 py-2">
                          <TextField hideLabel label={`Slab ${k + 1}: February tax`} type="number" min={0} placeholder="Same" containerClassName="w-28" value={r.febAmount} onChange={(e) => editRow(i, k, { febAmount: amt(e.target.value) })} />
                        </td>
                        <td className="pr-3">
                          {s.slabs.length > 1 && <IconButton label="Remove slab" icon={<Trash2 size={15} />} onClick={() => editState(i, { slabs: s.slabs.filter((_, x) => x !== k) })} />}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-soft px-4 py-3">
              <Button type="button" size="sm" variant="secondary" leftIcon={<Plus size={14} />}
                onClick={() => editState(i, { slabs: [...s.slabs, { upTo: '', amount: '', febAmount: '' }] })}>Add slab</Button>
              {problems.length > 0 && <span className="text-xs font-medium text-danger-fg">{problems.join(' · ')}</span>}
            </div>
          </div>
        );
      })}

      <div className="flex flex-wrap items-end gap-2">
        <div className="w-full sm:w-72">
          <Select label="Add a state" placeholder="Choose a state…" value={adding} onChange={(e) => setAdding(e.target.value)}
            options={Object.entries(PT_STATES).filter(([c]) => !used.has(c)).map(([c, n]) => ({ value: c, label: `${n} (${c})` }))} />
        </div>
        <Button type="button" variant="secondary" leftIcon={<Plus size={14} />} disabled={!adding}
          onClick={() => { onChange([...value, { state: adding, slabs: [{ upTo: '', amount: 0, febAmount: '' }] }]); if (!defaultState) onDefaultState(adding); setAdding(''); }}>Add state</Button>
      </div>
    </div>
  );
}

export function PayrollSettingsSection() {
  const { data } = useApi<PayrollSettings>('/payroll/settings');
  const [f, setF] = useState<PayrollSettings | null>(null);
  const [pt, setPt] = useState<StateSlabs[]>([]);
  useEffect(() => {
    if (!data) return;
    setF(data);
    setPt(Object.entries(data.ptSlabs).map(([state, slabs]) => ({ state, slabs: toRows(slabs) })));
  }, [data]);
  const ptInvalid = pt.some((s) => slabProblems(s.slabs).length > 0);
  const save = useAction(
    () => put('/payroll/settings', {
      ...f,
      ptSlabs: Object.fromEntries(pt.map((s) => [s.state, toPtSlabs(s.slabs)])),
      defaultPtState: f!.defaultPtState || null,
    }),
    { invalidate: ['/payroll'], success: 'Payroll settings saved' },
  );
  if (!f) return null;
  const set = <K extends keyof PayrollSettings>(k: K) => (v: PayrollSettings[K]) => setF({ ...f, [k]: v });
  const num = (k: keyof PayrollSettings, label: string, hint?: string, step = '1') => (
    <TextField label={label} hint={hint} type="number" step={step} value={f[k] as number} onChange={(e) => set(k)(Number(e.target.value) as never)} />
  );
  const cycle = f.cycleStartDay === 1 ? 'the calendar month (1st – last day)' : `the ${f.cycleStartDay}th of the previous month to the ${f.cycleStartDay - 1}th`;

  return (
    <form className="space-y-6" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <Heading title="Payroll" subtitle="Pay cycle, locking, overtime and statutory deductions. Changes apply to the next run; approved runs keep their payslips." />
      <Card>
        <div className="space-y-4">
          <h3 className="font-semibold text-fg">Pay cycle</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            {num('cycleStartDay', 'Cycle starts on day', 'e.g. 26 → November payroll covers 26 Oct – 25 Nov, so salary can be credited on the 1st')}
            {num('payDay', 'Salary credited on day', 'Printed on payslips')}
          </div>
          <Callout tone="info" title={`Each payroll month covers ${cycle}.`}>Changing this makes the next run a one-off shorter or longer transition period, so no days are skipped or paid twice.</Callout>
        </div>
      </Card>
      <Card>
        <div className="space-y-4">
          <h3 className="font-semibold text-fg">Locking attendance</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            <Pick label="Lock the period when the run is" value={f.lockOn} onChange={(v) => set('lockOn')(v as PayrollSettings['lockOn'])}
              options={[{ value: 'APPROVED', label: 'Approved' }, { value: 'PAID', label: 'Paid' }, { value: 'MANUAL', label: 'Locked by hand only' }]} />
            <Pick label="A locked period" value={f.lockMode} onChange={(v) => set('lockMode')(v as PayrollSettings['lockMode'])}
              options={[{ value: 'BLOCK', label: 'Refuses attendance changes', description: 'Corrections, leave, remote work, manual punches' }, { value: 'SNAPSHOT_ONLY', label: 'Allows changes (shown as drift)', description: 'Settle differences as arrears' }]} />
            {num('lockGraceDays', 'Grace days after period end', 'Late corrections can still land before the lock')}
          </div>
        </div>
      </Card>
      <Card>
        <div className="space-y-4">
          <h3 className="font-semibold text-fg">Overtime</h3>
          <Switch label="Pay overtime" description="Overtime hours come from attendance (policy: overtime enabled)" checked={f.otEnabled} onChange={set('otEnabled')} />
          {f.otEnabled && (
            <div className="grid gap-4 sm:grid-cols-3">
              {num('otMultiplier', 'Rate multiplier', '2 = double the hourly rate', '0.25')}
              <Pick label="Hourly rate from" value={f.otBase} onChange={(v) => set('otBase')(v as PayrollSettings['otBase'])} options={[{ value: 'GROSS', label: 'Monthly gross' }, { value: 'BASIC', label: 'Basic + DA' }]} />
              {num('standardHoursPerDay', 'Hours in a working day', undefined, '0.5')}
            </div>
          )}
        </div>
      </Card>
      <Card>
        <div className="space-y-4">
          <h3 className="font-semibold text-fg">PF & ESI</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            {num('pfRate', 'PF rate (%)', 'Employee and employer each', '0.01')}
            {num('pfWageCap', 'PF wage ceiling (₹)', 'PF is computed on at most this much Basic + DA')}
            <div />
            {num('esiEmployeeRate', 'ESI employee (%)', undefined, '0.01')}
            {num('esiEmployerRate', 'ESI employer (%)', undefined, '0.01')}
            {num('esiThreshold', 'ESI gross threshold (₹)', 'ESI applies while monthly gross is at most this')}
          </div>
        </div>
      </Card>
      <Card>
        <div className="space-y-4">
          <h3 className="font-semibold text-fg">Professional tax</h3>
          <ProfessionalTaxEditor value={pt} onChange={setPt} defaultState={f.defaultPtState} onDefaultState={(v) => set('defaultPtState')(v)} />
        </div>
      </Card>
      <div className="flex items-center justify-end gap-3">
        {ptInvalid && <span className="text-sm text-danger-fg">Fix the professional tax slabs to save</span>}
        <Button type="submit" loading={save.isPending} disabled={ptInvalid}>Save payroll settings</Button>
      </div>
    </form>
  );
}

// ── HR lists & checklists ───────────────────────────────────────────────────

interface Item { title: string; assigneeRole: 'HR' | 'IT' | 'MANAGER' | 'EMPLOYEE'; dueDays: number }
interface HrSettings { checklists: { ONBOARDING: Item[]; OFFBOARDING: Item[] }; expenseCategories: string[]; assetCategories: string[]; expenseRequiresHrApproval: boolean }

export function HrSettingsSection() {
  const { data } = useApi<HrSettings>('/hr/settings');
  const [f, setF] = useState<HrSettings | null>(null);
  useEffect(() => { if (data) setF(data); }, [data]);
  const save = useAction(() => put('/hr/settings', { checklists: f!.checklists, expenseCategories: f!.expenseCategories, assetCategories: f!.assetCategories, expenseRequiresHrApproval: f!.expenseRequiresHrApproval }), {
    invalidate: ['/hr/settings'], success: 'HR settings saved',
  });
  if (!f) return null;
  const list = (k: 'expenseCategories' | 'assetCategories', label: string) => (
    <Textarea label={label} hint="One per line" rows={6} value={f[k].join('\n')} onChange={(e) => setF({ ...f, [k]: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })} />
  );
  const checklist = (kind: 'ONBOARDING' | 'OFFBOARDING') => {
    const items = f.checklists[kind];
    const update = (next: Item[]) => setF({ ...f, checklists: { ...f.checklists, [kind]: next } });
    return (
      <Card>
        <div className="space-y-3">
          <h3 className="font-semibold text-fg">{kind === 'ONBOARDING' ? 'Onboarding checklist' : 'Offboarding checklist'}</h3>
          <p className="text-sm text-fg-muted">{kind === 'ONBOARDING' ? 'Created for every new employee. Due = days after joining.' : 'Created when someone is offboarded, plus a return task for each asset they hold. Due = days from the exit date (negative = before).'}</p>
          {items.map((it, i) => (
            <div key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_9rem_7rem_auto]">
              <TextField label="Task" maxLength={160} value={it.title} onChange={(e) => update(items.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
              <Pick label="Owner" value={it.assigneeRole} onChange={(v) => update(items.map((x, j) => (j === i ? { ...x, assigneeRole: v as Item['assigneeRole'] } : x)))}
                options={['HR', 'IT', 'MANAGER', 'EMPLOYEE'].map((r) => ({ value: r, label: r }))} />
              <TextField label="Due (days)" type="number" value={it.dueDays} onChange={(e) => update(items.map((x, j) => (j === i ? { ...x, dueDays: Number(e.target.value) } : x)))} />
              <IconButton label="Remove task" icon={<Trash2 size={16} />} onClick={() => update(items.filter((_, j) => j !== i))} />
            </div>
          ))}
          <Button type="button" size="sm" variant="secondary" leftIcon={<Plus size={14} />} onClick={() => update([...items, { title: '', assigneeRole: 'HR', dueDays: 0 }])}>Add task</Button>
        </div>
      </Card>
    );
  };
  return (
    <form className="space-y-6" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <Heading title="HR" subtitle="Checklists, expense and asset categories." />
      {checklist('ONBOARDING')}
      {checklist('OFFBOARDING')}
      <Card>
        <div className="space-y-4">
          <h3 className="font-semibold text-fg">Expenses & assets</h3>
          <Switch label="Expense claims need HR approval after the manager" checked={f.expenseRequiresHrApproval} onChange={(v) => setF({ ...f, expenseRequiresHrApproval: v })} />
          <div className="grid gap-4 sm:grid-cols-2">
            {list('expenseCategories', 'Expense categories')}
            {list('assetCategories', 'Asset categories')}
          </div>
        </div>
      </Card>
      <div className="flex justify-end"><Button type="submit" loading={save.isPending}>Save HR settings</Button></div>
    </form>
  );
}

// ── Letter templates ── (components/LetterTemplates.tsx)

export { LetterTemplates as LettersSection } from './LetterTemplates';
