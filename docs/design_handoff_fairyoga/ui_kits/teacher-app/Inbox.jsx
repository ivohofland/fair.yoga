// Inbox — chronological; unread rows on sand, read on cream. No hierarchy tricks.
(function () {
  const C = window.FYC;

  window.S = window.S || {};
  window.S.Inbox = function Inbox() {
    const items = window.MOCK.inbox;
    return (
      <div>
        <h1 className="type-display" style={{ margin: '0 0 24px' }}>Inbox</h1>
        <div>
          {items.map((n) => (
            <C.ListRow key={n.id} style={n.unread ? { background: 'var(--surface-card)', margin: '0 -16px', padding: '8px 16px' } : undefined}>
              <div className="type-body" style={{ color: 'var(--text-strong)', fontWeight: n.unread ? 600 : 400 }}>{n.title}</div>
              <div className="type-caption">{n.body} · {n.ago}</div>
            </C.ListRow>
          ))}
        </div>
      </div>
    );
  };
})();
