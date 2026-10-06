/** Georgia, ink, with a larger period in teal. */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <div className={`font-heading text-[22px] leading-none text-ink ${className}`.trim()}>
      fair<span className="text-teal text-[27px]">.</span>yoga
    </div>
  );
}
