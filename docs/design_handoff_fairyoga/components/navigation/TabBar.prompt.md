Mobile bottom tab bar: 64px, exactly 4 tabs (Schedule, Students, Inbox, Settings). Active tab = teal icon + label in a teal-tint pill; inactive = brown. Icons are the Lucide-style line set, never filled. On desktop ≥768px the same 4 items become a slim left rail instead — this component is the mobile form.

```jsx
<TabBar active="schedule" onChange={setTab} badge={{ inbox: true }} />
```
