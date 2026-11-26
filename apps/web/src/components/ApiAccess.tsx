import { Badge, Button, Callout, Card, CardHeader, CenteredSpinner, Checkbox, confirmAction, CopyField, DataTable, DateInput, EmptyState, IconButton, Modal, PageHeader, Select, Switch, Textarea, TextField } from '@iverto-org/core-ui';
import { BellRing, BookOpen, Ban, History, KeyRound, Pause, Pencil, Play, Plus, RotateCw, Send, Trash2, Webhook } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useEffect, useState } from 'react';
import { del, patch, post, put, useAction, useApi, useCursor, useSites } from '../lib/api';
import { dateTime } from '../lib/format';
import { FormModal, Panel } from './ui';

// ── Shapes (public-api/admin.ts) ────────────────────────────────────────────

interface Permission { id: string; module: string; label: string; methods: string[]; allowed?: boolean; requiresApproval?: boolean }
interface Catalog { apiVersion: string; modules: { id: string; label: string }[]; permissions: Permission[]; operations: { id: string; method: string; path: string; permission: string | null; summary: string }[] }
interface OrgCatalog extends Catalog {
  policy: { enabled: boolean; inherited: boolean; piiAllowed: boolean; maxKeys: number; maxKeyLifetimeDays: number | null; requireIpAllowlist: boolean; keyRateCeiling: number; rateLimit: Limits; credits: { enabled: boolean; monthlyGrant: number; onExhausted: string } };
}
interface Limits { perMinute: number; burst: number; perDay: number; concurrency: number }
export interface Policy {
  enabled: boolean;
  modules: Record<string, string[]>;
  approvalRequired: string[];
  piiAllowed: boolean;
  maxKeys: number;
  maxKeyLifetimeDays: number | null;
  requireIpAllowlist: boolean;
  orgIpAllowlist: string[];
  rateLimit: Limits;
  keyRateCeiling: number;
  credits: { enabled: boolean; monthlyGrant: number; onExhausted: 'block' | 'allow_overage'; costs: Record<string, number> };
  webhooks: { enabled: boolean; maxEndpoints: number };
  bulk: { maxRecordsPerRequest: number; concurrentJobs: number };
  alerts: { enabled: boolean; quotaPct: number; creditPct: number; errorSpikeFactor: number; expiryWarnDays: number; staleWarnDays: number; staleDisableDays: number };
}
interface ApiAlert { id: string; tenantId: string; apiKeyId: string | null; type: string; level: 'warning' | 'critical'; message: string; createdAt: string }
interface PlatformSettings extends Policy { killSwitch: boolean; logRetentionDays: number }
interface ApiKey {
  id: string; tenantId: string; tenantName?: string | null; name: string; description: string | null; purpose: string | null; integratorName: string | null;
  prefix: string; last4: string; status: string; scopes: string[]; effectivePermissions: string[]; restrictedByPolicy: string[];
  siteIds: string[]; ipAllowlist: string[]; rateLimitPerMin: number | null; creditCap: number | null; piiAccess: boolean;
  expiresAt: string | null; expired: boolean; lastUsedAt: string | null; lastUsedIp: string | null; createdAt: string; rotatedFromId: string | null;
  signingPublicKey: string | null; requireSignature: boolean; disabledReason: string | null;
}
interface LogRow { id: string; tenantId: string | null; apiKeyId: string | null; operationId: string | null; method: string; path: string; status: number; errorCode: string | null; latencyMs: number; ip: string | null; credits: number; createdAt: string }

const METHODS = ['GET', 'POST', 'PATCH', 'DELETE'] as const;
const KEY_TONE: Record<string, 'success' | 'warning' | 'neutral' | 'danger'> = { ACTIVE: 'success', PENDING_APPROVAL: 'warning', DISABLED: 'neutral', REVOKED: 'danger' };
const KEY_LABEL: Record<string, string> = { ACTIVE: 'Active', PENDING_APPROVAL: 'Awaiting approval', DISABLED: 'Disabled', REVOKED: 'Revoked' };

function KeyStatus({ k }: { k: ApiKey }) {
  if (k.expired && k.status !== 'REVOKED') return <Badge tone="neutral">Expired</Badge>;
  return <Badge tone={KEY_TONE[k.status] ?? 'neutral'}>{KEY_LABEL[k.status] ?? k.status}</Badge>;
}

const statusTone = (s: number) => (s < 300 ? 'success' : s === 304 ? 'info' : s < 500 ? 'warning' : 'danger');
const lines = (text: string) => text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
const num = (v: string) => (v === '' ? null : Number(v));

function SecretCallout({ secret, onDismiss }: { secret: { key: string; name: string }; onDismiss: () => void }) {
  return (
    <Callout tone="warning" title={`Copy the key for “${secret.name}” now — it won't be shown again`} onDismiss={onDismiss}>
      <CopyField label="API key" value={secret.key} hint="Send it as: Authorization: Bearer <key>. Store it in a secret manager; never in a browser or mobile app." />
    </Callout>
  );
}

// ── Org admin: Settings → API & integrations ────────────────────────────────

export function ApiKeysSection() {
  const navigate = useNavigate();
  const { data: catalog } = useApi<OrgCatalog>('/api-keys/catalog');
  const { data: keys, isLoading } = useApi<ApiKey[]>('/api-keys');
  const [editing, setEditing] = useState<ApiKey | 'new' | null>(null);
  const [secret, setSecret] = useState<{ key: string; name: string } | null>(null);
  const act = useAction(({ id, action, body }: { id: string; action: string; body?: unknown }) => post<{ key?: string; apiKey?: ApiKey }>(`/api-keys/${id}/${action}`, body), {
    invalidate: ['/api-keys'], success: 'Done',
    onSuccess: (r) => r?.key && r.apiKey && setSecret({ key: r.key, name: r.apiKey.name }),
  });
  if (!catalog) return <CenteredSpinner />;
  const p = catalog.policy;
  const live = (keys ?? []).filter((k) => k.status !== 'REVOKED').length;

  return (
    <div className="space-y-6">
      <PageHeader title="API & integrations" subtitle="Keys that let your other systems (payroll, ERP, access control) read and update attendance data. Server-to-server only."
        actions={<>
          <Button variant="secondary" leftIcon={<BookOpen size={16} />} onClick={() => navigate('/developers')}>API reference</Button>
          <Button leftIcon={<Plus size={16} />} disabled={!p.enabled || live >= p.maxKeys} onClick={() => setEditing('new')}>New API key</Button>
        </>} />
      {!p.enabled && <Callout tone="info" title="API access isn't enabled for your organisation">Contact Iverto support to switch it on. Existing keys stop working while it is off.</Callout>}
      {secret && <SecretCallout secret={secret} onDismiss={() => setSecret(null)} />}
      <Card>
        <CardHeader title="Your limits" description={p.inherited ? 'Iverto platform defaults' : 'Set for your organisation by Iverto'} />
        <div className="grid gap-3 text-sm sm:grid-cols-4">
          <Stat label="Keys" value={`${live} / ${p.maxKeys}`} />
          <Stat label="Requests / minute (org)" value={p.rateLimit.perMinute.toLocaleString()} />
          <Stat label="Requests / day (org)" value={p.rateLimit.perDay.toLocaleString()} />
          <Stat label="Max per key / minute" value={p.keyRateCeiling.toLocaleString()} />
        </div>
      </Card>
      <Panel>
        <DataTable rows={keys ?? []} getRowKey={(k) => k.id} loading={isLoading} empty={<EmptyState icon={KeyRound} title="No API keys yet" />}
          columns={[
            { key: 'n', header: 'Key', render: (k) => <div><div className="font-semibold text-fg">{k.name}</div><div className="font-mono text-xs text-fg-subtle">{k.prefix}…{k.last4}</div>{k.integratorName && <div className="text-xs text-fg-muted">{k.integratorName}</div>}</div> },
            { key: 's', header: 'Status', render: (k) => <KeyStatus k={k} /> },
            { key: 'p', header: 'Permissions', render: (k) => <div className="flex max-w-md flex-wrap gap-1">{k.scopes.map((s) => <Badge key={s} tone={k.restrictedByPolicy.includes(s) ? 'danger' : 'neutral'}>{s}{k.restrictedByPolicy.includes(s) ? ' (blocked by platform)' : ''}</Badge>)}{k.piiAccess && <Badge tone="warning">PII</Badge>}</div> },
            { key: 'u', header: 'Last used', render: (k) => k.lastUsedAt ? <div><div>{dateTime(k.lastUsedAt)}</div><div className="font-mono text-xs text-fg-subtle">{k.lastUsedIp}</div></div> : <span className="text-fg-subtle">Never</span> },
            { key: 'e', header: 'Expires', render: (k) => (k.expiresAt ? dateTime(k.expiresAt) : 'Never') },
          ]}
          rowActions={(k) => k.status === 'REVOKED' ? null : (
            <>
              <IconButton label="Edit" icon={<Pencil size={16} />} onClick={() => setEditing(k)} />
              {k.status === 'ACTIVE' && <IconButton label="Rotate secret" icon={<RotateCw size={16} />} onClick={async () => {
                if (await confirmAction({ title: `Rotate “${k.name}”?`, confirmLabel: 'Rotate', message: 'A new key is created with the same permissions. The current key keeps working for 24 hours so you can switch over, then stops.' })) act.mutate({ id: k.id, action: 'rotate', body: { overlapHours: 24 } });
              }} />}
              {k.status === 'DISABLED' && <IconButton label="Re-enable" icon={<Play size={16} />} onClick={() => act.mutate({ id: k.id, action: 'enable' })} />}
              <IconButton label="Revoke" icon={<Ban size={16} />} onClick={async () => {
                if (await confirmAction({ title: `Revoke “${k.name}”?`, tone: 'danger', confirmLabel: 'Revoke key', message: 'Every request with this key fails immediately. This cannot be undone.' })) act.mutate({ id: k.id, action: 'revoke' });
              }} />
            </>
          )} />
      </Panel>
      <WebhooksSection />
      <AlertsCard path="/api-keys/alerts" keys={keys ?? []} />
      <ApiUsage keys={keys ?? []} logsPath="/api-keys/logs" usagePath="/api-keys/usage" />
      {editing && <KeyForm catalog={catalog} current={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onCreated={(s) => { setEditing(null); setSecret(s); }} />}
    </div>
  );
}

const ALERT_LABEL: Record<string, string> = {
  rate_limit: 'Rate limited', quota: 'Daily quota', credits: 'Credits', key_expiring: 'Key expiring', key_stale: 'Unused key', key_disabled: 'Key disabled',
  webhook_failing: 'Webhook failing', error_spike: 'Error spike', auth_anomaly: 'Unusual access',
};

function AlertsCard({ path, keys, tenantNames }: { path: string; keys: ApiKey[]; tenantNames?: Map<string, string> }) {
  const { data: alerts } = useApi<ApiAlert[]>(path);
  return (
    <Panel>
      <div className="p-4"><p className="flex items-center gap-2 text-sm font-semibold text-fg"><BellRing size={16} /> Alerts</p><p className="text-xs text-fg-subtle">Checked every hour. Admins also get them in-app and by email; at most one of each per key per day.</p></div>
      <DataTable rows={alerts ?? []} getRowKey={(a) => a.id} empty={<EmptyState icon={BellRing} title="No alerts" description="Rate limits, quota, credits, expiring or unused keys and error spikes show up here." />}
        columns={[
          { key: 't', header: 'When', render: (a) => dateTime(a.createdAt) },
          ...(tenantNames ? [{ key: 'o', header: 'Organisation', render: (a: ApiAlert) => tenantNames.get(a.tenantId) ?? a.tenantId }] : []),
          { key: 'k', header: 'Alert', render: (a) => <Badge tone={a.level === 'critical' ? 'danger' : 'warning'}>{ALERT_LABEL[a.type] ?? a.type}</Badge> },
          { key: 'm', header: 'Details', render: (a) => <div><div>{a.message}</div>{a.apiKeyId && <div className="text-xs text-fg-subtle">{keys.find((k) => k.id === a.apiKeyId)?.name ?? ''}</div>}</div> },
        ]} />
    </Panel>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-line-soft p-3"><div className="text-xs text-fg-subtle">{label}</div><div className="text-lg font-semibold text-fg">{value}</div></div>;
}

function KeyForm({ catalog, current, onClose, onCreated }: { catalog: OrgCatalog; current: ApiKey | null; onClose: () => void; onCreated: (s: { key: string; name: string }) => void }) {
  const p = catalog.policy;
  const { data: sites } = useSites();
  const [f, setF] = useState({
    name: current?.name ?? '',
    integratorName: current?.integratorName ?? '',
    purpose: current?.purpose ?? '',
    description: current?.description ?? '',
    scopes: current?.scopes ?? [],
    siteIds: current?.siteIds ?? [],
    ipAllowlist: (current?.ipAllowlist ?? []).join('\n'),
    rateLimitPerMin: current?.rateLimitPerMin?.toString() ?? '',
    creditCap: current?.creditCap?.toString() ?? '',
    piiAccess: current?.piiAccess ?? false,
    expiresAt: current?.expiresAt?.slice(0, 10) ?? (p.maxKeyLifetimeDays ? new Date(Date.now() + p.maxKeyLifetimeDays * 86_400_000).toISOString().slice(0, 10) : ''),
    signingPublicKey: current?.signingPublicKey ?? '',
    requireSignature: current?.requireSignature ?? false,
  });
  const set = <K extends keyof typeof f>(k: K) => (v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const toggle = (list: string[], id: string, on: boolean) => (on ? [...new Set([...list, id])] : list.filter((x) => x !== id));
  const body = {
    name: f.name, integratorName: f.integratorName || undefined, purpose: f.purpose || undefined, description: f.description || undefined,
    scopes: f.scopes, siteIds: f.siteIds, ipAllowlist: lines(f.ipAllowlist), rateLimitPerMin: num(f.rateLimitPerMin), creditCap: num(f.creditCap),
    // Start of the chosen day (UTC): the furthest date the picker offers stays inside the lifetime limit.
    piiAccess: f.piiAccess, expiresAt: f.expiresAt ? new Date(`${f.expiresAt}T00:00:00Z`).toISOString() : null,
    signingPublicKey: f.signingPublicKey.trim() || (current?.signingPublicKey ? null : undefined), requireSignature: f.signingPublicKey.trim() ? f.requireSignature : false,
  };
  const save = useAction(() => (current ? patch(`/api-keys/${current.id}`, body) : post<{ key: string; apiKey: ApiKey }>('/api-keys', body)), {
    invalidate: ['/api-keys'], success: current ? 'Key updated' : undefined,
    onSuccess: (r: any) => (current ? onClose() : onCreated({ key: r.key, name: r.apiKey.name })),
  });
  const needsApproval = f.scopes.some((s) => catalog.permissions.find((x) => x.id === s)?.requiresApproval && !current?.scopes.includes(s));
  return (
    <FormModal open size="drawer" onClose={onClose} title={current ? `Edit “${current.name}”` : 'New API key'} submitLabel={current ? 'Save' : 'Create key'} saving={save.isPending} onSubmit={() => save.mutate()}
      description="Grant only what the integration needs. Every request is logged.">
      <TextField label="Name" required minLength={2} maxLength={80} value={f.name} onChange={(e) => set('name')(e.target.value)} hint="e.g. “Payroll sync”" />
      <TextField label="Integrator / vendor" maxLength={120} value={f.integratorName} onChange={(e) => set('integratorName')(e.target.value)} />
      <TextField label="Purpose" maxLength={200} value={f.purpose} onChange={(e) => set('purpose')(e.target.value)} hint="Why this system needs access (kept for your data-protection records)" />
      <div className="space-y-2 border-t border-line-soft pt-4">
        <p className="text-sm font-semibold text-fg">Permissions</p>
        {catalog.modules.map((m) => {
          const perms = catalog.permissions.filter((x) => x.module === m.id);
          return (
            <div key={m.id} className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">{m.label}</p>
              {perms.map((x) => (
                <Checkbox key={x.id} label={<span>{x.label} <span className="font-mono text-xs text-fg-subtle">{x.id}</span></span>} disabled={!x.allowed}
                  description={!x.allowed ? 'Not allowed for your organisation' : x.requiresApproval ? 'Needs Iverto approval before the key works' : undefined}
                  checked={f.scopes.includes(x.id)} onChange={(e) => set('scopes')(toggle(f.scopes, x.id, e.target.checked))} />
              ))}
            </div>
          );
        })}
        {needsApproval && <Callout tone="warning" title="This key will wait for Iverto approval">It won't work until approved{current ? '; until then the key stops working' : ''}.</Callout>}
      </div>
      <div className="space-y-2 border-t border-line-soft pt-4">
        <p className="text-sm font-semibold text-fg">Sites <span className="font-normal text-fg-subtle">— none ticked = all sites</span></p>
        {(sites ?? []).map((s) => <Checkbox key={s.id} label={s.name} checked={f.siteIds.includes(s.id)} onChange={(e) => set('siteIds')(toggle(f.siteIds, s.id, e.target.checked))} />)}
      </div>
      <Textarea label="Allowed IP addresses" rows={3} value={f.ipAllowlist} onChange={(e) => set('ipAllowlist')(e.target.value)}
        hint={`One address or CIDR range per line (e.g. 203.0.113.10 or 10.0.0.0/8).${p.requireIpAllowlist ? ' Required by your organisation.' : ' Empty = any address.'}`} required={p.requireIpAllowlist} />
      <TextField label="Rate limit (requests / minute)" type="number" min={1} max={p.keyRateCeiling} value={f.rateLimitPerMin} onChange={(e) => set('rateLimitPerMin')(e.target.value)} hint={`Empty = ${p.keyRateCeiling}, the most your organisation allows per key`} />
      {p.credits.enabled && <TextField label="Monthly credit cap" type="number" min={0} value={f.creditCap} onChange={(e) => set('creditCap')(e.target.value)} hint="Empty = no cap beyond the organisation's credits" />}
      {p.piiAllowed && <Checkbox label="Personal data (PII)" description="Date of birth, addresses, PAN, UAN, ESIC and bank details on employee records" checked={f.piiAccess} onChange={(e) => set('piiAccess')(e.target.checked)} />}
      <DateInput label="Expires on" value={f.expiresAt} required={!!p.maxKeyLifetimeDays} onChange={(e) => set('expiresAt')(e.target.value)} hint={p.maxKeyLifetimeDays ? `At most ${p.maxKeyLifetimeDays} days from today` : 'Empty = never'} />
      <div className="space-y-2 border-t border-line-soft pt-4">
        <p className="text-sm font-semibold text-fg">Request signing <span className="font-normal text-fg-subtle">(optional)</span></p>
        <Textarea label="Ed25519 public key" rows={2} value={f.signingPublicKey} onChange={(e) => set('signingPublicKey')(e.target.value)}
          hint="Base64 of the 32-byte public key, or PEM. The integrator keeps the private key and signs each request (API reference, Request signing). Empty = no signing key." />
        {f.signingPublicKey.trim() && <Checkbox label="Refuse unsigned requests" description="Every request must carry a valid Iverto-Signature; a stolen key alone is then useless" checked={f.requireSignature} onChange={(e) => set('requireSignature')(e.target.checked)} />}
      </div>
    </FormModal>
  );
}

// ── Org admin: webhooks (public-api/webhooks.ts) ────────────────────────────

interface Endpoint {
  id: string; tenantId: string; url: string; description: string | null; events: string[]; status: string; disabledReason: string | null;
  failingSince: string | null; previousSecretActive: boolean; createdAt: string;
}
interface WebhookList { policy: { enabled: boolean; maxEndpoints: number }; events: { type: string; label: string; permission: string; allowed: boolean }[]; endpoints: Endpoint[] }
interface Delivery {
  id: string; eventId: string; status: string; attempts: number; nextAttemptAt: string; responseStatus: number | null; responseSnippet: string | null;
  latencyMs: number | null; error: string | null; deliveredAt: string | null; createdAt: string; event: { type: string; createdAt: string };
}
const DELIVERY_TONE: Record<string, 'success' | 'warning' | 'danger'> = { SUCCEEDED: 'success', PENDING: 'warning', FAILED: 'danger' };

function EndpointStatus({ e }: { e: Endpoint }) {
  if (e.status === 'DISABLED') return <div><Badge tone="neutral">Disabled</Badge>{e.disabledReason && <div className="mt-1 text-xs text-fg-muted">{e.disabledReason}</div>}</div>;
  if (e.failingSince) return <div><Badge tone="danger">Failing</Badge><div className="mt-1 text-xs text-fg-muted">since {dateTime(e.failingSince)}</div></div>;
  return <Badge tone="success">Active</Badge>;
}

function WebhooksSection() {
  const { data, isLoading } = useApi<WebhookList>('/api-webhooks');
  const [editing, setEditing] = useState<Endpoint | 'new' | null>(null);
  const [viewing, setViewing] = useState<Endpoint | null>(null);
  const [secret, setSecret] = useState<{ secret: string; url: string } | null>(null);
  const act = useAction(({ id, action }: { id: string; action: string }) => post<{ secret?: string; endpoint?: Endpoint }>(`/api-webhooks/${id}/${action}`), {
    invalidate: ['/api-webhooks'], success: (r) => (r?.secret ? 'Secret rotated' : 'Test event sent'),
    onSuccess: (r) => r?.secret && r.endpoint && setSecret({ secret: r.secret, url: r.endpoint.url }),
  });
  const toggle = useAction(({ id, enabled }: { id: string; enabled: boolean }) => patch(`/api-webhooks/${id}`, { enabled }), { invalidate: ['/api-webhooks'], success: 'Done' });
  const remove = useAction((id: string) => del(`/api-webhooks/${id}`), { invalidate: ['/api-webhooks'], success: 'Endpoint deleted' });
  if (!data) return isLoading ? <Card><CenteredSpinner /></Card> : null;
  const full = data.endpoints.length >= data.policy.maxEndpoints;
  return (
    <Card>
      <CardHeader title="Webhooks" description="We POST an event to your server when something changes, signed per the Standard Webhooks spec. Failed deliveries are retried for about 2 days."
        action={<Button size="sm" leftIcon={<Plus size={16} />} disabled={!data.policy.enabled || full} onClick={() => setEditing('new')}>Add endpoint</Button>} />
      {!data.policy.enabled && <Callout tone="info" title="Webhooks aren't enabled for your organisation">Contact Iverto support to switch them on.</Callout>}
      {secret && (
        <Callout tone="warning" title="Copy the signing secret now — it won't be shown again" onDismiss={() => setSecret(null)}>
          <CopyField label={`Signing secret for ${secret.url}`} value={secret.secret} hint="Verify the webhook-signature header with it (any Standard Webhooks library). After a rotation the old secret also signs for 24 hours." />
        </Callout>
      )}
      <DataTable rows={data.endpoints} getRowKey={(e) => e.id} loading={isLoading} empty={<EmptyState icon={Webhook} title="No endpoints yet" />}
        columns={[
          { key: 'u', header: 'Endpoint', render: (e) => <div><div className="break-all font-mono text-xs text-fg">{e.url}</div>{e.description && <div className="text-xs text-fg-muted">{e.description}</div>}</div> },
          { key: 's', header: 'Status', render: (e) => <EndpointStatus e={e} /> },
          { key: 'e', header: 'Events', render: (e) => <div className="flex max-w-md flex-wrap gap-1">{e.events.map((t) => <Badge key={t} tone={data.events.find((x) => x.type === t)?.allowed ? 'neutral' : 'danger'}>{t}</Badge>)}</div> },
        ]}
        rowActions={(e) => (
          <>
            <IconButton label="Deliveries" icon={<History size={16} />} onClick={() => setViewing(e)} />
            <IconButton label="Edit" icon={<Pencil size={16} />} onClick={() => setEditing(e)} />
            {e.status === 'ACTIVE' && <IconButton label="Send test event" icon={<Send size={16} />} onClick={() => act.mutate({ id: e.id, action: 'test' })} />}
            <IconButton label="Rotate secret" icon={<RotateCw size={16} />} onClick={async () => {
              if (await confirmAction({ title: 'Rotate the signing secret?', confirmLabel: 'Rotate', message: 'The new secret signs from now on. The old one also signs for 24 hours so you can switch over.' })) act.mutate({ id: e.id, action: 'rotate-secret' });
            }} />
            {e.status === 'ACTIVE'
              ? <IconButton label="Disable" icon={<Pause size={16} />} onClick={() => toggle.mutate({ id: e.id, enabled: false })} />
              : <IconButton label="Re-enable" icon={<Play size={16} />} onClick={() => toggle.mutate({ id: e.id, enabled: true })} />}
            <IconButton label="Delete" icon={<Trash2 size={16} />} onClick={async () => {
              if (await confirmAction({ title: 'Delete this endpoint?', tone: 'danger', confirmLabel: 'Delete', message: `${e.url} stops receiving events and its delivery history is removed.` })) remove.mutate(e.id);
            }} />
          </>
        )} />
      {editing && <EndpointForm list={data} current={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onCreated={(s) => { setEditing(null); setSecret(s); }} />}
      {viewing && <Deliveries endpoint={viewing} onClose={() => setViewing(null)} />}
    </Card>
  );
}

function EndpointForm({ list, current, onClose, onCreated }: { list: WebhookList; current: Endpoint | null; onClose: () => void; onCreated: (s: { secret: string; url: string }) => void }) {
  const [f, setF] = useState({ url: current?.url ?? '', description: current?.description ?? '', events: current?.events ?? [] });
  const body = { url: f.url, description: f.description || undefined, events: f.events };
  const save = useAction(() => (current ? patch(`/api-webhooks/${current.id}`, body) : post<{ secret: string; endpoint: Endpoint }>('/api-webhooks', body)), {
    invalidate: ['/api-webhooks'], success: current ? 'Endpoint updated' : undefined,
    onSuccess: (r: any) => (current ? onClose() : onCreated({ secret: r.secret, url: r.endpoint.url })),
  });
  return (
    <FormModal open size="drawer" onClose={onClose} title={current ? 'Edit endpoint' : 'Add endpoint'} submitLabel={current ? 'Save' : 'Add endpoint'} saving={save.isPending} onSubmit={() => save.mutate()}
      description="Events carry ids only; fetch the full record with an API key.">
      <TextField label="URL" type="url" required maxLength={2000} value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} hint="Public https:// address. Answer with a 2xx within 10 seconds." />
      <TextField label="Description" maxLength={500} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      <div className="space-y-2 border-t border-line-soft pt-4">
        <p className="text-sm font-semibold text-fg">Events</p>
        {list.events.map((ev) => (
          <Checkbox key={ev.type} label={<span className="font-mono text-xs">{ev.type}</span>} disabled={!ev.allowed && !f.events.includes(ev.type)}
            description={ev.allowed ? ev.label : 'Not allowed for your organisation'} checked={f.events.includes(ev.type)}
            onChange={(e) => setF({ ...f, events: e.target.checked ? [...f.events, ev.type] : f.events.filter((t) => t !== ev.type) })} />
        ))}
      </div>
    </FormModal>
  );
}

const REPLAY_WINDOWS = [{ value: '1', label: 'Last hour' }, { value: '24', label: 'Last 24 hours' }, { value: '72', label: 'Last 3 days' }, { value: '168', label: 'Last 7 days' }, { value: '720', label: 'Last 30 days' }];

function Deliveries({ endpoint, onClose }: { endpoint: Endpoint; onClose: () => void }) {
  const [status, setStatus] = useState('');
  const [hours, setHours] = useState('24');
  const rows = useCursor<Delivery>(`/api-webhooks/${endpoint.id}/deliveries`, { status: status || undefined, limit: 50 });
  const retry = useAction((id: string) => post(`/api-webhooks/deliveries/${id}/retry`), { invalidate: ['/api-webhooks'], success: 'Queued for delivery' });
  const replay = useAction(() => post<{ queued: number }>(`/api-webhooks/${endpoint.id}/replay`, { since: new Date(Date.now() - Number(hours) * 3_600_000).toISOString() }), {
    invalidate: ['/api-webhooks'], success: (r) => `${r.queued} event${r.queued === 1 ? '' : 's'} queued`,
  });
  return (
    <Modal open size="drawer" onClose={onClose} title="Deliveries" description={endpoint.url}>
      <div className="space-y-4 p-5 sm:p-6">
        <div className="flex flex-wrap items-end gap-3">
          <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}
            options={[{ value: '', label: 'All' }, { value: 'SUCCEEDED', label: 'Delivered' }, { value: 'PENDING', label: 'Retrying' }, { value: 'FAILED', label: 'Failed' }]} />
          <Select label="Replay" value={hours} onChange={(e) => setHours(e.target.value)} options={REPLAY_WINDOWS} />
          <Button variant="secondary" loading={replay.isPending} onClick={async () => {
            if (await confirmAction({ title: 'Replay events?', confirmLabel: 'Replay', message: 'Every subscribed event in that window is sent again with its original webhook-id, so your server can skip duplicates.' })) replay.mutate();
          }}>Replay</Button>
        </div>
        <DataTable rows={rows.rows} getRowKey={(d) => d.id} loading={rows.isLoading} empty={<EmptyState title="No deliveries" />}
          columns={[
            { key: 't', header: 'Event', render: (d) => <div><div className="font-mono text-xs text-fg">{d.event.type}</div><div className="text-xs text-fg-subtle">{dateTime(d.event.createdAt)}</div></div> },
            { key: 's', header: 'Result', render: (d) => (
              <div>
                <div className="flex items-center gap-2"><Badge tone={DELIVERY_TONE[d.status] ?? 'neutral'}>{d.status === 'PENDING' ? `Retrying (${d.attempts})` : d.status === 'SUCCEEDED' ? 'Delivered' : 'Failed'}</Badge>{d.responseStatus && <span className="font-mono text-xs">{d.responseStatus}</span>}{d.latencyMs !== null && <span className="text-xs text-fg-subtle">{d.latencyMs} ms</span>}</div>
                {(d.error || (d.status !== 'SUCCEEDED' && d.responseSnippet)) && <div className="mt-1 max-w-sm truncate text-xs text-fg-muted" title={d.error ?? d.responseSnippet ?? ''}>{d.error ?? d.responseSnippet}</div>}
                {d.status === 'PENDING' && d.attempts > 0 && <div className="text-xs text-fg-subtle">Next try {dateTime(d.nextAttemptAt)}</div>}
              </div>
            ) },
          ]}
          rowActions={(d) => d.status !== 'PENDING' && <IconButton label="Send again" icon={<RotateCw size={16} />} onClick={() => retry.mutate(d.id)} />} />
        {rows.hasNextPage && <div className="flex justify-center"><Button variant="secondary" loading={rows.isFetchingNextPage} onClick={() => rows.fetchNextPage()}>Load more</Button></div>}
      </div>
    </Modal>
  );
}

/** Usage summary + request log, shared by the org page and the platform page. */
export function ApiUsage({ keys, logsPath, usagePath, params = {} }: { keys: ApiKey[]; logsPath: string; usagePath?: string; params?: Record<string, string | undefined> }) {
  const [errorsOnly, setErrorsOnly] = useState(false);
  const usage = useApi<{ byKey: { apiKeyId: string | null; requests: number; errors: number; rateLimited: number; credits: number }[]; credits: { enabled: boolean; allowance?: number; spent?: number } }>(usagePath ?? null, { days: 7 });
  const logs = useCursor<LogRow>(logsPath, { ...params, errorsOnly: errorsOnly || undefined, limit: 50 });
  const name = (id: string | null) => keys.find((k) => k.id === id)?.name ?? (id ? id.slice(0, 8) : 'Unknown key');
  const total = usage.data?.byKey.reduce((s, k) => ({ requests: s.requests + k.requests, errors: s.errors + k.errors, limited: s.limited + k.rateLimited }), { requests: 0, errors: 0, limited: 0 });
  return (
    <Card>
      <CardHeader title="Requests" description="Every call with an API key, newest first" action={<Switch label="Errors only" checked={errorsOnly} onChange={setErrorsOnly} />} />
      {total && (
        <div className="mb-4 grid gap-3 text-sm sm:grid-cols-4">
          <Stat label="Last 7 days" value={total.requests.toLocaleString()} />
          <Stat label="Errors" value={total.errors.toLocaleString()} />
          <Stat label="Rate limited" value={total.limited.toLocaleString()} />
          {usage.data?.credits.enabled && <Stat label="Credits this month" value={`${usage.data.credits.spent?.toLocaleString()} / ${usage.data.credits.allowance?.toLocaleString()}`} />}
        </div>
      )}
      <DataTable rows={logs.rows} getRowKey={(l) => l.id} loading={logs.isLoading} empty={<EmptyState title="No requests yet" />}
        columns={[
          { key: 't', header: 'Time', render: (l) => dateTime(l.createdAt) },
          { key: 'k', header: 'Key', render: (l) => (l.apiKeyId ? name(l.apiKeyId) : <span className="text-fg-subtle">Rejected key</span>) },
          { key: 'r', header: 'Request', render: (l) => <span className="font-mono text-xs">{l.method} {l.path.replace(/^\/v1\/public/, '')}</span> },
          { key: 's', header: 'Status', render: (l) => <div className="flex items-center gap-2"><Badge tone={statusTone(l.status)}>{l.status}</Badge>{l.errorCode && <span className="font-mono text-xs text-fg-muted">{l.errorCode}</span>}</div> },
          { key: 'l', header: 'Latency', align: 'right', render: (l) => `${l.latencyMs} ms` },
          { key: 'i', header: 'IP', render: (l) => <span className="font-mono text-xs">{l.ip}</span> },
        ]} />
      {logs.hasNextPage && <div className="mt-3 flex justify-center"><Button variant="secondary" loading={logs.isFetchingNextPage} onClick={() => logs.fetchNextPage()}>Load more</Button></div>}
    </Card>
  );
}

// ── Superadmin: policy editor ───────────────────────────────────────────────

function PolicyEditor({ value, onChange, catalog }: { value: Policy; onChange: (p: Policy) => void; catalog: Catalog }) {
  const set = <K extends keyof Policy>(k: K, v: Policy[K]) => onChange({ ...value, [k]: v });
  const setMethod = (mod: string, m: string, on: boolean) => {
    const cur = value.modules[mod] ?? [];
    set('modules', { ...value.modules, [mod]: on ? [...new Set([...cur, m])] : cur.filter((x) => x !== m) });
  };
  const n = (v: string) => Math.max(0, Number(v) || 0);
  return (
    <div className="space-y-5">
      <Switch label="API access enabled" description="Off = every key of this organisation is refused; keys are kept" checked={value.enabled} onChange={(v) => set('enabled', v)} />
      <div>
        <p className="mb-2 text-sm font-semibold text-fg">Allowed requests per module</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-fg-subtle"><th className="py-1 pr-4">Module</th>{METHODS.map((m) => <th key={m} className="px-2 py-1 font-mono">{m}</th>)}</tr></thead>
            <tbody>
              {catalog.modules.map((mod) => {
                const used = new Set(catalog.permissions.filter((p) => p.module === mod.id).flatMap((p) => p.methods));
                return (
                  <tr key={mod.id} className="border-t border-line-soft">
                    <td className="py-2 pr-4">{mod.label}</td>
                    {METHODS.map((m) => (
                      <td key={m} className="px-2 py-2">
                        <input type="checkbox" aria-label={`${mod.label} ${m}`} className="accent-[var(--color-brand,#cd0447)]" checked={value.modules[mod.id]?.includes(m) ?? false}
                          disabled={!used.has(m)} title={used.has(m) ? undefined : 'No operations use this method yet'} onChange={(e) => setMethod(mod.id, m, e.target.checked)} />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div>
        <p className="mb-2 text-sm font-semibold text-fg">Permissions that need platform approval</p>
        <div className="grid gap-1 sm:grid-cols-2">
          {catalog.permissions.map((p) => (
            <Checkbox key={p.id} label={<span className="font-mono text-xs">{p.id}</span>} description={p.label} checked={value.approvalRequired.includes(p.id)}
              onChange={(e) => set('approvalRequired', e.target.checked ? [...value.approvalRequired, p.id] : value.approvalRequired.filter((x) => x !== p.id))} />
          ))}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Checkbox label="Allow personal data (PII)" checked={value.piiAllowed} onChange={(e) => set('piiAllowed', e.target.checked)} />
        <Checkbox label="Require an IP allowlist on every key" checked={value.requireIpAllowlist} onChange={(e) => set('requireIpAllowlist', e.target.checked)} />
        <TextField label="Max keys" type="number" min={0} value={String(value.maxKeys)} onChange={(e) => set('maxKeys', n(e.target.value))} />
        <TextField label="Max key lifetime (days)" type="number" min={1} value={value.maxKeyLifetimeDays?.toString() ?? ''} hint="Empty = keys may never expire" onChange={(e) => set('maxKeyLifetimeDays', e.target.value ? n(e.target.value) : null)} />
        <TextField label="Org requests / minute" type="number" min={1} value={String(value.rateLimit.perMinute)} onChange={(e) => set('rateLimit', { ...value.rateLimit, perMinute: n(e.target.value) })} />
        <TextField label="Org burst" type="number" min={1} value={String(value.rateLimit.burst)} hint="Bucket size; ≤ 10× per minute" onChange={(e) => set('rateLimit', { ...value.rateLimit, burst: n(e.target.value) })} />
        <TextField label="Org requests / day" type="number" min={1} value={String(value.rateLimit.perDay)} onChange={(e) => set('rateLimit', { ...value.rateLimit, perDay: n(e.target.value) })} />
        <TextField label="Concurrent requests" type="number" min={1} value={String(value.rateLimit.concurrency)} onChange={(e) => set('rateLimit', { ...value.rateLimit, concurrency: n(e.target.value) })} />
        <TextField label="Max per key / minute" type="number" min={1} value={String(value.keyRateCeiling)} onChange={(e) => set('keyRateCeiling', n(e.target.value))} />
        <TextField label="Bulk: records per request" type="number" min={1} max={5000} value={String(value.bulk.maxRecordsPerRequest)} hint="POST /employees/bulk, 1–5,000" onChange={(e) => set('bulk', { ...value.bulk, maxRecordsPerRequest: Math.min(5000, Math.max(1, n(e.target.value))) })} />
        <TextField label="Bulk: jobs at a time" type="number" min={1} max={10} value={String(value.bulk.concurrentJobs)} onChange={(e) => set('bulk', { ...value.bulk, concurrentJobs: Math.min(10, Math.max(1, n(e.target.value))) })} />
      </div>
      <Textarea label="Organisation IP allowlist" rows={2} value={value.orgIpAllowlist.join('\n')} hint="Every key must also match one of these. Empty = no org-wide restriction." onChange={(e) => set('orgIpAllowlist', lines(e.target.value))} />
      <div className="grid gap-4 border-t border-line-soft pt-4 sm:grid-cols-2">
        <Switch label="Webhooks" description="Org admins may add endpoints for the events their allowed modules cover" checked={value.webhooks.enabled} onChange={(v) => set('webhooks', { ...value.webhooks, enabled: v })} />
        {value.webhooks.enabled && <TextField label="Max endpoints" type="number" min={0} max={100} value={String(value.webhooks.maxEndpoints)} onChange={(e) => set('webhooks', { ...value.webhooks, maxEndpoints: Math.min(100, n(e.target.value)) })} />}
      </div>
      <div className="space-y-3 border-t border-line-soft pt-4">
        <Switch label="Usage alerts and key hygiene" description="Hourly: rate limits, quota, credits, expiring and unused keys, failing webhooks, error spikes, unusual access" checked={value.alerts.enabled} onChange={(v) => set('alerts', { ...value.alerts, enabled: v })} />
        {value.alerts.enabled && (
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField label="Quota alert at (%)" type="number" min={1} max={100} value={String(value.alerts.quotaPct)} onChange={(e) => set('alerts', { ...value.alerts, quotaPct: Math.min(100, Math.max(1, n(e.target.value))) })} />
            <TextField label="Credits alert at (%)" type="number" min={1} max={100} value={String(value.alerts.creditPct)} onChange={(e) => set('alerts', { ...value.alerts, creditPct: Math.min(100, Math.max(1, n(e.target.value))) })} />
            <TextField label="Error spike (x usual rate)" type="number" min={2} max={100} value={String(value.alerts.errorSpikeFactor)} onChange={(e) => set('alerts', { ...value.alerts, errorSpikeFactor: Math.max(2, n(e.target.value)) })} />
            <TextField label="Warn before key expiry (days)" type="number" min={1} max={90} value={String(value.alerts.expiryWarnDays)} onChange={(e) => set('alerts', { ...value.alerts, expiryWarnDays: Math.max(1, n(e.target.value)) })} />
            <TextField label="Warn when unused for (days)" type="number" min={1} value={String(value.alerts.staleWarnDays)} onChange={(e) => set('alerts', { ...value.alerts, staleWarnDays: Math.max(1, n(e.target.value)) })} />
            <TextField label="Disable when unused for (days)" type="number" min={0} value={String(value.alerts.staleDisableDays)} hint="0 = never; admins can re-enable" onChange={(e) => set('alerts', { ...value.alerts, staleDisableDays: n(e.target.value) })} />
          </div>
        )}
      </div>
      <div className="space-y-3 border-t border-line-soft pt-4">
        <Switch label="Credits" description="Each request spends credits (default 1); the org gets a monthly grant plus top-ups" checked={value.credits.enabled} onChange={(v) => set('credits', { ...value.credits, enabled: v })} />
        {value.credits.enabled && (
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Monthly grant" type="number" min={0} value={String(value.credits.monthlyGrant)} onChange={(e) => set('credits', { ...value.credits, monthlyGrant: n(e.target.value) })} />
            <Select label="When credits run out" value={value.credits.onExhausted} onChange={(e) => set('credits', { ...value.credits, onExhausted: e.target.value as 'block' | 'allow_overage' })}
              options={[{ value: 'block', label: 'Refuse requests (402)' }, { value: 'allow_overage', label: 'Allow and record overage' }]} />
          </div>
        )}
      </div>
    </div>
  );
}

function KeysAdminTable({ params, showTenant }: { params: Record<string, string>; showTenant?: boolean }) {
  const { data, isLoading } = useApi<ApiKey[]>('/platform/api/keys', params);
  const act = useAction(({ id, action }: { id: string; action: string }) => post(`/platform/api/keys/${id}/${action}`), { invalidate: ['/platform/api'], success: 'Done' });
  return (
    <DataTable rows={data ?? []} getRowKey={(k) => k.id} loading={isLoading} empty={<EmptyState title="No keys" />}
      columns={[
        ...(showTenant ? [{ key: 'o', header: 'Organisation', render: (k: ApiKey) => k.tenantName ?? k.tenantId }] : []),
        { key: 'n', header: 'Key', render: (k) => <div><div className="font-semibold text-fg">{k.name}</div><div className="font-mono text-xs text-fg-subtle">{k.prefix}…{k.last4}</div>{k.purpose && <div className="text-xs text-fg-muted">{k.purpose}</div>}</div> },
        { key: 's', header: 'Status', render: (k) => <KeyStatus k={k} /> },
        { key: 'p', header: 'Permissions', render: (k) => <div className="flex flex-wrap gap-1">{k.scopes.map((s) => <Badge key={s} tone="neutral">{s}</Badge>)}{k.piiAccess && <Badge tone="warning">PII</Badge>}</div> },
        { key: 'u', header: 'Last used', render: (k) => dateTime(k.lastUsedAt) },
      ]}
      rowActions={(k) => (
        <>
          {k.status === 'PENDING_APPROVAL' && <Button size="sm" onClick={() => act.mutate({ id: k.id, action: 'approve' })}>Approve</Button>}
          {k.status === 'PENDING_APPROVAL' && <Button size="sm" variant="secondary" onClick={() => act.mutate({ id: k.id, action: 'reject' })}>Reject</Button>}
          {k.status !== 'REVOKED' && k.status !== 'PENDING_APPROVAL' && <IconButton label="Revoke" icon={<Ban size={16} />} onClick={async () => {
            if (await confirmAction({ title: `Revoke “${k.name}”?`, tone: 'danger', confirmLabel: 'Revoke', message: 'Requests with this key fail immediately. The organisation is not notified automatically.' })) act.mutate({ id: k.id, action: 'revoke' });
          }} />}
        </>
      )} />
  );
}

/** Platform → tenant → API access. */
export function TenantApiCard({ tenantId }: { tenantId: string }) {
  const { data: catalog } = useApi<Catalog>('/platform/api/catalog');
  const { data } = useApi<{ policy: Policy; inherited: boolean; version: number | null; versions: { version: number; note: string | null; createdAt: string; policy: Policy | null }[]; keys: Record<string, number> }>(`/platform/api/tenants/${tenantId}/policy`);
  const credits = useApi<{ enabled: boolean; month: string; allowance: number; spent: number }>(`/platform/api/tenants/${tenantId}/credits`);
  const [draft, setDraft] = useState<Policy | null>(null);
  const [topup, setTopup] = useState('');
  useEffect(() => { if (data) setDraft(data.policy); }, [data]);
  const inv = ['/platform/api'];
  const save = useAction(async (p: Policy) => {
    const { affectedKeys } = await post<{ affectedKeys: { name: string; restricted: string[] }[] }>(`/platform/api/tenants/${tenantId}/policy/preview`, { policy: p });
    if (affectedKeys.length && !(await confirmAction({
      title: `This restricts ${affectedKeys.length} key${affectedKeys.length === 1 ? '' : 's'}`, confirmLabel: 'Save anyway', tone: 'danger',
      message: affectedKeys.map((k) => `${k.name}: ${k.restricted.join(', ') || 'API switched off'}`).join('\n'),
    }))) return null;
    return put(`/platform/api/tenants/${tenantId}/policy`, { policy: p });
  }, { invalidate: inv, success: (r) => (r ? 'Policy saved; applies within seconds' : 'Not saved') });
  const inherit = useAction(() => del(`/platform/api/tenants/${tenantId}/policy`), { invalidate: inv, success: 'Back on the platform default' });
  const rollback = useAction((version: number) => post(`/platform/api/tenants/${tenantId}/policy/rollback`, { version }), { invalidate: inv, success: 'Rolled back' });
  const revokeAll = useAction(() => post<{ revoked: number }>(`/platform/api/tenants/${tenantId}/revoke-all`), { invalidate: inv, success: (r) => `${r.revoked} keys revoked` });
  const addCredits = useAction(() => post(`/platform/api/tenants/${tenantId}/credits`, { amount: Number(topup) }), { invalidate: inv, success: 'Credits updated', onSuccess: () => setTopup('') });
  if (!catalog || !data || !draft) return <Card><CenteredSpinner /></Card>;
  return (
    <Card className="lg:col-span-2">
      <CardHeader title="Developer API" description={data.inherited ? 'Using the platform default policy' : `Custom policy, version ${data.version}`}
        action={<Button variant="danger" size="sm" onClick={async () => {
          if (await confirmAction({ title: 'Revoke every API key of this organisation?', tone: 'danger', confirmLabel: 'Revoke all', message: 'Use when a key has leaked. Integrations stop at once; the org admin must create new keys.' })) revokeAll.mutate();
        }}>Revoke all keys</Button>} />
      <div className="mb-4 flex flex-wrap gap-2 text-sm">{Object.entries(data.keys).map(([s, c]) => <Badge key={s} tone={KEY_TONE[s] ?? 'neutral'}>{c} {KEY_LABEL[s] ?? s}</Badge>)}</div>
      <PolicyEditor value={draft} onChange={setDraft} catalog={catalog} />
      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line-soft pt-4">
        <Button loading={save.isPending} onClick={() => save.mutate(draft)}>Save policy</Button>
        {!data.inherited && <Button variant="secondary" loading={inherit.isPending} onClick={() => inherit.mutate()}>Use platform default</Button>}
        {data.versions.length > 1 && (
          <Select label="Roll back to" value="" onChange={(e) => e.target.value && rollback.mutate(Number(e.target.value))}
            options={[{ value: '', label: 'Choose a version…' }, ...data.versions.map((v) => ({ value: String(v.version), label: `v${v.version} · ${dateTime(v.createdAt)}${v.policy ? '' : ' (default)'}${v.note ? ` · ${v.note}` : ''}` }))]} />
        )}
      </div>
      {draft.credits.enabled && credits.data && (
        <div className="mt-5 flex flex-wrap items-end gap-3 border-t border-line-soft pt-4">
          <Stat label={`Credits ${credits.data.month}`} value={`${credits.data.spent.toLocaleString()} / ${credits.data.allowance.toLocaleString()}`} />
          <TextField label="Add credits this month" type="number" value={topup} onChange={(e) => setTopup(e.target.value)} hint="Negative to take back" />
          <Button variant="secondary" disabled={!topup || Number(topup) === 0} loading={addCredits.isPending} onClick={() => addCredits.mutate()}>Apply</Button>
        </div>
      )}
      <div className="mt-5 border-t border-line-soft pt-4">
        <p className="mb-2 text-sm font-semibold text-fg">Keys</p>
        <KeysAdminTable params={{ tenantId }} />
      </div>
      <div className="mt-5 border-t border-line-soft pt-4">
        <p className="mb-2 text-sm font-semibold text-fg">Webhook endpoints</p>
        <TenantWebhooks tenantId={tenantId} />
      </div>
    </Card>
  );
}

function TenantWebhooks({ tenantId }: { tenantId: string }) {
  const { data, isLoading } = useApi<Endpoint[]>(`/platform/api/tenants/${tenantId}/webhooks`);
  const disable = useAction((id: string) => post(`/platform/api/webhooks/${id}/disable`), { invalidate: ['/platform/api'], success: 'Endpoint disabled' });
  return (
    <DataTable rows={data ?? []} getRowKey={(e) => e.id} loading={isLoading} empty={<EmptyState title="No endpoints" />}
      columns={[
        { key: 'u', header: 'URL', render: (e) => <span className="break-all font-mono text-xs">{e.url}</span> },
        { key: 's', header: 'Status', render: (e) => <EndpointStatus e={e} /> },
        { key: 'e', header: 'Events', render: (e) => <div className="flex flex-wrap gap-1">{e.events.map((t) => <Badge key={t} tone="neutral">{t}</Badge>)}</div> },
      ]}
      rowActions={(e) => e.status === 'ACTIVE' && <IconButton label="Disable" icon={<Ban size={16} />} onClick={async () => {
        if (await confirmAction({ title: 'Disable this endpoint?', tone: 'danger', confirmLabel: 'Disable', message: 'Deliveries stop. The organisation sees “Disabled by Iverto” and can re-enable it.' })) disable.mutate(e.id);
      }} />} />
  );
}

/** Platform → Developer API: kill switch, defaults, approvals, all requests. */
export function PlatformApi() {
  const navigate = useNavigate();
  const { data: tenants } = useApi<{ id: string; name: string }[]>('/platform/tenants');
  const { data: catalog } = useApi<Catalog>('/platform/api/catalog');
  const { data: overview } = useApi<{ pendingApprovals: number; rejectedRequests24h: number; tenants: { tenantId: string; requests24h: number }[]; settings: PlatformSettings }>('/platform/api/overview');
  const [draft, setDraft] = useState<PlatformSettings | null>(null);
  useEffect(() => { if (overview) setDraft(overview.settings); }, [overview]);
  const save = useAction((s: PlatformSettings) => put('/platform/api/settings', { settings: s }), { invalidate: ['/platform/api'], success: 'Platform API settings saved' });
  if (!catalog || !overview || !draft) return <CenteredSpinner />;
  const requests = overview.tenants.reduce((s, t) => s + t.requests24h, 0);
  return (
    <div className="space-y-6">
      <PageHeader title="Developer API" subtitle={`Public API ${catalog.apiVersion} · ${catalog.operations.length} operations`}
        actions={<Button variant="secondary" leftIcon={<BookOpen size={16} />} onClick={() => navigate('/platform/developers')}>API reference</Button>} />
      {draft.killSwitch && <Callout tone="danger" title="Kill switch is on">Every API request from every organisation is refused with 503.</Callout>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Requests (24 h)" value={requests.toLocaleString()} />
        <Stat label="Rejected keys (24 h)" value={overview.rejectedRequests24h.toLocaleString()} />
        <Stat label="Awaiting approval" value={String(overview.pendingApprovals)} />
      </div>
      <Panel>
        <div className="p-4"><p className="text-sm font-semibold text-fg">Approval queue</p></div>
        <KeysAdminTable params={{ status: 'PENDING_APPROVAL' }} showTenant />
      </Panel>
      <Card>
        <CardHeader title="Platform settings" description="The kill switch and retention apply to everyone. The default policy applies to organisations without their own." />
        <div className="mb-5 space-y-4">
          <Switch label="Kill switch" description="Refuse every API request immediately (incident response)" checked={draft.killSwitch} onChange={async (on) => {
            if (on && !(await confirmAction({ title: 'Turn the kill switch on?', tone: 'danger', confirmLabel: 'Stop all API traffic', message: 'Every integration of every organisation fails until you turn it off.' }))) return;
            save.mutate({ ...draft, killSwitch: on });
          }} />
          <TextField label="Request log retention (days)" type="number" min={7} value={String(draft.logRetentionDays)} onChange={(e) => setDraft({ ...draft, logRetentionDays: Math.max(7, Number(e.target.value) || 7) })} />
        </div>
        <p className="mb-3 text-sm font-semibold text-fg">Default policy</p>
        <PolicyEditor value={draft} onChange={(p) => setDraft({ ...draft, ...p })} catalog={catalog} />
        <div className="mt-5 border-t border-line-soft pt-4"><Button loading={save.isPending} onClick={() => save.mutate(draft)}>Save settings</Button></div>
      </Card>
      <AlertsCard path="/platform/api/alerts" keys={[]} tenantNames={new Map((tenants ?? []).map((t) => [t.id, t.name]))} />
      <ApiUsage keys={[]} logsPath="/platform/api/logs" />
    </div>
  );
}
