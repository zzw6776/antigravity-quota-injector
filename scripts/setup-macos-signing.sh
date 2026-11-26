#!/usr/bin/env bash
set -euo pipefail

EXPECTED_IDENTITY="Mac Development: Antigravity Quota Injector Self-Signed"
EXPECTED_FINGERPRINT="37:93:A0:08:7E:43:9B:B5:7F:90:8A:F5:0C:A3:AA:6C:A3:1F:38:EC:03:32:A1:24:28:5D:34:87:88:7F:DA:0C"

if [[ -z "${MACOS_SIGNING_CERTIFICATE:-}" || -z "${MACOS_SIGNING_CERTIFICATE_PASSWORD:-}" ]]; then
  echo "macOS release signing secrets are not configured; falling back to ad-hoc signing."
  exit 0
fi

work_dir="${RUNNER_TEMP:-/tmp}/aq-macos-signing"
mkdir -p "${work_dir}"
chmod 700 "${work_dir}"

certificate_bundle="${work_dir}/signing.p12"
certificate_pem="${work_dir}/signing.pem"
keychain_path="${work_dir}/aq-release-signing.keychain-db"
keychain_pass="$(openssl rand -hex 24)"

cleanup_temp_certs() {
  rm -f "${certificate_bundle}" "${certificate_pem}"
}
trap cleanup_temp_certs EXIT

printf '%s' "${MACOS_SIGNING_CERTIFICATE}" | tr -d '[:space:]' | openssl base64 -d -A -out "${certificate_bundle}"

extract_certificate() {
  openssl pkcs12 "$@" \
    -in "${certificate_bundle}" \
    -clcerts \
    -nokeys \
    -passin env:MACOS_SIGNING_CERTIFICATE_PASSWORD \
    -out "${certificate_pem}"
}

if openssl pkcs12 -help 2>&1 | grep -Fq -- '-legacy'; then
  extract_certificate -legacy
else
  extract_certificate
fi

actual_fingerprint="$(
  openssl x509 -in "${certificate_pem}" -noout -fingerprint -sha256 | cut -d= -f2
)"
if [[ "${actual_fingerprint}" != "${EXPECTED_FINGERPRINT}" ]]; then
  echo "::error::macOS signing certificate fingerprint mismatch: got ${actual_fingerprint}, expected ${EXPECTED_FINGERPRINT}"
  exit 1
fi

security delete-keychain "${keychain_path}" >/dev/null 2>&1 || true
security create-keychain -p "${keychain_pass}" "${keychain_path}"
security set-keychain-settings -lut 21600 "${keychain_path}"
security unlock-keychain -p "${keychain_pass}" "${keychain_path}"

security import "${certificate_bundle}" \
  -k "${keychain_path}" \
  -P "${MACOS_SIGNING_CERTIFICATE_PASSWORD}" \
  -T /usr/bin/codesign \
  -T /usr/bin/security

security set-key-partition-list \
  -S apple-tool:,apple:,codesign: \
  -s -k "${keychain_pass}" \
  "${keychain_path}" >/dev/null

# Prepend our temporary keychain so codesign resolves the identity cleanly.
existing_keychains=()
while IFS= read -r line; do
  trimmed="$(printf '%s' "${line}" | sed -E 's/^[[:space:]]*"?([^"]+)"?[[:space:]]*$/\1/')"
  [[ -n "${trimmed}" ]] && existing_keychains+=("${trimmed}")
done < <(security list-keychains -d user)
security list-keychains -d user -s "${keychain_path}" "${existing_keychains[@]}"

sudo security add-trusted-cert \
  -d \
  -r trustRoot \
  -p codeSign \
  -k /Library/Keychains/System.keychain \
  "${certificate_pem}"

if [[ -n "${GITHUB_ENV:-}" ]]; then
  {
    echo "MACOS_SIGNING_IDENTITY=${EXPECTED_IDENTITY}"
    echo "MACOS_SIGNING_KEYCHAIN=${keychain_path}"
  } >> "${GITHUB_ENV}"
fi

echo "Configured stable macOS signing identity: ${EXPECTED_IDENTITY}"
