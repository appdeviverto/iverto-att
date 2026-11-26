import { ActivityFeed, Badge, confirmAction, Breadcrumbs, Button, Callout, Card, CardHeader, CenteredSpinner, CopyField, DataTable, DescriptionList, EmptyState, IconButton, PageHeader, requestReason, Select, Switch, Textarea, TextField } from '@iverto-org/core-ui';
import { LogIn, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { TenantApiCard } from '../components/ApiAccess';
import { FormModal, Panel, useForm } from '../components/ui';
import { ANNOUNCEMENT_KIND, AnnouncementBody, type PlatformAnnouncement } from '../components/WhatsNew';
import { clearCache, del, patch, post, useAction, useApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, REQUEST_STATUS, StatusBadge } from '../lib/format';

interface Tenant { id: string; name: string; slug: string; status: string; createdAt: string; suspendedAt: string | null; suspendedReason: string | null; employeeCount: number; terminalCount: number; terminalsOnline: number; lastPunchAt: string | null; settings?: { features?: Partial<Features> } }
interface Temp { email: string; temporaryPassword: string }
interface Features { hr: boolean; payroll: boolean }

/** The paid modules a tenant can have; core attendance is always on. */
const MODULES: { key: keyof Features; label: string; description: string }[] = [
  { key: 'hr', label: 'HR', description: 'Documents, letters, on/offboarding checklists, org chart, expenses, assets, announcements' },
  { key: 'payroll', label: 'Payroll', description: 'Salary structures, payroll runs, payslips, bank file, loans, period lock' },
];

/** Iverto staff only (§13.1). Platform admins do not see tenant attendance here. */
export function Tenants() {
  const navigate = useNavigate();
  const { data, isLoading } = useApi<Tenant[]>('/platform/tenants');
  const [creating, setCreating] = useState(false);
  const [temp, setTemp] = useState<Temp | null>(null);
  return (
    <div className="space-y-6">
      <PageHeader title="Tenants" subtitle="Organisations on Iverto Attendance" actions={<Button leftIcon={<Plus size={16} />} onClick={() => setCreating(true)}>New tenant</Button>} />
      {temp && <Callout tone="success" title={`Tenant created — admin ${temp.email}`} onDismiss={() => setTemp(null)}><CopyField label="Temporary password (shown once)" value={temp.temporaryPassword} /></Callout>}
      <Panel>
        <DataTable rows={data ?? []} getRowKey={(t) => t.id} loading={isLoading} onRowClick={(t) => navigate(`/platform/${t.id}`)} empty={<EmptyState title="No tenants yet" />}
          columns={[
            { key: 'n', header: 'Tenant', render: (t) => <div><div className="font-semibold text-fg">{t.name}</div><div className="font-mono text-xs text-fg-subtle">{t.slug}</div></div> },
            { key: 's', header: 'Status', render: (t) => <StatusBadge value={t.status} map={REQUEST_STATUS} /> },
            { key: 'm', header: 'Modules', render: (t) => <div className="flex gap-1">{MODULES.filter((m) => t.settings?.features?.[m.key]).map((m) => <Badge key={m.key} tone="brand">{m.label}</Badge>)}{!MODULES.some((m) => t.settings?.features?.[m.key]) && <span className="text-xs text-fg-subtle">Attendance only</span>}</div> },
            { key: 'e', header: 'Employees', align: 'right', render: (t) => t.employeeCount },
            { key: 't', header: 'Terminals online', align: 'right', render: (t) => <Badge tone={t.terminalsOnline < t.terminalCount ? 'warning' : 'success'}>{t.terminalsOnline} / {t.terminalCount}</Badge> },
            { key: 'p', header: 'Last punch', render: (t) => dateTime(t.lastPunchAt) },
          ]} />
      </Panel>
      {creating && <NewTenant onClose={() => setCreating(false)} onCreated={(t) => { setCreating(false); setTemp(t); }} />}
    </div>
  );
}

function NewTenant({ onClose, onCreated }: { onClose: () => void; onCreated: (t: Temp) => void }) {
  const [f, set] = useForm({ name: '', slug: '', siteName: '', timezone: 'Asia/Kolkata', fullName: '', email: '', hr: false, payroll: false });
  const save = useAction(() => post<{ admin: Temp }>('/platform/tenants', { name: f.name, slug: f.slug, site: { name: f.siteName, timezone: f.timezone }, admin: { fullName: f.fullName, email: f.email }, features: { hr: f.hr, payroll: f.payroll } }), {
    invalidate: ['/platform'], onSuccess: (r) => onCreated(r.admin),
  });
  return (
    <FormModal open size="drawer" onClose={onClose} title="New tenant" description="Creates the organisation, its first site, default policy, shift and leave types, and the first admin."
      submitLabel="Create tenant" saving={save.isPending} onSubmit={() => save.mutate()}>
      <TextField label="Organisation name" required value={f.name} onChange={(e) => set('name')(e.target.value)} />
      <TextField label="Slug" required pattern="[a-z0-9][a-z0-9-]{1,40}" hint="Lowercase letters, digits and dashes" value={f.slug} onChange={(e) => set('slug')(e.target.value.toLowerCase())} />
      <TextField label="First site" required value={f.siteName} onChange={(e) => set('siteName')(e.target.value)} />
      <TextField label="Site timezone (IANA)" required value={f.timezone} onChange={(e) => set('timezone')(e.target.value)} />
      <TextField label="Admin name" required value={f.fullName} onChange={(e) => set('fullName')(e.target.value)} />
      <TextField label="Admin email" type="email" required hint="One email belongs to one tenant" value={f.email} onChange={(e) => set('email')(e.target.value)} />
      <div className="space-y-3 border-t border-line-soft pt-4">
        <p className="text-sm font-semibold text-fg">Modules <span className="font-normal text-fg-subtle">— attendance is always included; these can be changed later</span></p>
        {MODULES.map((m) => <Switch key={m.key} label={m.label} description={m.description} checked={f[m.key]} onChange={set(m.key)} />)}
      </div>
    </FormModal>
  );
}

interface TenantDetailData extends Tenant { settings: { features?: Partial<Features> }; sites: { id: string; name: string; timezone: string }[]; audit: { id: string; action: string; actorUserId: string | null; createdAt: string; payload: any }[] }

export function TenantDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { setOverride } = useAuth();
  const { data: t } = useApi<TenantDetailData>(`/platform/tenants/${id}`);
  const [temp, setTemp] = useState<Temp | null>(null);
  const act = useAction(({ path, body }: { path: string; body?: unknown }) => post<Partial<Temp>>(`/platform/tenants/${id}/${path}`, body), {
    invalidate: ['/platform'], success: 'Done',
    onSuccess: (r) => r?.temporaryPassword && setTemp(r as Temp),
  });
  if (!t) return <CenteredSpinner />;

  const openInside = () => {
    clearCache();
    setOverride(t.id);
    navigate('/live');
  };

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={<Breadcrumbs items={[{ label: 'Tenants', href: '/platform' }, { label: t.name }]} />} title={t.name} subtitle={t.slug}
        actions={<>
          {t.status === 'PROVISIONING' && <Button variant="secondary" loading={act.isPending} onClick={() => act.mutate({ path: 'retry-admin' })}>Finish setup</Button>}
          {t.status === 'ACTIVE' && <Button variant="secondary" onClick={() => act.mutate({ path: 'admin/reset-password' })}>Reset admin password</Button>}
          {t.status === 'SUSPENDED'
            ? <Button variant="secondary" onClick={() => act.mutate({ path: 'reactivate' })}>Reactivate</Button>
            : <Button variant="danger" onClick={async () => {
                const reason = await requestReason({ title: `Suspend ${t.name}?`, message: 'Users are locked out within a minute. Terminals keep buffering scans; nothing is lost.', confirmLabel: 'Suspend tenant', tone: 'danger', minLength: 3 });
                if (reason) act.mutate({ path: 'suspend', body: { reason } });
              }}>Suspend</Button>}
          <Button leftIcon={<LogIn size={16} />} onClick={openInside}>Open as admin</Button>
        </>} />
      {t.status === 'SUSPENDED' && <Callout tone="danger" title={`Suspended ${dateTime(t.suspendedAt)}`}>{t.suspendedReason}</Callout>}
      {temp && <Callout tone="success" title={`New temporary password for ${temp.email}`} onDismiss={() => setTemp(null)}><CopyField label="Shown once" value={temp.temporaryPassword} /></Callout>}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Details" />
          <DescriptionList items={[
            { term: 'Status', value: <StatusBadge value={t.status} map={REQUEST_STATUS} /> },
            { term: 'Created', value: dateTime(t.createdAt) },
            { term: 'Sites', value: t.sites.map((s) => `${s.name} (${s.timezone})`).join(', '), wide: true },
          ]} />
        </Card>
        <Modules tenantId={t.id} features={t.settings.features ?? {}} />
        <TenantApiCard tenantId={t.id} />
        <Card>
          <CardHeader title="Platform audit trail" />
          <ActivityFeed empty={<p className="text-sm text-fg-muted">No platform actions yet.</p>}
            items={t.audit.map((a) => ({ id: a.id, actor: a.actorUserId?.slice(0, 8) ?? 'system', action: a.action.toLowerCase().replaceAll('_', ' '), time: dateTime(a.createdAt), detail: a.payload?.reason }))} />
        </Card>
      </div>
    </div>
  );
}

/** Switching a module off hides it and refuses its routes; its data is kept and comes back when switched on. */
function Modules({ tenantId, features }: { tenantId: string; features: Partial<Features> }) {
  const toggle = useAction((body: Partial<Features>) => patch(`/platform/tenants/${tenantId}/features`, body), {
    invalidate: ['/platform'], success: 'Modules updated',
  });
  return (
    <Card>
      <CardHeader title="Modules" description="Attendance, leave and the employee directory are always on." />
      <div className="space-y-4">
        {MODULES.map((m) => (
          <Switch key={m.key} label={m.label} description={m.description} checked={features[m.key] === true} disabled={toggle.isPending}
            onChange={async (on) => {
              if (!on && !(await confirmAction({
                title: `Switch ${m.label} off?`, tone: 'danger', confirmLabel: `Switch ${m.label} off`,
                message: `${m.label} disappears for everyone in this organisation within a minute, and the mobile app hides it. Nothing is deleted — switching it back on restores everything.`,
              }))) return;
              toggle.mutate({ [m.key]: on });
            }} />
        ))}
      </div>
    </Card>
  );
}

/** Iverto → every org admin, shown once as a "What's new" popup on their next visit. */
export function PlatformAnnouncements() {
  const { data, isLoading } = useApi<PlatformAnnouncement[]>('/platform/announcements');
  const [creating, setCreating] = useState(false);
  const remove = useAction((id: string) => del(`/platform/announcements/${id}`), { invalidate: ['/platform/announcements'], success: 'Announcement withdrawn' });
  return (
    <div className="space-y-6">
      <PageHeader title="Announcements" subtitle="System updates, new features and changelogs for org admins. Each admin sees a popup once, the next time they open Iverto."
        actions={<Button leftIcon={<Plus size={16} />} onClick={() => setCreating(true)}>New announcement</Button>} />
      <Panel>
        {isLoading ? <CenteredSpinner /> : !data?.length ? <EmptyState title="Nothing announced yet" /> : (
          <ul className="divide-y divide-line-soft">
            {data.map((a) => (
              <li key={a.id} className="flex items-start gap-3 p-4">
                <div className="min-w-0 flex-1"><AnnouncementBody a={a} /></div>
                <IconButton label="Withdraw announcement" icon={<Trash2 size={16} />} onClick={async () => {
                  if (await confirmAction({ title: 'Withdraw this announcement?', tone: 'danger', confirmLabel: 'Withdraw', message: "Admins who haven't seen it yet won't. It can't be restored." })) remove.mutate(a.id);
                }} />
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {creating && <NewAnnouncement onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewAnnouncement({ onClose }: { onClose: () => void }) {
  const [f, set] = useForm({ kind: 'FEATURE' as PlatformAnnouncement['kind'], title: '', body: '' });
  const save = useAction(() => post('/platform/announcements', f), { invalidate: ['/platform/announcements'], success: 'Published to every org admin', onSuccess: onClose });
  return (
    <FormModal open size="lg" onClose={onClose} title="New announcement" description="Goes out immediately to the admins of every organisation."
      submitLabel="Publish" saving={save.isPending} onSubmit={() => save.mutate()}>
      <Select label="Type" value={f.kind} onChange={(e) => set('kind')(e.target.value as PlatformAnnouncement['kind'])}
        options={Object.entries(ANNOUNCEMENT_KIND).map(([value, k]) => ({ value, label: k.label }))} />
      <TextField label="Title" required minLength={3} maxLength={140} value={f.title} onChange={(e) => set('title')(e.target.value)} />
      <Textarea label="Message" required rows={8} maxLength={5000} hint="Plain text; line breaks are kept" value={f.body} onChange={(e) => set('body')(e.target.value)} />
      {f.title && f.body && (
        <div className="rounded-lg border border-line-soft bg-surface-subtle p-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Preview</p>
          <AnnouncementBody a={{ id: '', kind: f.kind, title: f.title, body: f.body, publishedAt: new Date().toISOString() }} />
        </div>
      )}
    </FormModal>
  );
}
