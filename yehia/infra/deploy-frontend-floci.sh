#!/usr/bin/env bash
set -euo pipefail

export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"

ENDPOINT_URL="${FLOCI_ENDPOINT_URL:-http://localhost:4566}"
S3_BUCKET="${S3_BUCKET:-timetable-frontend}"
FRONTEND_DIR="frontend"

if [ -n "${API_URL:-}" ]; then
  echo "Updating FLOCI_API_URL in ${FRONTEND_DIR}/js/config.js -> ${API_URL}"
  node -e '
    const fs = require("fs");
    const filePath = process.argv[1];
    const apiUrl = process.argv[2];
    const content = fs.readFileSync(filePath, "utf8");
    const updated = content.replace(
      /const FLOCI_API_URL = "[^"]*";/,
      `const FLOCI_API_URL = "${apiUrl}";`
    );
    fs.writeFileSync(filePath, updated, "utf8");
  ' "${FRONTEND_DIR}/js/config.js" "${API_URL}"
fi

echo "1. Ensuring S3 bucket s3://${S3_BUCKET} exists on Floci..."
if ! aws --endpoint-url="$ENDPOINT_URL" s3api head-bucket --bucket "$S3_BUCKET" 2>/dev/null; then
  aws --endpoint-url="$ENDPOINT_URL" s3 mb "s3://${S3_BUCKET}"
else
  echo "   Bucket already exists."
fi

echo "2. Syncing HTML files..."
aws --endpoint-url="$ENDPOINT_URL" s3 sync "${FRONTEND_DIR}/" "s3://${S3_BUCKET}/" \
  --exclude "package.json" \
  --exclude "node_modules/*" \
  --exclude "*.css" \
  --exclude "*.js" \
  --content-type "text/html; charset=utf-8"

echo "3. Syncing CSS files (text/css)..."
aws --endpoint-url="$ENDPOINT_URL" s3 sync "${FRONTEND_DIR}/css/" "s3://${S3_BUCKET}/css/" \
  --exclude "*" --include "*.css" \
  --content-type "text/css"

echo "4. Syncing JS files (text/javascript)..."
aws --endpoint-url="$ENDPOINT_URL" s3 sync "${FRONTEND_DIR}/js/" "s3://${S3_BUCKET}/js/" \
  --exclude "*" --include "*.js" \
  --content-type "text/javascript"

echo "=========================================="
echo "Frontend deployed!"
echo "URL = ${ENDPOINT_URL}/${S3_BUCKET}/index.html"
echo "=========================================="
