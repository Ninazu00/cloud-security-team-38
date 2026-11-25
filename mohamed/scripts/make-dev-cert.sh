#!/usr/bin/env bash
#
# Create the self-signed certificate the demo uses.
#
# On real AWS the certificate comes from ACM (issued, not self-signed) and this
# script is not used. Here it exists so the load balancer can serve HTTPS without
# a public domain, and so the private key never has to live in git.
#
#   ./scripts/make-dev-cert.sh            creates infra/tls/dev.{crt,key} if missing
#   ./scripts/make-dev-cert.sh --force    overwrites them
#
# The certificate names localhost (DNS and IP), which is the only host a browser
# will reach the demo on. Browsers will warn that it is self-signed: that is the
# expected behaviour with a certificate nobody has signed.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TLS_DIR="$ROOT_DIR/infra/tls"
CRT="$TLS_DIR/dev.crt"
KEY="$TLS_DIR/dev.key"

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

if [[ -f "$CRT" && -f "$KEY" && "$FORCE" == "0" ]]; then
  echo "certificate already present: $CRT"
  exit 0
fi

command -v openssl >/dev/null || { echo "openssl is not on PATH" >&2; exit 1; }

mkdir -p "$TLS_DIR"

# 825 days is the maximum Apple trusts for a self-signed leaf certificate.
openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes \
  -keyout "$KEY" -out "$CRT" \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" 2>/dev/null

chmod 600 "$KEY"

echo "wrote $CRT"
echo "wrote $KEY"
