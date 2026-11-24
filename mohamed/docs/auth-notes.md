# Auth notes

Things I want to be able to say correctly in the report and to the other two.

## Four different "identity" things

The word identity covers four different situations here, and only one of them is
federation. Mixing them up is an easy way to lose marks.

1. **The task talking to AWS.** ECS gives the container a role, and the agent
   serves it credentials from `169.254.170.2`. That is a workload identity. It is
   not federation: no third party, no token exchange.
2. **The task talking to KMS and Secrets Manager.** Plain IAM authorisation. Also
   not federation.
3. **Catalogue talking to Timetable and Compare & Share.** This one is
   federation in effect: I sign a token, they verify it against a key I publish.
   Two authorities are involved.
4. **CI talking to AWS** (not built). GitHub's OIDC token exchanged with
   `sts:AssumeRoleWithWebIdentity`. That would be real federation, and floci
   cannot do it because it has no `sts`.

The comparison that makes it clear: EKS IRSA works because a third party mints a
token whose keys AWS already trusts. An ECS task role never involves a third
party, so calling it federation is wrong.

## Why the other services can verify without asking me

The tokens are signed with RS256 and the public key is published at
`/.well-known/jwks.json`. Timetable and Compare & Share fetch it once, cache it
for ten minutes, and check signatures themselves.

- Only the public key is published, so this is safe, and it is the reason I did
  not use HS256 — a shared secret would let every verifier mint tokens, and then
  there would be three identity providers instead of one.
- The upside and the downside are the same fact: if my service is down, tokens
  that were already issued keep working. But a token cannot be withdrawn either,
  so revocation is limited by the two-hour lifetime.
- What a relying party has to check: `alg` must be RS256, the signature must be
  over `header.payload`, `iss` and `aud` must both be `class-tt`, and `exp` must
  be in the future with at most 60 seconds of clock skew.

One audience for all three services is a deliberate simplification. It means a
stolen token works anywhere in the product, and it means I cannot tell which
service a token was meant for.

## How the signing key is kept

At boot, the task calls Secrets Manager and gets a ciphertext. It calls KMS to
decrypt it, turns the result into a private key, and drops the PEM string. The
key lives in memory for the life of the task; there is no file and no environment
variable holding it.

Reading the secret alone is useless — it is ciphertext. Calling KMS alone gets
nothing, because the task does not know which blob to decrypt. So an attacker
needs both permissions, and both calls are logged.

If either call fails, the task does not start. A task that cannot sign is worse
than a task that is not running, because it would answer logins it cannot
actually serve.

Limits I will say out loud rather than hide: a core dump or a debugger can read
the key out of memory, a compromised process owns it, and there is no CloudTrail
on floci, so on the emulator the evidence is the `keystore.unsealed` log line
rather than an audit trail.

Per-token signing with `kms:Sign` also works — I tested it — but it puts a network
call on the login path, so it stays an option rather than the design.

## Decisions worth defending

| Decision | What it buys | What it costs |
|---|---|---|
| RS256 over HS256 | verifiers can check but not mint | bigger tokens, key management |
| Two-hour access tokens | a stolen token expires | no instant revocation |
| Opaque rotating refresh tokens | revocation works, and reuse is detectable | a database row per session |
| Password checked before the lockout | an unknown address cannot be probed by timing a lock | one extra hash per locked attempt |
| Same `202` for register whether or not the address exists | no account enumeration | a user who mistyped their address gets no hint |
| One `UNAUTHENTICATED` code | no oracle for expired vs unknown | the client cannot tell, and has to refresh blindly |
