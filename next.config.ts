import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

/**
 * Content-Security-Policy. 'unsafe-inline' for scripts is required by
 * Next's hydration payload (a nonce-based policy needs middleware-driven
 * per-request nonces — heavier than this app warrants); the policy still
 * blocks all external script/style/connect origins, which is the main
 * XSS exfiltration path. Dev additionally needs 'unsafe-eval' and
 * websockets for Fast Refresh.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  // data: for the inline EPC payment QR codes
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self'${isDev ? " ws:" : ""}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Passkeys (WebAuthn) are unaffected: publickey-credentials is not restricted.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  // Ignored over plain http (local dev); enforced once served via TLS.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image (see Dockerfile).
  output: "standalone",
  // `next dev` otherwise writes a managed block into AGENTS.md or CLAUDE.md —
  // the flag governs both — whenever it detects an AI coding agent, leaving an
  // uncommitted change in every such session. Off because the block's text is
  // owned by Next, not by this repo: committing it would put a string that a
  // future patch release can reword into a file whose claims this project
  // maintains deliberately. The pointer it advertised is kept in AGENTS.md,
  // and src/lib/next-agent-rules.test.ts fails if the block ever lands.
  agentRules: false,
  // Holds the pre-16.3.4 behaviour rather than taking a changed default: this
  // was `undefined` and set true only under `cacheComponents` or
  // `--debug-prerender`, neither of which applies here, and 16.3.4 makes true
  // the base default. It puts `--enable-source-maps` in every prerender
  // worker's NODE_OPTIONS, which Next's own memory guide names as the thing to
  // turn off when a build runs short of memory — and this project builds its
  // image on the 2 GB VPS it deploys to (DEPLOYMENT.md).
  //
  // Not a measured saving: three paired builds here disagreed on the sign
  // (+66 MB, -56 MB, -29 MB against ~1.6-1.85 GB peaks), so the effect is
  // below this machine's noise, and a machine with room to spare cannot
  // measure one that has none — V8 sizes its heap to available memory. The
  // cost of holding it is less readable prerender stack traces.
  enablePrerenderSourceMaps: false,
  // Production builds get their own directory: `next build` writing into
  // the dev server's `.next` corrupts its compiler state, which then
  // silently serves stale pages until restarted (bit us repeatedly).
  distDir: process.env.NODE_ENV === "development" ? ".next" : ".next-build",
  async headers() {
    const rules = [{ source: "/(.*)", headers: securityHeaders }];
    if (isDev) {
      // Safari reuses cached dev chunks on plain reload despite
      // no-cache+ETag — stale CSS made every design change look broken.
      // Next.js emits a "Custom Cache-Control headers detected" warning on boot;
      // this is an accepted trade-off to preserve local Safari DX (#127).
      rules.push({
        source: "/_next/static/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      });
    }
    return rules;
  },
};

export default nextConfig;
