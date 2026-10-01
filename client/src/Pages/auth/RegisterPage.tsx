import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useAuth, useAuthActions } from '../../context/AuthContext';
import { previewInvitation, type InvitationPreview } from '../../services/fetchServices';
import AuthLayout from './AuthLayout';

/**
 * Creates a user, their organization, and the OWNER membership binding them —
 * one server-side transaction (docs/architecture.md: an ERP is operated by a
 * company, so there is no such thing as a user without an organization).
 *
 * The organization name is asked for here rather than in a second onboarding
 * step precisely because the two must be created atomically.
 *
 * Phase 37 — `?invite=<token>` switches to invite mode: no organization is
 * created, the email is the invited one (locked), and the new account joins
 * the inviting organization in the same transaction.
 */
export default function RegisterPage() {
  const auth = useAuth();
  const { register } = useAuthActions();

  const [name, setName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [searchParams] = useSearchParams();
  const inviteToken = searchParams.get('invite');
  const [invite, setInvite] = useState<InvitationPreview | null>(null);

  useEffect(() => {
    if (inviteToken === null) return;
    let ignore = false;
    previewInvitation(inviteToken)
      .then((res) => {
        if (ignore) return;
        setInvite(res.invitation);
        setEmail(res.invitation.email);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'This invitation link is not valid');
      });
    return () => {
      ignore = true;
    };
  }, [inviteToken]);

  if (auth.status === 'authenticated') return <Navigate to="/" replace />;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      // register() also logs in, so the user experiences one action.
      await (inviteToken === null
        ? register({ name, email, password, organizationName })
        : register({ name, email, password, inviteToken }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create your account');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      title={inviteToken === null ? 'Create your organization' : `Join ${invite?.organizationName ?? 'your team'}`}
      subtitle={
        inviteToken === null
          ? 'You will be its owner. Setup takes about two minutes.'
          : `Create your account to join as ${invite?.roleName ?? 'a member'}.`
      }
    >

      <form className="card form" onSubmit={(e) => void onSubmit(e)}>
        {inviteToken === null && (
          <>
            <label htmlFor="organizationName">Organization name</label>
            <input
              id="organizationName"
              required
              minLength={2}
              value={organizationName}
              onChange={(e) => setOrganizationName(e.target.value)}
            />
          </>
        )}

        <label htmlFor="name">Your name</label>
        <input
          id="name"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          required
          // In invite mode the address is the invited one; the server refuses any other.
          readOnly={inviteToken !== null}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {/* The 72-byte ceiling is bcrypt's, and the server rejects anything over it. */}
        <p className="muted">At least 8 characters.</p>

        {error !== null && (
          <p className="status status--bad" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="btn" disabled={submitting || (inviteToken !== null && invite === null)}>
          {submitting ? 'Creating…' : 'Create account'}
        </button>
      </form>

      <p className="muted m-0">
        Already have an account? <Link to="/login">Sign in</Link>
      </p>
    </AuthLayout>
  );
}
