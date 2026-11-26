#!/usr/bin/env bash
set -euo pipefail

app_path="${1:?Usage: verify-macos-bundle.sh <app-path> <dmg-path>}"
dmg_path="${2:?Usage: verify-macos-bundle.sh <app-path> <dmg-path>}"
expected_identity="${MACOS_SIGNING_IDENTITY:-}"

codesign --verify --deep --strict --verbose=2 "${app_path}"

signature_details="$(codesign --display --verbose=4 "${app_path}" 2>&1)"
designated_requirement="$(codesign --display --requirements - "${app_path}" 2>&1)"

echo "=== macOS App Signature ==="
echo "${signature_details}" | grep -E '^(Executable|Identifier|Authority|Signature|TeamIdentifier)=' || true
echo "${designated_requirement}"

if [[ -n "${expected_identity}" && "${expected_identity}" != "-" ]]; then
  if grep -Fq 'Signature=adhoc' <<< "${signature_details}"; then
    echo "::error::Expected stable macOS signing identity '${expected_identity}', found ad-hoc signature."
    exit 1
  fi
  if ! grep -Fxq "Authority=${expected_identity}" <<< "${signature_details}"; then
    echo "::error::Expected Authority=${expected_identity}."
    exit 1
  fi
  if grep -Fq 'cdhash ' <<< "${designated_requirement}"; then
    echo "::error::Designated requirement is tied to cdhash instead of stable certificate root."
    exit 1
  fi
  if ! grep -Fq 'identifier "com.zzw6776.antigravity-quota-injector"' <<< "${designated_requirement}"; then
    echo "::error::Designated requirement missing bundle identifier."
    exit 1
  fi
fi

hdiutil verify "${dmg_path}"

mount_dir="$(mktemp -d "${TMPDIR:-/tmp}/aq-dmg-verify.XXXXXX")"
mounted=false
cleanup() {
  if [[ "${mounted}" == true ]]; then
    hdiutil detach "${mount_dir}" >/dev/null 2>&1 || true
  fi
  rmdir "${mount_dir}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "${mount_dir}" "${dmg_path}" >/dev/null
mounted=true
codesign --verify --deep --strict --verbose=2 "${mount_dir}/Antigravity Quota Injector.app"
