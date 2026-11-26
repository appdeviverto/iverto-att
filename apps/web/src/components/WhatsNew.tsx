import { Badge, Button, Modal } from '@iverto-org/core-ui';
import { keyOf, post, queryClient, useApi } from '../lib/api';
import { useAuth, useMe } from '../lib/auth';
import { dateTime } from '../lib/format';

export interface PlatformAnnouncement { id: string; kind: 'UPDATE' | 'FEATURE' | 'CHANGELOG'; title: string; body: string; publishedAt: string }

export const ANNOUNCEMENT_KIND: Record<PlatformAnnouncement['kind'], { label: string; tone: 'brand' | 'info' | 'neutral' }> = {
  FEATURE: { label: 'New feature', tone: 'brand' },
  UPDATE: { label: 'System update', tone: 'info' },
  CHANGELOG: { label: 'Changelog', tone: 'neutral' },
};

export function AnnouncementBody({ a }: { a: PlatformAnnouncement }) {
  return (
    <article className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={ANNOUNCEMENT_KIND[a.kind].tone}>{ANNOUNCEMENT_KIND[a.kind].label}</Badge>
        <span className="text-xs text-fg-subtle">{dateTime(a.publishedAt)}</span>
      </div>
      <h3 className="font-semibold text-fg">{a.title}</h3>
      <p className="whitespace-pre-wrap text-sm text-fg-muted">{a.body}</p>
    </article>
  );
}

/** Iverto's announcements, once per org admin: closing the popup marks everything shown as seen. */
export function WhatsNew() {
  const me = useMe();
  const { override } = useAuth();
  const path = me.role === 'ADMIN' && !override ? '/whats-new' : null;
  const items = useApi<PlatformAnnouncement[]>(path).data ?? [];
  if (!items.length) return null;
  const close = () => {
    queryClient.setQueryData(keyOf('/whats-new'), []);
    void post('/whats-new/seen').catch(() => undefined); // worst case it shows again next visit
  };
  return (
    <Modal open onClose={close} size="lg" title="What's new" description="From the Iverto team"
      footer={<Button onClick={close}>Got it</Button>}>
      <div className="divide-y divide-line-soft p-5 sm:p-6 [&>*]:py-4 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
        {items.map((a) => <AnnouncementBody key={a.id} a={a} />)}
      </div>
    </Modal>
  );
}
