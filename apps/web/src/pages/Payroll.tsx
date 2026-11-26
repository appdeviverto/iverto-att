import {
  Badge, Breadcrumbs, Button, Callout, CenteredSpinner, confirmAction, DataTable, DescriptionList, EmptyState, IconButton, Modal, PageHeader, PillTabs,
  StatCard, Switch, TextField,
} from '@iverto-org/core-ui';
import { Banknote, CheckCheck, Download, FileSpreadsheet, IndianRupee, Lock, LockOpen, Play, Plus, RefreshCw, Trash2, Users, Wallet, X } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { clean, EmployeeMultiPicker, EmployeePicker, FormModal, Panel, Pick, useForm } from '../components/ui';
import { del, downloadFile, inr, inrPaise, patch, post, REFERENCE, useAction, useApi } from '../lib/api';
import { isHr, useMe } from '../lib/auth';
import { dateTime, today } from '../lib/format';

// ── Shapes ──────────────────────────────────────────────────────────────────

interface Run {
  id: string; month: string; periodStart: string; periodEnd: string; status: 'DRAFT' | 'APPROVED' | 'PAID'; locked: boolean; lockedAt: string | null;
  totals: { employees?: number; gross?: number; deductions?: number; net?: number; employerContrib?: number }; warnings: string[];
  computedAt: string; approvedAt: string | null; paidAt: string | null;
}
interface Line { code: string; name: string; kind: 'EARNING' | 'REIMBURSEMENT' | 'DEDUCTION' | 'EMPLOYER'; amount: number; full?: number }
interface Slip {
  id: string; employeeId: string; employee: { employeeCode: string; fullName: string; designation: string | null; department: string | null };
  attendance: { periodDays: number; employedDays: number; paidDays: number; lopDays: number; absenceDeduction: number; lateDeduction: number; unpaidLeave: number; overtimeHours: number; pendingDays: number };
  lines: Line[]; gross: number; deductions: number; net: number; employerContrib: number; paymentMode: string;
}
interface RunDetail extends Run { payslips: Slip[]; drift: { employeeId: string; employeeCode: string; paidDaysThen: number; paidDaysNow: number; otHoursThen: number; otHoursNow: number }[] }

const RUN_STATUS: Record<Run['status'], { label: string; tone: 'neutral' | 'info' | 'success' }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' }, APPROVED: { label: 'Approved', tone: 'info' }, PAID: { label: 'Paid', tone: 'success' },
};
const RunBadge = ({ run }: { run: Pick<Run, 'status' | 'locked'> }) => (
  <span className="flex flex-wrap gap-1.5"><Badge tone={RUN_STATUS[run.status].tone}>{RUN_STATUS[run.status].label}</Badge>{run.locked && <Badge tone="warning">Locked</Badge>}</span>
);
const monthName = (m: string) => new Date(`${m}-15T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const nextMonth = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
};

// ── Page ────────────────────────────────────────────────────────────────────

export function Payroll() {
  const { tab = 'runs' } = useParams();
  const navigate = useNavigate();
  return (
    <div className="space-y-6">
      <PageHeader title="Payroll" subtitle="Monthly runs from finalised attendance: payable days, salary structures, PF / ESI / PT, payslips and the bank file." />
      <PillTabs label="Section" value={tab} onChange={(t) => navigate(`/payroll/${t}`)} tabs={[
        { value: 'runs', label: 'Runs' }, { value: 'structures', label: 'Salary structures' }, { value: 'adjustments', label: 'Adjustments' }, { value: 'loans', label: 'Loans & advances' },
      ]} />
      {tab === 'runs' && <Runs />}
      {tab === 'structures' && <Structures />}
      {tab === 'adjustments' && <Adjustments />}
      {tab === 'loans' && <Loans />}
    </div>
  );
}

function Runs() {
  const navigate = useNavigate();
  const { data, isLoading } = useApi<Run[]>('/payroll/runs');
  const settings = useApi<{ cycleStartDay: number; lockOn: string; lockMode: string }>('/payroll/settings', undefined, REFERENCE).data;
  const [open, setOpen] = useState(false);
  const latest = data?.[0];
  const [f, set] = useForm({ month: '', force: false });
  const run = useAction(() => post<RunDetail>('/payroll/runs', { month: f.month, force: f.force }), {
    invalidate: ['/payroll/runs'], success: 'Payroll computed', onSuccess: (r) => navigate(`/payroll/runs/${r.id}`),
  });
  const start = () => { set('month')(latest ? nextMonth(latest.month) : today().slice(0, 7)); setOpen(true); };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-muted">
          {settings && <>Pay period: {settings.cycleStartDay === 1 ? 'calendar month' : `${settings.cycleStartDay}th to ${settings.cycleStartDay - 1}th`} · locks {settings.lockMode === 'SNAPSHOT_ONLY' ? 'never (snapshot only)' : `on ${settings.lockOn.toLowerCase()}`} · <a className="font-semibold text-brand hover:underline" href="/settings/payroll">change</a></>}
        </p>
        <Button leftIcon={<Play size={16} />} onClick={start}>Run payroll</Button>
      </div>
      <Panel>
        <DataTable rows={data ?? []} getRowKey={(r) => r.id} loading={isLoading} onRowClick={(r) => navigate(`/payroll/runs/${r.id}`)}
          empty={<EmptyState icon={Wallet} title="No payroll runs yet" description="Set salaries on employee profiles (or import them), then run the first month." action={<Button onClick={start}>Run payroll</Button>} />}
          columns={[
            { key: 'm', header: 'Month', render: (r) => <div><div className="font-semibold text-fg">{monthName(r.month)}</div><div className="text-xs text-fg-subtle">{r.periodStart} – {r.periodEnd}</div></div> },
            { key: 's', header: 'Status', render: (r) => <RunBadge run={r} /> },
            { key: 'e', header: 'Employees', align: 'right', render: (r) => r.totals.employees ?? 0 },
            { key: 'g', header: 'Gross', align: 'right', render: (r) => inrPaise(r.totals.gross ?? 0) },
            { key: 'n', header: 'Net pay', align: 'right', render: (r) => <b>{inrPaise(r.totals.net ?? 0)}</b> },
            { key: 'w', header: '', render: (r) => (r.warnings.length ? <Badge tone="warning">{r.warnings.length} warning{r.warnings.length === 1 ? '' : 's'}</Badge> : null) },
          ]} />
      </Panel>
      {open && (
        <FormModal open onClose={() => setOpen(false)} title="Run payroll" description="Computes a draft you can review, adjust and recompute before approving." submitLabel="Compute draft" saving={run.isPending} onSubmit={() => run.mutate()}>
          <TextField label="Payroll month" required type="month" value={f.month} onChange={(e) => set('month')(e.target.value)} hint="Periods run back to back: this one starts the day after the last run ended." />
          <Switch label="Run anyway" description="Compute before the period has ended or while some attendance days are not finalised — they are listed as warnings." checked={f.force} onChange={set('force')} />
        </FormModal>
      )}
    </div>
  );
}

// ── Run detail ──────────────────────────────────────────────────────────────

export function PayrollRun() {
  const { id } = useParams();
  const me = useMe();
  const navigate = useNavigate();
  const path = `/payroll/runs/${id}`;
  const { data: r } = useApi<RunDetail>(path);
  const [slip, setSlip] = useState<Slip | null>(null);
  const [q, setQ] = useState('');
  const SUCCESS: Record<string, string> = { approve: 'Payroll approved', paid: 'Marked paid — employees can now see their payslips', lock: 'Period locked', unlock: 'Unlocked' };
  const act = useAction((verb: string) => post<RunDetail>(`${path}/${verb}`).then((detail) => ({ verb, detail })), {
    invalidate: ['/payroll', '/attendance', '/expenses'],
    success: (r: { verb: string }) => SUCCESS[r.verb] ?? 'Done',
  });
  const busy = (verb: string) => act.isPending && act.variables === verb;
  const recompute = useAction(() => post(`/payroll/runs`, { month: r!.month, force: true }), { invalidate: ['/payroll'], success: 'Recomputed' });
  const remove = useAction(() => del(path), { invalidate: ['/payroll/runs'], success: 'Draft deleted', onSuccess: () => navigate('/payroll/runs') });

  if (!r) return <CenteredSpinner />;
  const shown = r.payslips.filter((s) => !q || `${s.employee.fullName} ${s.employee.employeeCode}`.toLowerCase().includes(q.toLowerCase()));
  const ask = async (title: string, message: string, label: string, fn: () => void) => { if (await confirmAction({ title, message, confirmLabel: label })) fn(); };

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={<Breadcrumbs items={[{ label: 'Payroll', href: '/payroll/runs' }, { label: monthName(r.month) }]} />}
        title={`Payroll · ${monthName(r.month)}`} subtitle={`${r.periodStart} – ${r.periodEnd} · computed ${dateTime(r.computedAt)}`}
        actions={<>
          {r.status === 'DRAFT' && <>
            <Button variant="ghost" leftIcon={<Trash2 size={16} />} onClick={() => ask('Delete this draft?', 'Nothing has been paid; you can run the month again.', 'Delete draft', () => remove.mutate())}>Delete</Button>
            <Button variant="secondary" leftIcon={<RefreshCw size={16} />} loading={recompute.isPending} onClick={() => recompute.mutate()}>Recompute</Button>
            <Button leftIcon={<CheckCheck size={16} />} loading={busy('approve')}
              onClick={() => ask('Approve this payroll?', 'Adjustments and reimbursements in it are marked as paid, and the period locks for attendance changes per your payroll settings.', 'Approve', () => act.mutate('approve'))}>Approve</Button>
          </>}
          {r.status !== 'DRAFT' && <>
            <Button variant="secondary" leftIcon={<FileSpreadsheet size={16} />} onClick={() => downloadFile(`${path}/register.csv`)}>Register</Button>
            <Button variant="secondary" leftIcon={<Banknote size={16} />} onClick={() => downloadFile(`${path}/bank-file.xlsx`)}>Bank file</Button>
            <Button variant="ghost" title="Plain CSV for bank portals that take an upload (don’t open it in Excel)" onClick={() => downloadFile(`${path}/bank-file.csv`)}>CSV</Button>
          </>}
          {r.status === 'APPROVED' && <Button leftIcon={<IndianRupee size={16} />} loading={busy('paid')}
            onClick={() => ask('Mark as paid?', 'Employees are notified and can download their payslips.', 'Mark paid', () => act.mutate('paid'))}>Mark paid</Button>}
          {!r.locked && r.status !== 'PAID' && <Button variant="ghost" leftIcon={<Lock size={16} />} loading={busy('lock')} onClick={() => act.mutate('lock')}>Lock period</Button>}
          {me.role === 'ADMIN' && r.status !== 'PAID' && (r.locked || r.status === 'APPROVED') && (
            <Button variant="ghost" leftIcon={<LockOpen size={16} />} loading={busy('unlock')}
              onClick={() => ask('Unlock this period?', r.status === 'APPROVED' ? 'The run goes back to draft and attendance for the period can change again. This is audited.' : 'Attendance for the period can change again. This is audited.', 'Unlock', () => act.mutate('unlock'))}>Unlock</Button>
          )}
        </>} />

      <div className="flex flex-wrap items-center gap-2"><RunBadge run={r} />{r.paidAt && <span className="text-sm text-fg-muted">Paid {dateTime(r.paidAt)}</span>}</div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Employees" value={r.totals.employees ?? 0} icon={<Users size={18} />} />
        <StatCard title="Gross" value={inrPaise(r.totals.gross ?? 0)} icon={<Wallet size={18} />} tone="info" />
        <StatCard title="Deductions" value={inrPaise(r.totals.deductions ?? 0)} icon={<X size={18} />} tone="warning" />
        <StatCard title="Net pay" value={inrPaise(r.totals.net ?? 0)} subtitle={`Employer contributions ${inrPaise(r.totals.employerContrib ?? 0)}`} icon={<IndianRupee size={18} />} tone="success" />
      </div>

      {r.warnings.length > 0 && (
        <Callout tone="warning" title={`${r.warnings.length} thing${r.warnings.length === 1 ? '' : 's'} to check`}>
          <ul className="list-disc space-y-0.5 pl-5">{r.warnings.slice(0, 12).map((w) => <li key={w}>{w}</li>)}</ul>
          {r.warnings.length > 12 && <p className="mt-1">…and {r.warnings.length - 12} more.</p>}
        </Callout>
      )}
      {r.drift.length > 0 && (
        <Callout tone="info" title={`Attendance changed for ${r.drift.length} employee${r.drift.length === 1 ? '' : 's'} since this run was approved`}>
          {r.drift.slice(0, 8).map((d) => `${d.employeeCode}: paid days ${d.paidDaysThen} → ${d.paidDaysNow}${d.otHoursThen !== d.otHoursNow ? `, OT ${d.otHoursThen} → ${d.otHoursNow} h` : ''}`).join(' · ')}.
          {' '}Settle the difference as an ARREARS or OTHER adjustment in the next month.
        </Callout>
      )}

      <TextField hideLabel label="Search" placeholder="Search name or code" containerClassName="w-full sm:w-72" value={q} onChange={(e) => setQ(e.target.value)} />
      <Panel>
        <DataTable rows={shown} getRowKey={(s) => s.id} onRowClick={setSlip} empty={<EmptyState title="No payslips in this run" />}
          columns={[
            { key: 'e', header: 'Employee', render: (s) => <div><div className="font-semibold text-fg">{s.employee.fullName}</div><div className="font-mono text-xs text-fg-subtle">{s.employee.employeeCode}{s.employee.department ? ` · ${s.employee.department}` : ''}</div></div> },
            { key: 'd', header: 'Paid days', align: 'right', render: (s) => <span>{s.attendance.paidDays}<span className="text-fg-subtle"> / {s.attendance.periodDays}</span></span> },
            { key: 'l', header: 'LOP', align: 'right', render: (s) => (s.attendance.lopDays ? <span className="text-danger-fg">{s.attendance.lopDays}</span> : '—') },
            { key: 'o', header: 'OT h', align: 'right', render: (s) => s.attendance.overtimeHours || '—' },
            { key: 'g', header: 'Gross', align: 'right', render: (s) => inrPaise(s.gross) },
            { key: 'x', header: 'Deductions', align: 'right', render: (s) => inrPaise(s.deductions) },
            { key: 'n', header: 'Net pay', align: 'right', render: (s) => <b>{inrPaise(s.net)}</b> },
            { key: 'p', header: 'Mode', render: (s) => <Badge tone="neutral">{s.paymentMode.toLowerCase()}</Badge> },
          ]} />
      </Panel>
      {slip && <PayslipModal slip={slip} month={r.month} onClose={() => setSlip(null)} />}
    </div>
  );
}

function PayslipModal({ slip, month, onClose }: { slip: Slip; month: string; onClose: () => void }) {
  const a = slip.attendance;
  const group = (k: Line['kind']) => slip.lines.filter((l) => l.kind === k);
  const block = (title: string, lines: Line[]) =>
    lines.length > 0 && (
      <div>
        <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-subtle">{title}</h4>
        <dl className="divide-y divide-line-soft rounded-xl border border-line-soft">
          {lines.map((l, i) => (
            <div key={`${l.code}${i}`} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <dt className="text-fg">{l.name}{l.full !== undefined && l.full !== l.amount && <span className="ml-1 text-xs text-fg-subtle">of {inrPaise(l.full)}</span>}</dt>
              <dd className="tabular-nums font-medium text-fg">{inrPaise(l.amount)}</dd>
            </div>
          ))}
        </dl>
      </div>
    );
  return (
    <Modal open onClose={onClose} size="lg" title={`${slip.employee.fullName} · ${monthName(month)}`} description={`${slip.employee.employeeCode}${slip.employee.designation ? ` · ${slip.employee.designation}` : ''}`}
      footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button leftIcon={<Download size={16} />} onClick={() => downloadFile(`/payroll/payslips/${slip.id}/pdf`)}>Payslip PDF</Button></>}>
      <div className="space-y-5 p-5 sm:p-6">
        <DescriptionList columns={3} items={[
          { term: 'Days in period', value: String(a.periodDays) }, { term: 'Employed days', value: String(a.employedDays) }, { term: 'Paid days', value: String(a.paidDays) },
          { term: 'Absence deduction', value: a.absenceDeduction ? `${a.absenceDeduction} d` : null }, { term: 'Late penalty', value: a.lateDeduction ? `${a.lateDeduction} d` : null },
          { term: 'Unpaid leave', value: a.unpaidLeave ? `${a.unpaidLeave} d` : null }, { term: 'Overtime', value: a.overtimeHours ? `${a.overtimeHours} h` : null },
        ]} />
        {block('Earnings', group('EARNING'))}
        {block('Reimbursements', group('REIMBURSEMENT'))}
        {block('Deductions', group('DEDUCTION'))}
        <div className="flex items-center justify-between rounded-xl bg-brand-soft px-4 py-3">
          <span className="font-semibold text-fg">Net pay</span><span className="text-xl font-bold tabular-nums text-brand">{inrPaise(slip.net)}</span>
        </div>
        {block('Employer contributions (not deducted)', group('EMPLOYER'))}
      </div>
    </Modal>
  );
}

// ── Structures ──────────────────────────────────────────────────────────────

interface Component { code: string; name: string; kind: 'EARNING' | 'DEDUCTION'; calc: 'FIXED' | 'PCT_GROSS' | 'PCT_BASIC' | 'BALANCE'; value: number; prorate: boolean }
interface Structure { id: string; name: string; active: boolean; components: Component[]; _count: { salaries: number } }
const CALC_LABEL: Record<Component['calc'], string> = { FIXED: '₹ per month', PCT_GROSS: '% of gross', PCT_BASIC: '% of Basic', BALANCE: 'Balance of gross' };
const describe = (c: Component) => (c.calc === 'BALANCE' ? 'rest of gross' : c.calc === 'FIXED' ? `${inr(c.value, 0)}/month` : `${c.value}% of ${c.calc === 'PCT_BASIC' ? 'Basic' : 'gross'}`);

function Structures() {
  const { data, isLoading } = useApi<Structure[]>('/payroll/structures');
  const [editing, setEditing] = useState<Structure | 'new' | null>(null);
  return (
    <div className="space-y-4">
      <div className="flex justify-end"><Button leftIcon={<Plus size={16} />} onClick={() => setEditing('new')}>Add structure</Button></div>
      <Panel>
        <DataTable rows={data ?? []} getRowKey={(r) => r.id} loading={isLoading} onRowClick={setEditing}
          columns={[
            { key: 'n', header: 'Structure', render: (r) => <div><div className="font-semibold text-fg">{r.name}</div>{!r.active && <Badge tone="neutral">Inactive</Badge>}</div> },
            { key: 'c', header: 'Components', render: (r) => <span className="text-sm text-fg-muted">{r.components.map((c) => `${c.name} (${describe(c)})`).join(' · ')}</span> },
            { key: 'u', header: 'Employees', align: 'right', render: (r) => r._count.salaries },
          ]} />
      </Panel>
      {editing && <StructureEditor structure={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function StructureEditor({ structure, onClose }: { structure?: Structure; onClose: () => void }) {
  const [name, setName] = useState(structure?.name ?? '');
  const [active, setActive] = useState(structure?.active ?? true);
  const [components, setComponents] = useState<Component[]>(structure?.components ?? [
    { code: 'BASIC', name: 'Basic', kind: 'EARNING', calc: 'PCT_GROSS', value: 50, prorate: true },
    { code: 'HRA', name: 'House rent allowance', kind: 'EARNING', calc: 'PCT_BASIC', value: 50, prorate: true },
    { code: 'SPECIAL', name: 'Special allowance', kind: 'EARNING', calc: 'BALANCE', value: 0, prorate: true },
  ]);
  const edit = (i: number, patchC: Partial<Component>) => setComponents((cs) => cs.map((c, j) => (j === i ? { ...c, ...patchC } : c)));
  const save = useAction(() => {
    const body = { name, active, components };
    return structure ? patch(`/payroll/structures/${structure.id}`, body) : post('/payroll/structures', body);
  }, { invalidate: ['/payroll/structures'], success: 'Structure saved', onSuccess: onClose });
  return (
    <FormModal open size="xl" onClose={onClose} title={structure ? `Edit ${structure.name}` : 'Add salary structure'}
      description="Earnings are worked out from each employee’s monthly gross, in order: fixed and % of gross, then % of Basic, then the balancing component takes what is left. PF uses the BASIC (+ DA) component."
      submitLabel="Save structure" saving={save.isPending} onSubmit={() => save.mutate()}>
      <TextField label="Name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
      {structure && <Switch label="Active" description="Inactive structures can’t be given to anyone new" checked={active} onChange={setActive} />}
      {structure && structure._count.salaries > 0 && <Callout tone="info" title={`Used by ${structure._count.salaries} salary record${structure._count.salaries === 1 ? '' : 's'}`}>Changes apply from the next payroll computation; approved runs keep their payslips.</Callout>}
      <div className="space-y-2">
        {components.map((c, i) => (
          <div key={i} className="grid items-end gap-2 rounded-xl border border-line-soft p-3 sm:grid-cols-[7rem_1fr_8rem_10rem_6rem_auto_auto]">
            <TextField label="Code" required maxLength={20} value={c.code} onChange={(e) => edit(i, { code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })} />
            <TextField label="Name" required maxLength={60} value={c.name} onChange={(e) => edit(i, { name: e.target.value })} />
            <Pick label="Kind" value={c.kind} onChange={(v) => edit(i, { kind: v as Component['kind'] })} options={[{ value: 'EARNING', label: 'Earning' }, { value: 'DEDUCTION', label: 'Deduction' }]} />
            <Pick label="Amount" value={c.calc} onChange={(v) => edit(i, { calc: v as Component['calc'] })} options={Object.entries(CALC_LABEL).map(([value, label]) => ({ value, label }))} />
            <TextField label="Value" type="number" min={0} step="0.01" disabled={c.calc === 'BALANCE'} value={c.calc === 'BALANCE' ? '' : c.value} onChange={(e) => edit(i, { value: Number(e.target.value) })} />
            <Switch label="Prorate" checked={c.prorate} onChange={(v) => edit(i, { prorate: v })} />
            <IconButton label="Remove component" icon={<Trash2 size={16} />} onClick={() => setComponents((cs) => cs.filter((_, j) => j !== i))} />
          </div>
        ))}
        <Button size="sm" variant="secondary" leftIcon={<Plus size={14} />}
          onClick={() => setComponents((cs) => [...cs, { code: '', name: '', kind: 'EARNING', calc: 'FIXED', value: 0, prorate: true }])}>Add component</Button>
      </div>
    </FormModal>
  );
}

// ── Adjustments & loans ─────────────────────────────────────────────────────

interface Adjustment { id: string; employeeId: string; month: string; kind: 'EARNING' | 'DEDUCTION'; code: string; amount: number; note: string | null; consumed: boolean; employee: { fullName: string; employeeCode: string } }

function Adjustments() {
  const [month, setMonth] = useState(today().slice(0, 7));
  const { data, isLoading } = useApi<Adjustment[]>('/payroll/adjustments', { month });
  const [adding, setAdding] = useState(false);
  const [f, set, setF] = useForm({ employeeIds: [] as string[], kind: 'EARNING', code: 'BONUS', amount: '' as number | '', note: '' });
  const add = useAction(() => post<unknown[]>('/payroll/adjustments', { ...clean(f), employeeIds: f.employeeIds, month }), {
    invalidate: ['/payroll/adjustments'],
    success: (r) => (r.length === 1 ? 'Adjustment added' : `Adjustment added for ${r.length} employees`),
    onSuccess: () => { setAdding(false); setF((x) => ({ ...x, employeeIds: [] })); },
  });
  const remove = useAction((id: string) => del(`/payroll/adjustments/${id}`), { invalidate: ['/payroll/adjustments'], success: 'Adjustment removed' });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <TextField label="Payroll month" type="month" containerClassName="w-full sm:w-56" value={month} onChange={(e) => setMonth(e.target.value)} />
        <Button leftIcon={<Plus size={16} />} onClick={() => setAdding(true)}>Add adjustment</Button>
      </div>
      <p className="text-sm text-fg-muted">One-off earnings and deductions for a month — bonus, incentive, arrears, advance recovery. Recompute the draft run after adding them.</p>
      <Panel>
        <DataTable rows={data ?? []} getRowKey={(r) => r.id} loading={isLoading} empty={<EmptyState title={`No adjustments for ${monthName(month)}`} />}
          columns={[
            { key: 'e', header: 'Employee', render: (r) => <span>{r.employee.fullName} <span className="font-mono text-xs text-fg-subtle">{r.employee.employeeCode}</span></span> },
            { key: 'c', header: 'Type', render: (r) => <span>{r.code.toLowerCase()} <Badge tone={r.kind === 'EARNING' ? 'success' : 'danger'}>{r.kind === 'EARNING' ? 'earning' : 'deduction'}</Badge></span> },
            { key: 'a', header: 'Amount', align: 'right', render: (r) => inr(r.amount) },
            { key: 'n', header: 'Note', render: (r) => r.note ?? '—' },
            { key: 's', header: '', render: (r) => (r.consumed ? <Badge tone="info">Paid in a run</Badge> : null) },
          ]}
          rowActions={(r) => !r.consumed && <IconButton label="Remove" icon={<Trash2 size={16} />} onClick={() => remove.mutate(r.id)} />} />
      </Panel>
      {adding && (
        <FormModal open onClose={() => setAdding(false)} title={`Adjustment for ${monthName(month)}`} submitLabel={f.employeeIds.length > 1 ? `Add for ${f.employeeIds.length} employees` : 'Add'} saving={add.isPending} onSubmit={() => add.mutate()}>
          <EmployeeMultiPicker required value={f.employeeIds} onChange={set('employeeIds')} />
          <Pick label="Kind" value={f.kind} onChange={set('kind')} options={[{ value: 'EARNING', label: 'Earning (added to pay)' }, { value: 'DEDUCTION', label: 'Deduction (taken from pay)' }]} />
          <Pick label="Type" value={f.code} onChange={set('code')} options={['BONUS', 'INCENTIVE', 'ARREARS', 'ADVANCE', 'OTHER'].map((c) => ({ value: c, label: c.toLowerCase() }))} />
          <TextField label="Amount (₹)" required type="number" min={0.01} step="0.01" value={f.amount} onChange={(e) => set('amount')(e.target.value === '' ? '' : Number(e.target.value))} />
          <TextField label="Note" hint="Printed on the payslip" maxLength={200} value={f.note} onChange={(e) => set('note')(e.target.value)} />
        </FormModal>
      )}
    </div>
  );
}

interface Loan { id: string; employeeId: string; principal: number; emi: number; startMonth: string; status: string; recovered: number; outstanding: number; note: string | null; employee: { fullName: string; employeeCode: string } }

function Loans() {
  const { data, isLoading } = useApi<Loan[]>('/payroll/loans');
  const [adding, setAdding] = useState(false);
  const [f, set] = useForm({ employeeId: '', principal: '' as number | '', emi: '' as number | '', startMonth: today().slice(0, 7), note: '' });
  const add = useAction(() => post('/payroll/loans', clean(f)), { invalidate: ['/payroll/loans'], success: 'Loan recorded', onSuccess: () => setAdding(false) });
  const close = useAction((id: string) => post(`/payroll/loans/${id}/close`), { invalidate: ['/payroll/loans'], success: 'Loan closed' });
  return (
    <div className="space-y-4">
      <div className="flex justify-end"><Button leftIcon={<Plus size={16} />} onClick={() => setAdding(true)}>Record loan / advance</Button></div>
      <Panel>
        <DataTable rows={data ?? []} getRowKey={(r) => r.id} loading={isLoading} empty={<EmptyState title="No loans or salary advances" description="The EMI is deducted in every payroll run from the start month until it is repaid." />}
          columns={[
            { key: 'e', header: 'Employee', render: (r) => <span>{r.employee.fullName} <span className="font-mono text-xs text-fg-subtle">{r.employee.employeeCode}</span></span> },
            { key: 'p', header: 'Amount', align: 'right', render: (r) => inr(r.principal, 0) },
            { key: 'm', header: 'EMI', align: 'right', render: (r) => inr(r.emi, 0) },
            { key: 's', header: 'From', render: (r) => r.startMonth },
            { key: 'r', header: 'Recovered', align: 'right', render: (r) => inr(r.recovered, 0) },
            { key: 'o', header: 'Outstanding', align: 'right', render: (r) => <b>{inr(r.outstanding, 0)}</b> },
            { key: 't', header: 'Status', render: (r) => <Badge tone={r.status === 'ACTIVE' ? 'info' : 'neutral'}>{r.status.toLowerCase()}</Badge> },
          ]}
          rowActions={(r) => r.status === 'ACTIVE' && <Button size="sm" variant="ghost" onClick={() => close.mutate(r.id)}>Close</Button>} />
      </Panel>
      {adding && (
        <FormModal open onClose={() => setAdding(false)} title="Record loan or salary advance" submitLabel="Save" saving={add.isPending} onSubmit={() => add.mutate()}>
          <EmployeePicker required value={f.employeeId} onChange={set('employeeId')} />
          <TextField label="Amount given (₹)" required type="number" min={1} value={f.principal} onChange={(e) => set('principal')(e.target.value === '' ? '' : Number(e.target.value))} />
          <TextField label="Monthly EMI (₹)" required type="number" min={1} value={f.emi} onChange={(e) => set('emi')(e.target.value === '' ? '' : Number(e.target.value))} />
          <TextField label="First deduction in" required type="month" value={f.startMonth} onChange={(e) => set('startMonth')(e.target.value)} />
          <TextField label="Note" maxLength={200} value={f.note} onChange={(e) => set('note')(e.target.value)} />
        </FormModal>
      )}
    </div>
  );
}

// ── My payslips (everyone) ──────────────────────────────────────────────────

interface MyPayslip { id: string; month: string; monthName: string; periodStart: string; periodEnd: string; paidAt: string | null; gross: number; deductions: number; net: number }

export function MyPayslips() {
  const me = useMe();
  const { data, isLoading } = useApi<MyPayslip[]>('/payroll/payslips/mine');
  const pdf = useAction((id: string) => downloadFile(`/payroll/payslips/${id}/pdf`, undefined, 'payslip.pdf'));
  return (
    <div className="space-y-6">
      <PageHeader title="My payslips" subtitle={isHr(me) ? 'Your own payslips. Everyone’s are under Payroll.' : 'Salary slips for every paid month.'} />
      <Panel>
        <DataTable rows={data ?? []} getRowKey={(r) => r.id} loading={isLoading} onRowClick={(r) => pdf.mutate(r.id)}
          empty={<EmptyState icon={Wallet} title="No payslips yet" description="They appear here once a payroll month is paid." />}
          columns={[
            { key: 'm', header: 'Month', render: (r) => <div><div className="font-semibold text-fg">{r.monthName}</div><div className="text-xs text-fg-subtle">{r.periodStart} – {r.periodEnd}</div></div> },
            { key: 'g', header: 'Gross', align: 'right', render: (r) => inr(r.gross) },
            { key: 'd', header: 'Deductions', align: 'right', render: (r) => inr(r.deductions) },
            { key: 'n', header: 'Net pay', align: 'right', render: (r) => <b>{inr(r.net)}</b> },
          ]}
          rowActions={(r) => <IconButton label="Download PDF" icon={<Download size={16} />} onClick={(e) => { e.stopPropagation(); pdf.mutate(r.id); }} />} />
      </Panel>
    </div>
  );
}
