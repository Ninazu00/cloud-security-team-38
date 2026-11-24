#!/usr/bin/env bash
#
# Deploy the catalogue service onto floci.
#
#   ./deploy/deploy.sh              # build the image, create/update everything, verify
#   ./deploy/deploy.sh --no-build   # reuse the image that is already built
#   ./deploy/deploy.sh --teardown   # delete the service, load balancer and target group
#
# Requirements: bash, aws CLI v2, docker, curl — and a floci instance reachable
# through the `floci` AWS profile. The repository ships that profile's settings
# in `infra/README.md`; nothing here reads credentials directly.
#
#   export AWS_PROFILE=floci
#   ./deploy/deploy.sh
#
# Everything is created through the AWS API, so the same file works against real
# AWS apart from `FLOCI_URL`, the image URI and the region.
#
# What it creates
#   ECS cluster + Fargate service running the app image (one task)
#   Application Load Balancer in front, with a host rule for PUBLIC_HOST
#   Two IAM roles (execution: image pull + logs; task: secret, KMS, SES, logs)
#   CloudWatch log group, so the app's structured logs land where AWS puts them
#   A task definition carrying the environment the service expects
#
# Two emulator facts shape this script:
#   * An ALB listener shares floci's own address and the load balancer is chosen
#     by the Host header (floci docs, ELB v2 notes). That is why the browser URL
#     is http://localhost:8080 — floci publishes its port 80 there — and why a
#     host rule for `localhost` is what routes the request to the task.
#   * A locally built image whose tag is the ECR-shaped URI is used as-is
#     (FLOCI_SERVICES_ECR_PREFER_LOCAL_IMAGES), so no registry push is needed.

set -euo pipefail

# ---------------------------------------------------------------- configuration

REGION=${AWS_REGION:-us-east-1}
ACCOUNT=${FLOCI_ACCOUNT_ID:-000000000000}
CLUSTER=${CLUSTER:-class-tt-catalogue}
SERVICE=${SERVICE:-catalogue}
FAMILY=${FAMILY:-class-tt-catalogue}
CONTAINER=${CONTAINER:-app}
APP_PORT=${APP_PORT:-3000}
IMAGE_TAG=${IMAGE_TAG:-deploy}
REPOSITORY=${REPOSITORY:-class-tt/catalogue}
IMAGE="$ACCOUNT.dkr.ecr.$REGION.localhost:4566/$REPOSITORY:$IMAGE_TAG"
LOG_GROUP=${LOG_GROUP:-/class-tt/catalogue}
ALB_NAME=${ALB_NAME:-class-tt-catalogue-alb}
TG_NAME=${TG_NAME:-class-tt-catalogue-tg}
PUBLIC_HOST=${PUBLIC_HOST:-localhost}
APP_HOST_PORT=${APP_HOST_PORT:-8080}
PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-http://$PUBLIC_HOST:$APP_HOST_PORT}
DATABASE_URL=${DATABASE_URL:-postgres://class_tt:local_dev_only@class-tt-postgres:5432/catalogue}
FLOCI_URL=${FLOCI_URL:-http://floci:4566}

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)

BUILD=1
TEARDOWN=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --teardown) TEARDOWN=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# Git Bash rewrites arguments that look like paths; the API takes none of those,
# but the AWS CLI does receive Windows paths in a few places below.
case "${OSTYPE:-}" in msys* | cygwin*) export MSYS_NO_PATHCONV=1 ;; esac

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

# ------------------------------------------------------------------ small tools

say() { printf '\n== %s\n' "$*"; }
# Notes go to stderr so a function can print its result on stdout and still be
# captured with $(...) without the log lines coming along.
note() { printf '   %s\n' "$*" >&2; }
die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }

# Text output keeps the parsing in one place: every query returns a bare value.
awsq() { aws "$@" --region "$REGION" --output text; }

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

preflight() {
  for tool in aws docker curl; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is not on PATH"
  done
  local profile=${AWS_PROFILE:-default}
  aws sts get-caller-identity --profile "$profile" --region "$REGION" --output text >/dev/null \
    || die "cannot authenticate with profile '$profile' — is floci running? (docker compose -f infra/floci/docker-compose.yml up -d)"
  aws elbv2 describe-load-balancers --region "$REGION" --output text >/dev/null \
    || die "ELB v2 is not answering on profile '$profile'"
  note "profile $profile · region $REGION · endpoint $FLOCI_URL"
}

# ------------------------------------------------------------------- resources

ensure_cluster() {
  aws ecs create-cluster --cluster-name "$CLUSTER" --region "$REGION" --output text >/dev/null 2>&1 || true
  note "cluster $CLUSTER"
}

ensure_log_group() {
  aws logs create-log-group --log-group-name "$LOG_GROUP" --region "$REGION" >/dev/null 2>&1 || true
  aws logs put-retention-policy --log-group-name "$LOG_GROUP" --retention-in-days 7 \
    --region "$REGION" >/dev/null 2>&1 || true
  note "log group $LOG_GROUP"
}

ensure_role() {
  local name=$1 policy=$2 arn
  arn=$(aws iam get-role --role-name "$name" --query 'Role.Arn' --output text 2>/dev/null || true)
  if [ -z "$arn" ] || [ "$arn" = "None" ]; then
    local trust='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
    aws iam create-role --role-name "$name" --assume-role-policy-document "$trust" --output text >/dev/null
    arn=$(aws iam get-role --role-name "$name" --query 'Role.Arn' --output text)
  fi
  aws iam put-role-policy --role-name "$name" --policy-name "$name-inline" \
    --policy-document "$policy" --output text >/dev/null
  note "role $name"
  printf '%s' "$arn"
}

ensure_roles() {
  local execution task
  execution=$(ensure_role class-tt-catalogue-execution "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {\"Effect\": \"Allow\", \"Action\": [\"ecr:GetAuthorizationToken\", \"ecr:BatchGetImage\", \"ecr:GetDownloadUrlForLayer\"], \"Resource\": \"*\"},
      {\"Effect\": \"Allow\", \"Action\": [\"logs:CreateLogStream\", \"logs:PutLogEvents\"], \"Resource\": \"arn:aws:logs:$REGION:$ACCOUNT:log-group:$LOG_GROUP:*\"}
    ]}")
  task=$(ensure_role class-tt-catalogue-task "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [
      {\"Effect\": \"Allow\", \"Action\": [\"secretsmanager:GetSecretValue\"], \"Resource\": \"arn:aws:secretsmanager:$REGION:$ACCOUNT:secret:class-tt/jwt-signing-key*\"},
      {\"Effect\": \"Allow\", \"Action\": [\"kms:Decrypt\"], \"Resource\": \"arn:aws:kms:$REGION:$ACCOUNT:alias/class-tt-keystore\"},
      {\"Effect\": \"Allow\", \"Action\": [\"ses:SendEmail\"], \"Resource\": \"*\"},
      {\"Effect\": \"Allow\", \"Action\": [\"logs:CreateLogStream\", \"logs:PutLogEvents\"], \"Resource\": \"arn:aws:logs:$REGION:$ACCOUNT:log-group:$LOG_GROUP:*\"}
    ]}")
  note "two roles: image pull + logs, and secret + KMS + SES + logs"
  printf '%s %s' "$execution" "$task"
}

# One VPC per project with two subnets in two zones: an ALB refuses fewer.
ensure_network() {
  local vpc subnet_a subnet_b group
  vpc=$(awsq ec2 describe-vpcs --filters Name=tag:Project,Values=class-tt --query 'Vpcs[0].VpcId')
  if [ -z "$vpc" ] || [ "$vpc" = "None" ]; then
    vpc=$(awsq ec2 create-vpc --cidr-block 10.20.0.0/16 --query 'Vpc.VpcId')
    aws ec2 create-tags --resources "$vpc" --tags Key=Project,Value=class-tt Key=Name,Value=class-tt-vpc >/dev/null
  fi

  subnet_a=$(awsq ec2 describe-subnets --filters Name=vpc-id,Values="$vpc" Name=tag:Project,Values=class-tt Name=availability-zone,Values=us-east-1a --query 'Subnets[0].SubnetId')
  subnet_b=$(awsq ec2 describe-subnets --filters Name=vpc-id,Values="$vpc" Name=tag:Project,Values=class-tt Name=availability-zone,Values=us-east-1b --query 'Subnets[0].SubnetId')
  if [ -z "$subnet_a" ] || [ "$subnet_a" = "None" ]; then
    subnet_a=$(awsq ec2 create-subnet --vpc-id "$vpc" --cidr-block 10.20.1.0/24 --availability-zone us-east-1a --query 'Subnet.SubnetId')
    aws ec2 create-tags --resources "$subnet_a" --tags Key=Project,Value=class-tt Key=Name,Value=class-tt-us-east-1a >/dev/null
  fi
  if [ -z "$subnet_b" ] || [ "$subnet_b" = "None" ]; then
    subnet_b=$(awsq ec2 create-subnet --vpc-id "$vpc" --cidr-block 10.20.2.0/24 --availability-zone us-east-1b --query 'Subnet.SubnetId')
    aws ec2 create-tags --resources "$subnet_b" --tags Key=Project,Value=class-tt Key=Name,Value=class-tt-us-east-1b >/dev/null
  fi

  group=$(awsq ec2 describe-security-groups --filters Name=vpc-id,Values="$vpc" Name=group-name,Values=class-tt-app --query 'SecurityGroups[0].GroupId')
  if [ -z "$group" ] || [ "$group" = "None" ]; then
    group=$(awsq ec2 create-security-group --group-name class-tt-app --description 'catalogue tasks and load balancer' --vpc-id "$vpc" --query 'GroupId')
    # floci does not enforce these; real AWS would. The task port is open only
    # inside the VPC, which is the difference between "the database is reachable"
    # and "the internet can reach the database".
    aws ec2 authorize-security-group-ingress --group-id "$group" --protocol tcp --port "$APP_PORT" --cidr 10.20.0.0/16 >/dev/null 2>&1 || true
    aws ec2 authorize-security-group-ingress --group-id "$group" --protocol tcp --port 80 --cidr 10.20.0.0/16 >/dev/null 2>&1 || true
  fi

  note "vpc $vpc · subnets $subnet_a $subnet_b · sg $group"
  printf '%s %s %s %s' "$vpc" "$subnet_a" "$subnet_b" "$group"
}

register_task_definition() {
  local execution=$1 task=$2 definition
  definition=$(cat <<JSON
{
  "family": "$FAMILY",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "executionRoleArn": "$execution",
  "taskRoleArn": "$task",
  "containerDefinitions": [
    {
      "name": "$CONTAINER",
      "image": "$IMAGE",
      "essential": true,
      "portMappings": [{"containerPort": $APP_PORT, "protocol": "tcp"}],
      "environment": [
        {"name": "NODE_ENV", "value": "production"},
        {"name": "PORT", "value": "$APP_PORT"},
        {"name": "LOG_LEVEL", "value": "${LOG_LEVEL:-info}"},
        {"name": "DATABASE_URL", "value": "$(json_escape "$DATABASE_URL")"},
        {"name": "AWS_REGION", "value": "$REGION"},
        {"name": "AWS_ENDPOINT_URL", "value": "$FLOCI_URL"},
        {"name": "AWS_ACCESS_KEY_ID", "value": "test"},
        {"name": "AWS_SECRET_ACCESS_KEY", "value": "test"},
        {"name": "AWS_SESSION_TOKEN", "value": "test"},
        {"name": "KMS_KEY_ALIAS", "value": "alias/class-tt-keystore"},
        {"name": "JWT_SECRET_ID", "value": "class-tt/jwt-signing-key"},
        {"name": "MAIL_FROM", "value": "noreply@class-tt.local"},
        {"name": "PUBLIC_BASE_URL", "value": "$PUBLIC_BASE_URL"},
        {"name": "MAILER_ENABLED", "value": "true"},
        {"name": "MAILER_INTERVAL_MS", "value": "1000"},
        {"name": "RESEND_LIMIT_PER_HOUR", "value": "3"},
        {"name": "TURNSTILE_SECRET", "value": "1x0000000000000000000000000000000AA"}
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "$LOG_GROUP",
          "awslogs-region": "$REGION",
          "awslogs-stream-prefix": "app"
        }
      }
    }
  ]
}
JSON
)
  local arn
  arn=$(aws ecs register-task-definition --cli-input-json "$definition" --region "$REGION" \
    --query 'taskDefinition.taskDefinitionArn' --output text)
  note "task definition ${arn##*/}"
}

ensure_alb() {
  local vpc=$1 subnet_a=$2 subnet_b=$3 group=$4
  local alb_arn tg_arn listener_arn dns

  alb_arn=$(aws elbv2 describe-load-balancers --names "$ALB_NAME" --region "$REGION" \
    --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null || true)
  if [ -z "$alb_arn" ] || [ "$alb_arn" = "None" ]; then
    alb_arn=$(aws elbv2 create-load-balancer --name "$ALB_NAME" --subnets "$subnet_a" "$subnet_b" \
      --security-groups "$group" --scheme internet-facing --type application --region "$REGION" \
      --query 'LoadBalancers[0].LoadBalancerArn' --output text)
  fi
  dns=$(aws elbv2 describe-load-balancers --load-balancer-arns "$alb_arn" --region "$REGION" \
    --query 'LoadBalancers[0].DNSName' --output text)

  tg_arn=$(aws elbv2 describe-target-groups --names "$TG_NAME" --region "$REGION" \
    --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)
  if [ -z "$tg_arn" ] || [ "$tg_arn" = "None" ]; then
    # The health check is /readyz, not /healthz: the task should leave the
    # rotation when the database is unreachable, without being restarted.
    tg_arn=$(aws elbv2 create-target-group --name "$TG_NAME" --protocol HTTP --port "$APP_PORT" \
      --vpc-id "$vpc" --target-type ip --health-check-path /readyz --health-check-interval-seconds 15 \
      --health-check-timeout-seconds 3 --healthy-threshold-count 2 --unhealthy-threshold-count 3 \
      --region "$REGION" --query 'TargetGroups[0].TargetGroupArn' --output text)
  fi

  listener_arn=$(aws elbv2 describe-listeners --load-balancer-arn "$alb_arn" --region "$REGION" \
    --query 'Listeners[?Port==`80`].ListenerArn | [0]' --output text)
  if [ -z "$listener_arn" ] || [ "$listener_arn" = "None" ]; then
    # The default rule refuses: only the hostname published to the browser is
    # routed, so a stray Host header cannot reach the application.
    listener_arn=$(aws elbv2 create-listener --load-balancer-arn "$alb_arn" --protocol HTTP --port 80 \
      --default-actions 'Type=fixed-response,FixedResponseConfig={StatusCode=404,ContentType=text/plain,MessageBody=Not found}' \
      --region "$REGION" --query 'Listeners[0].ListenerArn' --output text)
  fi

  local has_rule
  # Priority is fixed, so a create that answers PriorityInUse means the rule is
  # already there. Creating blind and reading the error is shorter and more
  # reliable than matching against every condition shape the API may echo back.
  has_rule=$(aws elbv2 create-rule --listener-arn "$listener_arn" --priority 10 \
    --conditions "Field=host-header,HostHeaderConfig={Values=[$PUBLIC_HOST]}" \
    --actions "Type=forward,TargetGroupArn=$tg_arn" --region "$REGION" \
    --query 'Rules[0].Priority' --output text 2>&1) || true
  if printf '%s' "$has_rule" | grep -q 'PriorityInUse\|Duplicate'; then
    note "host rule for $PUBLIC_HOST already exists"
  elif printf '%s' "$has_rule" | grep -qi 'error'; then
    note "could not create the host rule: $has_rule"
  else
    note "host rule $PUBLIC_HOST -> $TG_NAME created"
  fi

  note "alb $dns · target group $TG_NAME · host rule $PUBLIC_HOST"
  printf '%s %s' "$alb_arn" "$tg_arn"
}

ensure_service() {
  local subnet_a=$1 subnet_b=$2 group=$3 tg_arn=$4 network
  network=$(printf '{"awsvpcConfiguration":{"subnets":["%s","%s"],"securityGroups":["%s"],"assignPublicIp":"ENABLED"}}' \
    "$subnet_a" "$subnet_b" "$group")

  local exists
  exists=$(aws ecs list-services --cluster "$CLUSTER" --region "$REGION" --query 'serviceArns' --output text)
  if ! printf '%s' "$exists" | grep -q "/$SERVICE\$"; then
    aws ecs create-service --cluster "$CLUSTER" --service-name "$SERVICE" --task-definition "$FAMILY" \
      --desired-count 1 --launch-type FARGATE --network-configuration "$network" \
      --load-balancers "targetGroupArn=$tg_arn,containerName=$CONTAINER,containerPort=$APP_PORT" \
      --region "$REGION" --output text >/dev/null
    note "service $SERVICE created, desired=1"
    return 0
  fi

  # Only roll when the image really changed. A forced redeploy on every run replaces
  # the task, and while the new one boots the load balancer still points at the old
  # address — which is exactly the "bad gateway" a second run used to produce.
  local running_def running_image
  running_def=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" \
    --query 'services[0].taskDefinition' --output text)
  running_image=$(aws ecs describe-task-definition --task-definition "$running_def" --region "$REGION" \
    --query 'taskDefinition.containerDefinitions[0].image' --output text)

  if [ "$running_image" = "$IMAGE" ] && [ "$FORCE" != 1 ]; then
    note "service $SERVICE already runs $IMAGE (use --force to redeploy)"
    return 0
  fi

  aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --task-definition "$FAMILY" \
    --desired-count 1 --force-new-deployment --region "$REGION" --output text >/dev/null
  note "service $SERVICE rolling to a new task"
}

# Autoscaling is a policy on the service, not a service of its own. The policy is
# registered so the deployment matches the design; whether the emulator actually
# moves desired count under load is a separate question, and the report says so
# rather than implying it was demonstrated.
ensure_autoscaling() {
  local resource="service/$CLUSTER/$SERVICE"
  aws application-autoscaling register-scalable-target \
    --service-namespace ecs \
    --resource-id "$resource" \
    --scalable-dimension ecs:service:DesiredCount \
    --min-capacity 1 --max-capacity 4 \
    --region "$REGION" --output text >/dev/null 2>&1 || true

  # Requests per target is the metric that matters here: the service is I/O bound,
  # so CPU would sit low while requests queue.
  aws application-autoscaling put-scaling-policy \
    --policy-name "$SERVICE-requests" \
    --service-namespace ecs \
    --resource-id "$resource" \
    --scalable-dimension ecs:service:DesiredCount \
    --policy-type TargetTrackingScaling \
    --target-tracking-scaling-policy-configuration '{"TargetValue":100,"ScaleOutCooldown":60,"ScaleInCooldown":60,"PredefinedMetricSpecification":{"PredefinedMetricType":"ALBRequestCountPerTarget"}}' \
    --region "$REGION" --output text >/dev/null 2>&1 \
    && note 'autoscaling policy: 100 requests per target, 1-4 tasks' \
    || note 'autoscaling policy not accepted by this emulator (the service still runs)'
}

wait_for_task() {
  local deadline=$((SECONDS + 240)) task status ip
  while [ $SECONDS -lt $deadline ]; do
    task=$(aws ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" --region "$REGION" --query 'taskArns[0]' --output text)
    if [ -n "$task" ] && [ "$task" != "None" ]; then
      status=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task" --region "$REGION" --query 'tasks[0].lastStatus' --output text)
      if [ "$status" = "RUNNING" ]; then
        ip=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task" --region "$REGION" \
          --query "tasks[0].attachments[0].details[?name=='privateIPv4Address'].value | [0]" --output text)
        note "task ${task##*/} running at $ip:$APP_PORT"
        printf '%s' "$ip"
        return 0
      fi
      if [ "$status" = "STOPPED" ]; then
        die "task stopped: $(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task" --region "$REGION" --query 'tasks[0].stoppedReason' --output text)"
      fi
    fi
    sleep 3
  done
  die "task did not reach RUNNING within 4 minutes — check: aws logs tail $LOG_GROUP --profile ${AWS_PROFILE:-default}"
}

wait_for_healthy_target() {
  local tg_arn=$1 deadline=$((SECONDS + 150)) state
  while [ $SECONDS -lt $deadline ]; do
    state=$(aws elbv2 describe-target-health --target-group-arn "$tg_arn" --region "$REGION" \
      --query 'TargetHealthDescriptions[0].TargetHealth.State' --output text)
    case "$state" in
      healthy) note 'target health: healthy'; return 0 ;;
      unhealthy) note 'target health: unhealthy — the task is up but /readyz is failing' ;;
    esac
    sleep 4
  done
  note "target health: ${state:-unknown}"
}

verify() {
  local url="$PUBLIC_BASE_URL/healthz" ready="$PUBLIC_BASE_URL/readyz" body
  body=$(curl -sS -m 10 "$url" || true)
  [ -n "$body" ] || die "no answer from $url — is floci publishing port 80? (see infra/floci/docker-compose.yml)"
  note "GET /healthz -> $body"
  note "GET /readyz  -> $(curl -sS -m 10 "$ready" || true)"
}

teardown() {
  say 'teardown'
  aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --desired-count 0 --region "$REGION" --output text >/dev/null 2>&1 || true
  aws ecs delete-service --cluster "$CLUSTER" --service "$SERVICE" --force --region "$REGION" --output text >/dev/null 2>&1 || true
  local alb_arn tg_arn
  alb_arn=$(aws elbv2 describe-load-balancers --names "$ALB_NAME" --region "$REGION" --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null || true)
  if [ -n "$alb_arn" ] && [ "$alb_arn" != "None" ]; then
    aws elbv2 delete-load-balancer --load-balancer-arn "$alb_arn" --region "$REGION" >/dev/null
  fi
  sleep 3
  tg_arn=$(aws elbv2 describe-target-groups --names "$TG_NAME" --region "$REGION" --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)
  if [ -n "$tg_arn" ] && [ "$tg_arn" != "None" ]; then
    aws elbv2 delete-target-group --target-group-arn "$tg_arn" --region "$REGION" >/dev/null 2>&1 || true
  fi
  note 'service, load balancer and target group removed; image, roles and log group stay'
}

# ------------------------------------------------------------------------ main

preflight
if [ "$TEARDOWN" -eq 1 ]; then teardown; exit 0; fi

say 'build image'
if [ "$BUILD" -eq 1 ]; then
  docker build -t "class-tt/catalogue:$IMAGE_TAG" "$ROOT_DIR" >/dev/null
  docker tag "class-tt/catalogue:$IMAGE_TAG" "$IMAGE"
  note "tagged $IMAGE"
else
  note 'skipped (--no-build)'
fi

say 'cluster, log group, roles'
ensure_cluster
ensure_log_group
read -r EXECUTION_ROLE TASK_ROLE <<<"$(ensure_roles)"

say 'network'
read -r VPC SUBNET_A SUBNET_B GROUP <<<"$(ensure_network)"

say 'task definition'
register_task_definition "$EXECUTION_ROLE" "$TASK_ROLE"

say 'load balancer'
read -r ALB_ARN TG_ARN <<<"$(ensure_alb "$VPC" "$SUBNET_A" "$SUBNET_B" "$GROUP")"

say 'service'
ensure_service "$SUBNET_A" "$SUBNET_B" "$GROUP" "$TG_ARN"

say 'autoscaling'
ensure_autoscaling

say 'wait for the task'
TASK_IP=$(wait_for_task)

say 'point the target group at the task'
if aws elbv2 describe-target-health --target-group-arn "$TG_ARN" --region "$REGION" \
  --query "TargetHealthDescriptions[?Target.Id=='$TASK_IP'].Target.Id" --output text | grep -q .; then
  note 'the service registered its own target'
else
  aws elbv2 register-targets --target-group-arn "$TG_ARN" --targets "Id=$TASK_IP,Port=$APP_PORT" --region "$REGION" >/dev/null
  note "registered $TASK_IP:$APP_PORT (the emulator does not wire services to targets yet)"
fi

# A redeploy leaves the previous task's address behind; the health check would
# eventually stop routing to it, but a stale target in the console invites the
# wrong conclusion.
for stale in $(aws elbv2 describe-target-health --target-group-arn "$TG_ARN" --region "$REGION" \
  --query "TargetHealthDescriptions[?Target.Id!='$TASK_IP'].Target.Id" --output text); do
  aws elbv2 deregister-targets --target-group-arn "$TG_ARN" --targets "Id=$stale,Port=$APP_PORT" --region "$REGION" >/dev/null
  note "deregistered stale target $stale"
done

wait_for_healthy_target "$TG_ARN"

say 'verify through the load balancer'
verify

cat <<EOF

Deployed. Open $PUBLIC_BASE_URL/ and sign in with the seeded admin account
(admin@class-tt.local / local-admin-password).

  load balancer  $ALB_ARN
  host rule      Host: $PUBLIC_HOST -> $TG_NAME
  task image     $IMAGE
  logs           aws logs tail $LOG_GROUP --profile ${AWS_PROFILE:-default} --follow
  teardown       ./deploy/deploy.sh --teardown
EOF
