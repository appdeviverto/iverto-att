import {
  Badge, Button, Callout, Card, confirmAction, DataTable, DateInput, EmptyState, FileDropzone, IconButton, ListFooter, Modal, PageHeader, PillTabs,
  SearchInput, SegmentedControl, Switch, TextField, Textarea,
} from '@iverto-org/core-ui';
import { ExternalLink, Megaphone, Package, Pencil, Plus, Receipt, RotateCcw, Send, Trash2, UserPen } from 'lucide-react';
import { useMemo, useState } from 'react';
import { openDocument, TaskList, type Asset } from '../components/EmployeeHr';
import { ApprovalTracker, clean, Decide, EmployeePicker, FormModal, Panel, Pick, useForm, type Progress } from '../components/ui';
import { del, fileToBase64, inr, patch, post, REFERENCE, useAction, useApi, useCursor, useDepartments, useImportColumns, useSites } from '../lib/api';
import { isHr, isManager, useMe } from '../lib/auth';
import { dateTime, REQUEST_STATUS, StatusBadge, today } from '../lib/format';

// ── Expenses ────────────────────────────────────────────────────────────────

interface Expense {
  id: string; employeeId: string; category: string; amount: number; claimDate: string; description: string; status: string; reimbursed: boolean; reimbursedOutsidePayroll: boolean;
  receiptUrl: string | null; decisionNote: string | null; employee: { fullName: string; employeeCode: string }; progress: Progress; createdAt: string;
}

export function Expenses() {
  const me = useMe();
  const mgr = isManager(me);
  const [view, setView] = useState(mgr ? 'awaiting' : 'mine');
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<Expense | null>(null);
  const [claiming, setClaiming] = useState(false);
  const params = view === 'awaiting' ? { awaitingMe: true } : view === 'unpaid' ? { unpaid: true } : view === 'mine' ? { employeeId: me.employeeId ?? '__none__', status } : { status };
  const list = useCursor<Expense>('/expenses', params);
  const paidOutside = useAction((id: string) => post(`/expenses/${id}/paid-outside-payroll`), { invalidate: ['/expenses'], success: 'Marked reimbursed', onSuccess: () => setOpen(null) });

  return (
    <div className="space-y-6">
      <PageHeader title="Expense claims" subtitle="Claims with receipts, approved by the manager (and HR when two-level), reimbursed in the next payroll run."
        actions={me.employeeId && <Button leftIcon={<Plus size={16} />} onClick={() => setClaiming(true)}>New claim</Button>}
        filters={
          <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap">
            <PillTabs label="View" value={view} onChange={setView} tabs={[
              ...(mgr ? [{ value: 'awaiting', label: 'Waiting for me' }] : []),
              ...(me.employeeId ? [{ value: 'mine', label: 'My claims' }] : []),
              ...(mgr ? [{ value: 'all', label: 'All' }] : []),
              ...(isHr(me) ? [{ value: 'unpaid', label: 'To reimburse' }] : []),
            ]} />
            {(view === 'all' || view === 'mine') && (
              <SegmentedControl label="Status" value={status} onChange={setStatus} size="sm"
                options={[{ value: '', label: 'Any' }, { value: 'PENDING', label: 'Pending' }, { value: 'APPROVED', label: 'Approved' }, { value: 'REJECTED', label: 'Rejected' }]} />
            )}
          </div>
        } />
      <Panel>
        <DataTable rows={list.rows} getRowKey={(r) => r.id} loading={list.isLoading} onRowClick={setOpen}
          empty={<EmptyState icon={Receipt} title={view === 'awaiting' ? 'Nothing waiting for you' : 'No claims here'} />}
          columns={[
            ...(view !== 'mine' ? [{ key: 'e', header: 'Employee', render: (r: Expense) => <span>{r.employee.fullName} <span className="font-mono text-xs text-fg-subtle">{r.employee.employeeCode}</span></span> }] : []),
            { key: 'd', header: 'Date', render: (r) => r.claimDate },
            { key: 'c', header: 'Category', render: (r) => r.category },
            { key: 'x', header: 'Description', render: (r) => <span className="line-clamp-1 max-w-72">{r.description}</span> },
            { key: 'a', header: 'Amount', align: 'right', render: (r) => <b>{inr(r.amount)}</b> },
            { key: 's', header: 'Status', render: (r) => <span className="flex gap-1.5"><StatusBadge value={r.status} map={REQUEST_STATUS} />{r.reimbursed && <Badge tone="success">Reimbursed</Badge>}</span> },
          ]}
          rowActions={(r) => r.status === 'PENDING' && <Decide path="/expenses" id={r.id} noun="Expense" canDecide={mgr && r.employeeId !== me.employeeId} canCancel={r.employeeId === me.employeeId} />} />
      </Panel>
      <ListFooter count={list.rows.length} hasMore={Boolean(list.hasNextPage)} loadingMore={list.isFetchingNextPage} onLoadMore={() => void list.fetchNextPage()} noun="claims" />
      {claiming && <NewClaim onClose={() => setClaiming(false)} />}
      {open && (
        <Modal open onClose={() => setOpen(null)} size="lg" title={`${open.category} · ${inr(open.amount)}`} description={`${open.employee.fullName} · ${open.claimDate}`}
          footer={<>
            {isHr(me) && open.status === 'APPROVED' && !open.reimbursed && <Button variant="secondary" loading={paidOutside.isPending} onClick={() => paidOutside.mutate(open.id)}>Reimbursed outside payroll</Button>}
            <Button onClick={() => setOpen(null)}>Close</Button>
          </>}>
          <div className="space-y-5 p-5 sm:p-6">
            <ApprovalTracker progress={open.progress} />
            <p className="whitespace-pre-wrap text-sm text-fg">{open.description}</p>
            {open.receiptUrl && (/\.pdf/i.test(open.receiptUrl.split('?')[0])
              ? <Button variant="secondary" leftIcon={<ExternalLink size={16} />} onClick={() => window.open(open.receiptUrl!, '_blank', 'noopener')}>Open receipt (PDF)</Button>
              : <a href={open.receiptUrl} target="_blank" rel="noreferrer"><img src={open.receiptUrl} alt="Receipt" className="max-h-96 rounded-xl border border-line object-contain" /></a>)}
            {open.reimbursed && <Callout tone="success" title={open.reimbursedOutsidePayroll ? 'Reimbursed outside payroll' : 'Reimbursed in a payroll run'} />}
          </div>
        </Modal>
      )}
    </div>
  );
}

function NewClaim({ onClose }: { onClose: () => void }) {
  const categories = useApi<{ expenseCategories: string[] }>('/hr/settings', undefined, REFERENCE).data?.expenseCategories ?? [];
  const [f, set] = useForm({ category: '', amount: '' as number | '', claimDate: today(), description: '' });
  const [file, setFile] = useState<File | null>(null);
  const bad = file && !['image/jpeg', 'image/png', 'application/pdf'].includes(file.type) ? 'PDF, JPEG or PNG only' : file && file.size > 5 * 1024 * 1024 ? 'At most 5 MB' : '';
  const save = useAction(async () => post('/expenses', clean({ ...f, ...(file ? { receiptBase64: await fileToBase64(file), receiptType: file.type } : {}) })), {
    invalidate: ['/expenses'], success: 'Claim submitted', onSuccess: onClose,
  });
  return (
    <FormModal open onClose={onClose} title="New expense claim" submitLabel="Submit claim" saving={save.isPending} onSubmit={() => !bad && save.mutate()}>
      <Pick label="Category" required value={f.category} onChange={set('category')} options={categories.map((c) => ({ value: c, label: c }))} />
      <TextField label="Amount (₹)" required type="number" min={1} step="0.01" value={f.amount} onChange={(e) => set('amount')(e.target.value === '' ? '' : Number(e.target.value))} />
      <DateInput label="Date of expense" required max={today()} value={f.claimDate} onChange={(e) => set('claimDate')(e.target.value)} />
      <Textarea label="What was it for?" required minLength={3} maxLength={1000} value={f.description} onChange={(e) => set('description')(e.target.value)} />
      <FileDropzone label="Receipt" accept="application/pdf,image/jpeg,image/png" hint="Photo or PDF, up to 5 MB" icon="file" error={bad || undefined}
        file={file && { name: file.name }} onRemove={() => setFile(null)} onFiles={([x]) => setFile(x)} />
    </FormModal>
  );
}

// ── Assets ──────────────────────────────────────────────────────────────────

export function Assets() {
  const me = useMe();
  const hr = isHr(me);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const { data, isLoading } = useApi<Asset[]>('/assets', { status, q });
  const categories = useApi<{ assetCategories: string[] }>('/hr/settings', undefined, REFERENCE).data?.assetCategories ?? [];
  const [editing, setEditing] = useState<Asset | 'new' | null>(null);
  const [assigning, setAssigning] = useState<Asset | null>(null);
  const [employeeId, setEmployeeId] = useState('');
  const giveBack = useAction(({ id, retire }: { id: string; retire?: boolean }) => post(`/assets/${id}/return`, retire ? { status: 'RETIRED' } : {}), { invalidate: ['/assets'], success: 'Asset returned' });
  const assign = useAction(() => post(`/assets/${assigning!.id}/assign`, { employeeId }), { invalidate: ['/assets'], success: 'Asset assigned', onSuccess: () => setAssigning(null) });
  const counts = useMemo(() => ({ total: data?.length ?? 0, assigned: data?.filter((a) => a.status === 'ASSIGNED').length ?? 0 }), [data]);

  return (
    <div className="space-y-6">
      <PageHeader title="Assets" subtitle={status ? undefined : `${counts.total} in the register · ${counts.assigned} with employees`}
        actions={hr && <Button leftIcon={<Plus size={16} />} onClick={() => setEditing('new')}>Add asset</Button>}
        filters={
          <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap">
            <SearchInput value={q} onChange={setQ} placeholder="Tag, name or serial" />
            <SegmentedControl label="Status" value={status} onChange={setStatus} size="sm"
              options={[{ value: '', label: 'All' }, { value: 'IN_STOCK', label: 'In stock' }, { value: 'ASSIGNED', label: 'Assigned' }, { value: 'RETIRED', label: 'Retired' }]} />
          </div>
        } />
      <Panel>
        <DataTable rows={data ?? []} getRowKey={(r) => r.id} loading={isLoading} onRowClick={hr ? setEditing : undefined}
          empty={<EmptyState icon={Package} title="No assets" description={hr ? 'Add laptops, phones, ID cards… and assign them to people. Offboarding lists what they must return.' : undefined} />}
          columns={[
            { key: 't', header: 'Tag', render: (r) => <span className="font-mono font-semibold">{r.tag}</span> },
            { key: 'n', header: 'Asset', render: (r) => <div><div className="font-medium text-fg">{r.name}</div><div className="text-xs text-fg-subtle">{r.category}{r.serialNo ? ` · ${r.serialNo}` : ''}</div></div> },
            { key: 's', header: 'Status', render: (r) => <Badge tone={r.status === 'ASSIGNED' ? 'info' : r.status === 'IN_STOCK' ? 'success' : 'neutral'}>{r.status.replace('_', ' ').toLowerCase()}</Badge> },
            { key: 'e', header: 'With', render: (r) => (r.employee ? <span>{r.employee.fullName} <span className="font-mono text-xs text-fg-subtle">{r.employee.employeeCode}</span></span> : '—') },
            { key: 'a', header: 'Since', render: (r) => r.assignedAt?.slice(0, 10) ?? '—' },
          ]}
          rowActions={(r) => hr && (
            <>
              {r.status === 'IN_STOCK' && <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); setEmployeeId(''); setAssigning(r); }}>Assign</Button>}
              {r.status === 'ASSIGNED' && <IconButton label="Return to stock" icon={<RotateCcw size={16} />} onClick={(e) => { e.stopPropagation(); giveBack.mutate({ id: r.id }); }} />}
              {r.status === 'ASSIGNED' && (
                <IconButton label="Returned damaged / retire" icon={<Trash2 size={16} />} onClick={async (e) => {
                  e.stopPropagation();
                  if (await confirmAction({ title: `Retire ${r.tag}?`, message: 'Marks it returned and written off.', confirmLabel: 'Retire' })) giveBack.mutate({ id: r.id, retire: true });
                }} />
              )}
            </>
          )} />
      </Panel>
      {editing && <AssetForm asset={editing === 'new' ? undefined : editing} categories={categories} onClose={() => setEditing(null)} />}
      {assigning && (
        <FormModal open onClose={() => setAssigning(null)} title={`Assign ${assigning.tag} · ${assigning.name}`} submitLabel="Assign" saving={assign.isPending} onSubmit={() => employeeId && assign.mutate()}>
          <EmployeePicker required value={employeeId} onChange={setEmployeeId} />
        </FormModal>
      )}
    </div>
  );
}

function AssetForm({ asset, categories, onClose }: { asset?: Asset; categories: string[]; onClose: () => void }) {
  const [f, set] = useForm({ tag: asset?.tag ?? '', name: asset?.name ?? '', category: asset?.category ?? '', serialNo: asset?.serialNo ?? '', note: asset?.note ?? '' });
  const save = useAction(() => (asset ? patch(`/assets/${asset.id}`, { ...f, serialNo: f.serialNo || null, note: f.note || null }) : post('/assets', clean(f))), {
    invalidate: ['/assets'], success: 'Asset saved', onSuccess: onClose,
  });
  return (
    <FormModal open onClose={onClose} title={asset ? `Edit ${asset.tag}` : 'Add asset'} submitLabel="Save" saving={save.isPending} onSubmit={() => save.mutate()}>
      <TextField label="Asset tag" required maxLength={40} hint="The label on the item, e.g. LAP-014" value={f.tag} onChange={(e) => set('tag')(e.target.value)} />
      <TextField label="Name" required maxLength={120} placeholder="Dell Latitude 5440" value={f.name} onChange={(e) => set('name')(e.target.value)} />
      <Pick label="Category" required value={f.category} onChange={set('category')} options={categories.map((c) => ({ value: c, label: c }))} hint="Edit categories in Settings → HR" />
      <TextField label="Serial number" maxLength={80} value={f.serialNo} onChange={(e) => set('serialNo')(e.target.value)} />
      <Textarea label="Note" maxLength={500} value={f.note} onChange={(e) => set('note')(e.target.value)} />
    </FormModal>
  );
}

// ── Announcements ───────────────────────────────────────────────────────────

interface Announcement { id: string; title: string; body: string; siteIds: string[]; departmentIds: string[]; requiresAck: boolean; publishedAt: string | null; createdAt: string; acks?: number; audience?: number | null; ackAt?: string | null }

export function Announcements() {
  const me = useMe();
  const hr = isHr(me);
  const { data, isLoading } = useApi<Announcement[]>('/announcements');
  const [editing, setEditing] = useState<Announcement | 'new' | null>(null);
  const [acksOf, setAcksOf] = useState<Announcement | null>(null);
  const publish = useAction((id: string) => post<{ notified: number }>(`/announcements/${id}/publish`), { invalidate: ['/announcements'], success: (r) => `Published · ${r.notified} people notified` });
  const ack = useAction((id: string) => post(`/announcements/${id}/ack`), { invalidate: ['/announcements'], success: 'Acknowledged' });
  const remove = useAction((id: string) => del(`/announcements/${id}`), { invalidate: ['/announcements'], success: 'Removed' });

  return (
    <div className="space-y-6">
      <PageHeader title="Announcements" subtitle="Notices and policy updates, pushed to the app. Ask people to acknowledge the ones that matter."
        actions={hr && <Button leftIcon={<Plus size={16} />} onClick={() => setEditing('new')}>New announcement</Button>} />
      {isLoading ? null : !data?.length ? <Card><EmptyState icon={Megaphone} title="No announcements yet" /></Card> : (
        <div className="space-y-3">
          {data.map((a) => (
            <Card key={a.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold text-fg">{a.title}</h3>
                    {!a.publishedAt && <Badge tone="neutral">Draft</Badge>}
                    {a.requiresAck && <Badge tone="warning">Acknowledge</Badge>}
                  </div>
                  <p className="text-xs text-fg-subtle">{a.publishedAt ? `Published ${dateTime(a.publishedAt)}` : `Created ${dateTime(a.createdAt)}`}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {hr && !a.publishedAt && <>
                    <IconButton label="Edit" icon={<Pencil size={16} />} onClick={() => setEditing(a)} />
                    <Button size="sm" leftIcon={<Send size={14} />} loading={publish.isPending && publish.variables === a.id}
                      onClick={async () => { if (await confirmAction({ title: 'Publish now?', message: 'Everyone in the audience gets a notification. It can’t be edited afterwards.', confirmLabel: 'Publish' })) publish.mutate(a.id); }}>Publish</Button>
                  </>}
                  {hr && a.publishedAt && a.requiresAck && <Button size="sm" variant="secondary" onClick={() => setAcksOf(a)}>{a.acks ?? 0} / {a.audience ?? 0} acknowledged</Button>}
                  {hr && <IconButton label="Delete" icon={<Trash2 size={16} />} onClick={async () => { if (await confirmAction({ title: `Delete “${a.title}”?`, confirmLabel: 'Delete', tone: 'danger' })) remove.mutate(a.id); }} />}
                  {!hr && a.requiresAck && (a.ackAt ? <Badge tone="success">Acknowledged</Badge> : <Button size="sm" loading={ack.isPending} onClick={() => ack.mutate(a.id)}>I have read this</Button>)}
                </div>
              </div>
              <p className="mt-3 whitespace-pre-wrap text-sm text-fg">{a.body}</p>
            </Card>
          ))}
        </div>
      )}
      {editing && <AnnouncementForm announcement={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      {acksOf && <AckList announcement={acksOf} onClose={() => setAcksOf(null)} />}
    </div>
  );
}

function AnnouncementForm({ announcement, onClose }: { announcement?: Announcement; onClose: () => void }) {
  const sites = useSites().data ?? [];
  const departments = useDepartments().data ?? [];
  const [f, set] = useForm({ title: announcement?.title ?? '', body: announcement?.body ?? '', siteIds: announcement?.siteIds ?? [], departmentIds: announcement?.departmentIds ?? [], requiresAck: announcement?.requiresAck ?? false });
  const save = useAction(() => (announcement ? patch(`/announcements/${announcement.id}`, f) : post('/announcements', f)), { invalidate: ['/announcements'], success: 'Draft saved', onSuccess: onClose });
  const toggle = (k: 'siteIds' | 'departmentIds', id: string, on: boolean) => set(k)(on ? [...f[k], id] : f[k].filter((x) => x !== id));
  return (
    <FormModal open size="lg" onClose={onClose} title={announcement ? 'Edit draft' : 'New announcement'} description="Saved as a draft; publish it when it’s ready." submitLabel="Save draft" saving={save.isPending} onSubmit={() => save.mutate()}>
      <TextField label="Title" required maxLength={160} value={f.title} onChange={(e) => set('title')(e.target.value)} />
      <Textarea label="Message" required rows={8} maxLength={10000} value={f.body} onChange={(e) => set('body')(e.target.value)} />
      <Switch label="Ask people to acknowledge" description="Shows who has read it — for policy changes" checked={f.requiresAck} onChange={set('requiresAck')} />
      <div>
        <p className="mb-2 text-sm font-semibold text-fg">Sites <span className="font-normal text-fg-muted">(none = everyone)</span></p>
        <div className="flex flex-wrap gap-3">{sites.map((s) => <Switch key={s.id} label={s.name} checked={f.siteIds.includes(s.id)} onChange={(on) => toggle('siteIds', s.id, on)} />)}</div>
      </div>
      {departments.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-semibold text-fg">Departments <span className="font-normal text-fg-muted">(none = all)</span></p>
          <div className="flex flex-wrap gap-3">{departments.map((d) => <Switch key={d.id} label={d.name} checked={f.departmentIds.includes(d.id)} onChange={(on) => toggle('departmentIds', d.id, on)} />)}</div>
        </div>
      )}
    </FormModal>
  );
}

function AckList({ announcement, onClose }: { announcement: Announcement; onClose: () => void }) {
  const { data } = useApi<{ id: string; fullName: string; employeeCode: string; ackAt: string | null }[]>(`/announcements/${announcement.id}/acks`);
  const [only, setOnly] = useState(true);
  const rows = (data ?? []).filter((p) => !only || !p.ackAt);
  return (
    <Modal open onClose={onClose} size="lg" title={announcement.title} description="Who has acknowledged" footer={<Button onClick={onClose}>Close</Button>}>
      <div className="space-y-3 p-5 sm:p-6">
        <Switch label="Only people who haven’t" checked={only} onChange={setOnly} />
        <DataTable rows={rows} getRowKey={(r) => r.id} empty={<p className="p-4 text-sm text-fg-muted">Everyone has acknowledged.</p>}
          columns={[
            { key: 'n', header: 'Employee', render: (r) => <span>{r.fullName} <span className="font-mono text-xs text-fg-subtle">{r.employeeCode}</span></span> },
            { key: 'a', header: 'Acknowledged', render: (r) => (r.ackAt ? dateTime(r.ackAt) : <Badge tone="warning">Not yet</Badge>) },
          ]} />
      </div>
    </Modal>
  );
}

// ── Org chart ── (components/OrgTree.tsx)

export { OrgChart } from '../components/OrgTree';

// ── Profile change requests (HR) ────────────────────────────────────────────

interface ProfileRequest { id: string; employeeId: string; changes: Record<string, unknown>; before: Record<string, unknown>; reason: string | null; status: string; createdAt: string; decisionNote: string | null; employee: { fullName: string; employeeCode: string } }

export function ProfileChanges() {
  const [status, setStatus] = useState('PENDING');
  const list = useCursor<ProfileRequest>('/profile-requests', { status });
  const columns = useImportColumns().data ?? [];
  const label = (k: string) => columns.find((c) => c.key === k)?.label ?? k;
  return (
    <div className="space-y-6">
      <PageHeader title="Profile changes" subtitle="Personal, contact, ID and bank details employees asked to change from the app. Nothing changes until you approve."
        filters={<SegmentedControl label="Status" value={status} onChange={setStatus} size="sm" options={[{ value: 'PENDING', label: 'Pending' }, { value: 'APPROVED', label: 'Approved' }, { value: 'REJECTED', label: 'Rejected' }, { value: '', label: 'All' }]} />} />
      {!list.rows.length && !list.isLoading ? <Card><EmptyState icon={UserPen} title="No profile changes here" /></Card> : (
        <div className="space-y-3">
          {list.rows.map((r) => (
            <Card key={r.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="font-semibold text-fg">{r.employee.fullName} <span className="font-mono text-xs text-fg-subtle">{r.employee.employeeCode}</span></div>
                  <div className="text-xs text-fg-subtle">{dateTime(r.createdAt)}{r.reason ? ` · “${r.reason}”` : ''}</div>
                </div>
                {r.status === 'PENDING' ? <Decide path="/profile-requests" id={r.id} noun="Profile change" canDecide /> : <StatusBadge value={r.status} map={REQUEST_STATUS} />}
              </div>
              <table className="mt-3 w-full text-sm">
                <thead><tr className="text-left text-xs uppercase tracking-wide text-fg-subtle"><th className="py-1 font-medium">Field</th><th className="py-1 font-medium">Now</th><th className="py-1 font-medium">Requested</th></tr></thead>
                <tbody className="divide-y divide-line-soft">
                  {Object.entries(r.changes).map(([k, v]) => (
                    <tr key={k} className={k.startsWith('bank') ? 'bg-warning-soft/40' : ''}>
                      <td className="py-1.5 pr-3 font-medium text-fg">{label(k)}{k.startsWith('bank') && <Badge tone="warning" className="ml-1.5">bank</Badge>}</td>
                      <td className="py-1.5 pr-3 text-fg-muted">{String(r.before[k] ?? '—')}</td>
                      <td className="py-1.5 font-semibold text-fg">{v === null ? <i className="font-normal text-fg-muted">clear</i> : String(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ))}
        </div>
      )}
      <ListFooter count={list.rows.length} hasMore={Boolean(list.hasNextPage)} loadingMore={list.isFetchingNextPage} onLoadMore={() => void list.fetchNextPage()} noun="requests" />
    </div>
  );
}

// ── My tasks ────────────────────────────────────────────────────────────────

interface ExpiringDoc { id: string; name: string; category: string; expiresOn: string; expired: boolean; employeeId: string; employee: { fullName: string; employeeCode: string } }

export function MyTasks() {
  const me = useMe();
  const [all, setAll] = useState(false);
  const { data } = useApi<Parameters<typeof TaskList>[0]['tasks']>('/tasks/mine', { all });
  const expiring = useApi<ExpiringDoc[]>('/documents/expiring', { days: 30 }, { enabled: isHr(me) }).data ?? [];
  return (
    <div className="space-y-6">
      <PageHeader title="My tasks" subtitle={isHr(me) ? 'Onboarding and offboarding work for HR and IT across the organisation.' : 'Checklist items waiting on you.'}
        filters={<Switch label="Show completed" checked={all} onChange={setAll} />} />
      {expiring.length > 0 && (
        <Callout tone="warning" title={`${expiring.length} document${expiring.length === 1 ? '' : 's'} expiring within 30 days`}>
          <ul className="space-y-1">
            {expiring.slice(0, 10).map((d) => (
              <li key={d.id}>
                <button type="button" className="font-semibold hover:underline" onClick={() => void openDocument(d.id)}>{d.employee.fullName}: {d.name}</button>
                {' '}{d.expired ? 'expired' : 'expires'} {d.expiresOn}
              </li>
            ))}
          </ul>
        </Callout>
      )}
      <Panel><TaskList tasks={data ?? []} path="/tasks/mine" showEmployee /></Panel>
    </div>
  );
}

