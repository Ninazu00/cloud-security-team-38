import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

/**
 * The only file that knows the AWS SDK exists.
 *
 * `keystore.js` wants two verbs — "give me this secret" and "decrypt these bytes"
 * — so they are adapted here into plain functions. Two payoffs: the keystore is
 * testable offline with fakes, and swapping the transport (SDK, raw SigV4, a
 * different emulator) never touches the crypto code.
 *
 * Endpoint resolution matters because the assessment target is floci, not AWS:
 * when `endpoint` is set, requests go there. `testCredentials` is a separate,
 * explicit flag rather than something inferred from the environment, because an
 * inference is a bypass waiting to happen — `AWS_ENDPOINT_URL` inherited from a
 * copied `.env` would otherwise swap real task-role credentials for `test` in a
 * deployment, and the only visible symptom would be authenticating as nobody.
 */
export function createAwsPorts({ region = 'us-east-1', endpoint, testCredentials = false } = {}) {
  const clientConfig = { region };

  if (endpoint) clientConfig.endpoint = endpoint;

  // floci and LocalStack accept any credential but still want SigV4 headers.
  // Callers pass `testCredentials` only for a local emulator; the flag is never
  // derived from `process.env`, so a deployed task always uses its task role.
  if (endpoint && testCredentials) {
    clientConfig.credentials = {
      accessKeyId: 'test',
      secretAccessKey: 'test',
      sessionToken: 'test',
    };
  }

  const kmsClient = new KMSClient(clientConfig);
  const secretsClient = new SecretsManagerClient(clientConfig);

  return {
    kms: {
      async decrypt({ ciphertext, keyId }) {
        const out = await kmsClient.send(
          new DecryptCommand({
            CiphertextBlob: ciphertext,
            KeyId: keyId,
            EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
          }),
        );
        return Buffer.from(out.Plaintext);
      },

      async encrypt({ plaintext, keyId }) {
        const out = await kmsClient.send(
          new EncryptCommand({
            Plaintext: Buffer.from(plaintext, 'utf8'),
            KeyId: keyId,
            EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
          }),
        );
        return Buffer.from(out.CiphertextBlob);
      },
    },

    secrets: {
      async getSecretValue(secretId) {
        const out = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretId }));
        if (typeof out.SecretString === 'string') return out.SecretString;
        if (out.SecretBinary) return Buffer.from(out.SecretBinary).toString('utf8');
        throw new Error(`secret ${secretId} has no string or binary value.`);
      },

      async putSecretValue(secretId, value) {
        await secretsClient.send(
          new PutSecretValueCommand({ SecretId: secretId, SecretString: value }),
        );
      },

      async ensureSecret(secretId, value, description) {
        try {
          await secretsClient.send(new GetSecretValueCommand({ SecretId: secretId }));
        } catch (error) {
          if (error?.name !== 'ResourceNotFoundException') throw error;
          await secretsClient.send(
            new CreateSecretCommand({
              Name: secretId,
              SecretString: value,
              Description: description,
            }),
          );
          return 'created';
        }

        await secretsClient.send(
          new PutSecretValueCommand({ SecretId: secretId, SecretString: value }),
        );
        return 'updated';
      },
    },
  };
}
