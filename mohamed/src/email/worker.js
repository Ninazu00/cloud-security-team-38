import { passwordChangedEmail, verificationEmail } from './templates.js';

/**
 * Drains `email_outbox` inside the web process.
 *
 * A background loop rather than a separate worker service: one process, one
 * database, a handful of mails per sign-up. The cost is that mail stops while
 * every task is down; the benefit is that there is no queue to deploy, monitor
 * or pay for, and the claim query already makes N tasks safe.
 *
 * `runOnce` is the useful surface: the loop is just `runOnce` on a timer, so the
 * tests drive the same code path instead of a second implementation.
 */

export function createOutboxWorker({
  outbox,
  send,
  issueToken,
  publicBaseUrl,
  log = null,
  batchSize = 10,
  verifyTtlSeconds = 24 * 60 * 60,
} = {}) {
  if (typeof outbox?.claim !== 'function') throw new Error('createOutboxWorker needs outbox.');
  if (typeof send !== 'function') throw new Error('createOutboxWorker needs send().');
  if (typeof issueToken !== 'function') throw new Error('createOutboxWorker needs issueToken().');

  /** Template key → rendered message. The token is minted here, at send time. */
  async function render(job) {
    switch (job.templateKey) {
      case 'verify_email': {
        const token = await issueToken({
          userId: job.payload.userId,
          purpose: 'email_verify',
          ttlSeconds: verifyTtlSeconds,
        });

        const url = new URL('/verify-email.html', publicBaseUrl);
        url.searchParams.set('token', token);

        return verificationEmail({ verifyUrl: url.toString(), expiresInHours: 24 });
      }

      case 'password_changed':
        return passwordChangedEmail({ when: new Date().toISOString().replace('T', ' ').slice(0, 16) });

      default:
        // A row with an unknown template is a bug, not a transient failure: fail
        // it immediately rather than retrying five times for nothing.
        throw new Error(`unknown template key: ${job.templateKey}`);
    }
  }

  async function runOnce() {
    const jobs = await outbox.claim(batchSize);
    let sent = 0;
    let failed = 0;

    for (const job of jobs) {
      try {
        const message = await render(job);
        await send({ to: job.toEmail, ...message });
        await outbox.markSent(job.id);
        sent += 1;
      } catch (error) {
        await outbox.markFailed(job.id, error);
        failed += 1;
        // The recipient's address is not logged: the outbox id identifies the row.
        log?.warn({
          msg: 'mail.failed',
          outboxId: job.id,
          template: job.templateKey,
          attempt: job.attempts,
          error: error?.message ?? String(error),
        });
      }
    }

    return { sent, failed, claimed: jobs.length };
  }

  /** Start the loop. `unref` so an idle timer never keeps the process alive. */
  function start({ intervalMs = 2000 } = {}) {
    let stopped = false;
    let running = false;

    const tick = async () => {
      if (stopped || running) return; // a slow SES call must not stack up ticks
      running = true;
      try {
        await runOnce();
      } catch (error) {
        log?.error({ msg: 'mail.loop_failed', error: error?.message ?? String(error) });
      } finally {
        running = false;
      }
    };

    const timer = setInterval(tick, intervalMs);
    timer.unref();

    return function stop() {
      stopped = true;
      clearInterval(timer);
    };
  }

  return { runOnce, start };
}
