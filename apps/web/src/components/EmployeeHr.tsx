import {
  Badge, Button, Callout, Card, confirmAction, DataTable, DateInput, DescriptionList, EmptyState, FileDropzone, IconButton, Switch, TextField,
} from '@iverto-org/core-ui';
import { CheckCircle2, Circle, Download, ExternalLink, FilePlus2, FileText, Plus, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  api, del, downloadFile, fileToBase64, inr, post, REFERENCE, useAction, useApi, useImportColumns, type ImportColumn,
} from '../lib/api';
import { dateTime, today } from '../lib/format';
import { clean, FormModal, Panel, Pick, useForm, type FieldSpec } from './ui';

// ── Profile ─────────────────────────────────────────────────────────────────

/** Employee columns already on the main form (fields.ts keys that are not "directory" fields). */
const BASE_KEYS = new Set(['employeeCode', 'fullName', 'joinedOn', 'designation', 'employmentType', 'mobilePunch', 'email', 'phone']);

const pretty = (c: ImportColumn, v: unknown) => {
  if (v === null || v === undefined || v === '') return null;
  if (c.type === 'enum') return String(v).replace(/_/g, ' ').toLowerCase().replace(/^\w/, (x) => x.toUpperCase());
  if (c.key === 'bankAccountNumber') return `•••• ${String(v).slice(-4)}`;
  return String(v);
};

/** The registry's directory fields as form specs, one heading per section (edit drawer). */
export function useDirectoryFieldSpecs(): { section: string; specs: FieldSpec[] }[] {
  const columns = useImportColumns().data ?? [];
  const fields = columns.filter((c) => !c.virtual && !BASE_KEYS.has(c.key));
  return [...new Set(fields.map((c) => c.section))].map((section) => ({
    section,
    specs: fields.filter((c) => c.section === section).map((c): FieldSpec => ({
      key: c.key,
      label: c.label,
      hint: c.rule,
      type: c.type === 'date' ? 'date' : c.type === 'int' ? 'number' : c.type === 'email' ? 'email' : c.type === 'enum' ? 'select' : c.key.endsWith('Address') ? 'textarea' : 'text',
      ...(c.type === 'enum' ? { placeholder: 'Not set', options: (c.values ?? []).map((v) => ({ value: v, label: pretty(c, v)! })) } : {}),
    })),
  }));
}
export const directoryKeys = (columns: ImportColumn[]) => columns.filter((c) => !c.virtual && !BASE_KEYS.has(c.key)).map((c) => c.key);

/** Profile tab: every directory section from the registry. Fields a manager may not see are simply absent. */
export function ProfileSections({ employee, base }: { employee: Record<string, any>; base: { term: string; value: React.ReactNode }[] }) {
  const columns = useImportColumns().data ?? [];
  const fields = columns.filter((c) => !c.virtual && !BASE_KEYS.has(c.key) && c.key in employee);
  const sections = [...new Set(fields.map((c) => c.section))];
  return (
    <div className="space-y-4">
      <Card><DescriptionList columns={3} items={base} /></Card>
      {sections.map((s) => (
        <Card key={s}>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-fg-subtle">{s}</h3>
          <DescriptionList columns={3} items={fields.filter((c) => c.section === s).map((c) => ({ term: c.label, value: pretty(c, employee[c.key]), wide: c.key.endsWith('Address') }))} />
        </Card>
      ))}
    </div>
  );
}

// ── Documents & letters ─────────────────────────────────────────────────────

interface Doc { id: string; category: string; name: string; contentType: string; size: number; expiresOn: string | null; verifiedAt: string | null; createdAt: string }
const CATEGORY_LABEL: Record<string, string> = {
  ID_PROOF: 'ID proof', ADDRESS_PROOF: 'Address proof', EDUCATION: 'Education', EXPERIENCE: 'Experience', CONTRACT: 'Contract', LETTER: 'Letter', OTHER: 'Other',
};

export const openDocument = async (id: string) => {
  const { url } = await api<{ url: string }>(`/documents/${id}/url`);
  window.open(url, '_blank', 'noopener');
};

export function DocumentsTab({ employeeId, hr }: { employeeId: string; hr: boolean }) {
  const path = `/employees/${employeeId}/documents`;
  const { data, isLoading } = useApi<Doc[]>(path);
  const [modal, setModal] = useState<'upload' | 'letter' | null>(null);
  const verify = useAction((id: string) => post(`/documents/${id}/verify`), { invalidate: [path], success: 'Marked verified' });
  const remove = useAction((id: string) => del(`/documents/${id}`), { invalidate: [path], success: 'Document deleted' });
  const soon = (d: Doc) => d.expiresOn && d.expiresOn <= new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button leftIcon={<Plus size={16} />} onClick={() => setModal('upload')}>Upload document</Button>
        {hr && <Button variant="secondary" leftIcon={<FilePlus2 size={16} />} onClick={() => setModal('letter')}>Generate letter</Button>}
      </div>
      <Panel>
        <DataTable rows={data ?? []} getRowKey={(r) => r.id} loading={isLoading} onRowClick={(r) => void openDocument(r.id)}
          empty={<EmptyState icon={FileText} title="No documents yet" description="ID and address proofs, certificates, contracts and generated letters live here. Only HR and the employee can open them." />}
          columns={[
            { key: 'n', header: 'Document', render: (r) => <div><div className="font-semibold text-fg">{r.name}</div><div className="text-xs text-fg-subtle">{CATEGORY_LABEL[r.category] ?? r.category} · {Math.ceil(r.size / 1024)} KB · {dateTime(r.createdAt)}</div></div> },
            { key: 'x', header: 'Expires', render: (r) => (r.expiresOn ? <Badge tone={soon(r) ? 'danger' : 'neutral'}>{r.expiresOn}</Badge> : '—') },
            { key: 'v', header: 'Verified', render: (r) => (r.verifiedAt ? <Badge tone="success">Verified</Badge> : <Badge tone="warning">Not verified</Badge>) },
          ]}
          rowActions={(r) => (
            <>
              <IconButton label="Open" icon={<ExternalLink size={16} />} onClick={(e) => { e.stopPropagation(); void openDocument(r.id); }} />
              {hr && !r.verifiedAt && <IconButton label="Mark verified" icon={<ShieldCheck size={16} />} onClick={(e) => { e.stopPropagation(); verify.mutate(r.id); }} />}
              {hr && (
                <IconButton label="Delete" icon={<Trash2 size={16} />} onClick={async (e) => {
                  e.stopPropagation();
                  if (await confirmAction({ title: `Delete ${r.name}?`, message: 'The file is removed for good.', confirmLabel: 'Delete document', tone: 'danger' })) remove.mutate(r.id);
                }} />
              )}
            </>
          )} />
      </Panel>
      {modal === 'upload' && <UploadDocument path={path} onClose={() => setModal(null)} />}
      {modal === 'letter' && <GenerateLetter employeeId={employeeId} onClose={() => setModal(null)} />}
    </div>
  );
}

function UploadDocument({ path, onClose }: { path: string; onClose: () => void }) {
  const [f, set] = useForm({ category: 'ID_PROOF', name: '', expiresOn: '' });
  const [file, setFile] = useState<File | null>(null);
  const save = useAction(async () => post(path, clean({ ...f, fileName: file!.name.replace(/[^\w .()-]+/g, '_').slice(0, 120), contentType: file!.type, dataBase64: await fileToBase64(file!) })), {
    invalidate: [path], success: 'Document uploaded', onSuccess: onClose,
  });
  const bad = file && !['image/jpeg', 'image/png', 'application/pdf'].includes(file.type) ? 'PDF, JPEG or PNG only' : file && file.size > 5 * 1024 * 1024 ? 'At most 5 MB' : '';
  return (
    <FormModal open onClose={onClose} title="Upload document" submitLabel="Upload" saving={save.isPending} onSubmit={() => !bad && file && save.mutate()}>
      <Pick label="Kind" required value={f.category} onChange={set('category')} options={Object.entries(CATEGORY_LABEL).filter(([k]) => k !== 'LETTER').map(([value, label]) => ({ value, label }))} />
      <TextField label="Name" required maxLength={120} placeholder="e.g. Aadhaar card, Degree certificate" value={f.name} onChange={(e) => set('name')(e.target.value)} />
      <DateInput label="Expires on" hint="Passport, visa, licence… HR is reminded 30 and 7 days before" value={f.expiresOn} onChange={(e) => set('expiresOn')(e.target.value)} />
      <FileDropzone accept="application/pdf,image/jpeg,image/png" hint="PDF, JPEG or PNG, up to 5 MB" icon="file" error={bad || undefined}
        file={file && { name: file.name }} onRemove={() => setFile(null)} onFiles={([x]) => { setFile(x); if (!f.name) set('name')(x.name.replace(/\.\w+$/, '')); }} />
    </FormModal>
  );
}

function GenerateLetter({ employeeId, onClose }: { employeeId: string; onClose: () => void }) {
  const templates = useApi<{ id: string; name: string; kind: string }[]>('/letter-templates', undefined, REFERENCE).data ?? [];
  const [templateId, setTemplateId] = useState('');
  const [preview, setPreview] = useState<{ text: string; missing: string[] } | null>(null);
  const path = `/employees/${employeeId}/letters`;
  const show = useAction((id: string) => post<{ text: string; missing: string[] }>(path, { templateId: id, save: false }), { onSuccess: setPreview });
  const save = useAction(() => post(path, { templateId }), { invalidate: [`/employees/${employeeId}/documents`], success: 'Letter generated and filed', onSuccess: onClose });
  return (
    <FormModal open size="lg" onClose={onClose} title="Generate letter" description="Rendered from the template with this employee’s details, saved as a PDF in their documents." submitLabel="Generate PDF" saving={save.isPending}
      onSubmit={() => templateId && save.mutate()}>
      <Pick label="Template" required value={templateId} onChange={(v) => { setTemplateId(v); setPreview(null); if (v) show.mutate(v); }}
        options={templates.map((t) => ({ value: t.id, label: t.name, description: t.kind.toLowerCase() }))} hint="Edit templates in Settings → Letters" />
      {preview?.missing.length ? <Callout tone="warning" title={`Blank in this letter: ${preview.missing.join(', ')}`}>Fill these on the profile first, or edit the template.</Callout> : null}
      {preview && <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-xl border border-line-soft bg-surface-subtle p-4 font-sans text-sm text-fg">{preview.text}</pre>}
    </FormModal>
  );
}

// ── Checklist ───────────────────────────────────────────────────────────────

interface Task { id: string; kind: string; title: string; assigneeRole: string; dueOn: string | null; doneAt: string | null; overdue: boolean; note: string | null; employee?: { fullName: string; employeeCode: string }; employeeId: string }
export const ROLE_TONE: Record<string, 'brand' | 'info' | 'warning' | 'neutral'> = { HR: 'brand', IT: 'info', MANAGER: 'warning', EMPLOYEE: 'neutral' };

export function TaskList({ tasks, path, showEmployee }: { tasks: Task[]; path: string; showEmployee?: boolean }) {
  const toggle = useAction((t: Task) => post(`/tasks/${t.id}/${t.doneAt ? 'reopen' : 'done'}`), { invalidate: [path, '/tasks'] });
  return (
    <DataTable rows={tasks} getRowKey={(r) => r.id} empty={<EmptyState icon={CheckCircle2} title="Nothing to do" />}
      columns={[
        {
          key: 't', header: 'Task', render: (r) => (
            <button type="button" className="flex items-center gap-2 text-left" onClick={(e) => { e.stopPropagation(); toggle.mutate(r); }}>
              {r.doneAt ? <CheckCircle2 size={18} className="shrink-0 text-success" /> : <Circle size={18} className="shrink-0 text-fg-subtle" />}
              <span className={r.doneAt ? 'text-fg-muted line-through' : 'font-medium text-fg'}>{r.title}</span>
            </button>
          ),
        },
        ...(showEmployee ? [{ key: 'e', header: 'Employee', render: (r: Task) => <span>{r.employee?.fullName} <span className="font-mono text-xs text-fg-subtle">{r.employee?.employeeCode}</span></span> }] : []),
        { key: 'k', header: 'Stage', render: (r) => (r.kind === 'ONBOARDING' ? 'Onboarding' : 'Offboarding') },
        { key: 'r', header: 'Owner', render: (r) => <Badge tone={ROLE_TONE[r.assigneeRole]}>{r.assigneeRole}</Badge> },
        { key: 'd', header: 'Due', render: (r) => (r.dueOn ? <span className={r.overdue ? 'font-semibold text-danger-fg' : ''}>{r.dueOn}</span> : '—') },
      ]} />
  );
}

export function ChecklistTab({ employeeId, hr }: { employeeId: string; hr: boolean }) {
  const path = `/employees/${employeeId}/tasks`;
  const { data } = useApi<Task[]>(path);
  const [adding, setAdding] = useState(false);
  const [f, set] = useForm({ kind: 'ONBOARDING', title: '', assigneeRole: 'HR', dueOn: '' });
  const add = useAction(() => post(path, clean(f)), { invalidate: [path], success: 'Task added', onSuccess: () => setAdding(false) });
  const tasks = data ?? [];
  const open = tasks.filter((t) => !t.doneAt).length;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-fg-muted">{tasks.length ? `${tasks.length - open} of ${tasks.length} done` : 'Onboarding tasks are created when someone joins, offboarding tasks when they exit.'}</p>
        {hr && <Button size="sm" leftIcon={<Plus size={14} />} onClick={() => setAdding(true)}>Add task</Button>}
      </div>
      <Panel><TaskList tasks={tasks} path={path} /></Panel>
      {adding && (
        <FormModal open onClose={() => setAdding(false)} title="Add task" submitLabel="Add task" saving={add.isPending} onSubmit={() => add.mutate()}>
          <TextField label="Task" required maxLength={160} value={f.title} onChange={(e) => set('title')(e.target.value)} />
          <Pick label="Stage" value={f.kind} onChange={set('kind')} options={[{ value: 'ONBOARDING', label: 'Onboarding' }, { value: 'OFFBOARDING', label: 'Offboarding' }]} />
          <Pick label="Owner" value={f.assigneeRole} onChange={set('assigneeRole')} options={['HR', 'IT', 'MANAGER', 'EMPLOYEE'].map((r) => ({ value: r, label: r }))} />
          <DateInput label="Due" value={f.dueOn} onChange={(e) => set('dueOn')(e.target.value)} />
        </FormModal>
      )}
    </div>
  );
}

// ── Assets ──────────────────────────────────────────────────────────────────

export interface Asset { id: string; tag: string; name: string; category: string; serialNo: string | null; status: string; employeeId: string | null; assignedAt: string | null; note: string | null; employee: { id: string; fullName: string; employeeCode: string } | null }

export function AssetsTab({ employeeId, hr }: { employeeId: string; hr: boolean }) {
  const { data } = useApi<Asset[]>('/assets', { employeeId });
  const stock = useApi<Asset[]>('/assets', { status: 'IN_STOCK' }, { enabled: hr }).data ?? [];
  const [assetId, setAssetId] = useState('');
  const [assigning, setAssigning] = useState(false);
  const assign = useAction(() => post(`/assets/${assetId}/assign`, { employeeId }), { invalidate: ['/assets'], success: 'Asset assigned', onSuccess: () => setAssigning(false) });
  const giveBack = useAction((id: string) => post(`/assets/${id}/return`, {}), { invalidate: ['/assets'], success: 'Asset returned to stock' });
  return (
    <div className="space-y-4">
      {hr && <Button size="sm" leftIcon={<Plus size={14} />} onClick={() => setAssigning(true)}>Assign from stock</Button>}
      <Panel>
        <DataTable rows={data ?? []} getRowKey={(r) => r.id} empty={<EmptyState title="No company assets with this person" />}
          columns={[
            { key: 't', header: 'Tag', render: (r) => <span className="font-mono">{r.tag}</span> },
            { key: 'n', header: 'Asset', render: (r) => <div><div className="font-medium text-fg">{r.name}</div><div className="text-xs text-fg-subtle">{r.category}{r.serialNo ? ` · ${r.serialNo}` : ''}</div></div> },
            { key: 'a', header: 'Since', render: (r) => (r.assignedAt ? r.assignedAt.slice(0, 10) : '—') },
          ]}
          rowActions={(r) => hr && <IconButton label="Return to stock" icon={<RotateCcw size={16} />} onClick={(e) => { e.stopPropagation(); giveBack.mutate(r.id); }} />} />
      </Panel>
      {assigning && (
        <FormModal open onClose={() => setAssigning(false)} title="Assign an asset" submitLabel="Assign" saving={assign.isPending} onSubmit={() => assetId && assign.mutate()}>
          <Pick label="Asset in stock" required value={assetId} onChange={setAssetId} emptyText="Nothing in stock — add assets under HR → Assets"
            options={stock.map((a) => ({ value: a.id, label: `${a.tag} · ${a.name}`, description: a.category, keywords: a.serialNo ?? '' }))} />
        </FormModal>
      )}
    </div>
  );
}

// ── Salary & payslips ───────────────────────────────────────────────────────

interface Salary { id: string; effectiveFrom: string; monthlyGross: number; structure: { id: string; name: string }; pf: boolean; esi: boolean; pt: boolean; ptState: string | null; overrides: Record<string, number> }

export function SalaryTab({ employeeId, hr }: { employeeId: string; hr: boolean }) {
  const path = `/employees/${employeeId}/salaries`;
  const { data, isLoading } = useApi<Salary[]>(path);
  const [revising, setRevising] = useState(false);
  const current = data?.[0];
  return (
    <div className="space-y-4">
      {current ? (
        <Card>
          <DescriptionList columns={3} items={[
            { term: 'Monthly gross', value: inr(current.monthlyGross, 0) },
            { term: 'Annual gross', value: inr(current.monthlyGross * 12, 0) },
            { term: 'Structure', value: current.structure.name },
            { term: 'Effective from', value: current.effectiveFrom },
            { term: 'Statutory', value: [current.pf && 'PF', current.esi && 'ESI', current.pt && `PT${current.ptState ? ` (${current.ptState})` : ''}`].filter(Boolean).join(' · ') || 'None' },
            { term: 'Overrides', value: Object.entries(current.overrides).map(([k, v]) => `${k} ${inr(v, 0)}`).join(', ') || null },
          ]} />
        </Card>
      ) : !isLoading && <Callout tone="warning" title="No salary set">This person is left out of payroll runs until a salary is added.</Callout>}
      {hr && <Button size="sm" leftIcon={<Plus size={14} />} onClick={() => setRevising(true)}>{current ? 'Revise salary' : 'Set salary'}</Button>}
      {data && data.length > 1 && (
        <Panel>
          <DataTable rows={data} getRowKey={(r) => r.id}
            columns={[
              { key: 'f', header: 'From', render: (r) => r.effectiveFrom },
              { key: 'g', header: 'Monthly gross', align: 'right', render: (r) => inr(r.monthlyGross, 0) },
              { key: 's', header: 'Structure', render: (r) => r.structure.name },
            ]} />
        </Panel>
      )}
      {revising && <ReviseSalary path={path} current={current} onClose={() => setRevising(false)} />}
      <PayslipsTab employeeId={employeeId} />
    </div>
  );
}

function ReviseSalary({ path, current, onClose }: { path: string; current?: Salary; onClose: () => void }) {
  const structures = useApi<{ id: string; name: string; active: boolean }[]>('/payroll/structures', undefined, REFERENCE).data ?? [];
  const payroll = useApi<{ ptSlabs: Record<string, unknown>; defaultPtState: string | null }>('/payroll/settings', undefined, REFERENCE).data;
  const [f, set] = useForm({
    effectiveFrom: today().slice(0, 8) + '01', structureId: current?.structure.id ?? '', monthlyGross: current?.monthlyGross ?? ('' as number | ''),
    pf: current?.pf ?? true, esi: current?.esi ?? true, pt: current?.pt ?? true, ptState: current?.ptState ?? '',
  });
  const save = useAction(() => post(path, { ...clean(f), ptState: f.ptState || null }), { invalidate: [path], success: 'Salary saved', onSuccess: onClose });
  return (
    <FormModal open onClose={onClose} title={current ? 'Revise salary' : 'Set salary'} description="Applies to pay periods ending on or after the effective date. Saving the same date again corrects that revision."
      submitLabel="Save salary" saving={save.isPending} onSubmit={() => save.mutate()}>
      <DateInput label="Effective from" required value={f.effectiveFrom} onChange={(e) => set('effectiveFrom')(e.target.value)} />
      <Pick label="Salary structure" required value={f.structureId} onChange={set('structureId')} options={structures.filter((s) => s.active).map((s) => ({ value: s.id, label: s.name }))} />
      <TextField label="Monthly gross (₹)" required type="number" min={0} step="0.01" value={f.monthlyGross} onChange={(e) => set('monthlyGross')(e.target.value === '' ? '' : Number(e.target.value))} />
      <Switch label="Provident fund (PF)" description="12% of Basic, capped at the PF wage ceiling" checked={f.pf} onChange={set('pf')} />
      <Switch label="ESI" description="Only applies while gross is within the ESI threshold" checked={f.esi} onChange={set('esi')} />
      <Switch label="Professional tax" checked={f.pt} onChange={set('pt')} />
      {f.pt && (
        <Pick label="Professional tax state" hint="States and slabs are set in Settings → Payroll" value={f.ptState} onChange={set('ptState')}
          placeholder={payroll?.defaultPtState ? `Organisation default (${payroll.defaultPtState})` : 'Organisation default (none set)'}
          options={Object.keys(payroll?.ptSlabs ?? {}).map((code) => ({ value: code, label: code }))} />
      )}
    </FormModal>
  );
}

interface PayslipRow { id: string; runId: string; month: string; status: string; periodStart: string; periodEnd: string; paidDays: number; lopDays: number; gross: number; deductions: number; net: number }
const RUN_TONE: Record<string, 'neutral' | 'info' | 'success'> = { DRAFT: 'neutral', APPROVED: 'info', PAID: 'success' };

export function PayslipsTab({ employeeId }: { employeeId: string }) {
  const { data } = useApi<PayslipRow[]>(`/employees/${employeeId}/payslips`);
  const pdf = useAction((id: string) => downloadFile(`/payroll/payslips/${id}/pdf`, undefined, 'payslip.pdf'));
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-fg-subtle">Payslips</h3>
      <Panel>
        <DataTable rows={data ?? []} getRowKey={(r) => r.id} empty={<EmptyState title="No payslips yet" />}
          columns={[
            { key: 'm', header: 'Month', render: (r) => <div><div className="font-medium text-fg">{r.month}</div><div className="text-xs text-fg-subtle">{r.periodStart} – {r.periodEnd}</div></div> },
            { key: 's', header: 'Run', render: (r) => <Badge tone={RUN_TONE[r.status]}>{r.status.toLowerCase()}</Badge> },
            { key: 'd', header: 'Paid days', align: 'right', render: (r) => `${r.paidDays}${r.lopDays ? ` (LOP ${r.lopDays})` : ''}` },
            { key: 'g', header: 'Gross', align: 'right', render: (r) => inr(r.gross) },
            { key: 'n', header: 'Net pay', align: 'right', render: (r) => <b>{inr(r.net)}</b> },
          ]}
          rowActions={(r) => <IconButton label="Download PDF" icon={<Download size={16} />} onClick={(e) => { e.stopPropagation(); pdf.mutate(r.id); }} />} />
      </Panel>
    </div>
  );
}

