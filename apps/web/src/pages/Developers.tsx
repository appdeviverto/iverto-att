import { CenteredSpinner, EmptyState } from '@iverto-org/core-ui';
import { ApiReferenceReact } from '@scalar/api-reference-react';
import '@scalar/api-reference-react/style.css';
import { ArrowLeft } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router';
// The prose guides (auth, errors, sync, webhooks, signing, changelog): one source, also in the repo.
import guide from '../../../../docs/public-api-reference.md?raw';
import { useApi } from '../lib/api';
import { useMe } from '../lib/auth';

/** The guide minus its title (the reference shows the API title) and repo-only links. */
const description = guide.replace(/^# .*\n/, '').replace(/\[([^\]]+)\]\((?!https?:)[^)]+\)/g, '$1');

/** Brand accent + app font on Scalar's default theme; the header bar offsets its sticky sidebar. */
const CSS = `
.scalar-app, .scalar-api-reference { --scalar-custom-header-height: 48px; --scalar-font: "Poppins", ui-sans-serif, system-ui, sans-serif; }
.light-mode { --scalar-color-accent: #cd0447; --scalar-sidebar-color-active: #cd0447; --scalar-sidebar-item-active-background: #cd04471a; }
.dark-mode { --scalar-color-accent: #ff4d84; --scalar-sidebar-color-active: #ff4d84; --scalar-sidebar-item-active-background: #ff4d8426; }
`;

/**
 * API reference (docs/public-api.md §14), rendered with Scalar from the registry-generated
 * OpenAPI document. Org admins and superadmins only: the spec endpoints refuse anyone else.
 * Read-only on purpose: the public API refuses browsers (403 BROWSER_NOT_ALLOWED), so no
 * "try it" client, no proxy, no telemetry, no hosted AI agent, no third-party fonts.
 */
export default function Developers() {
  const me = useMe();
  const allowed = me.isSuperAdmin || me.role === 'ADMIN';
  const { data: raw, error } = useApi<Record<string, any>>(allowed ? (me.isSuperAdmin ? '/platform/api/openapi.json' : '/api-keys/openapi.json') : null, undefined, { staleTime: 10 * 60_000 });
  const content = useMemo(() => raw && { ...raw, info: { ...raw.info, description } }, [raw]);
  const back = me.isSuperAdmin ? '/platform/api' : '/settings/api';

  if (!allowed) return <EmptyState title="Only organisation admins can view the API reference" description="Ask an admin of your organisation for access." />;
  if (error) return <EmptyState title="Could not load the API reference" description={(error as Error).message} />;
  if (!content) return <CenteredSpinner />;

  return (
    <div className="min-h-screen">
      {/* Scalar's theme variables (set on <body>), so the bar follows its light/dark toggle. */}
      <header className="sticky top-0 z-[1000] flex h-12 items-center justify-between gap-3 border-b px-4"
        style={{ background: 'var(--scalar-background-1)', borderColor: 'var(--scalar-border-color)', color: 'var(--scalar-color-2)' }}>
        <Link to={back} className="inline-flex items-center gap-2 text-sm font-medium hover:opacity-80" style={{ color: 'var(--scalar-color-1)' }}>
          <ArrowLeft size={16} /> Back to Iverto Attend
        </Link>
        <span className="hidden text-xs sm:inline">
          <kbd className="rounded border px-1.5 py-0.5 font-mono" style={{ borderColor: 'var(--scalar-border-color)' }}>Ctrl K</kbd> to search · Postman: download the OpenAPI JSON → Import
        </span>
      </header>
      <ApiReferenceReact
        configuration={{
          content,
          title: 'Iverto Attend API',
          customCss: CSS,
          withDefaultFonts: false,
          telemetry: false,
          agent: { disabled: true },
          mcp: { disabled: true },
          hideClientButton: true,
          hideTestRequestButton: true,
          showDeveloperTools: 'never',
          persistAuth: false,
          documentDownloadType: 'json',
          defaultOpenFirstTag: true,
          orderRequiredPropertiesFirst: true,
          defaultHttpClient: { targetKey: 'shell', clientKey: 'curl' },
          // Placeholder in every snippet; a real key typed into the auth box stays in this tab only.
          authentication: { preferredSecurityScheme: 'apiKey', securitySchemes: { apiKey: { token: 'YOUR_API_KEY' } } },
        }}
      />
    </div>
  );
}
