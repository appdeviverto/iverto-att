import { AuthHighlights, AuthShell, Button, Callout, CopyField, IconButton, PasswordStrength, TextField } from '@iverto-org/core-ui';
import { Activity, CalendarRange, Eye, EyeOff, Lock, Mail, ScanFace, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { changeOwnPassword, post } from '../lib/api';
import { supabase, useAuth } from '../lib/auth';

/** Password input with a show/hide toggle and a caps-lock warning. */
function PasswordField({ label, autoComplete, value, onChange, minLength, leadingIcon }: {
  label: string; autoComplete: string; value: string; onChange: (v: string) => void; minLength?: number; leadingIcon?: ReactNode;
}) {
  const [shown, setShown] = useState(false);
  const [caps, setCaps] = useState(false);
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => setCaps(e.getModifierState?.('CapsLock') ?? false);
  return (
    <TextField label={label} type={shown ? 'text' : 'password'} autoComplete={autoComplete} required minLength={minLength} leadingIcon={leadingIcon}
      value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} onKeyUp={onKey} hint={caps ? 'Caps Lock is on' : undefined}
      trailing={<IconButton label={shown ? 'Hide password' : 'Show password'} icon={shown ? <EyeOff size={16} /> : <Eye size={16} />} onClick={() => setShown(!shown)} />} />
  );
}

const HIGHLIGHTS = [
  { icon: ScanFace, title: 'Face-recognition terminals', body: 'Every scan lands in seconds — no cards, no buddy punching.' },
  { icon: Activity, title: 'Live board', body: 'See who is in, late, on break or remote, right now, across every site.' },
  { icon: CalendarRange, title: 'Shifts, leave & holidays', body: 'Rosters, location holiday calendars and leave balances that add up on their own.' },
];

/** Email + password straight to Supabase; the tenant comes from the account, so there is no tenant picker (§13.2). */
export function Login() {
  const { session } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (session) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) setError(error.message === 'Invalid login credentials' ? 'That email and password don’t match. Use “Forgot your password?” below if you can’t remember it.' : error.message);
  };

  return (
    <AuthShell
      aside={<AuthHighlights headline="Attendance that" accent="runs itself." lede="Iverto Attendance turns terminal scans, schedules and leave into payroll-ready days — automatically." highlights={HIGHLIGHTS} />}
      footer={<p className="mt-6 text-xs text-fg-subtle">© {new Date().getFullYear()} Iverto AI · Iverto Attendance</p>}>
      <form onSubmit={submit} className="space-y-5">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-fg">Welcome back</h1>
          <p className="text-sm text-fg-muted">Sign in with the email your HR team set up for you.</p>
        </div>
        {error && <Callout tone="danger" title="Couldn’t sign you in">{error}</Callout>}
        <TextField label="Email" type="email" autoComplete="username" autoFocus required placeholder="you@company.com" leadingIcon={<Mail size={18} />} value={email} onChange={(e) => setEmail(e.target.value)} />
        <PasswordField label="Password" autoComplete="current-password" leadingIcon={<Lock size={18} />} value={password} onChange={setPassword} />
        <Button type="submit" fullWidth loading={busy}>Sign in</Button>
        <p className="text-center text-sm"><Link to="/forgot-password" className="font-medium text-fg-muted underline hover:text-fg">Forgot your password?</Link></p>
      </form>
    </AuthShell>
  );
}

/** First login: the API refuses everything but this until the temporary password is replaced (§13). */
export function SetPassword() {
  const { me, signOut } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setError('The two new passwords don’t match.');
    setBusy(true);
    setError('');
    try {
      await changeOwnPassword(me!.email, current, next);
      navigate('/', { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <form onSubmit={submit} className="space-y-5">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-fg">Set a new password</h1>
          <p className="text-sm text-fg-muted">Replace the temporary password HR gave you. You’ll stay signed in.</p>
        </div>
        {error && <Callout tone="danger" title="Password not changed">{error}</Callout>}
        <PasswordField label="Temporary password" autoComplete="current-password" value={current} onChange={setCurrent} />
        <PasswordField label="New password" autoComplete="new-password" minLength={10} value={next} onChange={setNext} />
        <PasswordStrength password={next} email={me?.email} />
        <PasswordField label="Confirm new password" autoComplete="new-password" minLength={10} value={confirm} onChange={setConfirm} />
        <Button type="submit" fullWidth loading={busy}>Save and continue</Button>
        <Button variant="ghost" fullWidth onClick={() => void signOut()}>Sign out</Button>
      </form>
    </AuthShell>
  );
}

/** Six-digit authenticator code field. */
function CodeField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <TextField label="6-digit code" inputMode="numeric" autoComplete="one-time-code" autoFocus required pattern="\d{6}" maxLength={6}
      placeholder="123456" value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))} />
  );
}

/**
 * Two-factor setup, once per account: scan the QR in an authenticator app and
 * confirm one code. Supabase Auth MFA does the TOTP; the API refuses web routes
 * until the session is aal2.
 */
export function MfaSetup() {
  const { signOut } = useAuth();
  const [factor, setFactor] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      // A setup abandoned on an earlier visit would block a new one; clear it.
      const { data } = await supabase.auth.mfa.listFactors();
      for (const f of data?.all ?? []) if (f.status === 'unverified') await supabase.auth.mfa.unenroll({ factorId: f.id });
      const { data: enrolled, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', issuer: 'Iverto Attendance', friendlyName: 'Iverto Attendance' });
      if (error) return setError(error.message);
      setFactor({ id: enrolled.id, qr: enrolled.totp.qr_code, secret: enrolled.totp.secret });
    })();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!factor) return;
    setBusy(true);
    setError('');
    // Success swaps in an aal2 session, which lets the app open.
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
    setBusy(false);
    if (error) setError('That code didn’t match. Check your phone sets its time automatically, then try the newest code.');
  };

  return (
    <AuthShell>
      <form onSubmit={submit} className="space-y-5">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-fg"><ShieldCheck size={24} /> Set up two-factor sign-in</h1>
          <p className="text-sm text-fg-muted">Scan this QR code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…), then enter the 6-digit code it shows. You’ll need a code each time you sign in on the web.</p>
        </div>
        {error && <Callout tone="danger" title="Not set up yet">{error}</Callout>}
        {factor ? (
          <>
            <div className="flex justify-center"><img src={factor.qr} alt="QR code for your authenticator app" className="size-48 rounded-lg bg-white p-2" /></div>
            <CopyField label="Can’t scan? Enter this key instead" value={factor.secret} />
            <CodeField value={code} onChange={setCode} />
            <Button type="submit" fullWidth loading={busy}>Verify and continue</Button>
          </>
        ) : !error && <p className="text-center text-sm text-fg-muted">Preparing your QR code…</p>}
        <Button variant="ghost" fullWidth onClick={() => void signOut()}>Sign out</Button>
      </form>
    </AuthShell>
  );
}

/** Every web sign-in after setup: one code from the authenticator app. */
export function MfaChallenge() {
  const { me, signOut } = useAuth();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const { data } = await supabase.auth.mfa.listFactors();
    const factor = data?.totp.find((f) => f.status === 'verified');
    const { error } = factor ? await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code }) : { error: new Error('No authenticator is set up') };
    setBusy(false);
    if (error) setError('That code didn’t match. Try the newest code from your authenticator app.');
  };

  return (
    <AuthShell>
      <form onSubmit={submit} className="space-y-5">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-fg"><ShieldCheck size={24} /> Two-factor sign-in</h1>
          <p className="text-sm text-fg-muted">Enter the 6-digit code from your authenticator app{me?.email ? ` for ${me.email}` : ''}.</p>
        </div>
        {error && <Callout tone="danger" title="Couldn’t verify">{error}</Callout>}
        <CodeField value={code} onChange={setCode} />
        <Button type="submit" fullWidth loading={busy}>Verify</Button>
        <p className="text-center text-xs text-fg-subtle">Lost your phone? Ask HR or your admin to reset two-factor sign-in for your account.</p>
        <Button variant="ghost" fullWidth onClick={() => void signOut()}>Sign out</Button>
      </form>
    </AuthShell>
  );
}

/** Asks the API to e-mail a reset link (sent through Resend). Same answer whether or not the account exists. */
export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await post('/auth/forgot-password', { email: email.trim() });
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <form onSubmit={submit} className="space-y-5">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-fg">Forgot your password?</h1>
          <p className="text-sm text-fg-muted">Enter the email you sign in with and we’ll send you a link to set a new password.</p>
        </div>
        {sent ? (
          <Callout tone="success" title="Check your inbox">If an account exists for {email.trim()}, a reset link is on its way. It works once and expires in an hour.</Callout>
        ) : (
          <>
            {error && <Callout tone="danger" title="Couldn’t send the link">{error}</Callout>}
            <TextField label="Email" type="email" autoComplete="username" autoFocus required placeholder="you@company.com" leadingIcon={<Mail size={18} />} value={email} onChange={(e) => setEmail(e.target.value)} />
            <Button type="submit" fullWidth loading={busy}>Send reset link</Button>
          </>
        )}
        <p className="text-center text-sm"><Link to="/login" className="font-medium text-fg-muted underline hover:text-fg">Back to sign in</Link></p>
      </form>
    </AuthShell>
  );
}

/** The e-mailed link lands here with ?token=…; the API spends the token and sets the password. */
export function ResetPassword() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setError('The two new passwords don’t match.');
    setBusy(true);
    setError('');
    try {
      await post('/auth/reset-password', { token, newPassword: next });
      // The API revoked every session, including any in this browser.
      await supabase.auth.signOut({ scope: 'local' });
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <form onSubmit={submit} className="space-y-5">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-fg">Set a new password</h1>
          <p className="text-sm text-fg-muted">You’ll be signed out everywhere and can sign in with the new password straight away.</p>
        </div>
        {!token ? (
          <Callout tone="danger" title="This link is incomplete">Open the link from the e-mail again, or <Link to="/forgot-password" className="underline">ask for a new one</Link>.</Callout>
        ) : done ? (
          <>
            <Callout tone="success" title="Password changed">Sign in with your new password.</Callout>
            <Button fullWidth onClick={() => navigate('/login', { replace: true })}>Go to sign in</Button>
          </>
        ) : (
          <>
            {error && <Callout tone="danger" title="Password not changed">{error} <Link to="/forgot-password" className="underline">Get a new link</Link></Callout>}
            <PasswordField label="New password" autoComplete="new-password" minLength={10} value={next} onChange={setNext} />
            <PasswordStrength password={next} />
            <PasswordField label="Confirm new password" autoComplete="new-password" minLength={10} value={confirm} onChange={setConfirm} />
            <Button type="submit" fullWidth loading={busy}>Save new password</Button>
          </>
        )}
      </form>
    </AuthShell>
  );
}

export function Suspended() {
  const { signOut } = useAuth();
  return (
    <AuthShell>
      <div className="space-y-5">
        <Callout tone="warning" title="Your organisation’s account is paused">
          Nothing is lost — terminals keep recording scans and everything syncs when the account is reactivated. Contact your administrator or Iverto support.
        </Callout>
        <Button variant="secondary" fullWidth onClick={() => void signOut()}>Sign out</Button>
      </div>
    </AuthShell>
  );
}
