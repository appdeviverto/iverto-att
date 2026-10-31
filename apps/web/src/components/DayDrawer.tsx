import { Badge, Button, Callout, CenteredSpinner, DateInput, DescriptionList, Modal, Select, Textarea } from '@iverto-org/core-ui';
import { ClipboardEdit } from 'lucide-react';
import { useState } from 'react';
import { post, useAction, useApi } from '../lib/api';
import { isHr, useMe } from '../lib/auth';
import { clock, dateTime, hm, LIVE_STATE, StatusBadge } from '../lib/format';
import type { Day, Punch } from '../lib/live';
import { EmployeePicker, FormModal, useForm } from './ui';

// The detail endpoint's `remote` is the day's remote-work requests, not the flag.
interface DayDetail extends Omit<Day, 'remote'> {
  windowStart: string;
  windowEnd: string;
  punches: (Punch & { device: Punch['device'] })[];
  leave: { id: string; status: string; leaveType: { name: string } }[];
  remote: { id: string; status: string }[];
  corrections: { id: string; status: string; reason: string; inAt: string | null; outAt: string | null }[];
}

/** Segments against the scheduled shift, on one bar. */
function Timeline({ day }: { day: DayDetail }) {
  const now = new Date().toISOString();
  const points = [day.schedStart, day.schedEnd, ...day.segments.flatMap((s) => [s.in, s.out ?? now])].filter(Boolean).map((t) => new Date(t!).getTime());
  if (!points.length) return null;
  const pad = 30 * 60_000;
  const start = Math.min(...points) - pad;
  const span = Math.max(...points) + pad - start;
  const pct = (iso: string) => `${Math.min(100, Math.max(0, ((new Date(iso).getTime() - start) / span) * 100))}%`;
  const width = (a: string, b: string) => `${Math.min(100, Math.max(0, ((new Date(b).getTime() - new Date(a).getTime()) / span) * 100))}%`;
  return (
    <div>
      <div className="relative h-8 overflow-hidden rounded-full bg-surface-muted">
        {day.schedStart && day.schedEnd && (
          <div className="absolute inset-y-0 rounded-full border-2 border-dashed border-line-strong" style={{ left: pct(day.schedStart), width: width(day.schedStart, day.schedEnd) }} title="Scheduled shift" />
        )}
        {day.segments.map((s, i) => (
          <div key={i} className={`absolute inset-y-1.5 rounded-full ${s.credited ? 'bg-warning' : 'bg-success'}`} style={{ left: pct(s.in), width: width(s.in, s.out ?? now) }}
            title={`${clock(s.in, day.timezone)} – ${s.out ? clock(s.out, day.timezone) : 'still in'}`} />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs text-fg-subtle">
        <span>{clock(new Date(start).toISOString(), day.timezone)}</span>
        <span>Dashed: scheduled · green: worked{day.segments.some((s) => s.credited) ? ' · amber: credited' : ''}</span>
        <span>{clock(new Date(start + span).toISOString(), day.timezone)}</span>
      </div>
    </div>
  );
}

export function DayDrawer({ dayId, onClose }: { dayId: string | null; onClose: () => void }) {
  const { data: day, isLoading } = useApi<DayDetail>(dayId ? `/attendance/days/${dayId}` : null);
  const [correcting, setCorrecting] = useState(false);

  return (
    <Modal open={dayId !== null} onClose={onClose} size="drawer"
      title={day ? `${day.employee?.fullName ?? 'Employee'} · ${day.workDate}` : 'Attendance day'}
      description={day ? `Times in site time (UTC${day.local.offset})` : undefined}
      footer={day && <Button variant="secondary" leftIcon={<ClipboardEdit size={16} />} onClick={() => setCorrecting(true)}>Request correction</Button>}>
      {isLoading || !day ? (
        <CenteredSpinner />
      ) : (
        <div className="space-y-6 p-5 sm:p-6">
          <div className="flex flex-wrap items-center gap-2">
            {day.status === 'PENDING' ? <StatusBadge value={day.liveState} map={LIVE_STATE} /> : <StatusBadge value={day.status} />}
            {day.isLate && <Badge tone="warning">Late {day.lateMinutes} min</Badge>}
            {day.isEarlyExit && <Badge tone="warning">Left early {day.earlyExitMinutes} min</Badge>}
            {day.missedPunch && <Badge tone="danger">Missed punch</Badge>}
            {day.hasLeaveConflict && <Badge tone="orange">Punched while on leave</Badge>}
            {day.corrected && <Badge tone="info">Corrected</Badge>}
            {day.holidayName && <Badge tone="neutral">{day.holidayName}</Badge>}
          </div>
          <Timeline day={day} />
          <DescriptionList columns={2} items={[
            { term: 'Scheduled', value: day.local.schedStart ? `${day.local.schedStart} – ${day.local.schedEnd}` : 'Not scheduled' },
            { term: 'First in / last out', value: `${day.local.firstIn ?? '—'} / ${day.local.lastOut ?? '—'}` },
            { term: 'Worked', value: hm(day.workedMinutes) },
            { term: 'Required', value: hm(day.requiredMinutes) },
            { term: 'Breaks', value: hm(day.breakMinutes) },
            { term: 'Overtime', value: hm(day.overtimeMinutes) },
          ]} />
          <section>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">Punches</h3>
            {day.punches.length ? (
              <ul className="divide-y divide-line-soft rounded-2xl border border-line">
                {day.punches.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                    <span className="font-mono">{p.local.slice(11, 16)}</span>
                    <span className="flex-1 text-fg-muted">{p.device ? `${p.device.name ?? p.device.serialNo} · ${p.device.gateName}` : p.source.toLowerCase()}</span>
                    <Badge tone={p.direction === 'in' ? 'success' : p.direction === 'out' ? 'neutral' : 'info'}>{p.direction}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-fg-muted">No punches in this day’s window.</p>
            )}
          </section>
          {[...day.leave.map((l) => `Leave: ${l.leaveType.name} (${l.status.toLowerCase()})`), ...day.remote.map((r) => `Remote work (${r.status.toLowerCase()})`),
            ...day.corrections.map((c) => `Correction (${c.status.toLowerCase()}): ${c.reason}`)].map((t) => <Callout key={t} tone="info" title={t} />)}
        </div>
      )}
      {day && <CorrectionModal key={day.id} open={correcting} onClose={() => setCorrecting(false)} employeeId={day.employeeId} date={day.workDate} />}
    </Modal>
  );
}

/** Missed-punch fix (§1): approval adds CORRECTION punches; nothing is overwritten (D5). */
export function CorrectionModal({ open, onClose, employeeId, date }: { open: boolean; onClose: () => void; employeeId?: string; date?: string }) {
  const me = useMe();
  const [f, set] = useForm({ employeeId: employeeId ?? '', date: date ?? '', in: '', out: '', reason: '', fieldVisitId: '' });
  const who = f.employeeId || me.employeeId;
  const visits = useApi<{ data: FieldVisit[] }>('/field-visits', { employeeId: who, date: f.date }, { enabled: Boolean(who && f.date) }).data?.data ?? [];
  const save = useAction(
    () => post('/attendance/corrections', { employeeId: f.employeeId || undefined, date: f.date, in: f.in || undefined, out: f.out || undefined, reason: f.reason, fieldVisitId: f.fieldVisitId || undefined }),
    { invalidate: ['/attendance'], success: isHr(me) ? 'Correction filed' : 'Correction sent for approval', onSuccess: onClose },
  );
  return (
    <FormModal open={open} onClose={onClose} title="Request a correction" description="Give the time you actually came in and/or left, in site time."
      submitLabel="Send request" saving={save.isPending} onSubmit={() => save.mutate()}>
      {me.role !== 'EMPLOYEE' && !employeeId && <EmployeePicker value={f.employeeId} onChange={set('employeeId')} label="Employee (leave empty for yourself)" />}
      <DateInput label="Date" required value={f.date} onChange={(e) => set('date')(e.target.value)} />
      <div className="grid grid-cols-2 gap-3">
        <DateInput mode="time" label="In" value={f.in} onChange={(e) => set('in')(e.target.value)} />
        <DateInput mode="time" label="Out" hint="Earlier than in = next morning" value={f.out} onChange={(e) => set('out')(e.target.value)} />
      </div>
      <Textarea label="Reason" required minLength={3} maxLength={500} value={f.reason} onChange={(e) => set('reason')(e.target.value)} />
      {visits.length > 0 && (
        <Select label="Proof (field visit)" hint="A geotagged selfie taken in the mobile app that day" placeholder="No proof attached" value={f.fieldVisitId} onChange={(e) => set('fieldVisitId')(e.target.value)}
          options={visits.map((v) => ({ value: v.id, label: `${v.local.slice(11)}${v.note ? ` · ${v.note}` : ''}` }))} />
      )}
    </FormModal>
  );
}

/** A field visit: geotagged, server-timestamped selfie from the mobile app, attached to corrections as proof. */
export interface FieldVisit {
  id: string; takenAt: string; local: string; lat: number; lng: number; accuracy: number; isMockLocation: boolean | null; note: string | null; photoUrl: string;
}

/** The photo beside a map of where it was taken. */
export function FieldVisitProof({ visit }: { visit: Omit<FieldVisit, 'local'> }) {
  const { lat, lng } = visit;
  const where = `${lat.toFixed(5)}, ${lng.toFixed(5)} ±${Math.round(visit.accuracy)} m`;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <img src={visit.photoUrl} alt="Field visit selfie" className="aspect-[3/4] w-full rounded-lg object-cover" />
      <div className="space-y-3">
        <iframe title="Where the photo was taken" className="aspect-square w-full rounded-lg border border-border"
          src={`https://www.openstreetmap.org/export/embed.html?bbox=${lng - 0.004},${lat - 0.004},${lng + 0.004},${lat + 0.004}&layer=mapnik&marker=${lat},${lng}`} />
        <DescriptionList columns={1} items={[
          { term: 'Taken', value: dateTime(visit.takenAt) },
          { term: 'Location', value: <a className="underline" href={`https://www.google.com/maps?q=${lat},${lng}`} target="_blank" rel="noreferrer">{where}</a> },
          { term: 'GPS', value: visit.isMockLocation ? <Badge tone="danger">Mock location reported</Badge> : 'Device location' },
          ...(visit.note ? [{ term: 'Note', value: visit.note }] : []),
        ]} />
      </div>
    </div>
  );
}
