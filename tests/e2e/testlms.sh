#!/bin/sh
# A disposable LMS 9.1 in Docker with the LyrionJS plugin and a few generated test tracks.
# Ports are bound to localhost only, so household players never discover it.
#   tests/e2e/testlms.sh [workdir]      then: python3 tests/e2e/bridge_live.py http://127.0.0.1:19000
#   docker rm -f lyrionjs-testlms        to remove it
set -eu
HERE=$(cd "$(dirname "$0")/../.." && pwd)
T=${1:-${TMPDIR:-/tmp}/lyrionjs-testlms}
mkdir -p "$T/config/cache/InstalledPlugins/Plugins" "$T/music/Test Artist/Sine Album" "$T/music/Other Artist/Hi Res" "$T/playlist"

mk() { # freq rate seconds codec-args artist album title track file
	[ -f "$T/music/$9" ] || ffmpeg -loglevel error -y -f lavfi -i "aevalsrc='0.3*sin(2*PI*$1*t)|0.3*sin(2*PI*$1*1.5*t)':s=$2:d=$3" \
		$4 -metadata artist="$5" -metadata album="$6" -metadata title="$7" -metadata track="$8" "$T/music/$9"
}
mk 440 44100 20 "-c:a flac" "Test Artist" "Sine Album" "A440" 1 "Test Artist/Sine Album/01 A440.flac"
mk 330 44100 20 "-c:a flac" "Test Artist" "Sine Album" "E330" 2 "Test Artist/Sine Album/02 E330.flac"
mk 262 44100 20 "-c:a libmp3lame -b:a 192k" "Test Artist" "Sine Album" "C262 mp3" 3 "Test Artist/Sine Album/03 C262.mp3"
mk 523 96000 15 "-c:a flac -sample_fmt s32" "Other Artist" "Hi Res" "C523 hires" 1 "Other Artist/Hi Res/01 C523.flac"
mk 392 48000 15 "-c:a aac -b:a 160k" "Other Artist" "Hi Res" "G392 aac" 2 "Other Artist/Hi Res/02 G392.m4a"

python3 "$HERE/build.py" >/dev/null
rm -rf "$T/config/cache/InstalledPlugins/Plugins/LyrionJS"
cp -r "$HERE/plugin/LyrionJS" "$T/config/cache/InstalledPlugins/Plugins/"

docker rm -f lyrionjs-testlms >/dev/null 2>&1 || true
docker run -d --name lyrionjs-testlms -p 127.0.0.1:19000:9000 -p 127.0.0.1:13483:3483 \
	-e PUID="$(id -u)" -e PGID="$(id -g)" \
	-v "$T/config:/config" -v "$T/music:/music:ro" -v "$T/playlist:/playlist" \
	lmscommunity/lyrionmusicserver:9.1.1 >/dev/null

rpc() { curl -s -m3 -X POST http://127.0.0.1:19000/jsonrpc.js -d "{\"id\":1,\"method\":\"slim.request\",\"params\":[\"\",$1]}"; }
i=0; until rpc '["version","?"]' | grep -q _version; do i=$((i + 1)); [ $i -gt 60 ] && { echo "LMS did not start"; exit 1; }; sleep 2; done
rpc '["pref","mediadirs","/music"]' >/dev/null
rpc '["rescan","full"]' >/dev/null
sleep 8
echo "Test LMS ready: http://127.0.0.1:19000/plugins/LyrionJS/"
