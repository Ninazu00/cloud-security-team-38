/**
 * Response headers that are set once for everything the service serves.
 *
 * The two that matter for this app:
 *
 *   - **Content-Security-Policy** is the reason the frontend has no inline
 *     scripts and no inline styles. `script-src 'self'` means an injected
 *     `<script>` cannot run, which is the difference between "we escape our HTML"
 *     and "an escape we got wrong is a one-line fix instead of an incident".
 *     The Cloudflare Turnstile widget is the only third party allowed in, and
 *     only for the two directives it needs.
 *   - **X-Content-Type-Options: nosniff** stops a browser from guessing that a
 *     file we serve as `text/plain` is really HTML or JavaScript. Without it, an
 *     upload of the wrong type becomes a script.
 *
 * `frame-ancestors 'none'` is the modern clickjacking control; `X-Frame-Options`
 * stays only for browsers that never learned the new one.
 */

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders({ hsts = false } = {}) {
  return function applySecurityHeaders(_req, res, next) {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // HSTS only where it is true: floci's load balancer speaks HTTP, and sending
    // the header from there would pin a browser to a scheme that is not offered.
    if (hsts) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}
