#!/usr/bin/env bash
set -euo pipefail

export MSYS_NO_PATHCONV=1
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"
ENDPOINT="${AWS_ENDPOINT_URL:-http://127.0.0.1:4566}"

awsl() {
  aws --endpoint-url "$ENDPOINT" "$@"
}

ROLE_NAME="timetable-api-role"
POLICY_NAME="timetable-service-policy"
FUNC_NAME="timetable-api"
API_NAME="timetable-http-api"

echo "1. Ensuring IAM role and least-privilege policy..."
awsl iam create-role --role-name "$ROLE_NAME" \
  --assume-role-policy-document file://infra/iam/trust-policy.json >/dev/null 2>&1 || true

awsl iam create-policy --policy-name "$POLICY_NAME" \
  --policy-document file://infra/iam/timetable-policy.json >/dev/null 2>&1 || true

awsl iam attach-role-policy --role-name "$ROLE_NAME" \
  --policy-arn "arn:aws:iam::000000000000:policy/${POLICY_NAME}" >/dev/null 2>&1 || true

echo "2. Building lambda.zip..."
npm run zip

ENV_VARS="Variables={DEP_MODE=mock,NODE_ENV=production,TIMETABLES_TABLE=timetables,SECTION_INDEX_TABLE=section_timetables,CORS_ORIGINS=http://localhost:4566,TERM_START_DATE=2026-09-20,TERM_END_DATE=2026-12-24,TIMEZONE=Africa/Cairo,JWT_ISSUER=class-tt,JWT_AUDIENCE=class-tt}"

echo "3. Deploying Lambda function ($FUNC_NAME)..."
if awsl lambda get-function --function-name "$FUNC_NAME" >/dev/null 2>&1; then
  awsl lambda update-function-code --function-name "$FUNC_NAME" \
    --zip-file fileb://lambda.zip >/dev/null
  awsl lambda wait function-updated-v2 --function-name "$FUNC_NAME" || true
  awsl lambda update-function-configuration --function-name "$FUNC_NAME" \
    --environment "$ENV_VARS" >/dev/null
else
  awsl lambda create-function --function-name "$FUNC_NAME" \
    --runtime nodejs24.x \
    --handler src/lambda.handler \
    --role "arn:aws:iam::000000000000:role/${ROLE_NAME}" \
    --zip-file fileb://lambda.zip \
    --timeout 15 \
    --environment "$ENV_VARS" >/dev/null
  awsl lambda wait function-active-v2 --function-name "$FUNC_NAME" || true
fi

echo "4. Creating API Gateway HTTP API ($API_NAME)..."
EXISTING_API_ID=$(awsl apigatewayv2 get-apis \
  --query "Items[?Name=='${API_NAME}'].ApiId | [0]" --output text)

if [ -n "$EXISTING_API_ID" ] && [ "$EXISTING_API_ID" != "None" ]; then
  API_ID="$EXISTING_API_ID"
  echo "   Reusing existing API ID: $API_ID"
else
  API_ID=$(awsl apigatewayv2 create-api --name "$API_NAME" \
    --protocol-type HTTP --query ApiId --output text)

  INTEGRATION_ID=$(awsl apigatewayv2 create-integration --api-id "$API_ID" \
    --integration-type AWS_PROXY --payload-format-version 2.0 \
    --integration-uri "arn:aws:lambda:us-east-1:000000000000:function:${FUNC_NAME}" \
    --query IntegrationId --output text)

  ROUTES=(
    "GET /api/health"
    "OPTIONS /api/health"
    "POST /api/timetables/check"
    "OPTIONS /api/timetables/check"
    "POST /api/timetables/generate"
    "OPTIONS /api/timetables/generate"
    "POST /api/timetables"
    "GET /api/timetables"
    "OPTIONS /api/timetables"
    "GET /api/timetables/{id}"
    "DELETE /api/timetables/{id}"
    "OPTIONS /api/timetables/{id}"
    "GET /api/timetables/{id}/calendar.ics"
    "OPTIONS /api/timetables/{id}/calendar.ics"
  )

  for ROUTE in "${ROUTES[@]}"; do
    awsl apigatewayv2 create-route --api-id "$API_ID" --route-key "$ROUTE" \
      --target "integrations/${INTEGRATION_ID}" >/dev/null
  done

  awsl apigatewayv2 create-stage --api-id "$API_ID" --stage-name '$default' --auto-deploy >/dev/null
fi

awsl lambda add-permission --function-name "$FUNC_NAME" \
  --statement-id apigw-invoke \
  --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:us-east-1:000000000000:${API_ID}/*" >/dev/null 2>&1 || true

API_URL="http://${API_ID}.execute-api.localhost.floci.io:4566"
echo ""
echo "=========================================="
echo "Deployed! API_URL = $API_URL"
echo "=========================================="

CONSUMER_NAME="timetable-section-consumer"
CONSUMER_ENV="Variables={NODE_ENV=production,TIMETABLES_TABLE=timetables,SECTION_INDEX_TABLE=section_timetables}"

echo "5. Deploying SQS consumer Lambda ($CONSUMER_NAME)..."
if awsl lambda get-function --function-name "$CONSUMER_NAME" >/dev/null 2>&1; then
  awsl lambda update-function-code --function-name "$CONSUMER_NAME" --zip-file fileb://lambda.zip >/dev/null
  awsl lambda wait function-updated-v2 --function-name "$CONSUMER_NAME" || true
  awsl lambda update-function-configuration --function-name "$CONSUMER_NAME" --environment "$CONSUMER_ENV" >/dev/null
else
  awsl lambda create-function --function-name "$CONSUMER_NAME" \
    --runtime nodejs24.x \
    --handler src/consumer.handler \
    --role "arn:aws:iam::000000000000:role/${ROLE_NAME}" \
    --zip-file fileb://lambda.zip \
    --timeout 15 \
    --environment "$CONSUMER_ENV" >/dev/null
  awsl lambda wait function-active-v2 --function-name "$CONSUMER_NAME" || true
fi

EXISTING_ESM=$(awsl lambda list-event-source-mappings --function-name "$CONSUMER_NAME" \
  --query "EventSourceMappings[0].UUID" --output text 2>/dev/null || true)
if [ -z "$EXISTING_ESM" ] || [ "$EXISTING_ESM" = "None" ]; then
  awsl lambda create-event-source-mapping \
    --function-name "$CONSUMER_NAME" \
    --event-source-arn "arn:aws:sqs:us-east-1:000000000000:timetable-section-events" \
    --batch-size 5 >/dev/null
fi
echo "Consumer Lambda wired to SQS."
