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
import subprocess
import sys
import zipfile
from urllib.parse import quote

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


def logo():
    """assets/icon.svg as (an inline <svg> defining symbol #lj-logo, a data: URI for the favicon)."""
    with open(os.path.join(HERE, "assets", "icon.svg"), encoding="utf-8") as f:
        svg = re.sub(r"<!--.*?-->", "", f.read(), flags=re.S)
    svg = re.sub(r">\s+<", "><", svg).strip()
    inner = re.search(r"<svg[^>]*>(.*)</svg>", svg, re.S).group(1)
    view = re.search(r'viewBox="([^"]+)"', svg).group(1)
    inner_ids = inner.replace('id="bg"', 'id="lj-logo-bg"').replace("url(#bg)", "url(#lj-logo-bg)")
    symbol = (f'<svg width="0" height="0" style="position:absolute" aria-hidden="true">'
              f'<symbol id="lj-logo" viewBox="{view}">{inner_ids}</symbol></svg>')
    uri = "data:image/svg+xml," + quote(svg, safe=" =:/;,'()")
    return symbol, uri


def page():
    app = ("'use strict';\n(function () {\n  const LJ = window.LJ;\n"
           f"  const VERSION = '{read_version()}';\n" + script(APP) + "\n})();")
    out = read("index.html")
    symbol, uri = logo()
    out = out.replace("@@LOGO_URI@@", uri.replace('"', "%22"))
    for key, text in {"CSS": read("style.css"), "LOGO": symbol, "WORKLET": script(WORKLET), "LIB": script(LIB), "APP": app}.items():
        marker = f"/*@@{key}@@*/"
        if marker not in out:
            sys.exit(f"index.html has no {marker}")
        out = out.replace(marker, text.rstrip())
    return out


def icons():
    """The PNG icons LMS and phones use, rendered from assets/icon.svg (needs rsvg-convert)."""
    images = os.path.join(HERE, "plugin", "LyrionJS", "HTML", "EN", "plugins", "LyrionJS", "html", "images")
    src = os.path.join(HERE, "assets", "icon.svg")
    with open(src, encoding="utf-8") as f:
        svg = f.read()
    # Home-screen icons: the tile fills the square (the phone rounds the corners itself).
    full = re.sub(r'<rect x="4" y="4" width="120" height="120" rx="28"', '<rect x="0" y="0" width="128" height="128" rx="0"', svg)
    full = re.sub(r'<rect x="4.75"[^>]*/>', "", full)
    tmp = os.path.join(HERE, "dist", "icon-full.svg")
    os.makedirs(os.path.dirname(tmp), exist_ok=True)
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(full)
    for name, size, source in (("icon.png", 128, src), ("apple-touch-icon.png", 180, tmp)):
        subprocess.run(["rsvg-convert", "-w", str(size), "-h", str(size), source, "-o", os.path.join(images, name)], check=True)
        print(f"wrote {os.path.relpath(os.path.join(images, name), HERE)}")


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
    ap.add_argument("--icons", action="store_true", help="also render the PNG icons from assets/icon.svg (rsvg-convert)")
    args = ap.parse_args()
    built = page()
    # The page lives in the plugin (served by LMS) and next to the dev relay.
    for out in (os.path.join(HERE, "plugin", "LyrionJS", "HTML", "lyrionjs.html"), os.path.join(HERE, "lyrionjs.html")):
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, "w", encoding="utf-8") as f:
            f.write(built)
        print(f"wrote {os.path.relpath(out, HERE)} ({len(built.encode()) // 1024} KiB)")
    if args.icons:
        icons()
    if args.package:
        package(args.url)


if __name__ == "__main__":
    main()
