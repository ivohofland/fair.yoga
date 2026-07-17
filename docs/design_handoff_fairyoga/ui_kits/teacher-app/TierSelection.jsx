// Tier selection (student side) — the most philosophically important screen.
(function () {
  const C = window.FYC;
  const { useState } = React;

  window.S = window.S || {};
  window.S.TierSelection = function TierSelection() {
    const [selected, setSelected] = useState(null);
    const tiers = window.MOCK.tiers;

    return (
      <div>
        <a style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-teal)', fontSize: 14, fontWeight: 500, textDecoration: 'none', marginBottom: 16 }}>
          <C.Icon name="arrow-left" size={16} /> Settings
        </a>
        <h1 className="type-display" style={{ margin: '0 0 8px' }}>Your tier</h1>
        <p className="type-body" style={{ margin: 0 }}>
          Your price for every class is based on what you can comfortably contribute. Tiers are self-reported — no proof needed, and you can change yours here at any time.
        </p>
        <p className="type-caption" style={{ fontFamily: 'var(--font-heading)', fontStyle: 'italic', margin: '16px 0 24px' }}>
          "Yoga is not about touching your toes. It is about what you learn on the way down." — Judith Hanson Lasater
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {tiers.map((t) => (
            <C.Card key={t.tier} onClick={() => setSelected(t.tier)} selected={selected === t.tier}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div className="type-label" style={{ color: 'var(--text-strong)', fontWeight: 600 }}>Tier {t.tier} · {t.label}</div>
                  <div className="type-caption" style={{ marginTop: 2 }}>
                    {t.tier === 1 && 'Money is tight right now'}
                    {t.tier === 2 && 'Covering the basics'}
                    {t.tier === 3 && 'Comfortable, with some room'}
                    {t.tier === 4 && 'Doing well financially'}
                    {t.tier === 5 && 'Happy to support others'}
                  </div>
                </div>
                <span className="type-number" style={{ fontSize: 18 }}>€{t.price.toFixed(2)}</span>
              </div>
            </C.Card>
          ))}
        </div>

        <div className="type-caption" style={{ margin: '16px 0 24px' }}>Highest pays 2.1× the lowest. Your tier applies to every class you book. <a style={{ color: 'var(--color-teal)' }}>Learn more</a></div>
        <C.Button variant="primary" fullWidth disabled={selected == null}>
          {selected == null ? 'Choose a tier' : `Save tier — €${tiers.find((t) => t.tier === selected).price.toFixed(2)} per class`}
        </C.Button>
      </div>
    );
  };
})();
