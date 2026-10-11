'use client';

import { useState, type ComponentProps } from 'react';
import { parseDecimal } from '@/lib/decimal-input';
import { Input } from './input';

type BaseProps = Omit<ComponentProps<typeof Input>, 'type' | 'value' | 'onChange'> & {
  value: number;
  onValueChange: (value: number) => void;
};

type NumberInputProps =
  | (BaseProps & { decimals?: undefined; signed?: never })
  | (BaseProps & {
      /** Most fraction digits an amount may carry; `Infinity` sets no limit. */
      decimals: number;
      /** The amount may be negative. */
      signed?: boolean;
      min?: never;
      max?: never;
      step?: never;
      inputMode?: never;
    });

/** An empty or blank field holds 0. */
function parse(text: string, decimals: number | undefined): number {
  if (text.trim() === '') return 0;
  return decimals === undefined ? Number(text) : parseDecimal(text, decimals);
}

/**
 * A number field that shows what was typed rather than the number it holds,
 * so clearing it leaves it empty (holding 0) instead of refilling it with 0.
 * Leaving an empty field shows that 0. The text is rewritten only when it no
 * longer parses to `value` — the form clamped it, or replaced it — so a "5.0"
 * still being typed is left alone.
 *
 * Without `decimals` the field is an integer `type="number"`. Text the
 * browser cannot read as a number (a lone "-") reaches the page as `''` with
 * `validity.badInput` set; it is reported as NaN, never as the 0 an empty
 * field holds, so a caller's validation can refuse it.
 *
 * With `decimals` the field is a text field read by `parseDecimal`, which
 * takes `,` or `.` as the separator; Chromium's number input drops a typed
 * comma. Unreadable text is reported as NaN and left as typed. It asks for
 * the decimal keypad, unless `signed`: iOS's decimal keypad has no minus key,
 * so a signed field sets no `inputMode` and gets the plain keyboard, whose
 * number layer has both `-` and `,`.
 */
export function NumberInput({ value, onValueChange, onBlur, decimals, signed, ...props }: NumberInputProps) {
  const [text, setText] = useState(String(value));
  // A NaN `value` equals no parse of any text, and a `String(value)` that does
  // not parse back (4.555 at 2 decimals) would rewrite on every render; both
  // are left as they are.
  if (parse(text, decimals) !== value && !Number.isNaN(value) && text !== String(value)) {
    setText(String(value));
  }
  const typeProps =
    decimals === undefined
      ? { type: 'number' }
      : signed
        ? { type: 'text' }
        : { type: 'text', inputMode: 'decimal' as const };
  return (
    <Input
      {...props}
      {...typeProps}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onValueChange(e.currentTarget.validity.badInput ? Number.NaN : parse(e.target.value, decimals));
      }}
      onBlur={(e) => {
        if (text.trim() === '' && !e.currentTarget.validity.badInput) setText(String(value));
        onBlur?.(e);
      }}
    />
  );
}
