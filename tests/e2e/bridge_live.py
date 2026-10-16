"""Live tests of the plugin's WebSocket bridge against a running LMS with LyrionJS installed.

Only ever run this against a disposable test LMS (tests/e2e/testlms.sh), never a household one:
it creates and removes test players.

    python3 tests/e2e/bridge_live.py http://127.0.0.1:19000
"""
import asyncio
import json
import os
import struct
import sys
import time
import unittest
import urllib.error
import urllib.request
from urllib.parse import urlsplit

LMS = sys.argv.pop(1) if len(sys.argv) > 1 and sys.argv[1].startswith("http") else "http://127.0.0.1:19000"
HOST, PORT = urlsplit(LMS).hostname, urlsplit(LMS).port or 80
KEY = "dGhlIHNhbXBsZSBub25jZQ=="


def rpc(player, cmd):
    body = json.dumps({"id": 1, "method": "slim.request", "params": [player, cmd]}).encode()
    req = urllib.request.Request(LMS + "/jsonrpc.js", body, {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=5))["result"]


def players():
    return {p["playerid"]: p for p in rpc("", ["players", 0, 100]).get("players_loop", [])}


def helo(mac):
    caps = b"Model=squeezelite,ModelName=LyrionJS-test,Firmware=test"
    payload = bytes([12, 0]) + bytes(mac) + bytes(16) + b"\0\0" + bytes(8) + b"en" + caps
    return b"HELO" + struct.pack(">I", len(payload)) + payload


def frame(data, op=0x2):
    mask = os.urandom(4)
    n = len(data)
    hdr = struct.pack(">BB", 0x80 | op, 0x80 | n) if n < 126 else struct.pack(">BBH", 0x80 | op, 0x80 | 126, n)
    return hdr + mask + bytes(b ^ mask[i & 3] for i, b in enumerate(data))


class WS:
    opened = []

    @classmethod
    async def open(cls, origin=f"http://{HOST}:{PORT}", host=f"{HOST}:{PORT}", extra=()):
        self = cls()
        self.r, self.w = await asyncio.open_connection(HOST, PORT)
        cls.opened.append(self)
        hdrs = ["GET /plugins/LyrionJS/ws HTTP/1.1", f"Host: {host}", "Upgrade: websocket",
                "Connection: Upgrade", f"Sec-WebSocket-Key: {KEY}", "Sec-WebSocket-Version: 13", *extra]
        if origin:
            hdrs.append(f"Origin: {origin}")
        self.w.write(("\r\n".join(hdrs) + "\r\n\r\n").encode())
        self.status = (await self.r.readuntil(b"\r\n\r\n")).split(b"\r\n")[0].decode()
        self.got = 0
        return self

    async def recv(self, timeout=5):
        b1, b2 = await asyncio.wait_for(self.r.readexactly(2), timeout)
        n = b2 & 0x7F
        if n == 126:
            n = struct.unpack(">H", await self.r.readexactly(2))[0]
        elif n == 127:
            n = struct.unpack(">Q", await self.r.readexactly(8))[0]
        data = await self.r.readexactly(n)
        op = b1 & 0x0F
        if op == 0x2:
            self.got += len(data)
        return op, data

    async def hello(self, msg):
        self.w.write(frame(json.dumps(msg).encode(), 0x1))
        op, data = await self.recv()
        if op == 0x8:
            return struct.unpack(">H", data[:2])[0]
        return json.loads(data)

    async def drain(self, seconds):
        end = time.time() + seconds
        try:
            while time.time() < end:
                op, data = await self.recv(max(0.05, end - time.time()))
                if op == 0x8:
                    return struct.unpack(">H", data[:2])[0]
        except (asyncio.TimeoutError, asyncio.IncompleteReadError):
            pass
        return None

    def kill(self):
        self.w.transport.abort()   # vanish without a close frame, like a phone losing Wi-Fi


MAC = [0x02, 0x4C, 0x4A, 0xEE, 0xEE, 0x01]
MAC_S = "02:4c:4a:ee:ee:01"


class BridgeLive(unittest.IsolatedAsyncioTestCase):
    async def asyncTearDown(self):
        for ws in WS.opened:
            ws.w.close()
        WS.opened.clear()
        for mac in (MAC_S, "02:4c:4a:ee:ee:02"):
            try:
                rpc(mac, ["client", "forget"])
            except Exception:
                pass

    async def test_other_sites_refused(self):
        ws = await WS.open(origin="http://evil.example")
        self.assertIn("403", ws.status)

    async def test_origin_behind_an_https_proxy(self):
        # A proxy that passes Host through without a port, or names the public host itself.
        ws = await WS.open(origin="https://music.example", host="music.example")
        self.assertIn("101", ws.status)
        ws = await WS.open(origin="https://music.example", extra=["X-Forwarded-Host: music.example"])
        self.assertIn("101", ws.status)
        ws = await WS.open(origin="https://evil.example", extra=["X-Forwarded-Host: music.example"])
        self.assertIn("403", ws.status)

    async def test_socket_without_hello_is_closed(self):
        ws = await WS.open()
        self.assertEqual(await ws.drain(17), 1008)

    async def test_diagnostics_from_another_site_refused(self):
        req = urllib.request.Request(LMS + "/plugins/LyrionJS/log", b'{"lines":["x"]}',
                                     {"Content-Type": "application/json", "Origin": "http://evil.example"})
        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(req, timeout=5)
        self.assertEqual(e.exception.code, 403)

    async def test_hardware_mac_refused(self):
        ws = await WS.open()
        self.assertIn("101", ws.status)
        r = await ws.hello({"hello": 1})
        self.assertIn("session", r)
        ws.w.write(frame(helo([0x00, 0x04, 0x20, 0x23, 0x2D, 0x84])))
        self.assertEqual(await ws.drain(3), 1008)
        self.assertNotIn("00:04:20:23:2d:84", players())

    async def test_player_appears_proxy_streams_set_and_resume_replays(self):
        ws = await WS.open()
        r = await ws.hello({"hello": 1})
        self.assertFalse(r["resumed"])
        self.assertEqual(r["hold"], 10)
        ws.w.write(frame(helo(MAC)))
        await ws.drain(2)
        self.assertGreater(ws.got, 0, "LMS spoke to the player")
        p = players().get(MAC_S)
        self.assertIsNotNone(p, "player registered in LMS")
        self.assertEqual(p["connected"], 1)
        self.assertEqual(rpc(MAC_S, ["playerpref", "mp3StreamingMethod", "?"])["_p2"], "1",
                         "streams proxied for LyrionJS players")

        # Drop without a close frame; LMS keeps polling the (held) player meanwhile.
        got = ws.got
        ws.kill()
        await asyncio.sleep(6)
        self.assertEqual(players()[MAC_S]["connected"], 1, "LMS never saw the player leave")

        ws2 = await WS.open()
        bad = await ws2.hello({"resume": {"session": r["session"], "secret": "0" * 32, "received": got}})
        self.assertEqual(bad, 4404, "wrong secret refused")

        ws3 = await WS.open()
        ok = await ws3.hello({"resume": {"session": r["session"], "secret": r["secret"], "received": got}})
        self.assertTrue(ok["resumed"])
        self.assertGreater(ok["replay"], 0, "says how much is replayed")
        op, data = await ws3.recv()
        self.assertEqual(op, 0x2)
        self.assertEqual(data[2:6], b"strm", "the status poll LMS sent during the gap is replayed")
        self.assertEqual(data[6:7], b"t")

        # Too far back: refused.
        ws4 = await WS.open()
        self.assertEqual(await ws4.hello({"resume": {"session": r["session"], "secret": r["secret"], "received": got + 10 ** 9}}), 4404)

    async def test_hold_expires_then_player_disconnects(self):
        ws = await WS.open()
        r = await ws.hello({"hello": 1})
        ws.w.write(frame(helo(MAC)))
        await ws.drain(1)
        ws.kill()
        await asyncio.sleep(12)
        self.assertEqual(players()[MAC_S]["connected"], 0, "after the hold LMS sees the player go")
        ws2 = await WS.open()
        self.assertEqual(await ws2.hello({"resume": {"session": r["session"], "secret": r["secret"], "received": 0}}), 4404)

    async def test_second_session_for_same_player_ends_the_first(self):
        a = await WS.open()
        await a.hello({"hello": 1})
        a.w.write(frame(helo(MAC)))
        await a.drain(1)
        b = await WS.open()
        await b.hello({"hello": 1})
        b.w.write(frame(helo(MAC)))
        self.assertEqual(await a.drain(3), 4000, "the old session is ended")

    async def test_bad_hello_and_non_websocket(self):
        ws = await WS.open()
        ws.w.write(frame(b"\x00binary first", 0x2))
        self.assertEqual(await ws.drain(2), 1008)
        try:
            urllib.request.urlopen(LMS + "/plugins/LyrionJS/ws", timeout=5)
            self.fail("plain GET accepted")
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 400)


if __name__ == "__main__":
    unittest.main(verbosity=2)
