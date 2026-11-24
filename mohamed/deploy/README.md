# Deploying to floci

One script does the whole deployment:

```bash
export AWS_PROFILE=floci
cd mohamed
./deploy/deploy.sh
```

Then open <http://localhost:8080> and sign in as `admin@class-tt.local` /
`local-admin-password` (that account comes from `scripts/seed-admin.mjs`).

You need `bash`, the `aws` CLI, `docker`, `curl`, and the local stack running:

```bash
cd infra/floci && docker compose up -d
```

Two flags, when you do not want a rebuild or want everything gone:

```bash
./deploy/deploy.sh --no-build
./deploy/deploy.sh --teardown
```

On Windows, run it from Git Bash. The script sets `MSYS_NO_PATHCONV=1` itself so
the `aws` arguments are not rewritten into Windows paths.

## What it creates

- an ECS cluster `class-tt-catalogue` and a service `catalogue` running one
  Fargate task, with autoscaling between 1 and 4 tasks at 100 requests per target
- a task definition with the app image, the environment, and CloudWatch logging
- a load balancer with a health check on `/readyz` and a rule that sends
  `Host: localhost` to the task; every other host gets a 404
- two IAM roles: one to pull the image and write logs, one for the task itself
  (read the sealed signing key, decrypt it with KMS, send mail with SES)
- a VPC with two subnets in two zones, because a load balancer refuses fewer
- a log group `/class-tt/catalogue` with 7-day retention

It is safe to run again. Existing resources are reused, the task definition gets
a new revision, the service is redeployed, and targets pointing at the previous
task are removed.

## Two things about the emulator

The load balancer does not have its own address. Listeners share floci's port 80
and are picked by the `Host` header, which is why the compose file publishes
`127.0.0.1:8080:80` and why the rule is on `Host: localhost`. A browser cannot
set that header itself, so `localhost:8080` is the cheapest honest way to reach
the task.

Pushing to the ECR URI does not work from Docker Desktop: `*.localhost` does not
resolve inside the daemon, so the push fails before it starts. floci reuses local
images when their tag looks like an ECR one
(`FLOCI_SERVICES_ECR_PREFER_LOCAL_IMAGES=1`, the default), so the script tags the
image `000000000000.dkr.ecr.us-east-1.localhost:4566/class-tt/catalogue:deploy`
and the task definition stays exactly what real AWS would run. Being honest
about the gap: the registry half of ECR is not exercised by this script.

## Checking that it worked

```bash
curl -s http://localhost:8080/healthz                      # {"status":"ok"}
curl -s http://localhost:8080/readyz                       # {"status":"ready","db":"ok","ms":2}
aws logs tail /class-tt/catalogue --follow                 # the app's own JSON lines
aws ecs describe-services --cluster class-tt-catalogue \
  --services catalogue --query 'services[0].{desired:desiredCount,running:runningCount}'
```

The two health endpoints answer different questions. `/healthz` is the container
check, `/readyz` is the load balancer check. With Postgres stopped, `/readyz`
returns 503 and `/healthz` still returns 200, so the platform should take the
task out of rotation instead of restarting it.

I measured that on the deployed service: `/readyz` did turn 503 while `/healthz`
stayed 200, and the task was not restarted. floci's own target health did not
flip to unhealthy within the 20 seconds I waited, so I am not claiming that the
draining works there — only that the endpoint behaves correctly.

## Going to real AWS

The script's values change, and four things get added: push the image to ECR
instead of tagging it locally, put TLS on the listener with a real certificate
and drop the host rule, point `DATABASE_URL` at Neon, and remove the `test`
credentials from the environment because the task role supplies real ones. The
KMS permission also has to exist on the key policy, not only in the IAM policy,
which is the mistake that costs an afternoon.
