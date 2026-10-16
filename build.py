#!/usr/bin/env python3
"""Inline src/ into the single self-contained page, lyrionjs.html."""
import argparse
import hashlib
import os
import re
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")


def read(name):
    with open(os.path.join(SRC, name), encoding="utf-8") as f:
        return f.read()


def package(url):
    """dist/LyrionJS-<version>.zip (files at the zip's root, as LMS expects) and dist/repo.xml."""
    plugin = os.path.join(HERE, "plugin", "LyrionJS")
    with open(os.path.join(plugin, "install.xml"), encoding="utf-8") as f:
        version = re.search(r"<version>([^<]+)</version>", f.read()).group(1)
    dist = os.path.join(HERE, "dist")
    os.makedirs(dist, exist_ok=True)
    zpath = os.path.join(dist, f"LyrionJS-{version}.zip")
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for root, _, files in os.walk(plugin):
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
    page = read("index.html")
    parts = {"CSS": read("style.css"), "WORKLET": read("worklet.js"), "CORE": read("core.js"), "MEDIA": read("media.js"), "APP": read("app.js")}
    for key, text in parts.items():
        if key != "CSS" and re.search(r"</script", text, re.I):
            sys.exit(f"{key}: contains '</script', which would end the inline script early")
        page = page.replace(f"/*@@{key}@@*/", text.rstrip())
    # The page lives in the plugin (served by LMS) and next to the dev relay.
    for out in (os.path.join(HERE, "plugin", "LyrionJS", "HTML", "lyrionjs.html"), os.path.join(HERE, "lyrionjs.html")):
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, "w", encoding="utf-8") as f:
            f.write(page)
        print(f"wrote {os.path.relpath(out, HERE)} ({len(page.encode()) // 1024} KiB)")
    if args.package:
        package(args.url)


if __name__ == "__main__":
    main()
