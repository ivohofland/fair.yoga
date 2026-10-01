/**
 * How to add fair.yoga to the Home Screen, in words. No arrow pointing at a
 * toolbar: where Safari's Share button sits differs by layout and device.
 * `manual` is Chromium after its one-shot prompt was used.
 */
export function InstallSteps({ variant }: { variant: 'ios' | 'manual' }) {
  if (variant === 'manual') {
    return (
      <p className="type-body">
        Open your browser’s menu (⋮) and choose Install app, or Add to Home screen.
      </p>
    );
  }
  return (
    <ol className="type-body list-decimal pl-5 space-y-1">
      <li>Tap Share in Safari’s toolbar. If you don’t see it, tap ⋯ first.</li>
      <li>Choose Add to Home Screen. You may need to scroll.</li>
      <li>Tap Add.</li>
    </ol>
  );
}
