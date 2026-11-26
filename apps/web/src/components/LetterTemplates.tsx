import { Badge, Button, Callout, Card, confirmAction, EmptyState, IconButton, Modal, Select, TextField } from '@iverto-org/core-ui';
import { FileSignature, Pencil, Plus, Trash2, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { del, patch, post, REFERENCE, useAction, useApi, useEmployeeOptions } from '../lib/api';
import { Letterhead, type Branding } from './Letterhead';

type Kind = 'OFFER' | 'APPOINTMENT' | 'EXPERIENCE' | 'RELIEVING' | 'OTHER';
interface Template { id: string; kind: Kind; name: string; body: string; updatedAt: string }
interface LibraryItem { key: string; kind: Kind; name: string; description: string; placeholders: number }
interface Field { key: string; label: string; group: 'Letter' | 'Employee' | 'Company' | 'Salary'; sample: string }

const KIND_LABEL: Record<Kind, string> = { OFFER: 'Offer', APPOINTMENT: 'Appointment', EXPERIENCE: 'Experience', RELIEVING: 'Relieving', OTHER: 'Other' };
const GROUPS: Field['group'][] = ['Employee', 'Salary', 'Company', 'Letter'];
const TOKEN = /\{\{\s*([\w.]+)\s*\}\}/g;
const fieldsUsed = (body: string) => new Set([...body.matchAll(TOKEN)].map((m) => m[1])).size;

/**
 * Settings → Letters, after the iverto-industry agreement maker: your templates on the
 * left, ready-made starting points on the right ("Use template" copies one in), and an
 * editor with click-to-insert fields beside a live preview of the filled-in letter.
 */
export function LetterTemplates() {
  const templates = useApi<Template[]>('/letter-templates');
  const library = useApi<LibraryItem[]>('/letter-templates/library', undefined, REFERENCE).data ?? [];
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  const adopt = useAction((key: string) => post<Template>(`/letter-templates/library/${key}/adopt`), {
    invalidate: ['/letter-templates'],
    success: 'Template added — review the wording for your company',
    onSuccess: (t) => setEditing(t),
  });
  const remove = useAction((id: string) => del(`/letter-templates/${id}`), { invalidate: ['/letter-templates'], success: 'Template deleted' });
  const list = templates.data ?? [];
  const names = new Set(list.map((t) => t.name.replace(/ \(\d+\)$/, '')));

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold text-fg">Letters</h2>
        <p className="text-sm text-fg-muted">Offer, appointment, experience and other letters, filled in from each employee’s profile and saved as a PDF on the company letterhead in their documents.</p>
      </div>
      <div className="grid gap-5 lg:grid-cols-[1fr_19rem]">
        <Card padding="none" className="h-fit overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-line-soft p-4">
            <p className="text-sm text-fg-muted">Generate a letter from an employee’s profile → Documents → Generate letter.</p>
            <Button size="sm" leftIcon={<Plus size={14} />} onClick={() => setEditing('new')}>New letter</Button>
          </div>
          {!list.length && !templates.isLoading ? (
            <EmptyState icon={FileSignature} title="No letter templates yet" description="Start from one of the ready-made letters on the right, or write your own." />
          ) : (
            <ul className="divide-y divide-line-soft">
              {list.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEditing(t)}>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-fg">{t.name}</span>
                      <Badge tone="neutral">{KIND_LABEL[t.kind]}</Badge>
                    </div>
                    <div className="truncate text-xs text-fg-subtle">
                      {fieldsUsed(t.body)} field{fieldsUsed(t.body) === 1 ? '' : 's'} · {t.body.replace(TOKEN, '…').replace(/\s+/g, ' ').slice(0, 110)}
                    </div>
                  </button>
                  <Button size="sm" variant="secondary" leftIcon={<Pencil size={14} />} onClick={() => setEditing(t)}>Edit</Button>
                  <IconButton label={`Delete ${t.name}`} icon={<Trash2 size={16} />} onClick={async () => {
                    if (await confirmAction({ title: `Delete “${t.name}”?`, message: 'Letters already generated from it stay in employees’ documents.', confirmLabel: 'Delete template', tone: 'danger' })) remove.mutate(t.id);
                  }} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <aside className="h-fit rounded-2xl border border-line bg-surface p-4 shadow-soft">
          <p className="mb-3 flex items-center gap-2 text-sm font-semibold text-fg"><Wand2 size={16} className="text-brand" /> Starting points</p>
          <ul className="space-y-2">
            {library.map((l) => (
              <li key={l.key} className="rounded-xl border border-line-soft p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-fg">{l.name}</p>
                  <span className="text-[11px] text-fg-subtle">{KIND_LABEL[l.kind]}</span>
                </div>
                <p className="mt-0.5 text-xs text-fg-muted">{l.description}</p>
                <Button size="sm" variant="secondary" className="mt-2" loading={adopt.isPending && adopt.variables === l.key} onClick={() => adopt.mutate(l.key)}>
                  {names.has(l.name) ? 'Add another copy' : 'Use template'}
                </Button>
              </li>
            ))}
          </ul>
        </aside>
      </div>
      {editing && <LetterEditor value={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function LetterEditor({ value, onClose }: { value: Template | 'new'; onClose: () => void }) {
  const existing = value === 'new' ? null : value;
  const fields = useApi<Field[]>('/letter-templates/fields', undefined, REFERENCE).data ?? [];
  const org = useApi<{ name: string; settings: { branding?: Branding | null } }>('/org').data;
  const employees = useEmployeeOptions().data?.items ?? [];
  const [name, setName] = useState(existing?.name ?? '');
  const [kind, setKind] = useState<Kind>(existing?.kind ?? 'OTHER');
  const [body, setBody] = useState(existing?.body ?? '{{today}}\n\nDear {{employee.fullName}},\n\nSubject: \n\n\n\nFor {{org.name}}\n\nAuthorised Signatory');
  const [asEmployee, setAsEmployee] = useState('');
  const [preview, setPreview] = useState<{ text: string; missing: string[] } | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const label = useMemo(() => new Map(fields.map((f) => [f.key, f.label])), [fields]);

  // Live preview, rendered by the API exactly as the PDF will be (debounced while typing).
  useEffect(() => {
    const t = setTimeout(() => {
      post<{ text: string; missing: string[] }>('/letter-templates/render', { body, ...(asEmployee ? { employeeId: asEmployee } : {}) }).then(setPreview).catch(() => undefined);
    }, 300);
    return () => clearTimeout(t);
  }, [body, asEmployee]);

  const insert = (key: string) => {
    const token = `{{${key}}}`;
    const el = ref.current;
    if (!el) return setBody((b) => b + token);
    const { selectionStart: a, selectionEnd: b } = el;
    setBody((t) => t.slice(0, a) + token + t.slice(b));
    setTimeout(() => { el.focus(); el.selectionStart = el.selectionEnd = a + token.length; }, 0);
  };

  const save = useAction(() => (existing ? patch(`/letter-templates/${existing.id}`, { name: name.trim(), kind, body }) : post('/letter-templates', { name: name.trim(), kind, body })), {
    invalidate: ['/letter-templates'], success: 'Template saved', onSuccess: onClose,
  });
  const unknown = (preview?.missing ?? []).filter((k) => !label.has(k));
  const blank = (preview?.missing ?? []).filter((k) => label.has(k));

  return (
    <Modal open onClose={onClose} size="xl" closeOnBackdrop={false} title={existing ? `Edit ${existing.name}` : 'New letter template'}
      description="Write the letter once; the fields fill in from each employee’s profile when you generate it."
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={save.isPending} disabled={!name.trim() || !body.trim()} onClick={() => save.mutate()}>Save template</Button>
      </>}>
      <div className="space-y-4 p-5 sm:p-6">
        <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
          <TextField label="Template name" required maxLength={120} placeholder="e.g. Appointment letter" value={name} onChange={(e) => setName(e.target.value)} />
          <Select label="Kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)} options={Object.entries(KIND_LABEL).map(([v, l]) => ({ value: v, label: l }))} />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="min-w-0 space-y-2">
            <p className="field-label mb-0">Insert a field <span className="font-normal text-fg-subtle">— click to add it at the cursor</span></p>
            <div className="max-h-36 space-y-1.5 overflow-y-auto rounded-xl border border-line-soft bg-surface-subtle p-2">
              {GROUPS.map((g) => (
                <div key={g} className="flex flex-wrap items-center gap-1">
                  <span className="w-16 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">{g}</span>
                  {fields.filter((f) => f.group === g).map((f) => (
                    <button key={f.key} type="button" title={`{{${f.key}}} — e.g. ${f.sample || '—'}`} onClick={() => insert(f.key)}
                      className="rounded-md border border-line bg-surface px-1.5 py-0.5 text-[11px] text-fg-muted hover:border-brand hover:text-brand">
                      + {f.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
            <label className="field-label mb-0 block" htmlFor="letter-body">Letter text</label>
            <textarea id="letter-body" ref={ref} rows={18} className="field resize-y text-sm leading-relaxed" value={body} onChange={(e) => setBody(e.target.value)} />
            <p className="text-xs text-fg-subtle">A blank line starts a new paragraph. The letterhead (logo, address, contacts) is added automatically — don’t type it here.</p>
          </div>

          <div className="min-w-0 space-y-2">
            <div className="flex items-end justify-between gap-2">
              <p className="field-label mb-0">Preview</p>
              <div className="w-56">
                <Select hideLabel label="Preview as" value={asEmployee} onChange={(e) => setAsEmployee(e.target.value)} placeholder="Sample employee"
                  options={employees.map((e) => ({ value: e.id, label: `${e.fullName} (${e.employeeCode})` }))} />
              </div>
            </div>
            <div className="max-h-[30rem] overflow-y-auto rounded-xl border border-line bg-white p-5 text-[13px] leading-relaxed text-[#1f2937] shadow-soft">
              <div className="mb-4"><Letterhead branding={org?.settings.branding ?? {}} fallbackName={org?.name ?? 'Your company'} /></div>
              {preview?.text.trim()
                ? preview.text.split(/\n{2,}/).map((p, i) => <p key={i} className="mb-2.5 whitespace-pre-wrap">{p.trim()}</p>)
                : <p className="text-[#9ca3af]">The filled-in letter appears here as you type.</p>}
            </div>
            {blank.length > 0 && (
              <Callout tone="warning" title={asEmployee ? 'Blank for this employee' : 'Blank in the sample'}>
                {blank.map((k) => label.get(k)).join(', ')} — {asEmployee ? 'fill these on the profile, or remove them from the letter.' : 'these come from the company settings; fill them in Settings → Organisation.'}
              </Callout>
            )}
            {unknown.length > 0 && <Callout tone="danger" title="Unknown fields">{unknown.map((k) => `{{${k}}}`).join(', ')} — use the field buttons instead of typing them.</Callout>}
          </div>
        </div>
      </div>
    </Modal>
  );
}
