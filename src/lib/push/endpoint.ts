import 'server-only';

// A host matches an entry exactly; a suffix entry matches any subdomain of it
// and never the bare suffix itself.
const PUSH_SERVICE_HOSTS: readonly string[] = ['fcm.googleapis.com', 'updates.push.services.mozilla.com'];
const PUSH_SERVICE_SUFFIXES: readonly string[] = ['push.apple.com', 'notify.windows.com'];

/**
 * True when `url` is an `https:` endpoint on a known browser push service.
 * The server POSTs to whatever endpoint a signed-in account registers, so
 * anything else would let that account aim the dispatch sweep at a host of
 * its choosing. Decided on the parsed hostname, never on the string, so
 * userinfo (`https://fcm.googleapis.com@evil.example/`) and lookalike hosts
 * (`evilpush.apple.com.attacker.example`) fail. A non-default port fails too:
 * no push service names one, and `URL.host` would carry it.
 */
export function isPushServiceEndpoint(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.port !== '') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  const host = parsed.hostname;
  return (
    PUSH_SERVICE_HOSTS.includes(host) ||
    PUSH_SERVICE_SUFFIXES.some((suffix) => host.endsWith(`.${suffix}`))
  );
}
