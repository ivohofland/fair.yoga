export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col flex-1">
      <div className="fy-wordmark-display mb-14">fair.yoga</div>
      {children}
    </div>
  );
}
