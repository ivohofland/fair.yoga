import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** Reachability probe: public, no database; `now` is the server's clock. */
export function GET() {
  return NextResponse.json({ now: Date.now() }, { headers: { 'Cache-Control': 'no-store' } });
}
