// Class day — one-handed use at the venue: large names, big checkboxes, add walk-in.
(function () {
  const C = window.FYC;
  const { useState } = React;

  window.S = window.S || {};
  window.S.ClassDay = function ClassDay({ nav, classId }) {
    const c = window.MOCK.classes.find((x) => x.id === classId) || window.MOCK.classes[0];
    const [att, setAtt] = useState(window.MOCK.attendance);
    const toggle = (id) => setAtt(att.map((a) => (a.id === id ? { ...a, present: !a.present } : a)));
    const present = att.filter((a) => a.present).length;

    return (
      <div>
        <a onClick={() => nav('class', c.id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-teal)', fontSize: 14, fontWeight: 500, textDecoration: 'none', marginBottom: 16 }}>
          <C.Icon name="arrow-left" size={16} /> Class
        </a>
        <h1 className="type-display" style={{ margin: 0 }}>{c.type} · {c.time}</h1>
        <div className="type-caption" style={{ margin: '4px 0 24px' }}>{present} of {att.length} checked in</div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {att.map((a) => (
            <div key={a.id} onClick={() => toggle(a.id)} style={{ display: 'flex', alignItems: 'center', gap: 16, minHeight: 64, borderBottom: '1px solid var(--border-default)', cursor: 'pointer' }}>
              <span
                style={{
                  width: 44, height: 44, borderRadius: 12, boxSizing: 'border-box', flexShrink: 0,
                  border: a.present ? 'none' : '1.5px solid var(--border-default)',
                  background: a.present ? 'var(--color-teal)' : 'var(--surface-card)',
                  color: 'var(--color-cream)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                {a.present && <C.Icon name="check" size={22} />}
              </span>
              <span style={{ fontSize: 20, color: 'var(--text-strong)' }}>{a.name}</span>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <C.Button variant="secondary" fullWidth><C.Icon name="plus" size={18} /> Add walk-in</C.Button>
          <C.Button variant="primary" fullWidth onClick={() => nav('summary', c.id)}>End class</C.Button>
        </div>
      </div>
    );
  };
})();
