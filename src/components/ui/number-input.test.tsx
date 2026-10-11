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
      <output data-testid="held">{String(value)}</output>
    </>
  );
}

function DecimalHarness({ initial }: { initial: number }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <NumberInput label="Amount" decimals={2} value={value} onValueChange={setValue} />
      <output data-testid="held">{String(value)}</output>
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

  it('rewrites the text when the form clamps to the value it already held', () => {
    render(<Harness initial={10} clampTo={10} />);
    const input = screen.getByLabelText('Amount') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '12' } });
    expect(input.value).toBe('10');
    expect(screen.getByTestId('held')).toHaveTextContent('10');
  });

  it('holds NaN, not 0, for text the browser cannot read as a number', () => {
    render(<Harness initial={5} />);
    const input = screen.getByLabelText('Amount') as HTMLInputElement;
    // jsdom does not flag unreadable text, so the flag is set by hand.
    Object.defineProperty(input, 'validity', { value: { badInput: true }, configurable: true });
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByTestId('held')).toHaveTextContent('NaN');
    fireEvent.blur(input);
    expect(input.value).toBe('');
  });

  it('shows the 0 an empty field holds once the field is left', () => {
    render(<Harness initial={21} />);
    const input = screen.getByLabelText('Amount') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(input.value).toBe('0');
  });

  it('renders a NaN value without re-rendering forever', () => {
    render(<NumberInput label="Amount" value={Number.NaN} onValueChange={vi.fn()} />);
    expect(screen.getByLabelText('Amount')).toBeInTheDocument();
  });

  it('follows a value replaced from outside', () => {
    const onValueChange = vi.fn();
    const { rerender } = render(<NumberInput label="Amount" value={3} onValueChange={onValueChange} />);
    rerender(<NumberInput label="Amount" value={7} onValueChange={onValueChange} />);
    expect(screen.getByLabelText('Amount')).toHaveValue(7);
  });

  describe('decimal mode', () => {
    it('renders a text field with the decimal keyboard', () => {
      render(<DecimalHarness initial={0} />);
      const input = screen.getByLabelText('Amount');
      expect(input).toHaveAttribute('type', 'text');
      expect(input).toHaveAttribute('inputmode', 'decimal');
    });

    it('reads a decimal comma and leaves it as typed', () => {
      render(<DecimalHarness initial={0} />);
      const input = screen.getByLabelText('Amount') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '4,5' } });
      expect(input.value).toBe('4,5');
      expect(screen.getByTestId('held')).toHaveTextContent('4.5');
    });

    it('holds NaN for more decimals than allowed and leaves the text as typed', () => {
      render(<DecimalHarness initial={0} />);
      const input = screen.getByLabelText('Amount') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '4,555' } });
      expect(input.value).toBe('4,555');
      expect(screen.getByTestId('held')).toHaveTextContent('NaN');
    });

    it('holds 0 when cleared and shows the 0 once the field is left', () => {
      render(<DecimalHarness initial={21} />);
      const input = screen.getByLabelText('Amount') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '' } });
      expect(input.value).toBe('');
      expect(screen.getByTestId('held')).toHaveTextContent('0');
      fireEvent.blur(input);
      expect(input.value).toBe('0');
    });

    it('renders a held value that does not parse back without re-rendering forever', () => {
      render(<NumberInput label="Amount" decimals={2} value={4.555} onValueChange={vi.fn()} />);
      expect(screen.getByLabelText('Amount')).toHaveValue('4.555');
    });

    it('refuses min, max and step beside decimals at compile time', () => {
      // @ts-expect-error min does nothing on a text field
      const withMin = <NumberInput label="Amount" decimals={2} min={0} value={1} onValueChange={vi.fn()} />;
      // @ts-expect-error max does nothing on a text field
      const withMax = <NumberInput label="Amount" decimals={2} max={9} value={1} onValueChange={vi.fn()} />;
      // @ts-expect-error step does nothing on a text field
      const withStep = <NumberInput label="Amount" decimals={2} step={1} value={1} onValueChange={vi.fn()} />;
      expect([withMin, withMax, withStep]).toHaveLength(3);
    });

    it('renders a signed field with no inputmode, so a phone keyboard offers the minus key', () => {
      render(<NumberInput label="Amount" decimals={2} signed value={0} onValueChange={vi.fn()} />);
      const input = screen.getByLabelText('Amount');
      expect(input).toHaveAttribute('type', 'text');
      expect(input).not.toHaveAttribute('inputmode');
    });

    it('reads a negative decimal comma in a signed field', () => {
      const onValueChange = vi.fn();
      render(<NumberInput label="Amount" decimals={2} signed value={0} onValueChange={onValueChange} />);
      fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '-4,5' } });
      expect(onValueChange).toHaveBeenLastCalledWith(-4.5);
    });

    it('refuses inputMode beside decimals, and signed without them, at compile time', () => {
      const withInputMode = (
        // @ts-expect-error the field chooses its own keyboard in decimal mode
        <NumberInput label="Amount" decimals={2} inputMode="numeric" value={1} onValueChange={vi.fn()} />
      );
      // @ts-expect-error signed only means something on a text field
      const signedInteger = <NumberInput label="Amount" signed value={1} onValueChange={vi.fn()} />;
      expect([withInputMode, signedInteger]).toHaveLength(2);
    });

    it('rewrites the field when the value is replaced from outside', () => {
      const onValueChange = vi.fn();
      const { rerender } = render(<NumberInput label="Amount" decimals={2} value={4.5} onValueChange={onValueChange} />);
      const input = screen.getByLabelText('Amount') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '4,5' } });
      expect(input.value).toBe('4,5');
      rerender(<NumberInput label="Amount" decimals={2} value={9} onValueChange={onValueChange} />);
      expect(input.value).toBe('9');
    });
  });
});
