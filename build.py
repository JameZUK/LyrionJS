#!/usr/bin/env python3
"""Builds the single self-contained page, lyrionjs.html, from src/; optionally packages the plugin.

The page is plain scripts inlined in order:
  lj-worklet  the output stage (also loaded into an AudioWorklet from this script's text)
  lj-lib      core (Slimproto, decoders, player), outputs and transport: each file its own
              module on the shared `LJ` namespace, testable under Node
  lj-app      the browser app: its files share one scope (wrapped in a single function)
"""
import argparse
import hashlib
import os
import re
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")

WORKLET = ["output/worklet.js"]
LIB = [
    "core/bytes.js", "core/slimproto.js", "core/decoder.js", "core/flac.js", "core/pcm.js", "core/mp3.js", "core/player.js",
    "output/fmp4.js", "output/media.js", "output/webaudio.js",
    "host/transport.js",
]
APP = [
    "app/util.js", "app/lms.js", "app/state.js", "app/widgets.js", "app/router.js", "app/poll.js", "app/actions.js",
    "app/slimbrowse.js", "app/local.js",
    "app/views/now.js", "app/views/queue.js", "app/views/library.js", "app/views/playlists.js", "app/views/search.js",
    "app/views/players.js", "app/views/settings.js",
    "app/boot.js",
]


def read(name):
    with open(os.path.join(SRC, name), encoding="utf-8") as f:
        return f.read()


def script(files):
    text = "\n".join(read(f).rstrip() for f in files)
    if re.search(r"</script", text, re.I):
        sys.exit("a source file contains '</script', which would end the inline script early")
    return text


def read_version():
    with open(os.path.join(HERE, "plugin", "LyrionJS", "install.xml"), encoding="utf-8") as f:
        return re.search(r"<version>([^<]+)</version>", f.read()).group(1)


def page():
    app = ("'use strict';\n(function () {\n  const LJ = window.LJ;\n"
           f"  const VERSION = '{read_version()}';\n" + script(APP) + "\n})();")
    out = read("index.html")
    for key, text in {"CSS": read("style.css"), "WORKLET": script(WORKLET), "LIB": script(LIB), "APP": app}.items():
        marker = f"/*@@{key}@@*/"
        if marker not in out:
            sys.exit(f"index.html has no {marker}")
        out = out.replace(marker, text.rstrip())
    return out


def package(url):
    """dist/LyrionJS-<version>.zip (files at the zip's root, as LMS expects) and dist/repo.xml."""
    plugin = os.path.join(HERE, "plugin", "LyrionJS")
    version = read_version()
    dist = os.path.join(HERE, "dist")
    os.makedirs(dist, exist_ok=True)
    zpath = os.path.join(dist, f"LyrionJS-{version}.zip")
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for root, _, files in sorted(os.walk(plugin)):
            for name in sorted(files):
                full = os.path.join(root, name)
                info = zipfile.ZipInfo(os.path.relpath(full, plugin), date_time=(2026, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                with open(full, "rb") as f:
                    z.writestr(info, f.read())   # fixed timestamps: the same files give the same zip
    with open(zpath, "rb") as f:
        sha = hashlib.sha1(f.read()).hexdigest()
    zurl = (url.rstrip("/") + "/" if url else "") + os.path.basename(zpath)
    repo = f"""<?xml version="1.0" encoding="UTF-8"?>
<extensions>
	<details>
		<title lang="EN">LyrionJS</title>
	</details>
	<plugins>
		<plugin name="LyrionJS" version="{version}" minTarget="8.0" maxTarget="*">
			<title lang="EN">LyrionJS</title>
			<desc lang="EN">Play music in any web browser: the browser becomes a Slimproto player in LMS, with a full controller.</desc>
			<creator>JameZUK</creator>
			<category>player</category>
			<url>{zurl}</url>
			<sha>{sha}</sha>
		</plugin>
	</plugins>
</extensions>
"""
    with open(os.path.join(dist, "repo.xml"), "w", encoding="utf-8") as f:
        f.write(repo)
    print(f"wrote dist/{os.path.basename(zpath)} (sha1 {sha}) and dist/repo.xml")


def main():
    ap = argparse.ArgumentParser(description="Build lyrionjs.html; optionally package the plugin")
    ap.add_argument("--package", action="store_true", help="also write dist/LyrionJS-<version>.zip and dist/repo.xml")
    ap.add_argument("--url", default="", help="where the zip will be published (for repo.xml)")
    args = ap.parse_args()
    built = page()
    # The page lives in the plugin (served by LMS) and next to the dev relay.
    for out in (os.path.join(HERE, "plugin", "LyrionJS", "HTML", "lyrionjs.html"), os.path.join(HERE, "lyrionjs.html")):
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, "w", encoding="utf-8") as f:
            f.write(built)
        print(f"wrote {os.path.relpath(out, HERE)} ({len(built.encode()) // 1024} KiB)")
    if args.package:
        package(args.url)


if __name__ == "__main__":
    main()
