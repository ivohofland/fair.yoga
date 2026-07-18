// Schedule — home screen. A chronological card list, not a calendar grid.
// The window is the current week plus the next four (the recurring-
// generation horizon), so the list breaks at every week boundary: a
// type-subtitle head — the same section idiom as "By month" or "Updates" —
// labelled "This week", "Next week", then "Week of 4 August".
(function () {
  const C = window.FYC;

  window.S = window.S || {};
  window.S.Schedule = function Schedule({ nav }) {
    const classes = window.MOCK.classes.filter((c) => !c.past);
    const groups = [];
    classes.forEach((c) => {
      const g = groups[groups.length - 1];
      if (g && g.week === c.week) g.items.push(c);
      else groups.push({ week: c.week, items: [c] });
    });
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 24 }}>
          <h1 className="type-display" style={{ margin: 0 }}>Schedule</h1>
          <a onClick={() => nav('new')} style={{ color: 'var(--color-teal)', fontSize: 14, fontWeight: 500, textDecoration: 'none' }}>+ Add class</a>
        </div>
        {groups.map((group, gi) => (
          <div key={group.week}>
            <h2 className="type-subtitle" style={{ margin: gi === 0 ? '0 0 12px' : '32px 0 12px' }}>
              {group.week}
            </h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {group.items.map((c) =>
                c.studio ? (
                  <div key={c.id} style={{ padding: '12px 20px', border: '1px dashed var(--border-default)', borderRadius: 16 }}>
                    <div className="type-label">{c.day} · {c.time}</div>
                    <div className="type-caption">{c.type} · {c.where}</div>
                  </div>
                ) : (
                  <C.Card key={c.id} onClick={() => nav('class', c.id)} chevron>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <span className="type-label" style={{ color: 'var(--text-strong)' }}>{c.day} · {c.time}</span>
                      <C.StatusBadge status={c.status} />
                    </div>
                    <div className="type-subtitle" style={{ margin: '4px 0 2px' }}>{c.type}</div>
                    <div className="type-caption">{c.where}</div>
                    {c.status !== 'draft' && (
                      <C.RegistrationProgress registered={c.reg} min={c.min} max={c.max} style={{ marginTop: 12 }} />
                    )}
                  </C.Card>
                )
              )}
            </div>
          </div>
        ))}
      </div>
    );
  };
})();
