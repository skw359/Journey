import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { checkInvite } from '../api/auth';
import './Register.css';

const MIN_PASSWORD_LENGTH = 8;

export default function Register() {
  const { register, registration } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const invite = searchParams.get('invite') || '';
  const needsInvite = registration !== 'first-run';
  // 'checking' | 'valid' | 'invalid' | 'missing'
  const [inviteState, setInviteState] = useState(() => (!needsInvite ? 'valid' : invite ? 'checking' : 'missing'));
  const [username, setUsername] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!needsInvite || !invite) return undefined;
    let cancelled = false;
    checkInvite(invite)
      .then(({ valid }) => { if (!cancelled) setInviteState(valid ? 'valid' : 'invalid'); })
      .catch(() => { if (!cancelled) setInviteState('invalid'); });
    return () => { cancelled = true; };
  }, [needsInvite, invite]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      await register({
        username: username.trim(),
        password,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        invite: needsInvite ? invite : undefined,
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleBackToLogin = () => {
    navigate('/login');
  };

  return (
    <div className="register-page">
      <div className="register-wrapper">
        <div className="form-side">
          <div className="logo">
            <img src="/logo.png" alt="" aria-hidden="true" width={18} height={18} />
            <span>Journey</span>
          </div>

          <div className="header-text">
            <h1>Create Account</h1>
            <p>{!needsInvite ? 'This first account administers the server.' : ''}</p>
          </div>

          {inviteState !== 'valid' ? (
            <div className="register-error" role="alert">
              {inviteState === 'checking' && 'Checking your invite…'}
              {inviteState === 'missing' && 'Journey accounts are invite-only. Ask the server admin for an invite link.'}
              {inviteState === 'invalid' && 'This invite link has expired, was already used, or was revoked. Ask the server admin for a new one.'}
            </div>
          ) : (
          <form className="register-form" onSubmit={handleSubmit}>
            {error && <div className="register-error" role="alert">{error}</div>}

            <div className="register-row">
              <div className="input-group">
                <label htmlFor="reg-first">First Name</label>
                <div className="input-wrapper">
                  <input
                    id="reg-first"
                    type="text"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    autoComplete="given-name"
                    disabled={loading}
                    required
                  />
                </div>
              </div>

              <div className="input-group">
                <label htmlFor="reg-last">Last Name</label>
                <div className="input-wrapper">
                  <input
                    id="reg-last"
                    type="text"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    autoComplete="family-name"
                    disabled={loading}
                    required
                  />
                </div>
              </div>
            </div>

            <div className="input-group">
              <label htmlFor="reg-username">Username / Email</label>
              <div className="input-wrapper">
                <input
                  id="reg-username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  placeholder="Username or email"
                  disabled={loading}
                  required
                />
              </div>
            </div>

            <div className="input-group">
              <label htmlFor="reg-password">Password</label>
              <div className="input-wrapper">
                <input
                  id="reg-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                  disabled={loading}
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                />
              </div>
            </div>

            <div className="input-group">
              <label htmlFor="reg-confirm">Confirm Password</label>
              <div className="input-wrapper">
                <input
                  id="reg-confirm"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  placeholder="Re-enter your password"
                  disabled={loading}
                  required
                />
              </div>
            </div>

            <button className="btn-primary" type="submit" disabled={loading}>
              {loading ? 'Creating account...' : 'Create Account'}
            </button>
          </form>
          )}

          <p className="register-switch">
            Already have an account?
            <button type="button" onClick={handleBackToLogin} disabled={loading}>Log in.</button>
          </p>
        </div>
      </div>
    </div>
  );
}
