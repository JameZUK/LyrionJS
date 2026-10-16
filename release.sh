#!/bin/sh
# Build a GitHub release: dist/LyrionJS-<version>.zip, and repo.xml (the LMS repository file)
# pointing at that zip as a release asset. The version comes from plugin/LyrionJS/install.xml.
#   ./release.sh                 then follow the steps it prints
set -eu
REPO=${REPO:-JameZUK/LyrianJS}
cd "$(dirname "$0")"
V=$(sed -n 's:.*<version>\(.*\)</version>.*:\1:p' plugin/LyrionJS/install.xml)
python3 build.py --package --url "https://github.com/$REPO/releases/download/v$V" --link "https://github.com/$REPO"
cp dist/repo.xml repo.xml
cat <<STEPS

Release v$V is built. To publish it:
  git add repo.xml && git commit -m "LyrionJS $V" && git tag v$V
  git push origin main v$V
  gh release create v$V dist/LyrionJS-$V.zip --repo $REPO --title "LyrionJS $V" --notes "..."
LMS then offers the update to everyone who added
  https://raw.githubusercontent.com/$REPO/main/repo.xml
STEPS
