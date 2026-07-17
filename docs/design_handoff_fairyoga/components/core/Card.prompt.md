Surface card: sand background, 1px border, radius 16, padding 20. Cards sit 12px apart on the cream page. Tappable cards show a chevron and sand-hover.

```jsx
<Card onClick={open} chevron>
  <div className="type-subtitle">Vinyasa · 09:00</div>
  <div className="type-caption">Studio A at Laurel St.</div>
</Card>
```

Depth comes from sand-on-cream + the border — never a shadow.
