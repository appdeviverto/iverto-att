import { Button, CenteredSpinner, EmptyState } from '@iverto-org/core-ui';
import { ArrowLeft, Download } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router';
import { RedocStandalone } from 'redoc';
// The prose guides (auth, errors, sync, webhooks, signing, changelog): one source, also in the repo.
import guide from '../../../../docs/public-api-reference.md?raw';
import { useApi } from '../lib/api';
import { useMe } from '../lib/auth';

/** The guide minus its title (Redoc shows the API title) and repo-only links. */
const description = guide.replace(/^# .*\n/, '').replace(/\[([^\]]+)\]\((?!https?:)[^)]+\)/g, '$1');

const THEME = {
  colors: { primary: { main: '#cd0447' } },
  typography: {
    fontFamily: '"Poppins", ui-sans-serif, system-ui, sans-serif',
    fontSize: '15px',
    headings: { fontFamily: '"Poppins", ui-sans-serif, system-ui, sans-serif', fontWeight: '600' },
    code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
  },
  sidebar: { width: '280px' },
  rightPanel: { backgroundColor: '#1f2433' },
};

/**
 * API reference (docs/public-api.md §14), rendered with Redoc from the registry-generated
 * OpenAPI document. Org admins and superadmins only: the spec endpoints refuse anyone else.
 * Full-screen (outside the app layout) so Redoc's sticky menu and scroll tracking work.
 */
export default function Developers() {
  const me = useMe();
  const allowed = me.isSuperAdmin || me.role === 'ADMIN';
  const { data: raw, error } = useApi<Record<string, any>>(allowed ? (me.isSuperAdmin ? '/platform/api/openapi.json' : '/api-keys/openapi.json') : null, undefined, { staleTime: 10 * 60_000 });
  const spec = useMemo(() => raw && { ...raw, info: { ...raw.info, description } }, [raw]);
  const back = me.isSuperAdmin ? '/platform/api' : '/settings/api';

  if (!allowed) return <EmptyState title="Only organisation admins can view the API reference" description="Ask an admin of your organisation for access." />;
  if (error) return <EmptyState title="Could not load the API reference" description={(error as Error).message} />;
  if (!spec) return <CenteredSpinner />;

  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(spec, null, 2)], { type: 'application/json' }));
    Object.assign(document.createElement('a'), { href: url, download: `iverto-attend-openapi-${spec.info.version}.json` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  return (
    <div className="min-h-screen bg-white">
      <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-gray-200 bg-white px-4 py-2">
        <Link to={back} className="inline-flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-gray-900">
          <ArrowLeft size={16} /> Back to Iverto Attend
        </Link>
        <div className="flex items-center gap-2">
          <span className="hidden text-xs text-gray-500 sm:inline">Postman: Import → File → this JSON</span>
          <Button size="sm" variant="secondary" leftIcon={<Download size={14} />} onClick={download}>OpenAPI JSON</Button>
        </div>
      </header>
      <RedocStandalone spec={spec} options={{ theme: THEME, scrollYOffset: 49, hideDownloadButton: true, expandResponses: '200,201,202', jsonSampleExpandLevel: 2, pathInMiddlePanel: true, sortTagsAlphabetically: false }} />
    </div>
  );
}
