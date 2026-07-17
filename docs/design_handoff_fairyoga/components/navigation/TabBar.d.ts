/** Bottom tab bar, 64px, exactly 4 tabs: Schedule, Students, Inbox, Settings. */
export interface TabBarProps {
  /** Active tab id. Default 'schedule'. */
  active?: 'schedule' | 'students' | 'inbox' | 'settings';
  onChange?: (id: string) => void;
  /** Map of tab id → truthy to show a small gold attention dot (e.g. unread inbox). */
  badge?: Record<string, boolean | number>;
  style?: React.CSSProperties;
}
