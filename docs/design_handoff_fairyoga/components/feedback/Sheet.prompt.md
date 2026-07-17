Overlay surface: mobile bottom sheet with drag handle and 20px top radius, or desktop centered modal (max 480px) via `desktop`. Ink-40% scrim; the sheet's soft shadow is the only shadow in the system. Confirmations get two buttons, never three.

```jsx
<Sheet open={confirming} onClose={dismiss} title="Cancel this class?">
  <p className="type-body">Registered students will be notified.</p>
  <Button variant="destructive" fullWidth>Cancel class</Button>
  <Button variant="ghost" fullWidth>Keep class</Button>
</Sheet>
```

Positioned `absolute` — give the phone/app container `position: relative`.
