import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import './Register.css';

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (password.length < 4) {
      setError('Password must be at least 4 characters.');
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
            <p></p>
          </div>

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
                  placeholder="At least 4 characters"
                  disabled={loading}
                  required
                  minLength={4}
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

          <p className="register-switch">
            Already have an account?
            <button type="button" onClick={handleBackToLogin} disabled={loading}>Log in.</button>
          </p>
        </div>
      </div>
    </div>
  );
}
