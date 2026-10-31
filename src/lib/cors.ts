import type { NextResponse } from 'next/server';

/** Lets any page's script read a public, credential-free response. */
export function withCors(res: NextResponse): NextResponse {
  res.headers.set('Access-Control-Allow-Origin', '*');
  return res;
}
