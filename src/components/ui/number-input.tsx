'use client';

import { useState, type ComponentProps } from 'react';
import { Input } from './input';

type NumberInputProps = Omit<ComponentProps<typeof Input>, 'type' | 'value' | 'onChange'> & {
  value: number;
  onValueChange: (value: number) => void;
};

/** An empty field holds 0. */
function parse(text: string): number {
  return text.trim() === '' ? 0 : Number(text);
}

/**
 * A number field that shows what was typed rather than the number it holds,
 * so clearing a 0 leaves the field empty instead of putting the 0 back. The
 * text is rewritten only when `value` stops matching it — the form clamped
 * it, or replaced it.
 */
export function NumberInput({ value, onValueChange, ...props }: NumberInputProps) {
  const [text, setText] = useState(String(value));
  // NaN never matches itself, so it is left alone rather than rewritten forever.
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
        onValueChange(parse(e.target.value));
      }}
    />
  );
}
