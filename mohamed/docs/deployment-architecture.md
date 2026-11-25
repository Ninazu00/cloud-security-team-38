# Deployment architecture

What the component runs on, why each piece is there, and what the emulator can
and cannot prove. Everything below is created by the Terraform in `infra/`.

## Shape

```
browser
  |
  | HTTPS 443 (self-signed, imported into ACM)
  v
application load balancer  class-tt-catalogue-alb
  |  host rule: localhost -> target group
  |  priority 1: /healthz, /readyz -> fixed 404
  v
ECS Fargate task  (private IP in 10.240.0.0/16)
  |-- Secrets Manager: database URL, Turnstile secret
  |-- KMS: alias/class-tt-keystore, decrypt once at boot
  |-- SES: verification and reset mail
  |-- CloudWatch: JSON logs to /class-tt/catalogue
  |-- ECR: image pulled at task start
  v
Neon PostgreSQL 18 (TLS, sslmode=verify-full)
```

Two IAM roles: the execution role pulls the image, writes logs and reads the two
task secrets; the task role signs and decrypts, and sends mail. Neither role has
more than it needs, and the task role has no log permissions at all.

## The seven services, and the threat each one answers

| Service | Why it is here |
|---|---|
| ALB | TLS termination, one public entry point, a target that can be taken out of rotation |
| ECS Fargate | runs the container without a host to patch |
| ECR | the image, immutable tags, scan on push |
| KMS | the signing key is ciphertext at rest and only decryptable by this task |
| Secrets Manager | database URL and Turnstile secret are injected, not stored in the image |
| SES | verification and reset mail, sent from the service rather than the client |
| CloudWatch | one place for the request log and the 4xx/5xx lines |

## Network

- VPC `10.42.0.0/16`, two public subnets in `us-east-1a` and `us-east-1b`.
  Public because the task has to reach Neon and SES, and a NAT gateway is real
  money for a student deployment. On real AWS the recommendation is private
  subnets plus a NAT, or interface endpoints for ECR, Secrets Manager, KMS,
  CloudWatch and SES.
- Two security groups. The load balancer accepts 443 from anywhere and reaches
  the task **by group reference**, not by CIDR. The task accepts 3000 only from
  the load balancer group, and can open outbound connections. Reference by group
  means a new load balancer in the same group is allowed and nothing else is.
- The rules are separate `aws_vpc_security_group_*_rule` resources rather than
  inline blocks, because two groups pointing at each other inline would be a
  dependency cycle in Terraform.

## The load balancer

- HTTPS listener on 443, default action a fixed 404, so an unknown `Host` header
  cannot reach the application.
- Priority 1 answers `/healthz` and `/readyz` with 404 for every host, so the
  probes exist for the target group and not for the internet.
- Priority 10 forwards `Host: localhost` to the target group.
- The target group checks `GET /readyz` on port 3000 every 15 seconds. Health
  checks go to the task directly, so the probe rule does not intercept them.

## The task

- `node:24-alpine`, `USER node`, read-only root filesystem, 0.25 vCPU and 512 MB.
- `DATABASE_URL` and `TURNSTILE_SECRET` come from `secrets.valueFrom`, so they
  appear in the task definition as a secret name, not a value.
- The container waits for the load balancer to report healthy before the service
  is considered stable, with a grace period so a slow first boot is not a failed
  deployment.
- Autoscaling: target tracking on `ALBRequestCountPerTarget = 100`, one to four
  tasks. Registered, never observed scaling, because no load was generated.

## What is proven, and how

- `terraform apply` from an empty account creates the stack, and a second apply
  reports `No changes`.
- `https://localhost:8443/` returns 200, `/readyz` and `/healthz` return 404 from
  outside, `/api/courses` returns 401, and `/.well-known/jwks.json` returns the
  public key.
- With Postgres stopped, `/readyz` returns 503 and `/healthz` stays 200, which is
  the split the target group relies on.
- The security group rules and both IAM policies were read back from the API
  after the apply, not just from the plan.

## What floci cannot prove

- **IAM is stored, not enforced.** A wrong ARN would still work here. The
  policies are written to be correct on AWS: specific ARNs everywhere except
  `ecr:GetAuthorizationToken`, `kms:Decrypt` on the key ARN rather than the
  alias, and no log permissions on the task role.
- **No CloudTrail**, so the audit trail is the application log line
  `keystore.unsealed` rather than an AWS record.
- **One socket for every load balancer**, so the demo needs the
  `Host: localhost` rule and port 8443. On AWS this is an ordinary host rule.
- **No image pull from ECR** with Docker Desktop, so the task runs the locally
  tagged image.
- **Target health is reported optimistically** after the database went away, so
  the draining behaviour is designed and the endpoint semantics are measured, but
  the load balancer's reaction was not observed.

## Reset and recovery

`terraform destroy` removes the stack in dependency order. The KMS key and the
sealed signing key are created once by `scripts/seal-key.mjs` and are not managed
by Terraform: destroying either makes the other useless, and every session
invalid.
