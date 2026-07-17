import React from 'react';
import { Icon } from '../core/Icon.jsx';

const TABS = [
  { id: 'schedule', label: 'Schedule', icon: 'calendar' },
  { id: 'students', label: 'Students', icon: 'users' },
  { id: 'inbox', label: 'Inbox', icon: 'inbox' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

/** Bottom tab bar, 64px, exactly 4 tabs. Active = teal icon + label in a teal-tint pill. */
export function TabBar({ active = 'schedule', onChange, badge = {}, style }) {
  return (
    <nav
      style={{
        height: 'var(--tabbar-height)',
        background: 'var(--bg-page)',
        borderTop: '1px solid var(--border-default)',
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        alignItems: 'center',
        ...style,
      }}
    >
      {TABS.map((t) => {
        const isActive = t.id === active;
        return (
          <button
            key={t.id}
            onClick={() => onChange && onChange(t.id)}
            style={{
              background: 'none', border: 'none', padding: 0, height: '100%',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '2px',
              fontFamily: 'var(--font-body)',
            }}
            aria-current={isActive ? 'page' : undefined}
          >
            <span
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '4px 14px', borderRadius: '999px',
                background: isActive ? 'var(--color-teal-tint)' : 'transparent',
                color: isActive ? 'var(--color-teal)' : 'var(--text-body)',
                position: 'relative',
              }}
            >
              <Icon name={t.icon} size={22} />
              {badge[t.id] ? (
                <span style={{ position: 'absolute', top: '0', right: '4px', width: '8px', height: '8px', borderRadius: '50%', background: 'var(--color-gold)' }} />
              ) : null}
            </span>
            <span style={{ fontSize: '11px', fontWeight: isActive ? 600 : 400, color: isActive ? 'var(--color-teal)' : 'var(--text-body)' }}>
              {t.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
