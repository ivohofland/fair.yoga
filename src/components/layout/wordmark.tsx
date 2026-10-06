/** Georgia, ink, with the period at 125% in teal. */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <div className={`font-heading text-[22px] leading-none text-ink ${className}`.trim()}>
      fair<span className="text-teal text-[27px]">.</span>yoga
    </div>
  );
}
