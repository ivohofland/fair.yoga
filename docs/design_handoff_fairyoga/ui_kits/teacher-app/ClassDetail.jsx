// Class detail — one adaptive screen that transforms by lifecycle stage.
(function () {
  const C = window.FYC;
  const { useState } = React;

  window.S = window.S || {};
  window.S.ClassDetail = function ClassDetail({ nav, classId }) {
    const c = window.MOCK.classes.find((x) => x.id === classId) || window.MOCK.classes[0];
    const [confirming, setConfirming] = useState(false);
    const tiers = window.MOCK.tiers;
    const counts = window.MOCK.tierCounts;
    const students = window.MOCK.students.slice(0, c.reg > 5 ? 5 : c.reg);

    return (
      <div>
        <a onClick={() => nav('schedule')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-teal)', fontSize: 14, fontWeight: 500, textDecoration: 'none', marginBottom: 16 }}>
          <C.Icon name="arrow-left" size={16} /> Schedule
        </a>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
          <h1 className="type-display" style={{ margin: 0 }}>{c.type}</h1>
          <C.StatusBadge status={c.status} />
        </div>
        <div className="type-body" style={{ margin: '4px 0 0' }}>{c.day} · {c.time} · {c.where}</div>
        <div className="type-caption" style={{ marginTop: 2 }}>{c.reg} registered · needs {c.min} to go ahead</div>

        <C.RegistrationProgress registered={c.reg} min={c.min} max={c.max} style={{ margin: '20px 0 32px' }} />

        <h2 className="type-subtitle" style={{ margin: '0 0 4px' }}>Students</h2>
        {students.length === 0 ? (
          <C.EmptyState title="No registrations yet" body="Share the booking link to open registration." actionLabel="Share booking link" />
        ) : (
          <div>
            {students.map((s) => (
              <C.ListRow key={s.id}>
                <span className="type-body" style={{ color: 'var(--text-strong)' }}>{s.name}</span>
              </C.ListRow>
            ))}
          </div>
        )}

        <h2 className="type-subtitle" style={{ margin: '32px 0 4px' }}>Estimated prices</h2>
        <div className="type-caption" style={{ marginBottom: 8 }}>Based on {c.reg} registered students. Highest pays 2.1× the lowest.</div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['TIER', 'STUDENTS', 'PRICE'].map((h, i) => (
                <th key={h} style={{ textAlign: i === 0 ? 'left' : 'right', fontSize: 12, fontWeight: 500, color: 'var(--color-teal)', padding: '6px 0', borderBottom: '1px solid var(--border-default)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tiers.map((t) => (
              <tr key={t.tier}>
                <td className="type-body" style={{ padding: '8px 0', borderBottom: '1px solid var(--border-default)' }}>Tier {t.tier}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-body)', borderBottom: '1px solid var(--border-default)' }}>{counts[t.tier] || 0}</td>
                <td className="type-number" style={{ textAlign: 'right', borderBottom: '1px solid var(--border-default)' }}>€{t.price.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, margin: '32px 0 0' }}>
          <C.Button variant="primary" fullWidth onClick={() => nav('classday', c.id)}>Start class day</C.Button>
          <C.Button variant="secondary" fullWidth><C.Icon name="share" size={18} /> Share booking link</C.Button>
          <C.Button variant="destructive" fullWidth onClick={() => setConfirming(true)}>Cancel class</C.Button>
        </div>

        <C.Sheet open={confirming} onClose={() => setConfirming(false)} title="Cancel this class?">
          <p className="type-body" style={{ margin: '0 0 8px' }}>{c.reg} registered students will be notified.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <C.Button variant="destructive" fullWidth onClick={() => setConfirming(false)}>Cancel class</C.Button>
            <C.Button variant="ghost" fullWidth onClick={() => setConfirming(false)}>Keep class</C.Button>
          </div>
        </C.Sheet>
      </div>
    );
  };
})();
