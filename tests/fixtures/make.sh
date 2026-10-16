#!/bin/sh
# Regenerates the test audio and its reference decodes (needs ffmpeg, flac and lame).
# Run once before the tests: tests/fixtures/make.sh
set -eu
cd "$(dirname "$0")"
ff() { ffmpeg -loglevel error -y "$@"; }
[ -f s16.wav ] || ff -f lavfi -i "aevalsrc='0.6*sin(2*PI*(200+2000*t)*t)+0.2*(random(0)-0.5)|0.5*sin(2*PI*440*t)':s=44100:d=4" -c:a pcm_s16le -map_metadata -1 -fflags +bitexact s16.wav
[ -f s24.wav ] || ff -f lavfi -i "aevalsrc='0.7*sin(2*PI*(100+4000*t)*t)|0.3*(random(1)-0.5)':s=96000:d=2" -c:a pcm_s24le -map_metadata -1 -fflags +bitexact s24.wav
[ -f mono.wav ] || ff -f lavfi -i "aevalsrc='0.5*sin(2*PI*300*t)':s=22050:d=2" -ac 1 -c:a pcm_s16le -map_metadata -1 -fflags +bitexact mono.wav
[ -f silence.wav ] || ff -f lavfi -i "anullsrc=r=48000:cl=stereo" -t 1 -c:a pcm_s16le -map_metadata -1 -fflags +bitexact silence.wav
enc() { [ -f "$2" ] || flac -s -f "$@" 2>/dev/null; }
enc -0 -o s16-l0.flac s16.wav
enc -5 -o s16-l5.flac s16.wav
enc -8 --lax -l 32 -b 4608 -o s16-lax32.flac s16.wav
enc -8 -M -o s16-adaptive.flac s16.wav
enc -8 -o s24-l8.flac s24.wav
enc -5 -o mono.flac mono.wav
enc -5 -o silence.flac silence.wav
for f in *.flac; do
	[ -f "${f%.flac}.raw" ] || flac -s -f -d --force-raw-format --endian=little --sign=signed "$f" -o "${f%.flac}.raw"
done
[ -f s16.mp3 ] || lame --silent -b 192 s16.wav s16.mp3
echo "fixtures ready"
