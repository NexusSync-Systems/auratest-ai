import React from 'react';

/**
 * Bez error boundary shodila kterákoli chyba v renderu celé UI na bílou
 * stránku. Konkrétní kandidáti jsou místa, kde se sahá hluboko do dat ze
 * serveru: `v.nodes[0].failureSummary.replace(...)`,
 * `greenResult.green.rating.includes(...)`, `cookieResult.gdpr.suspiciousItems.length`.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Zachyceno v ErrorBoundary:', error, info?.componentStack);
  }

  handleReset = () => {
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          padding: '24px',
          margin: '24px',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: '8px',
          background: 'rgba(239, 68, 68, 0.08)',
          color: '#fff',
        }}
      >
        <h2 style={{ marginTop: 0 }}>Něco se pokazilo</h2>
        <p style={{ opacity: 0.85 }}>
          Zobrazení této části se nepodařilo vykreslit. Zbytek aplikace funguje dál.
        </p>
        <pre
          style={{
            whiteSpace: 'pre-wrap',
            fontSize: '0.85rem',
            opacity: 0.7,
            maxHeight: '160px',
            overflow: 'auto',
          }}
        >
          {String(this.state.error?.message || this.state.error)}
        </pre>
        <button type="button" className="btn" onClick={this.handleReset}>
          Zkusit znovu
        </button>
      </div>
    );
  }
}
