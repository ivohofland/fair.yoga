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
  // Production builds get their own directory: `next build` writing into
  // the dev server's `.next` corrupts its compiler state, which then
  // silently serves stale pages until restarted (bit us repeatedly).
  distDir: process.env.NODE_ENV === "development" ? ".next" : ".next-build",
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
