// Names a teacher may not claim as `fair.yoga/<pageSlug>`. A static route
// segment beats the `(public)/[slug]` dynamic one, so a route sharing a
// teacher's slug would silently hide their page — `schemas.test.ts` holds every
// static top-level route segment, and every top-level `public/` entry name,
// against this set. The rest are reserved ahead of any route: a name a teacher
// holds can't later become a page without hiding theirs, and a deploy refuses
// while a teacher holds one (`scripts/check-reserved-slugs.ts`); some would
// also make a teacher's page read as the platform's own. A `next.config`
// rewrite, a path the proxy routes, or an nginx `location` can claim a name
// too, and nothing tests those, so reserve the name here when one does.
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // Routes the app has today.
  'login', 'verify', 'signup', 'bookings', 'settings', 'schedule', 'students',
  'inbox', 'class', 'studio-class', 'api', 'admin', 'account', 'updates', 'start',
  'payout-pause', 'unsubscribe', 'passkey-revoke',
  // Common website pages.
  'home', 'about', 'about-us', 'contact', 'contact-us', 'help', 'support', 'faq',
  'pricing', 'prices', 'costs', 'running-costs', 'donate', 'donations', 'blog', 'news',
  'press', 'changelog', 'status', 'docs', 'open-source', 'team', 'jobs', 'careers',
  'alternatives',
  // Legal pages.
  'privacy', 'privacy-policy', 'terms', 'terms-of-service', 'tos', 'legal', 'cookies',
  'gdpr', 'imprint', 'impressum', 'accessibility', 'security',
  // Names that would pass a teacher's page off as the platform's.
  'yoga', 'fair', 'fair-yoga', 'fairyoga', 'official', 'staff', 'administrator', 'root',
  'system', 'moderator',
  // Routes the app may grow.
  'logout', 'sign-in', 'sign-out', 'signin', 'register', 'auth', 'invite', 'join',
  'onboarding', 'dashboard', 'me', 'profile', 'teacher', 'teachers', 'student', 'classes',
  'calendar', 'notifications', 'payments', 'search', 'explore',
  // Infrastructure and technical names.
  'www', 'app', 'mail', 'email', 'static', 'assets', 'cdn', 'icons', 'images', 'public',
  'robots', 'sitemap', 'favicon', 'opengraph-image', 'twitter-image', 'health', 'null',
  'undefined', 'test',
]);
