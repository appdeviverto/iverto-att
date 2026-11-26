import { Button, Card, EmptyState, IconButton, PageHeader, SearchInput } from '@iverto-org/core-ui';
import { ArrowUpRight, Maximize2, Minus, Network, Plus, Users } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useNavigate } from 'react-router';
import { REFERENCE, useApi } from '../lib/api';
import { isManager, useMe } from '../lib/auth';
import { SiteSelect } from './ui';

interface Person { id: string; employeeCode: string; fullName: string; designation: string | null; managerId: string | null; department: string | null; site: string }

const TONES = ['#cd0447', '#2563eb', '#059669', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#4b5563'];
const toneOf = (s: string) => TONES[[...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TONES.length];
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
/** Levels open on first load: the top person and their direct reports. */
const OPEN_DEPTH = 2;

/**
 * Org chart as a top-down tree of cards (Teams-style). Click a card to focus on that person:
 * their chain of managers above, their team below. Drag to pan, zoom with the buttons.
 */
export function OrgChart() {
  const me = useMe();
  const navigate = useNavigate();
  const { data } = useApi<Person[]>('/employees/org-chart', undefined, REFERENCE);
  const [q, setQ] = useState('');
  const [siteFilter, setSiteFilter] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);
  const people = data ?? [];
  const siteName = useApi<{ id: string; name: string }[]>('/sites', undefined, REFERENCE).data?.find((s) => s.id === siteFilter)?.name;

  const { byId, children, roots } = useMemo(() => {
    const byId = new Map(people.map((p) => [p.id, p]));
    const children = new Map<string, Person[]>();
    const roots: Person[] = [];
    for (const p of people) {
      // Someone whose manager is not listed (exited, another site) heads a tree of their own.
      if (p.managerId && byId.has(p.managerId)) children.set(p.managerId, [...(children.get(p.managerId) ?? []), p]);
      else roots.push(p);
    }
    // Managers first, then by name, so teams read left to right.
    const order = (a: Person, b: Person) => Number(children.has(b.id)) - Number(children.has(a.id)) || a.fullName.localeCompare(b.fullName);
    for (const list of children.values()) list.sort(order);
    roots.sort(order);
    return { byId, children, roots };
  }, [people]);

  const teamSize = useMemo(() => {
    const memo = new Map<string, number>();
    const size = (id: string): number => memo.get(id) ?? (memo.set(id, (children.get(id) ?? []).reduce((n, c) => n + 1 + size(c.id), 0)), memo.get(id)!);
    return size;
  }, [children]);

  // First load: open the top levels.
  useEffect(() => {
    if (!people.length || open.size) return;
    const next = new Set<string>();
    const walk = (list: Person[], depth: number) => list.forEach((p) => { if (depth < OPEN_DEPTH - 1) { next.add(p.id); walk(children.get(p.id) ?? [], depth + 1); } });
    walk(roots, 0);
    setOpen(next);
  }, [people.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const ancestors = (id: string) => {
    const chain: Person[] = [];
    for (let p = byId.get(byId.get(id)?.managerId ?? ''); p; p = byId.get(p.managerId ?? '')) chain.unshift(p);
    return chain;
  };

  // Search / site filter: matching people, with the path down to them opened.
  const term = q.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!term && !siteName) return null;
    return new Set(people.filter((p) => (!term || `${p.fullName} ${p.employeeCode} ${p.designation ?? ''} ${p.department ?? ''}`.toLowerCase().includes(term)) && (!siteName || p.site === siteName)).map((p) => p.id));
  }, [term, siteName, people]); // eslint-disable-line react-hooks/exhaustive-deps
  const forcedOpen = useMemo(() => {
    const s = new Set<string>();
    if (matches) for (const id of matches) for (const a of ancestors(id)) s.add(a.id);
    return s;
  }, [matches]); // eslint-disable-line react-hooks/exhaustive-deps
  const isOpen = (id: string) => (matches ? forcedOpen.has(id) : open.has(id));
  /** With a filter, only branches that lead to a match are drawn. */
  const visible = (p: Person): boolean => !matches || matches.has(p.id) || (children.get(p.id) ?? []).some(visible);
  const toggle = (id: string) => {
    setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    // Keep the person whose team just opened in view; the tree may have grown sideways.
    setTimeout(() => document.getElementById(`org-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' }), 60);
  };
  /** Teams-style focus: the person's managers above, their own team opened below. */
  const focusOn = (id: string) => {
    setFocusId(id);
    setOpen((s) => new Set(s).add(id));
  };
  /** Zoom so the whole drawn tree fits the canvas width (measured visually, so repeat clicks are stable). */
  const fit = () => {
    const tree = scroller.current?.querySelector('.org-tree') as HTMLElement | null;
    if (!tree || !scroller.current) return;
    const natural = tree.getBoundingClientRect().width / zoom;
    setZoom(Math.max(0.5, Math.min(1, +((scroller.current.clientWidth - 80) / natural).toFixed(2))));
  };

  // Centre the chart horizontally whenever what is drawn changes.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
  }, [focusId, people.length, term, siteName, zoom]);

  // Drag anywhere on the canvas to pan.
  // Panning starts only after a few pixels of movement, so a plain click still reaches the card.
  const drag = useRef<{ x: number; y: number; left: number; top: number; active: boolean } | null>(null);
  const onPointerDown = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest('button, a')) return;
    const el = scroller.current!;
    drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, active: false };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const el = scroller.current!;
    if (!d.active) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
      d.active = true;
      el.setPointerCapture(e.pointerId);
    }
    el.scrollLeft = d.left - (e.clientX - d.x);
    el.scrollTop = d.top - (e.clientY - d.y);
  };
  const endDrag = () => { drag.current = null; };

  const PersonCard = ({ p, compact = false }: { p: Person; compact?: boolean }) => {
    const kids = (children.get(p.id) ?? []).filter(visible);
    const hit = matches?.has(p.id) && (term || siteName);
    const focused = focusId === p.id;
    return (
      <div className="relative flex flex-col items-center">
        <div
          id={`org-${p.id}`} role="button" tabIndex={0} onClick={() => focusOn(p.id)} onKeyDown={(e) => e.key === 'Enter' && focusOn(p.id)}
          className={`group relative w-56 cursor-pointer rounded-2xl border bg-surface px-4 pb-3 pt-4 text-center shadow-soft transition hover:-translate-y-0.5 hover:shadow-lift
            ${focused ? 'border-brand ring-4 ring-brand-soft' : hit ? 'border-brand' : 'border-line'} ${compact ? 'opacity-90' : ''}`}>
          <span className="absolute inset-x-0 top-0 h-1 rounded-t-2xl" style={{ background: toneOf(p.department ?? p.site) }} />
          <span className="mx-auto mb-2 flex size-11 items-center justify-center rounded-full text-sm font-bold text-white" style={{ background: toneOf(p.fullName) }}>
            {initials(p.fullName)}
          </span>
          <div className="truncate font-semibold text-fg">{p.fullName}</div>
          <div className="truncate text-xs text-fg-muted">{p.designation ?? '—'}</div>
          <div className="mt-1 truncate text-[11px] text-fg-subtle">{[p.department, p.site].filter(Boolean).join(' · ')}</div>
          {isManager(me) && (
            <button type="button" aria-label={`Open ${p.fullName}’s profile`} onClick={(e) => { e.stopPropagation(); navigate(`/employees/${p.id}`); }}
              className="absolute right-2 top-2 rounded-lg p-1 text-fg-subtle opacity-0 transition hover:bg-surface-subtle hover:text-brand group-hover:opacity-100">
              <ArrowUpRight size={15} />
            </button>
          )}
        </div>
        {!compact && kids.length > 0 && (
          <button type="button" onClick={() => toggle(p.id)} disabled={Boolean(matches)}
            className="relative z-10 -mt-3 flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-0.5 text-xs font-semibold text-fg-muted shadow-soft hover:border-brand hover:text-brand disabled:cursor-default">
            <Users size={12} /> {teamSize(p.id)} {isOpen(p.id) ? '▴' : '▾'}
          </button>
        )}
      </div>
    );
  };

  const Branch = ({ p }: { p: Person }) => {
    const kids = (children.get(p.id) ?? []).filter(visible);
    return (
      <li>
        <PersonCard p={p} />
        {kids.length > 0 && isOpen(p.id) && <ul>{kids.map((k) => <Branch key={k.id} p={k} />)}</ul>}
      </li>
    );
  };

  const focus = focusId ? byId.get(focusId) : undefined;
  const chain = focus ? ancestors(focus.id) : [];
  const shownRoots = focus ? [focus] : roots.filter(visible);

  return (
    <div className="space-y-6">
      <PageHeader title="Org chart" subtitle={`${people.length} ${people.length === 1 ? 'person' : 'people'} · click someone to see their managers and team`}
        filters={
          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
            <SearchInput value={q} onChange={setQ} placeholder="Find a person, role or department" />
            <SiteSelect value={siteFilter} onChange={setSiteFilter} />
            {focus && <Button variant="secondary" leftIcon={<Network size={16} />} onClick={() => setFocusId(null)}>Whole organisation</Button>}
          </div>
        } />
      <Card padding="none" className="relative overflow-hidden">
        <div className="absolute right-3 top-3 z-20 flex items-center gap-1 rounded-xl border border-line bg-surface p-1 shadow-soft">
          <IconButton label="Zoom out" icon={<Minus size={16} />} onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)))} />
          <button type="button" className="w-12 text-center text-xs font-semibold text-fg-muted" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
          <IconButton label="Zoom in" icon={<Plus size={16} />} onClick={() => setZoom((z) => Math.min(1.4, +(z + 0.1).toFixed(2)))} />
          <IconButton label="Fit" icon={<Maximize2 size={15} />} onClick={fit} />
        </div>
        <div ref={scroller} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}
          className="h-[calc(100vh-15rem)] min-h-[28rem] cursor-grab overflow-auto bg-[radial-gradient(var(--color-line-soft)_1px,transparent_1px)] [background-size:20px_20px] active:cursor-grabbing">
          <div className="inline-block min-w-full px-10 pb-12 pt-14" style={{ zoom }}>
            {!shownRoots.length ? (
              <EmptyState title="No one matches" />
            ) : (
              <div className="flex flex-col items-center">
                {chain.map((m) => (
                  <div key={m.id} className="flex flex-col items-center">
                    <PersonCard p={m} compact />
                    <span className="h-6 w-px bg-line-strong" />
                  </div>
                ))}
                <div className="org-tree">
                  <ul>{shownRoots.map((p) => <Branch key={p.id} p={p} />)}</ul>
                </div>
              </div>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
