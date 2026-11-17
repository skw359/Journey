import { Component } from 'react';

// Contains a render error to the page it happened on. Without it, one broken page unmounts
// the whole app and leaves a blank screen. The header stays outside, so navigation still
// works; App gives each page its own boundary, so moving to another page starts clean.
export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('A page failed to render:', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page-error" role="alert">
        <h2>This page ran into a problem</h2>
        <p>Your journeys are safe. Try reloading, or open another page from the menu above.</p>
        <button type="button" className="page-error-btn" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
