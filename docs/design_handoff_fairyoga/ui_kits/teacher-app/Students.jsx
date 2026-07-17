// Students — a warm address book, not a CRM dashboard.
(function () {
  const C = window.FYC;

  window.S = window.S || {};
  window.S.Students = function Students() {
    const students = window.MOCK.students;
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 24 }}>
          <h1 className="type-display" style={{ margin: 0 }}>Students</h1>
          <a style={{ color: 'var(--color-teal)', fontSize: 14, fontWeight: 500, textDecoration: 'none' }}>+ Add student</a>
        </div>
        <div>
          {students.map((s) => (
            <C.ListRow key={s.id} onClick={() => {}} chevron>
              <div className="type-body" style={{ color: 'var(--text-strong)' }}>{s.name}</div>
              <div className="type-caption">{s.total} classes · last {s.last}</div>
            </C.ListRow>
          ))}
        </div>
      </div>
    );
  };
})();
