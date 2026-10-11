import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { NumberInput } from './number-input';

function Harness({ initial, clampTo }: { initial: number; clampTo?: number }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <NumberInput
        label="Amount"
        value={value}
        onValueChange={(n) => setValue(clampTo === undefined ? n : Math.min(n, clampTo))}
      />
      <output data-testid="held">{value}</output>
    </>
  );
}

describe('NumberInput', () => {
  it('stays empty when cleared, holding 0, so the next digit replaces the 0', () => {
    render(<Harness initial={0} />);
    const input = screen.getByLabelText('Amount') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');
    expect(screen.getByTestId('held')).toHaveTextContent('0');
    fireEvent.change(input, { target: { value: '9' } });
    expect(input.value).toBe('9');
    expect(screen.getByTestId('held')).toHaveTextContent('9');
  });

  it('stays empty when a non-zero value is cleared', () => {
    render(<Harness initial={21} />);
    const input = screen.getByLabelText('Amount') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');
    expect(screen.getByTestId('held')).toHaveTextContent('0');
  });

  it('leaves a decimal still being typed alone', () => {
    render(<Harness initial={5} />);
    const input = screen.getByLabelText('Amount') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '5.0' } });
    expect(input.value).toBe('5.0');
  });

  it('shows the value the form settled on when it differs from what was typed', () => {
    render(<Harness initial={4} clampTo={10} />);
    const input = screen.getByLabelText('Amount') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '12' } });
    expect(input.value).toBe('10');
  });

  it('follows a value replaced from outside', () => {
    const onValueChange = vi.fn();
    const { rerender } = render(<NumberInput label="Amount" value={3} onValueChange={onValueChange} />);
    rerender(<NumberInput label="Amount" value={7} onValueChange={onValueChange} />);
    expect(screen.getByLabelText('Amount')).toHaveValue(7);
  });
});
