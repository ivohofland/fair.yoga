// Post-class summary — the payoff screen. Earnings large, transparent breakdown below.
(function () {
  const C = window.FYC;

  window.S = window.S || {};
  window.S.PostClassSummary = function PostClassSummary({ nav }) {
    const c = window.MOCK.classes.find((x) => x.past) || window.MOCK.classes[4];
    const tiers = window.MOCK.tiers;
    const counts = window.MOCK.tierCounts;

    return (
      <div>
        <a onClick={() => nav('schedule')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-teal)', fontSize: 14, fontWeight: 500, textDecoration: 'none', marginBottom: 16 }}>
          <C.Icon name="arrow-left" size={16} /> Schedule
        </a>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <h1 className="type-display" style={{ margin: 0 }}>{c.type} · {c.day.split(',')[0]}</h1>
          <C.StatusBadge status="completed" />
        </div>
        <div className="type-caption" style={{ margin: '4px 0 24px' }}>{c.reg} attended · {c.where}</div>

        <C.Card style={{ background: 'var(--surface-selected)', border: 'none', textAlign: 'center' }}>
          <div className="type-label">You earn</div>
          <div style={{ fontFamily: 'var(--font-body)', fontWeight: 600, fontSize: 40, lineHeight: 1.25, fontVariantNumeric: 'tabular-nums', color: 'var(--color-teal)' }}>
            €{c.earnings.toFixed(2)}
          </div>
        </C.Card>

        <h2 className="type-subtitle" style={{ margin: '32px 0 4px' }}>How this was calculated</h2>
        <div>
          <C.ListRow trailing={<span className="type-number">€{c.total.toFixed(2)}</span>}><span className="type-body">Total for this class</span></C.ListRow>
          <C.ListRow trailing={<span className="type-number" style={{ color: 'var(--text-body)' }}>− €{c.roomCost.toFixed(2)}</span>}><span className="type-body">Room cost</span></C.ListRow>
          <C.ListRow trailing={<span className="type-number">€{c.earnings.toFixed(2)}</span>} divider={false}><span className="type-body" style={{ fontWeight: 600 }}>Your earnings</span></C.ListRow>
        </div>

        <h2 className="type-subtitle" style={{ margin: '32px 0 4px' }}>Per-tier prices</h2>
        <div className="type-caption" style={{ marginBottom: 4 }}>Highest pays 2.1× the lowest.</div>
        <div>
          {tiers.map((t, i) => (
            <C.ListRow key={t.tier} trailing={<span className="type-number">€{t.price.toFixed(2)}</span>} divider={i < tiers.length - 1}>
              <span className="type-body">Tier {t.tier}</span>
              <span className="type-caption" style={{ marginLeft: 8 }}>{counts[t.tier] || 0} students</span>
            </C.ListRow>
          ))}
        </div>

        <div style={{ marginTop: 32 }}>
          <C.Button variant="primary" fullWidth onClick={() => nav('payments')}>Payment checklist</C.Button>
        </div>
      </div>
    );
  };
})();
