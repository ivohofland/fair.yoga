// Fallback primitives — used only if the project bundle hasn't been generated yet.
// Mirrors components/ 1:1; the bundle namespace wins when present.
(function () {
  if (window.FYC) return;
  const { useState } = React;

  const ICON_PATHS = {
    calendar: <><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
    inbox: <><polyline points="22 12 16 12 14 15 10 15 8 12 2 12" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></>,
    settings: <><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></>,
    'chevron-right': <path d="m9 18 6-6-6-6" />,
    'arrow-left': <><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></>,
    plus: <path d="M5 12h14M12 5v14" />,
    check: <path d="M20 6 9 17l-5-5" />,
    x: <path d="M18 6 6 18M6 6l12 12" />,
    share: <><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" /><polyline points="16 6 12 2 8 6" /><line x1="12" y1="2" x2="12" y2="15" /></>,
  };

  function Icon({ name, size = 24, style }) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, ...style }} aria-hidden="true">
        {ICON_PATHS[name] || null}
      </svg>
    );
  }

  const BTN = {
    primary: (h, a) => ({ background: a ? 'var(--color-teal-pressed)' : h ? 'var(--color-teal-hover)' : 'var(--color-teal)', color: 'var(--color-cream)', border: '1.5px solid transparent' }),
    secondary: (h) => ({ background: h ? 'var(--color-teal-tint)' : 'transparent', color: 'var(--color-teal)', border: '1.5px solid var(--color-teal)' }),
    destructive: (h) => ({ background: h ? 'var(--danger-tint)' : 'transparent', color: 'var(--danger)', border: '1.5px solid var(--danger)' }),
    ghost: (h) => ({ background: h ? 'var(--color-teal-tint)' : 'transparent', color: 'var(--color-teal)', border: '1.5px solid transparent' }),
  };

  function Button({ variant = 'primary', children, onClick, disabled, fullWidth, style }) {
    const [h, setH] = useState(false);
    const [a, setA] = useState(false);
    const v = (BTN[variant] || BTN.primary)(h && !disabled, a && !disabled);
    return (
      <button onClick={onClick} disabled={disabled}
        onMouseEnter={() => setH(true)} onMouseLeave={() => { setH(false); setA(false); }}
        onMouseDown={() => setA(true)} onMouseUp={() => setA(false)}
        style={{ height: 48, padding: '0 24px', borderRadius: 999, fontFamily: 'var(--font-body)', fontSize: 16, fontWeight: 600, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: fullWidth ? '100%' : undefined, opacity: disabled ? 0.5 : 1, cursor: disabled ? 'not-allowed' : 'pointer', outline: 'none', ...v, ...style }}>
        {children}
      </button>
    );
  }

  function Input({ label, value, onChange, placeholder, error, helper, type = 'text', disabled, style }) {
    const [focus, setFocus] = useState(false);
    return (
      <label style={{ display: 'block', ...style }}>
        {label && <div style={{ fontSize: 14, fontWeight: 500, lineHeight: 1.4, color: 'var(--text-body)', marginBottom: 8 }}>{label}</div>}
        <input type={type} value={value} onChange={onChange} placeholder={placeholder} disabled={disabled}
          onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
          style={{ boxSizing: 'border-box', width: '100%', height: 48, padding: '0 16px', background: error ? 'var(--danger-tint)' : 'var(--surface-card)', border: `1px solid ${error ? 'var(--danger)' : focus ? 'var(--color-teal)' : 'var(--border-default)'}`, borderRadius: 12, fontFamily: 'var(--font-body)', fontSize: 16, color: 'var(--text-strong)', outline: 'none', boxShadow: focus ? '0 0 0 3px var(--color-teal-tint)' : 'none', opacity: disabled ? 0.5 : 1 }} />
        {error && <div style={{ fontSize: 13, color: 'var(--danger)', marginTop: 4 }}>{error}</div>}
        {!error && helper && <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>{helper}</div>}
      </label>
    );
  }

  function Card({ children, onClick, chevron, selected, style }) {
    const [h, setH] = useState(false);
    const tappable = !!onClick;
    return (
      <div onClick={onClick} onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
        style={{ background: selected ? 'var(--surface-selected)' : tappable && h ? 'var(--surface-card-hover)' : 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 16, padding: 20, cursor: tappable ? 'pointer' : undefined, display: chevron ? 'flex' : undefined, alignItems: chevron ? 'center' : undefined, gap: chevron ? 12 : undefined, ...style }}>
        {chevron ? <div style={{ flex: 1, minWidth: 0 }}>{children}</div> : children}
        {chevron && <Icon name="chevron-right" size={20} style={{ color: 'var(--text-muted)' }} />}
      </div>
    );
  }

  const BADGES = {
    // fill encodes time: outline = upcoming, tint = now, solid = done
    draft: { bg: 'transparent', fg: 'var(--status-draft-fg)', border: 'var(--status-draft-border)', label: 'Draft' },
    registering: { bg: 'transparent', fg: 'var(--status-open-fg)', border: 'var(--status-open-border)', label: 'Open for registration' },
    full: { bg: 'var(--status-full-bg)', fg: 'var(--status-full-fg)', label: 'Full — waitlist' },
    in_progress: { bg: 'var(--status-inprogress-bg)', fg: 'var(--status-inprogress-fg)', label: 'In progress' },
    completed: { bg: 'var(--status-completed-bg)', fg: 'var(--status-completed-fg)', label: 'Completed' },
    cancelled: { bg: 'var(--status-cancelled-bg)', fg: 'var(--status-cancelled-fg)', label: 'Cancelled' },
    below_min: { bg: 'var(--status-belowmin-bg)', fg: 'var(--status-belowmin-fg)', label: 'Below minimum' },
    waitlist: { bg: 'var(--status-waitlist-bg)', fg: 'var(--status-waitlist-fg)', label: 'Waitlist' },
    // payment is never a badge; kept for compat only
    paid: { bg: 'var(--status-completed-bg)', fg: 'var(--status-completed-fg)', label: 'Paid' },
  };

  function StatusBadge({ status = 'registering', children, style }) {
    const v = BADGES[status] || BADGES.registering;
    return <span style={{ display: 'inline-block', background: v.bg, color: v.fg, border: `1px solid ${v.border || 'transparent'}`, borderRadius: 12, padding: '3px 10px', fontSize: 13, fontWeight: 500, lineHeight: 1.4, whiteSpace: 'nowrap', ...style }}>{children || v.label}</span>;
  }

  function RegistrationProgress({ registered = 0, min = 0, max = 1, style }) {
    const pct = Math.min(100, (registered / max) * 100);
    const minPct = Math.min(100, (min / max) * 100);
    const met = registered >= min;
    return (
      <div style={style}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: met ? 'var(--color-teal)' : 'var(--text-body)' }}>{registered} / {min}–{max}</span>
        </div>
        <div style={{ position: 'relative', height: 8, background: 'var(--border-default)', borderRadius: 4 }}>
          <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: pct + '%', background: met ? 'var(--color-teal)' : 'var(--danger)', borderRadius: 4 }} />
          {min > 0 && min < max && <div style={{ position: 'absolute', top: -2, bottom: -2, left: minPct + '%', width: 2, background: 'var(--color-ink)', borderRadius: 1 }} />}
        </div>
      </div>
    );
  }

  function EmptyState({ title, body, actionLabel, onAction, style }) {
    return (
      <div style={{ padding: '40px 16px', textAlign: 'center', ...style }}>
        <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 18, lineHeight: 1.4, color: 'var(--text-strong)' }}>{title}</div>
        {body && <div style={{ fontSize: 16, lineHeight: 1.55, color: 'var(--text-body)', marginTop: 8 }}>{body}</div>}
        {actionLabel && <div style={{ marginTop: 20 }}><Button variant="secondary" onClick={onAction}>{actionLabel}</Button></div>}
      </div>
    );
  }

  function Skeleton({ width = '100%', height = 16, radius = 4, style }) {
    return <div aria-hidden="true" style={{ width, height, borderRadius: radius, background: 'var(--surface-card)', ...style }} />;
  }

  const TABS = [
    { id: 'schedule', label: 'Schedule', icon: 'calendar' },
    { id: 'students', label: 'Students', icon: 'users' },
    { id: 'inbox', label: 'Inbox', icon: 'inbox' },
    { id: 'settings', label: 'Settings', icon: 'settings' },
  ];

  function TabBar({ active = 'schedule', onChange, badge = {}, style }) {
    return (
      <nav style={{ height: 64, background: 'var(--bg-page)', borderTop: '1px solid var(--border-default)', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', alignItems: 'center', ...style }}>
        {TABS.map((t) => {
          const isActive = t.id === active;
          return (
            <button key={t.id} onClick={() => onChange && onChange(t.id)} style={{ background: 'none', border: 'none', padding: 0, height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, fontFamily: 'var(--font-body)' }}>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '4px 14px', borderRadius: 999, background: isActive ? 'var(--color-teal-tint)' : 'transparent', color: isActive ? 'var(--color-teal)' : 'var(--text-body)', position: 'relative' }}>
                <Icon name={t.icon} size={22} />
                {badge[t.id] ? <span style={{ position: 'absolute', top: 0, right: 4, width: 8, height: 8, borderRadius: '50%', background: 'var(--color-gold)' }} /> : null}
              </span>
              <span style={{ fontSize: 11, fontWeight: isActive ? 600 : 400, color: isActive ? 'var(--color-teal)' : 'var(--text-body)' }}>{t.label}</span>
            </button>
          );
        })}
      </nav>
    );
  }

  function ListRow({ children, trailing, onClick, chevron, selected, divider = true, style }) {
    const [h, setH] = useState(false);
    const tappable = !!onClick;
    return (
      <div onClick={onClick} onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
        style={{ minHeight: 56, display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: divider ? '1px solid var(--border-default)' : 'none', background: selected ? 'var(--surface-selected)' : tappable && h ? 'var(--surface-card-hover)' : 'transparent', cursor: tappable ? 'pointer' : undefined, boxSizing: 'border-box', ...style }}>
        <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
        {trailing}
        {chevron && <Icon name="chevron-right" size={20} style={{ color: 'var(--text-muted)' }} />}
      </div>
    );
  }

  function Sheet({ open, onClose, title, children, desktop, style }) {
    if (!open) return null;
    return (
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'var(--scrim)', display: 'flex', alignItems: desktop ? 'center' : 'flex-end', justifyContent: 'center', zIndex: 100 }}>
        <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--bg-page)', borderRadius: desktop ? 16 : '20px 20px 0 0', boxShadow: 'var(--shadow-sheet)', width: desktop ? 'min(480px, calc(100% - 48px))' : '100%', maxHeight: '85%', overflowY: 'auto', padding: '0 20px 20px', boxSizing: 'border-box', ...style }}>
          {!desktop && <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 4px' }}><div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border-default)' }} /></div>}
          {title && <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 18, lineHeight: 1.4, color: 'var(--text-strong)', padding: desktop ? '20px 0 12px' : '8px 0 12px' }}>{title}</div>}
          {children}
        </div>
      </div>
    );
  }

  window.FYC = { Icon, Button, Input, Card, StatusBadge, RegistrationProgress, EmptyState, Skeleton, TabBar, ListRow, Sheet };
})();
