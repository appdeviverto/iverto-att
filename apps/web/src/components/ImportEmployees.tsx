import { Badge, Button, Callout, DataTable, FileDropzone, Modal, SegmentedControl, Switch } from '@iverto-org/core-ui';
import { ArrowLeft, Check, CheckCircle2, Download, FileSpreadsheet, MapPin, RefreshCw, Trash2, Upload, Users, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  downloadFile, fileToBase64, post, REFERENCE, useAction, useApi, useDepartments, useFeatures, useEmployeeOptions, useEmploymentTypes, useImportColumns, useSites, type ImportColumn,
} from '../lib/api';
import { headerKey, normaliseDate, parseCsv, toCsv } from '../lib/csv';
import { Pick, SitePicker } from './ui';

// ── The sheet ───────────────────────────────────────────────────────────────
// Columns come from the API's field registry (GET /employees/import/columns), so the
// wizard, the Excel template and the import engine always agree.

type Mode = 'CREATE' | 'UPSERT';
type Row = Record<string, string> & { _id: number };
interface CheckResult {
  total: number; valid: number; invalid: number; creates: number; updates: number; ignoredColumns: string[];
  errors: { line: number; errors: { field: string; message: string }[] }[];
}
type Problems = Map<number, { field: string; message: string }[]>; // by row _id
const rowsOf = (n: number) => `${n.toLocaleString('en-IN')} row${n === 1 ? '' : 's'}`;

function guessKey(header: string, columns: ImportColumn[]): string {
  const k = headerKey(header.replace(/\*$/, ''));
  return columns.find((c) => headerKey(c.key) === k || c.aka.includes(k))?.key ?? '';
}

/** Required columns depend on the mode: an update only needs the code to find the person. */
const requiredFor = (mode: Mode, hasSite: boolean) =>
  mode === 'UPSERT' ? ['employeeCode'] : ['employeeCode', 'fullName', 'joinedOn', ...(hasSite ? [] : ['siteName'])];

// ── Wizard ──────────────────────────────────────────────────────────────────

const STEPS = [
  { key: 'location', label: 'Mode & location', icon: MapPin },
  { key: 'upload', label: 'Upload & map', icon: Upload },
  { key: 'review', label: 'Check & fix', icon: Wand2 },
  { key: 'done', label: 'Import', icon: CheckCircle2 },
] as const;
type Step = (typeof STEPS)[number]['key'];

function Stepper({ step }: { step: Step }) {
  const at = STEPS.findIndex((s) => s.key === step);
  return (
    <ol className="flex items-center gap-2 border-b border-line-soft px-5 py-4 sm:px-6">
      {STEPS.map((s, i) => (
        <li key={s.key} className="flex min-w-0 flex-1 items-center gap-2">
          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold transition-colors ${
            i < at ? 'bg-success-soft text-success-fg' : i === at ? 'bg-brand text-on-brand shadow-soft' : 'bg-surface-subtle text-fg-subtle'}`}>
            {i < at ? <Check size={16} /> : <s.icon size={15} />}
          </span>
          <span className={`hidden truncate text-sm sm:block ${i === at ? 'font-semibold text-fg' : 'text-fg-muted'}`}>{s.label}</span>
          {i < STEPS.length - 1 && <span className={`h-px flex-1 ${i < at ? 'bg-success' : 'bg-line'}`} />}
        </li>
      ))}
    </ol>
  );
}

/**
 * Employee directory import: mode & location → upload an .xlsx or .csv (columns
 * auto-mapped, remappable) → dry run with in-place fixes → import. Create mode
 * adds people; Update mode also changes existing ones matched by code (blank =
 * keep, "-" = clear). Import is only offered once a dry run of exactly the
 * current rows passed.
 */
export function ImportEmployees({ onClose }: { onClose: () => void }) {
  const { payroll } = useFeatures();
  const sites = useSites().data ?? [];
  const columns = useImportColumns().data ?? [];
  const [step, setStep] = useState<Step>('location');
  const [mode, setMode] = useState<Mode>('CREATE');
  const [siteId, setSiteId] = useState('');
  const [consent, setConsent] = useState(false);
  const [file, setFile] = useState<{ name: string; header: string[]; body: string[][] } | null>(null);
  const [fileError, setFileError] = useState('');
  const [reading, setReading] = useState(false);
  const [mapping, setMapping] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [version, setVersion] = useState(0); // bumps on every edit; a dry run is valid for one version
  const [checked, setChecked] = useState<{ version: number; result: CheckResult; problems: Problems } | null>(null);
  const [onlyProblems, setOnlyProblems] = useState(true);
  const [done, setDone] = useState({ created: 0, updated: 0 });
  const site = sites.find((s) => s.id === siteId);
  const byKey = useMemo(() => new Map(columns.map((c) => [c.key, c])), [columns]);
  const label = (k: string) => byKey.get(k)?.label ?? k;

  const mapped = new Set(mapping.filter(Boolean));
  const required = requiredFor(mode, Boolean(siteId));
  const missing = required.filter((k) => !mapped.has(k));
  const doubled = [...mapped].filter((k) => mapping.filter((m) => m === k).length > 1);
  /** The fields this file supplies, in sheet order: the review table and the CSV sent use only these. */
  const used = columns.filter((c) => mapped.has(c.key));

  const template = useAction((prefill: boolean) => downloadFile('/employees/import/template.xlsx', { siteId: prefill ? undefined : siteId, prefill }, 'employees.xlsx'));

  const readFile = async (f: File) => {
    setFileError('');
    if (f.size > 10_000_000) return setFileError('That file is over 10 MB.');
    setReading(true);
    try {
      const all = /\.xlsx$/i.test(f.name)
        ? (await post<{ rows: string[][] }>('/employees/import/read', { fileBase64: await fileToBase64(f) })).rows
        : parseCsv(await f.text());
      const [header = [], ...body] = all;
      if (!body.length) return setFileError('The file has no employee rows under the header.');
      if (body.length > 5000) return setFileError(`At most 5,000 employees per import — this file has ${body.length}.`);
      setFile({ name: f.name, header, body });
      setMapping(header.map((h) => guessKey(h, columns)));
      setChecked(null);
    } catch (e) {
      setFileError(e instanceof Error ? e.message : 'The file could not be read.');
    } finally {
      setReading(false);
    }
  };

  const buildRows = () => {
    setRows(file!.body.map((r, i) => {
      const row = { ...Object.fromEntries(used.map((c) => [c.key, ''])), _id: i } as Row;
      mapping.forEach((k, col) => { if (k) row[k] = (r[col] ?? '').trim(); });
      return row;
    }));
    setVersion((v) => v + 1);
    setStep('review');
  };

  const csvOf = (rs: Row[]) => toCsv([used.map((c) => c.key), ...rs.map((r) => used.map((c) => r[c.key] ?? ''))]);
  const send = (commit: boolean) =>
    post<CheckResult & { committed: boolean; createdIds?: string[]; updatedIds?: string[] }>('/employees/import', {
      csv: csvOf(rows), mode, ...(siteId ? { siteId } : {}), biometricConsent: consent, commit,
    });

  const dryRun = useAction(async () => ({ version, sent: rows.map((r) => r._id), result: await send(false) }), {
    onSuccess: ({ version: v, sent, result }) => {
      // The API reports CSV line numbers (header = line 1); map them back to stable row ids.
      const problems: Problems = new Map(result.errors.map((e) => [sent[e.line - 2], e.errors]));
      setChecked({ version: v, result, problems });
      setOnlyProblems(result.invalid > 0);
    },
  });
  const commit = useAction(() => send(true), {
    invalidate: ['/employees'],
    onSuccess: (r) => { setDone({ created: r.createdIds?.length ?? 0, updated: r.updatedIds?.length ?? 0 }); setStep('done'); },
  });

  const fresh = checked?.version === version ? checked : null;
  const problems = checked?.problems ?? new Map();
  const edit = (id: number, key: string, value: string) => { setRows((rs) => rs.map((r) => (r._id === id ? { ...r, [key]: value } : r))); setVersion((v) => v + 1); };
  const replaceAll = (key: string, from: string, to: string) => { setRows((rs) => rs.map((r) => (r[key] === from ? { ...r, [key]: to } : r))); setVersion((v) => v + 1); };
  const removeRow = (id: number) => { setRows((rs) => rs.filter((r) => r._id !== id)); setVersion((v) => v + 1); };

  // Entering review runs the first dry run on its own.
  const autoRun = step === 'review' && !checked && rows.length > 0;
  useEffect(() => { if (autoRun) dryRun.mutate(); }, [autoRun]); // eslint-disable-line react-hooks/exhaustive-deps

  const where = site ? `${site.name}` : 'the site in each row';
  const footer: Record<Step, ReactNode> = {
    location: <>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button disabled={mode === 'CREATE' ? !siteId : false} onClick={() => setStep('upload')}>Continue</Button>
    </>,
    upload: <>
      <Button variant="ghost" leftIcon={<ArrowLeft size={16} />} onClick={() => setStep('location')}>Back</Button>
      <Button disabled={!file || missing.length > 0 || doubled.length > 0} onClick={buildRows}>Check {file ? rowsOf(file.body.length) : 'rows'}</Button>
    </>,
    review: <>
      <Button variant="ghost" leftIcon={<ArrowLeft size={16} />} onClick={() => { setStep('upload'); setChecked(null); }}>Back</Button>
      <Button variant="secondary" leftIcon={<RefreshCw size={16} />} loading={dryRun.isPending} disabled={!rows.length} onClick={() => dryRun.mutate()}>Run dry run</Button>
      <Button disabled={!fresh || fresh.result.invalid > 0 || !rows.length} loading={commit.isPending} onClick={() => commit.mutate()}>
        {mode === 'CREATE' ? `Import ${rows.length} employee${rows.length === 1 ? '' : 's'}` : `Apply ${rows.length} row${rows.length === 1 ? '' : 's'}`}
      </Button>
    </>,
    done: <Button onClick={onClose}>View employees</Button>,
  };

  const sections = [...new Set(columns.map((c) => c.section))];

  return (
    <Modal open onClose={onClose} size="xl" closeOnBackdrop={false} title={mode === 'CREATE' ? 'Import employees' : 'Update employees from a spreadsheet'}
      description={mode === 'CREATE' ? (site ? `Into ${site.name}` : 'Add a whole location’s directory from a spreadsheet') : 'Change many profiles at once, matched by employee code'} footer={footer[step]}>
      <Stepper step={step} />
      <div className="space-y-5 p-5 sm:p-6">
        {step === 'location' && (
          <>
            <SegmentedControl label="What does this file do?" value={mode} onChange={(v) => { setMode(v as Mode); setFile(null); setMapping([]); }}
              options={[{ value: 'CREATE', label: 'Add new employees' }, { value: 'UPSERT', label: 'Update existing (and add new)' }]} />
            <SitePicker label={mode === 'CREATE' ? 'Which office location are these employees at?' : 'Location for anyone new in the file (optional)'} required={mode === 'CREATE'}
              placeholder={mode === 'CREATE' ? 'Search locations' : 'Use the Site column'} value={siteId} onChange={setSiteId} />
            {mode === 'CREATE' && site && <p className="text-sm text-fg-muted">Everyone in the file joins <b className="text-fg">{site.name}</b> ({site.timezone}) and follows its holiday calendar. Import one file per location.</p>}
            {mode === 'UPSERT' && <Callout tone="info" title="Blank keeps, “-” clears">Rows are matched by employee code. A blank cell leaves that field as it is; a single dash clears it. Codes that don’t exist yet are added as new employees.</Callout>}
            <Switch label="Biometric consent was collected for the new employees in this file" description="Recorded against each new employee; required before enrolling faces (DPDP Act / GDPR)." checked={consent} onChange={setConsent} />
            <div className="rounded-2xl border border-line-soft bg-surface-subtle p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 font-semibold text-fg"><FileSpreadsheet size={18} className="text-brand" /> The Excel template</div>
                <div className="flex flex-wrap gap-2">
                  {mode === 'UPSERT' && <Button size="sm" variant="secondary" leftIcon={<Users size={14} />} loading={template.isPending && template.variables} onClick={() => template.mutate(true)}>Current employees</Button>}
                  <Button size="sm" variant="secondary" leftIcon={<Download size={14} />} loading={template.isPending && !template.variables} onClick={() => template.mutate(false)}>Blank template</Button>
                </div>
              </div>
              <p className="mb-3 text-sm text-fg-muted">
                Dropdowns for your sites, departments and categories{payroll && ' and salary structures'}; dates and IDs already formatted; hover any header for its rule. {mode === 'UPSERT' && '“Current employees” is the same sheet filled in — edit it and upload it back.'}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {sections.map((s) => (
                  <span key={s} title={columns.filter((c) => c.section === s).map((c) => c.label).join(', ')}>
                    <Badge tone="neutral">{s} · {columns.filter((c) => c.section === s).length}</Badge>
                  </span>
                ))}
              </div>
              <p className="mt-2 text-xs text-fg-subtle">Required: {required.map(label).join(', ')}. Everything else is optional.</p>
            </div>
          </>
        )}

        {step === 'upload' && (
          <>
            <FileDropzone accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" uploading={reading}
              hint="Excel (.xlsx) or CSV, up to 5,000 rows" icon="file" error={fileError || undefined}
              file={file && { name: `${file.name} · ${rowsOf(file.body.length)}` }} onRemove={() => { setFile(null); setMapping([]); }} onFiles={([f]) => void readFile(f)} />
            {file && (
              <div className="space-y-3">
                <div>
                  <h3 className="font-semibold text-fg">Match your columns</h3>
                  <p className="text-sm text-fg-muted">We matched what we recognised. Fix anything that’s wrong, or ignore columns you don’t need.</p>
                </div>
                {missing.length > 0 && <Callout tone="danger" title={`Missing: ${missing.map(label).join(', ')}`}>Map a column to each, or add it to the file.</Callout>}
                {doubled.length > 0 && <Callout tone="danger" title={`Mapped twice: ${doubled.map(label).join(', ')}`}>Each field can come from one column only.</Callout>}
                <div className="divide-y divide-line-soft rounded-2xl border border-line">
                  {file.header.map((h, col) => (
                    <div key={col} className="grid items-center gap-3 px-4 py-3 sm:grid-cols-[1fr_auto_1fr]">
                      <div className="min-w-0">
                        <p className="truncate font-mono text-sm font-semibold text-fg">{h || `Column ${col + 1}`}</p>
                        <p className="truncate text-xs text-fg-subtle">e.g. {file.body.slice(0, 3).map((r) => r[col]).filter(Boolean).join(', ') || 'empty'}</p>
                      </div>
                      <span className="hidden text-fg-subtle sm:block">→</span>
                      <Pick label={<span className="sr-only">Field for {h}</span>} placeholder="Ignore this column" value={mapping[col] ?? ''}
                        onChange={(v) => setMapping(mapping.map((m, i) => (i === col ? v : m)))}
                        options={columns.map((c) => ({ value: c.key, label: c.label, description: `${c.section}${required.includes(c.key) ? ' · required' : ''}`, keywords: c.rule }))} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {step === 'review' && (
          <Review rows={rows} used={used} checked={checked} fresh={Boolean(fresh)} pending={dryRun.isPending} problems={problems} mode={mode}
            onlyProblems={onlyProblems} setOnlyProblems={setOnlyProblems} edit={edit} replaceAll={replaceAll} removeRow={removeRow} where={where} />
        )}

        {step === 'done' && (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-success-soft text-success-fg"><CheckCircle2 size={30} /></span>
            <h3 className="text-xl font-bold text-fg">
              {[done.created && `${done.created} employee${done.created === 1 ? '' : 's'} added`, done.updated && `${done.updated} updated`].filter(Boolean).join(' · ') || 'Nothing to change'}
            </h3>
            {done.created > 0 && <p className="max-w-md text-sm text-fg-muted">New people start on the default shift with the tenant’s weekly offs and their onboarding checklist. Give app access from each profile, and enrol faces from Face enrolment.</p>}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ── Check & fix ─────────────────────────────────────────────────────────────

/** Fields whose bad values are usually the same typo many times over: fix them once for every row. */
const BULK_TYPES = new Set(['ref', 'enum']);

function Review({ rows, used, checked, fresh, pending, problems, mode, onlyProblems, setOnlyProblems, edit, replaceAll, removeRow, where }: {
  rows: Row[]; used: ImportColumn[]; checked: { result: CheckResult } | null; fresh: boolean; pending: boolean; problems: Problems; mode: Mode;
  onlyProblems: boolean; setOnlyProblems: (v: boolean) => void; edit: (id: number, key: string, v: string) => void; replaceAll: (key: string, from: string, to: string) => void;
  removeRow: (id: number) => void; where: string;
}) {
  const employees = useEmployeeOptions().data?.items ?? [];
  const departments = useDepartments().data ?? [];
  const sites = useSites().data ?? [];
  const categories = useEmploymentTypes();
  const { payroll } = useFeatures();
  const structures = useApi<{ id: string; name: string }[]>(payroll ? '/payroll/structures' : null, undefined, REFERENCE).data ?? [];
  const bad = rows.filter((r) => problems.get(r._id)?.length);
  const shown = (onlyProblems ? bad : rows).slice(0, 200);
  const errorOf = (r: Row, key: string) => problems.get(r._id)?.find((e) => e.field === key)?.message;
  const col = (key: string) => used.find((c) => c.key === key);

  // Same field + same bad value = one decision ("“Enginering” in 4 rows → Engineering").
  const groups = useMemo(() => {
    const g = new Map<string, { key: string; value: string; count: number; message: string }>();
    for (const r of bad) for (const e of problems.get(r._id) ?? []) {
      if (!BULK_TYPES.has(col(e.field)?.type ?? '')) continue;
      const id = `${e.field}\u0000${r[e.field]}`;
      g.set(id, { key: e.field, value: r[e.field], count: (g.get(id)?.count ?? 0) + 1, message: e.message });
    }
    return [...g.values()];
  }, [bad, problems]); // eslint-disable-line react-hooks/exhaustive-deps
  const dateKeys = used.filter((c) => c.type === 'date').map((c) => c.key);
  const fixableDates = bad.flatMap((r) => dateKeys.filter((k) => errorOf(r, k) && normaliseDate(r[k])).map((k) => ({ r, k })));

  const choices = (key: string) =>
    key === 'departmentName' ? departments.map((d) => ({ value: d.name, label: d.name }))
    : key === 'siteName' ? sites.map((s) => ({ value: s.name, label: s.name }))
    : key === 'salaryStructure' ? structures.map((s) => ({ value: s.name, label: s.name }))
    : key === 'managerCode' ? [...employees.map((e) => ({ value: e.employeeCode, label: e.fullName, description: e.employeeCode })), ...rows.filter((r) => r.employeeCode).map((r) => ({ value: r.employeeCode, label: r.fullName || r.employeeCode, description: `${r.employeeCode} · in this file` }))]
    : key === 'employmentType' ? categories.map((c) => ({ value: c.code, label: c.label }))
    : (col(key)?.values ?? []).map((v) => ({ value: v, label: v.replace(/_/g, ' ').toLowerCase() }));

  if (!checked) return <Callout tone="info" title="Running a dry run…">Checking every row against {where}’s directory. Nothing is saved yet.</Callout>;
  const { result } = checked;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Rows', value: rows.length, tone: 'text-fg' },
          { label: mode === 'CREATE' ? 'Ready' : 'New', value: fresh ? (mode === 'CREATE' ? rows.length - bad.length : result.creates) : '—', tone: 'text-success-fg' },
          ...(mode === 'UPSERT' ? [{ label: 'Updates', value: fresh ? result.updates : '—', tone: 'text-info-fg' }] : []),
          { label: 'Need fixing', value: bad.length, tone: bad.length ? 'text-danger-fg' : 'text-fg-subtle' },
        ].map((s) => (
          <div key={s.label} className="rounded-2xl border border-line-soft bg-surface-subtle px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{s.label}</p>
            <p className={`text-2xl font-bold ${s.tone}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {pending ? <Callout tone="info" title="Running the dry run…">Nothing is saved yet.</Callout>
        : !fresh ? <Callout tone="warning" title="You changed the data since the last dry run">Run the dry run again — import unlocks once every row passes.</Callout>
        : result.invalid === 0 ? <Callout tone="success" title={rows.length === 1 ? 'Dry run passed: the row is ready' : `Dry run passed: all ${rows.length} rows are ready`}>Nothing has been saved yet. {mode === 'CREATE' ? 'Import adds them all in one go.' : 'Apply makes every change in one go.'}</Callout>
        : <Callout tone="danger" title={`${result.invalid} of ${result.total} rows didn’t pass the dry run`}>Fix them below — in bulk where the same value is wrong many times — or skip rows, then run the dry run again.</Callout>}
      {fresh && result.ignoredColumns?.length > 0 && <Callout tone="neutral" title={`Ignored columns: ${result.ignoredColumns.join(', ')}`} />}

      {(groups.length > 0 || fixableDates.length > 0) && (
        <div className="space-y-3 rounded-2xl border border-line-soft bg-surface-subtle p-4">
          <div className="flex items-center gap-2 font-semibold text-fg"><Wand2 size={17} className="text-brand" /> Fix mismatches in bulk</div>
          {fixableDates.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface px-3 py-2.5">
              <span className="text-sm text-fg">{fixableDates.length} date{fixableDates.length === 1 ? '' : 's'} like “{fixableDates[0].r[fixableDates[0].k]}” can be converted to YYYY-MM-DD</span>
              <Button size="sm" onClick={() => fixableDates.forEach(({ r, k }) => edit(r._id, k, normaliseDate(r[k])!))}>Convert dates</Button>
            </div>
          )}
          {groups.map((g) => (
            <div key={`${g.key}:${g.value}`} className="grid items-center gap-2 rounded-xl bg-surface px-3 py-2.5 sm:grid-cols-[1fr_18rem]">
              <div className="min-w-0 text-sm">
                <span className="text-fg-muted">{col(g.key)?.label}</span> <b className="text-fg">“{g.value || 'empty'}”</b>{' '}
                <span className="text-fg-muted">in {g.count} row{g.count === 1 ? '' : 's'} — {g.message}</span>
              </div>
              <Pick label={<span className="sr-only">Replace {g.value}</span>} avatar={g.key === 'managerCode'} placeholder="Replace with…"
                value="" onChange={(v) => v && replaceAll(g.key, g.value, v)} options={choices(g.key)} />
              {(g.key === 'managerCode' || g.key === 'departmentName') && (
                <button type="button" className="justify-self-start text-xs font-semibold text-brand hover:underline sm:col-start-2" onClick={() => replaceAll(g.key, g.value, '')}>
                  Leave {col(g.key)?.label.toLowerCase()} empty for these rows
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-fg">{onlyProblems ? 'Rows that need fixing' : 'All rows'}</h3>
        <Switch label="Only rows with problems" checked={onlyProblems} onChange={setOnlyProblems} />
      </div>
      <div className="max-h-[26rem] overflow-auto rounded-2xl border border-line">
        <DataTable rows={shown} getRowKey={(r) => String(r._id)}
          empty={<p className="p-6 text-center text-sm text-fg-muted">{onlyProblems ? 'No problems left.' : 'No rows.'}</p>}
          columns={[
            { key: 'line', header: '#', render: (r) => <span className="font-mono text-xs text-fg-subtle">{r._id + 2}</span> },
            ...used.map((c) => ({
              key: c.key,
              header: c.label,
              render: (r: Row) => {
                const err = errorOf(r, c.key);
                if (!err) return <span className={r[c.key] ? 'whitespace-nowrap text-fg' : 'text-fg-subtle'}>{r[c.key] || '—'}</span>;
                return (
                  <div className="min-w-36">
                    <input aria-label={`${c.label}, line ${r._id + 2}`} className="field field-invalid !py-1.5 text-sm" value={r[c.key]} onChange={(e) => edit(r._id, c.key, e.target.value)} />
                    <p className="mt-1 text-xs text-danger-fg">{err}</p>
                  </div>
                );
              },
            })),
            { key: 'x', header: '', render: (r) => <Button size="sm" variant="ghost" leftIcon={<Trash2 size={14} />} onClick={() => removeRow(r._id)}>Skip</Button> },
          ]} />
      </div>
      {(onlyProblems ? bad : rows).length > shown.length && <p className="text-xs text-fg-subtle">Showing the first {shown.length} — fix these and run the dry run again to see the rest.</p>}
    </div>
  );
}
