// Create class — stepped flow: basics → pricing → policies → confirmation.
(function () {
  const C = window.FYC;
  const { useState } = React;

  window.S = window.S || {};
  window.S.NewClassFlow = function NewClassFlow({ nav }) {
    const [step, setStep] = useState(0);
    const tiers = window.MOCK.tiers;
    const steps = ['Basics', 'Pricing', 'Policies'];

    const Dots = () => (
      <div className="type-caption" style={{ marginBottom: 24 }}>
        {step < 3 ? `Step ${step + 1} of 3 · ${steps[step]}` : 'Confirmation'}
      </div>
    );

    return (
      <div>
        <a onClick={() => (step === 0 || step === 3 ? nav('schedule') : setStep(step - 1))} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-teal)', fontSize: 14, fontWeight: 500, textDecoration: 'none', marginBottom: 16 }}>
          <C.Icon name="arrow-left" size={16} /> {step === 0 || step === 3 ? 'Schedule' : 'Back'}
        </a>
        <h1 className="type-display" style={{ margin: '0 0 4px' }}>{step === 3 ? 'Class created' : 'Create class'}</h1>
        <Dots />

        {step === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <C.Input label="Class type" value="Vinyasa" onChange={() => {}} />
            <C.Input label="Date" value="Monday, Apr 29" onChange={() => {}} />
            <C.Input label="Time" value="09:00" onChange={() => {}} />
            <C.Input label="Room" value="Studio A at Laurel St." onChange={() => {}} helper="Room cost €20.00 per class" />
            <C.Button variant="primary" fullWidth onClick={() => setStep(1)}>Next</C.Button>
          </div>
        )}

        {step === 1 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={{ display: 'flex', gap: 12 }}>
              <C.Input label="Minimum students" value="6" onChange={() => {}} style={{ flex: 1 }} />
              <C.Input label="Maximum students" value="14" onChange={() => {}} style={{ flex: 1 }} />
            </div>
            <div>
              <h2 className="type-subtitle" style={{ margin: '0 0 4px' }}>Pricing preview</h2>
              <div className="type-caption" style={{ marginBottom: 8 }}>What each tier pays, by class size</div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', fontSize: 12, fontWeight: 500, color: 'var(--color-teal)', padding: '6px 0', borderBottom: '1px solid var(--border-default)' }}>TIER</th>
                    {[6, 10, 14].map((n) => (
                      <th key={n} style={{ textAlign: 'right', fontSize: 12, fontWeight: 500, color: 'var(--color-teal)', padding: '6px 0', borderBottom: '1px solid var(--border-default)' }}>{n} STUDENTS</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tiers.map((t) => (
                    <tr key={t.tier}>
                      <td className="type-body" style={{ padding: '10px 0', borderBottom: '1px solid var(--border-default)' }}>Tier {t.tier}</td>
                      {[1.4, 1.0, 0.8].map((f, i) => (
                        <td key={i} className="type-number" style={{ textAlign: 'right', borderBottom: '1px solid var(--border-default)' }}>€{(t.price * f).toFixed(2)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <C.Button variant="primary" fullWidth onClick={() => setStep(2)}>Next</C.Button>
          </div>
        )}

        {step === 2 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <C.Input label="Cancellation window" value="24 hours before class" onChange={() => {}} />
            <C.Input label="Waitlist" value="Open when full" onChange={() => {}} />
            <div className="type-caption">Students can change their tier at any time. Tiers are self-reported — and that is by design.</div>
            <C.Button variant="primary" fullWidth onClick={() => setStep(3)}>Create class</C.Button>
          </div>
        )}

        {step === 3 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <C.Card>
              <div className="type-subtitle">Vinyasa · Monday, Apr 29 · 09:00</div>
              <div className="type-caption" style={{ marginTop: 4 }}>Studio A at Laurel St. · 6–14 students</div>
            </C.Card>
            <div className="type-body">This class needs 6 students to go ahead. You'll be notified once it's confirmed.</div>
            <C.Button variant="primary" fullWidth><C.Icon name="share" size={18} /> Share booking link</C.Button>
            <C.Button variant="ghost" fullWidth onClick={() => nav('schedule')}>Done</C.Button>
          </div>
        )}
      </div>
    );
  };
})();
