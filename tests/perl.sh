#!/bin/sh
# Runs the plugin's Perl tests (plugin/t/*.t) with LMS's own libraries, inside the disposable
# test LMS container (tests/e2e/testlms.sh).
set -e
C=${1:-lyrionjs-testlms}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
docker exec "$C" rm -rf /tmp/ljt
docker exec "$C" mkdir -p /tmp/ljt/Plugins
docker cp "$ROOT/plugin/LyrionJS" "$C:/tmp/ljt/Plugins/LyrionJS"
docker cp "$ROOT/plugin/t" "$C:/tmp/ljt/t"
docker exec "$C" sh -c 'cd /tmp/ljt && for t in t/*.t; do echo "# $t"; perl \
  -I/lms/CPAN/arch/5.36/x86_64-linux-thread-multi -I/lms/CPAN/arch/5.36 -I/lms -I/lms/CPAN -I/tmp/ljt "$t" \
  | grep -av "^ok" || true; done' | tee /dev/stderr | grep -aqE "^not ok|Looks like|^Can.t locate|died" && exit 1 || exit 0
