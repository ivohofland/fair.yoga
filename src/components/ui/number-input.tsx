'use client';

import { useState, type ComponentProps } from 'react';
import { Input } from './input';

type NumberInputProps = Omit<ComponentProps<typeof Input>, 'type' | 'value' | 'onChange'> & {
  value: number;
  onValueChange: (value: number) => void;
};

/** An empty or blank field holds 0. */
function parse(text: string): number {
  return text.trim() === '' ? 0 : Number(text);
}

/**
 * A number field that shows what was typed rather than the number it holds,
 * so clearing it leaves it empty (holding 0) instead of refilling it with 0.
 * Leaving an empty field shows that 0. The text is rewritten only when it no
 * longer parses to `value` — the form clamped it, or replaced it — so a "5.0"
 * still being typed is left alone.
 *
 * Text the browser cannot read as a number ("4,5", a lone "-") reaches the
 * page as `''` with `validity.badInput` set; it is reported as NaN, never as
 * the 0 an empty field holds, so a caller's validation can refuse it.
 */
export function NumberInput({ value, onValueChange, onBlur, ...props }: NumberInputProps) {
  const [text, setText] = useState(String(value));
  // A NaN `value` equals no parse of any text, so rewriting would re-render
  // forever; the text is left as typed instead.
  if (parse(text) !== value && !Number.isNaN(value)) {
    setText(String(value));
  }
  return (
    <Input
      {...props}
      type="number"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onValueChange(e.currentTarget.validity.badInput ? Number.NaN : parse(e.target.value));
      }}
      onBlur={(e) => {
        if (text.trim() === '' && !e.currentTarget.validity.badInput) setText(String(value));
        onBlur?.(e);
      }}
    />
  );
}
