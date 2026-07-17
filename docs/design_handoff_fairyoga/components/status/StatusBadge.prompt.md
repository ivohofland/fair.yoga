Status badge, radius 12, 13px medium. Fill encodes time: outline = upcoming (Draft, Open for registration), tint = now (Full, Waitlist, In progress, Below minimum), solid = done (Completed, Cancelled). Never color alone — the label carries the meaning. Colors come from the `--status-*` tokens; do not hardcode.

Payment (Paid / Unpaid / Overdue) is never a badge: render a glyph + word in text color — `✓ Paid` (--status-paid-fg), `○ Unpaid` (--status-unpaid-fg), `! Overdue` (--status-overdue-fg).

```jsx
<StatusBadge status="registering" />
<StatusBadge status="full">Full — 3 waitlisted</StatusBadge>
```
