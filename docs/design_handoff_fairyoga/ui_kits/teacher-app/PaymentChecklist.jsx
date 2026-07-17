// Payment checklist — simple rows, unpaid is brown, never alarming.
(function () {
  const C = window.FYC;
  const { useState } = React;

  window.S = window.S || {};
  window.S.PaymentChecklist = function PaymentChecklist({ nav }) {
    const [pays, setPays] = useState(window.MOCK.payments);
    const toggle = (id) => setPays(pays.map((p) => (p.id === id ? { ...p, paid: !p.paid } : p)));
    const outstanding = pays.filter((p) => !p.paid).reduce((s, p) => s + p.amt, 0);

    return (
      <div>
        <a onClick={() => nav('summary')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-teal)', fontSize: 14, fontWeight: 500, textDecoration: 'none', marginBottom: 16 }}>
          <C.Icon name="arrow-left" size={16} /> Summary
        </a>
        <h1 className="type-display" style={{ margin: 0 }}>Payments</h1>
        <div className="type-caption" style={{ margin: '4px 0 24px' }}>
          {outstanding > 0 ? `€${outstanding.toFixed(2)} outstanding` : 'All paid'}
        </div>

        <div>
          {pays.map((p) => (
            <C.ListRow
              key={p.id}
              trailing={
                <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span className="type-number" style={{ color: p.paid ? 'var(--status-paid-fg)' : 'var(--text-body)' }}>€{p.amt.toFixed(2)}</span>
                  <button
                    onClick={() => toggle(p.id)}
                    style={{
                      height: 36, padding: '0 16px', borderRadius: 999, fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 500,
                      border: p.paid ? '1.5px solid transparent' : '1.5px solid var(--color-teal)',
                      background: p.paid ? 'var(--color-teal)' : 'transparent',
                      color: p.paid ? 'var(--color-cream)' : 'var(--color-teal)',
                    }}
                  >
                    {p.paid ? 'Paid' : 'Mark paid'}
                  </button>
                </span>
              }
            >
              <span className="type-body" style={{ color: 'var(--text-strong)' }}>{p.name}</span>
              <div className="type-caption" style={{ color: p.paid ? 'var(--status-paid-fg)' : 'var(--status-unpaid-fg)' }}>{p.paid ? '✓ Paid' : '○ Unpaid'}</div>
            </C.ListRow>
          ))}
        </div>

        <div style={{ marginTop: 24 }}>
          <C.Button variant="ghost" fullWidth>Send reminder</C.Button>
        </div>
      </div>
    );
  };
})();
