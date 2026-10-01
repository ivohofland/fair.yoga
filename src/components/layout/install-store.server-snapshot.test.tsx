import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { useCoarsePointer, useInstallSupport } from './install-store';

/** Reads both hooks the way a real page does: rendered once, server-side,
 *  before any browser event has told either store anything. */
function Probe() {
  const support = useInstallSupport();
  const coarse = useCoarsePointer();
  return (
    <div data-support={support} data-coarse={String(coarse)} />
  );
}

describe('useInstallSupport / useCoarsePointer, rendered server-side', () => {
  it('report the server snapshot: unknown support, no coarse pointer', () => {
    const html = renderToString(<Probe />);
    expect(html).toContain('data-support="unknown"');
    expect(html).toContain('data-coarse="false"');
  });
});
