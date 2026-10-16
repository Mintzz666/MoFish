#!/usr/bin/env bash
# Compatibility runtime for the Linux binary shipped by embedded-postgres.
# Extract the checksum-verified official Ubuntu package; never replace system libraries.
set -euo pipefail

if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo 'The ICU 60 CI adapter supports Linux x86_64 only.' >&2
  exit 1
fi
if [[ -z "${GITHUB_ENV:-}" ]]; then
  echo 'Run this adapter inside GitHub Actions (GITHUB_ENV is required).' >&2
  exit 1
fi

runtime_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/mofish-pg-runtime.XXXXXX")"
trap 'rm -rf -- "$runtime_dir"' ERR
package_url='https://archive.ubuntu.com/ubuntu/pool/main/i/icu/libicu60_60.2-3ubuntu3.2_amd64.deb'
package_sha='f01f61f57e63dc905e02e6441d10370fe0c79e43e70e6f5fe24b342fd2633209'
curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 \
  --connect-timeout 15 --max-time 120 "$package_url" --output "$runtime_dir/icu.deb"
printf '%s  %s\n' "$package_sha" "$runtime_dir/icu.deb" | sha256sum --check --status
dpkg-deb --extract "$runtime_dir/icu.deb" "$runtime_dir"
rm -- "$runtime_dir/icu.deb"
printf 'MOFISH_PG_RUNTIME_DIR=%s\n' "$runtime_dir" >> "$GITHUB_ENV"
printf 'LD_LIBRARY_PATH=%s/usr/lib/x86_64-linux-gnu%s\n' \
  "$runtime_dir" "${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" >> "$GITHUB_ENV"
echo "Prepared owned PostgreSQL compatibility runtime: $runtime_dir"
