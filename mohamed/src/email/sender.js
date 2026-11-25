import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

/**
 * The only file that knows SES exists.
 *
 * Two SES details worth naming:
 *  - **SESv2** is used (`SendEmailCommand` on `SESv2Client`) because the v1 API is
 *    legacy and v2 is what the console and the docs now describe.
 *  - The sender address must be a **verified identity** in the account. On floci
 *    that is one command (`aws ses verify-email-identity`); in a real account it
 *    is a DNS record or a mailbox click. Nothing in this file can fake it, which
 *    is why the deployment runbook runs that command before the first sign-up.
 *
 * `testCredentials` is passed in by the caller rather than inferred here: an ECS
 * task with a task role sets `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, not
 * `AWS_ACCESS_KEY_ID`, so guessing from the environment could swap real
 * credentials for the literals "test" in a deployment that talks to a real SES.
 */
export function createSesSender({
  region = 'us-east-1',
  endpoint = null,
  fromAddress,
  testCredentials = false,
  client = null,
} = {}) {
  if (!fromAddress) throw new Error('createSesSender needs fromAddress (a verified identity).');

  const ses =
    client ??
    new SESv2Client({
      region,
      ...(endpoint ? { endpoint } : {}),
      ...(testCredentials
        ? { credentials: { accessKeyId: 'test', secretAccessKey: 'test' } }
        : {}),
    });

  return async function send({ to, subject, text, html }) {
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: fromAddress,
        Destination: { ToAddresses: [to] },
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: text, Charset: 'UTF-8' },
              Html: { Data: html, Charset: 'UTF-8' },
            },
          },
        },
      }),
    );
  };
}

/**
 * A sender that collects messages instead of sending them. Used by the tests so
 * the verification flow can be exercised without a mail server - the token is
 * read back out of the rendered text, exactly as a user would read it.
 */
export function createCaptureSender() {
  const messages = [];
  const send = async (message) => {
    messages.push(message);
  };
  return { send, messages };
}
