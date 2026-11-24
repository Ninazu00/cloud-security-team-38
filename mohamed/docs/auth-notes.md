# Auth design notes — for the report and for talking to the team

Kept here so the wording is settled before it has to be defended. Sources: the
approved contract (`docs/api-contract.md`), the architecture docs (`docs/07`), and
what was actually run against floci.

## 1. Four identity mechanisms, not one

The word "identity" covers four different things in this system. Conflating them is
the usual way a report loses a mark, because only one of the four is federation.

| Layer | Mechanism | Is it federation? |
|---|---|---|
| Task → AWS | ECS task role; credentials served by the ECS agent at `169.254.170.2` | **No** — an IAM principal |
| Task → KMS / Secrets Manager | IAM policy evaluation (`kms:Decrypt`, `secretsmanager:GetSecretValue`) | **No** — authorisation |
| Catalogue → Timetable, Compare & Share | RS256 JWT verified against a published JWKS | **Yes, in effect** — issuer and relying parties |
| CI → AWS (not built) | GitHub OIDC → `sts:AssumeRoleWithWebIdentity` | Yes — and floci cannot emulate `sts` |

The contrast that makes the point: **EKS IRSA** (and GitHub Actions → AWS) works by
presenting an OIDC token minted by a *third party*, whose keys AWS already trusts.
That is federation — two authorities. An **ECS task role** involves no third party
and no token exchange, so calling it federation would be wrong.

Sentence for an examiner:

> The service authenticates to AWS as a workload identity, and acts as a small
> identity provider to its peers. The second half is federated trust established by
> key distribution; the first half is not federation at all.

## 2. Why the peers can verify locally

`Catalogue` mints tokens and publishes `{kty, use, alg, kid, n, e}` at
`/.well-known/jwks.json`. Timetable and Compare & Share fetch that once, cache it
for 10 minutes, and verify **without calling back**.

- **Public key only.** The private half never leaves custody, so publishing is safe.
  This is the reason `RS256` was chosen over `HS256`: with a shared secret every
  verifier could also *mint*, which would silently create three identity providers.
- **Availability upside / revocation downside come from the same property.** If the
  Catalogue service is down, already-issued tokens keep working at the other two
  services. The price is that a token cannot be withdrawn before it expires.
- **Revocation is therefore time-bounded.** Logout revokes the *refresh* session
  immediately; the access token survives at most its 2-hour lifetime. That lifetime
  is a revocation-policy decision, not a performance one.
- **Rotation without a flag day.** On an unknown `kid`, a verifier refetches the
  JWKS once; the `retired` keys stay published until the longest token lifetime has
  drained, so the old key keeps verifying while the new one mints.

## 3. What a relying party must check — all four, in this order

```text
1. algorithms: ['RS256'] only      // never take alg from the token
2. signature over "header.payload" with the key named by kid
3. iss === "class-tt" && aud === "class-tt"
4. exp/iat within 60 s clock skew, and reject a far-future iat
```

Each line blocks a specific, documented attack:

| Check | Attack it stops |
|---|---|
| allow-list `RS256` | `alg: none`; `RS256 → HS256` confusion (sign with the public key as an HMAC secret) |
| signature against the `kid` key | payload tampering (e.g. rewriting `role` to `admin`) |
| `iss` / `aud` | a token minted for another issuer or another product being replayed here |
| `exp` with skew | expired tokens; and skew tolerance is what keeps clocks from logging people out |

## 4. Key custody chain (what "the key is in memory only" means)

```text
1. Task starts with a task role (IAM principal).
2. GET class-tt/jwt-signing-key  → JSON: { current: { kid, ciphertext } }   ← ciphertext only
3. kms:Decrypt(ciphertext, alias/class-tt-keystore) → PEM                    ← audited call
4. crypto.createPrivateKey(pem) → KeyObject held by that process
5. PEM string dropped; signing is local from then on (no per-token AWS call)
```

Both halves are required: the secret alone is opaque, and `kms:Decrypt` alone has
nothing to decrypt. Blast radius is the intersection of two grants, plus a
CloudTrail entry per unseal.

Limits stated honestly:

- A core dump or attached debugger captures the key; the mitigations are
  no-core-dumps, no debugger in the image, read-only root filesystem.
- A compromised process is a compromised key — KMS protects the key at rest and in
  transit, not from code running beside it.
- Unsealing happens once per task, not per request. Per-token `kms:Sign` is the
  stronger variant, and probe **A2** proved floci supports it
  (`RSA_2048` `SIGN_VERIFY` + `sign` + `get-public-key`); it was not adopted because
  it puts a network call on the login path.

## 5. Decisions that belong in the report's threat table

| Decision | Threat it answers | Cost accepted |
|---|---|---|
| RS256 + JWKS, not HS256 | verifier could mint tokens | larger tokens, key distribution needed |
| One audience `class-tt` for all three services | — | a stolen token works across the product |
| 2-hour access token | stolen token lifetime | no instant revocation |
| Refresh is an opaque, rotating, hashed row | replay; theft of the cookie | a DB round trip per refresh |
| Password check **before** lock check | account-existence oracle | one hash per attempt on a locked account |
| Uniform `202` on register / reset request | enumeration | slightly worse UX |
| `UNAUTHENTICATED` for missing, malformed, expired and unverifiable tokens | token oracle | harder debugging; the reason is logged, not returned |
