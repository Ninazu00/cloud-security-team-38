import { forbidden } from '../errors.js';

/**
 * Cloudflare Turnstile - the only external API in this component.
 *
 * It answers one question before we spend 50 ms of Argon2id on a stranger:
 * did a human just complete a challenge? It is not authentication and it is not
 * a rate limit; it is proof-of-work on the *client*, which is exactly what a
 * credential-stuffing script does not want to pay.
 *
 * Fails closed. A network error, a timeout, a 500 from Cloudflare, a missing
 * token: all of them mean "not verified", never "the check is unavailable so
 * let it through". The alternative turns an outage of a third party into an
 * open door on ours.
 */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 3000;

export function createTurnstileVerifier({
  secret,
  siteverifyUrl = SITEVERIFY_URL,
  timeoutMs = TIMEOUT_MS,
  fetchImpl = fetch,
  log = null,
} = {}) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('createTurnstileVerifier needs a secret; there is no "open" mode.');
  }

  async function verify(token, remoteIp) {
    if (typeof token !== 'string' || token.length === 0 || token.length > 2048) {
      return false;
    }

    const body = new URLSearchParams({ secret, response: token });
    if (typeof remoteIp === 'string' && remoteIp.length > 0) body.set('remoteip', remoteIp);

    try {
      const response = await fetchImpl(siteverifyUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        log?.warn({ msg: 'turnstile.unavailable', status: response.status });
        return false;
      }

      const result = await response.json();
      return result?.success === true;
    } catch (error) {
      // Timeout, DNS, TLS, malformed JSON: indistinguishable from "failed".
      log?.warn({ msg: 'turnstile.error', error: error?.message });
      return false;
    }
  }

  return { verify };
}

/** The error the login route answers with when the challenge did not pass. */
export function turnstileFailed() {
  return forbidden('TURNSTILE_FAILED', 'Human verification failed. Please try again.');
}
