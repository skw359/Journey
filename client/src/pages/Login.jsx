import { useState } from 'react';
import { Map as MapIcon } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import VisualCanvas from './VisualCanvas';
import './Login.css';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login({ username: username.trim(), password });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = () => {
    setError('Password reset is not available yet. Contact your administrator.');
  };

  const handleCreateAccount = () => {
    setError('');
    navigate('/register');
  };

  return (
    <div className="login-page">
      <div className="login-wrapper">
        <div className="visual-side" aria-hidden="true">
          <VisualCanvas />
          <div className="visual-content">
            <h2>
              The <span className="highlight">first-class</span>
              <br />
              timeline platform.
            </h2>
          </div>
          <div className="visual-footer">
            <p>© 2026 Journey Inc.</p>
          </div>
        </div>

        <div className="form-side">
          <div className="logo">
            <MapIcon size={18} strokeWidth={2.2} aria-hidden="true" />
            <span>Journey</span>
          </div>

          <div className="header-text">
            <h1>Login to Continue</h1>
            <p></p>
          </div>

          <form className="login-form" onSubmit={handleSubmit}>
            {error && <div className="login-error" role="alert">{error}</div>}

            <div className="input-group">
              <div className="input-wrapper">
                <input
                  id="login-username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  placeholder="Username or Email"
                  aria-label="Username or Email"
                  disabled={loading}
                  required
                />
              </div>
            </div>

            <div className="input-group">
              <div className="input-wrapper">
                <input
                  id="login-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  aria-label="Password"
                  disabled={loading}
                  required
                />
              </div>
            </div>

            <div className="actions">
              <button className="forgot-pass" type="button" onClick={handleForgotPassword} disabled={loading}>
                Forgot password?
              </button>
            </div>

            <button className="btn-primary" type="submit" disabled={loading}>
              {loading ? 'Logging in...' : 'Log in'}
            </button>
          </form>

          <p className="signup-link">
            Don't have an account?
            <button type="button" onClick={handleCreateAccount} disabled={loading}>Create one.</button>
          </p>
        </div>
      </div>
    </div>
  );
}
