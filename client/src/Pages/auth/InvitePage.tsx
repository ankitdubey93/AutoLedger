import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth, useAuthActions } from '../../context/AuthContext';
import { useOrg } from '../../context/OrgContext';
import { acceptInvitation, previewInvitation, type InvitationPreview } from '../../services/fetchServices';
import AuthLayout from './AuthLayout';
import LoadingState from '../../components/ui/LoadingState';

/**
 * Phase 37 — where an invitation link lands. Public: the invitee may not
 * have an account yet.
 *
 * Accepting needs both the link and a signed-in account with the invited
 * email (the server checks; this page only steers): signed out, it offers
 * sign-in (returning here through LoginPage's `state.from`) or sign-up in
 * invite mode; signed in with another address, it says so and offers to
 * sign out.
 */
export default function InvitePage() {
  const { token = '' } = useParams();
  const auth = useAuth();
  const { logout } = useAuthActions();
  const { enterSession } = useOrg();

  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    previewInvitation(token)
      .then((res) => {
        if (!ignore) setPreview(res.invitation);
      })
      .catch((err: unknown) => {
        if (!ignore) setLoadError(err instanceof Error ? err.message : 'Could not load this invitation');
      });
    return () => {
      ignore = true;
    };
  }, [token]);

  async function accept() {
    setAccepting(true);
    setAcceptError(null);
    try {
      enterSession(await acceptInvitation(token));
    } catch (err) {
      setAcceptError(err instanceof Error ? err.message : 'Could not accept the invitation');
      setAccepting(false);
    }
  }

  if (loadError !== null) {
    return (
      <AuthLayout title="Invitation" subtitle="This link could not be used.">
        <p className="status status--bad" role="alert">
          {loadError}
        </p>
        <p className="muted m-0">
          <Link to="/login">Go to sign in</Link>
        </p>
      </AuthLayout>
    );
  }

  if (preview === null || auth.status === 'checking') {
    return (
      <AuthLayout title="Invitation" subtitle="Loading…">
        <LoadingState />
      </AuthLayout>
    );
  }

  const inviter = preview.invitedByName ?? 'Someone';
  const subtitle = `${inviter} invited ${preview.email} to join as ${preview.role}.`;

  if (preview.status !== 'PENDING') {
    const why = preview.status === 'ACCEPTED' ? 'has already been used' : `has ${preview.status.toLowerCase()}`;
    return (
      <AuthLayout title={`Join ${preview.organizationName}`} subtitle={subtitle}>
        <p className="status status--bad">This invitation {why}. Ask for a new one.</p>
        <p className="muted m-0">
          <Link to="/">Go to AutoLedger</Link>
        </p>
      </AuthLayout>
    );
  }

  if (auth.status === 'anonymous') {
    const here = `/invite/${token}`;
    return (
      <AuthLayout title={`Join ${preview.organizationName}`} subtitle={subtitle}>
        <div className="card form">
          <p className="m-0">
            Already have an account for <strong>{preview.email}</strong>? Sign in to accept.
          </p>
          <Link to="/login" state={{ from: here }} className="btn no-underline text-center">
            Sign in
          </Link>
          <Link to={`/register?invite=${encodeURIComponent(token)}`} className="text-center">
            New to AutoLedger? Create an account
          </Link>
        </div>
      </AuthLayout>
    );
  }

  const emailMatches = auth.user.email.toLowerCase() === preview.email;

  return (
    <AuthLayout title={`Join ${preview.organizationName}`} subtitle={subtitle}>
      <div className="card form">
        {emailMatches ? (
          <>
            <p className="m-0">
              You will be able to switch between {preview.organizationName} and your other organizations from the top
              bar.
            </p>
            {acceptError !== null && (
              <p className="status status--bad" role="alert">
                {acceptError}
              </p>
            )}
            <button type="button" className="btn" disabled={accepting} onClick={() => void accept()}>
              {accepting ? 'Joining…' : `Join ${preview.organizationName}`}
            </button>
          </>
        ) : (
          <>
            <p className="m-0">
              You are signed in as <strong>{auth.user.email}</strong>, but this invitation was sent to{' '}
              <strong>{preview.email}</strong>. Sign out and sign in with that address to accept it.
            </p>
            <button type="button" className="btn" onClick={() => void logout()}>
              Sign out
            </button>
          </>
        )}
      </div>
    </AuthLayout>
  );
}
