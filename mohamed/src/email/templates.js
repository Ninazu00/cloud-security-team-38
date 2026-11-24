/**
 * The two mails this service sends, as plain functions.
 *
 * Both return `{ subject, text, html }`. No template engine: three fixed strings
 * are easier to audit than a rendering library, and a template that takes user
 * data is a template you can inject into. The only substitution is a URL we
 * built ourselves.
 *
 * The text part is not decoration — it is what a client shows when HTML is
 * unavailable, and it is what a test asserts against.
 */

const BRAND = 'Class TT';

function layout(heading, paragraphs, link) {
  const body = paragraphs
    .map((line) => `<p style="margin:0 0 12px;line-height:1.5">${escapeHtml(line)}</p>`)
    .join('');
  const button = link
    ? `<p style="margin:24px 0"><a href="${escapeHtml(link.url)}"
         style="background:#2f4bd0;color:#fff;padding:10px 18px;border-radius:8px;
                text-decoration:none;display:inline-block">${escapeHtml(link.label)}</a></p>
       <p style="margin:0 0 12px;color:#555;font-size:13px">If the button does not work, paste this
         address into your browser:<br>${escapeHtml(link.url)}</p>`
    : '';

  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f5f6f8;font-family:Segoe UI,Arial,sans-serif;color:#1d2330">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:28px">
    <p style="margin:0 0 20px;font-weight:600">${BRAND}</p>
    <h1 style="margin:0 0 16px;font-size:20px">${escapeHtml(heading)}</h1>
    ${body}
    ${button}
  </div>
</body></html>`;
}

/** Verification mail. The link points at the frontend, which posts the token. */
export function verificationEmail({ verifyUrl, expiresInHours = 24 }) {
  const text = [
    `Confirm your ${BRAND} email address`,
    '',
    'Open this address to finish creating your account:',
    verifyUrl,
    '',
    `The link works once and expires in ${expiresInHours} hours.`,
    'If you did not create an account, ignore this message.',
  ].join('\n');

  return {
    subject: `Confirm your ${BRAND} email address`,
    text,
    html: layout(
      'Confirm your email address',
      [
        'Open the link below to finish creating your account.',
        `It works once and expires in ${expiresInHours} hours.`,
        'If you did not create an account, ignore this message.',
      ],
      { url: verifyUrl, label: 'Confirm email address' },
    ),
  };
}

/** Sent after a password reset, so a mailbox owner notices a change they did not make. */
export function passwordChangedEmail({ when }) {
  const text = [
    `Your ${BRAND} password was changed`,
    '',
    `This happened at ${when}.`,
    'Every existing session was signed out. If this was not you, reset the password again',
    'and contact the module team.',
  ].join('\n');

  return {
    subject: `Your ${BRAND} password was changed`,
    text,
    html: layout(
      'Your password was changed',
      [
        `This happened at ${when}.`,
        'Every existing session was signed out.',
        'If this was not you, reset the password again and contact the module team.',
      ],
      null,
    ),
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
