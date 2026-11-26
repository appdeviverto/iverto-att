import './index.css';
import { CenteredSpinner, ConfirmHost, EmptyState, ReasonDialogHost, ThemeProvider, Toaster } from '@iverto-org/core-ui';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation } from 'react-router';
import { Layout, PlatformLayout } from './components/Layout';
import { CACHE_MAX_AGE, clearCache, persistable, persister, queryClient, useFeatures } from './lib/api';
import { AuthProvider, isManager, useAuth, useMe } from './lib/auth';
import { ForgotPassword, Login, MfaChallenge, MfaSetup, ResetPassword, SetPassword, Suspended } from './pages/Auth';
import { Corrections, Daily, Logs, Overview } from './pages/Attendance';
import { EmployeeDetail, Employees } from './pages/Employees';
import { Assets, Announcements, Expenses, MyTasks, OrgChart, ProfileChanges } from './pages/Hr';
import { Leaderboard } from './pages/Leaderboard';
import { MyPayslips, Payroll, PayrollRun } from './pages/Payroll';
import { Leave, RemoteCheckIns, RemoteWork } from './pages/Leave';
import { Live } from './pages/Live';
import { PlatformAnnouncements, TenantDetail, Tenants } from './pages/Platform';
import { PlatformApi } from './components/ApiAccess';
import { Reports } from './pages/Reports';
import { Holidays } from './pages/Holidays';
import { Patterns, Roster, Shifts } from './pages/Schedule';
import { Settings } from './pages/Settings';
import { Enrollment, Terminals } from './pages/Terminals';

/** HR and payroll pages only for tenants the platform switched the module on for. */
function RequireFeature({ feature }: { feature: 'hr' | 'payroll' }) {
  const features = useFeatures();
  if (!features.loaded) return <CenteredSpinner />;
  if (!features[feature]) {
    return <EmptyState title={`${feature === 'hr' ? 'HR' : 'Payroll'} isn’t enabled for your organisation`} description="Contact Iverto to switch it on. Everything else keeps working as before." />;
  }
  return <Outlet />;
}

/** Signed in → the persisted cache for *this* user (and tenant, for platform admins) is restored. */
function RequireAuth() {
  const { session, me, mfa, override, suspended } = useAuth();
  const { pathname } = useLocation();
  if (session === undefined) return <CenteredSpinner />;
  if (!session || !me) return <Navigate to="/login" replace />;
  if (me.mustChangePassword) return pathname === '/set-password' ? <SetPassword /> : <Navigate to="/set-password" replace />;
  // 2FA comes after the temporary password is replaced; existing accounts enrol on their next sign-in.
  if (mfa === undefined) return <CenteredSpinner />;
  if (mfa === 'enroll') return <MfaSetup />;
  if (mfa === 'challenge') return <MfaChallenge />;
  if (suspended) return <Suspended />;
  if (me.isSuperAdmin && !override && !pathname.startsWith('/platform')) return <Navigate to="/platform" replace />;
  return (
    <PersistQueryClientProvider key={`${me.id}:${override ?? ''}`} client={queryClient}
      persistOptions={{ persister, maxAge: CACHE_MAX_AGE, buster: `${me.id}:${override ?? ''}`, dehydrateOptions: { shouldDehydrateQuery: persistable } }}>
      <Outlet />
    </PersistQueryClientProvider>
  );
}

/** The API reference (Scalar) is big: its own chunk, loaded only when someone opens the API reference. */
const Developers = lazy(() => import('./pages/Developers'));
const developers = <Suspense fallback={<CenteredSpinner />}><Developers /></Suspense>;

function Home() {
  return <Navigate to={isManager(useMe()) ? '/live' : '/attendance/daily'} replace />;
}

const router = createBrowserRouter([
  { path: '/login', element: <Login /> },
  { path: '/forgot-password', element: <ForgotPassword /> },
  { path: '/reset-password', element: <ResetPassword /> },
  {
    element: <RequireAuth />,
    children: [
      { path: '/set-password', element: <SetPassword /> },
      // Full-screen API reference: org admins (developers) and superadmins (platform/developers).
      { path: '/developers', element: developers },
      { path: '/platform/developers', element: developers },
      { path: '/platform', element: <PlatformLayout />, children: [{ index: true, element: <Tenants /> }, { path: 'announcements', element: <PlatformAnnouncements /> }, { path: 'api', element: <PlatformApi /> }, { path: ':id', element: <TenantDetail /> }] },
      {
        element: <Layout />,
        children: [
          { index: true, element: <Home /> },
          { path: 'live', element: <Live /> },
          { path: 'attendance/daily', element: <Daily /> },
          { path: 'attendance/logs', element: <Logs /> },
          { path: 'attendance/overview', element: <Overview /> },
          { path: 'attendance/corrections', element: <Corrections /> },
          { path: 'attendance/leaderboard', element: <Leaderboard /> },
          { path: 'employees', element: <Employees /> },
          { path: 'employees/:id', element: <EmployeeDetail /> },
          { path: 'schedule/shifts', element: <Shifts /> },
          { path: 'schedule/patterns', element: <Patterns /> },
          { path: 'schedule/roster', element: <Roster /> },
          { path: 'schedule/holidays', element: <Holidays /> },
          { path: 'leave/:tab', element: <Leave /> },
          { path: 'leave', element: <Navigate to="/leave/requests" replace /> },
          { path: 'remote-work', element: <RemoteWork /> },
          { path: 'remote-work/check-ins', element: <RemoteCheckIns /> },
          { path: 'reports', element: <Reports /> },
          { path: 'terminals', element: <Terminals /> },
          { path: 'enrollment', element: <Enrollment /> },
          {
            element: <RequireFeature feature="payroll" />,
            children: [
              { path: 'payroll/runs/:id', element: <PayrollRun /> },
              { path: 'payroll/mine', element: <MyPayslips /> },
              { path: 'payroll/:tab', element: <Payroll /> },
              { path: 'payroll', element: <Navigate to="/payroll/runs" replace /> },
            ],
          },
          {
            element: <RequireFeature feature="hr" />,
            children: [
              { path: 'hr/expenses', element: <Expenses /> },
              { path: 'hr/assets', element: <Assets /> },
              { path: 'hr/announcements', element: <Announcements /> },
              { path: 'hr/org-chart', element: <OrgChart /> },
              { path: 'hr/tasks', element: <MyTasks /> },
            ],
          },
          { path: 'hr/profile-changes', element: <ProfileChanges /> },
          { path: 'settings/:section?', element: <Settings /> },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider defaultPreference="light">
      <AuthProvider onSignOut={clearCache}>
        <RouterProvider router={router} />
      </AuthProvider>
      <Toaster />
      <ConfirmHost />
      <ReasonDialogHost />
    </ThemeProvider>
  </StrictMode>,
);
