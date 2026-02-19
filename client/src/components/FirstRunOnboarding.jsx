import { Link } from 'react-router-dom';
import { Smartphone, Link2, CloudUpload, ArrowRight } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import './FirstRunOnboarding.css';

const steps = [
  {
    title: 'Pair Once',
    description: 'In the iPhone app Settings, pair it with this web dashboard.',
    icon: Link2,
  },
  {
    title: 'Record On iPhone',
    description: 'Open Journey on your iPhone or  Watch and start recording your trip.',
    icon: Smartphone,
  },
  {
    title: 'Auto Upload',
    description: 'Finished journeys sync here automatically after recording.',
    icon: CloudUpload,
  },
];

export default function FirstRunOnboarding() {
  const { user } = useAuth();
  const firstName = user?.firstName || user?.displayName?.split(' ')[0] || 'Traveler';

  return (
    <div className="first-run-shell" role="status" aria-live="polite">
      <div className="first-run-card">
        <h2 className="first-run-title">
          Welcome to Journey, <span style={{ color: '#01d67e' }}>{firstName}</span>
        </h2>

        <div className="first-run-steps">
          {steps.map((step, idx) => (
            <div key={step.title} className="first-run-step">
              <div className="first-run-step-icon">
                <step.icon size={18} />
              </div>
              <div className="first-run-step-body">
                <div className="first-run-step-number">{String(idx + 1).padStart(2, '0')}</div>
                <h3>{step.title}</h3>
                <p>{step.description}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="first-run-actions">
          <Link to="/pair" className="first-run-btn first-run-btn-primary">
            Pair
            <ArrowRight size={16} />
          </Link>
          <Link to="/settings" className="first-run-btn first-run-btn-secondary">
            Open Settings
          </Link>
        </div>
      </div>
    </div>
  );
}
