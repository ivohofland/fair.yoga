export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col flex-1">
      {/* Wordmark: Georgia, ink, with the period at 125% in teal */}
      <div className="font-heading text-[22px] leading-none text-ink mb-14">
        fair<span className="text-teal text-[27px]">.</span>yoga
      </div>
      {children}
    </div>
  );
}
