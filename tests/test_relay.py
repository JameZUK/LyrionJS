"""The dev relay against a fake LMS (no Docker needed). Run: python3 -m unittest discover -s tests

The live suite, tests/e2e/bridge_live.py, runs the same protocol checks against a real LMS
through either the plugin or this relay."""
import asyncio
import json
import os
import struct
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import relay  # noqa: E402

KEY = "dGhlIHNhbXBsZSBub25jZQ=="


def frame(data, op=0x2):
    mask = os.urandom(4)
    n = len(data)
    hdr = struct.pack(">BB", 0x80 | op, 0x80 | n) if n < 126 else struct.pack(">BBH", 0x80 | op, 0x80 | 126, n)
    return hdr + mask + bytes(b ^ mask[i & 3] for i, b in enumerate(data))


def helo(mac):
    payload = bytes([12, 0]) + bytes(mac) + bytes(28) + b"Model=squeezelite"
    return b"HELO" + struct.pack(">I", len(payload)) + payload


class Pure(unittest.TestCase):
    def test_origin(self):
        ok = relay.origin_allowed
        self.assertTrue(ok("", "lms:9000"))
        self.assertTrue(ok("http://lms:9000", "lms:9000"))
        self.assertTrue(ok("http://lms", "lms"))
        self.assertFalse(ok("http://evil.example", "lms:9000"))
        self.assertFalse(ok("http://lms:9000.evil.example", "lms:9000"))
        self.assertFalse(ok("null", "lms:9000"))

    def test_helo(self):
        self.assertEqual(relay.helo_mac(helo([2, 0x4C, 0x4A, 1, 2, 3])[:15]), "")
        self.assertEqual(relay.helo_mac(helo([2, 0x4C, 0x4A, 1, 2, 3])), "02:4c:4a:01:02:03")
        self.assertIsNone(relay.helo_mac(helo([0, 4, 0x20, 1, 2, 3])))

    def test_replay_buffer(self):
        s = relay.Session("a", "b")
        s.keep(b"x" * 1000)
        self.assertEqual(s.replay_from(400), b"x" * 600)
        self.assertIsNone(s.replay_from(1001))
        self.assertIsNone(s.replay_from("10"))
        s.keep(b"y" * relay.REPLAY_BYTES)
        self.assertIsNone(s.replay_from(10))
        self.assertEqual(len(s.replay_from(s.sent - 5)), 5)

    def test_discovery_reply(self):
        self.assertEqual(relay.parse_discovery_reply(b"ENAME\x04TestJSON\x049000"), {"NAME": "Test", "JSON": "9000"})
        self.assertIsNone(relay.parse_discovery_reply(b"x"))


class WithFakeLms(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.slim_rx = bytearray()
        self.slim_writers = []

        async def slim(r, w):   # a "Slimproto server": records what arrives; the test sends
            self.slim_writers.append(w)
            while data := await r.read(65536):
                self.slim_rx += data

        async def web(r, w):
            head = await r.readuntil(b"\r\n\r\n")
            self.web_head = head.decode()
            if b"/stream.mp3" in head:
                w.write(b"HTTP/1.0 200 OK\r\nContent-Type: audio/flac\r\n\r\n" + b"a" * 200000)
            else:
                body = b'{"result":{}}'
                w.write(b"HTTP/1.1 200 OK\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
            await w.drain()
            w.close()

        self.slim = await asyncio.start_server(slim, "127.0.0.1", 0)
        self.web = await asyncio.start_server(web, "127.0.0.1", 0)
        self.relay = relay.Relay("127.0.0.1", self.web.sockets[0].getsockname()[1], self.slim.sockets[0].getsockname()[1])
        self.srv = await asyncio.start_server(self.relay.handle, "127.0.0.1", 0, limit=relay.MAX_HEADER)
        self.port = self.srv.sockets[0].getsockname()[1]

    async def asyncTearDown(self):
        for s in list(self.relay.sessions.values()):
            await self.relay.end_session(s, 1001)
        for s in (self.srv, self.slim, self.web):
            s.close()

    async def http(self, raw):
        r, w = await asyncio.open_connection("127.0.0.1", self.port)
        w.write(raw)
        data = await asyncio.wait_for(r.read(), 5)
        w.close()
        return data

    async def ws(self, origin=None):
        r, w = await asyncio.open_connection("127.0.0.1", self.port)
        h = ["GET /plugins/LyrionJS/ws HTTP/1.1", f"Host: 127.0.0.1:{self.port}", "Upgrade: websocket",
             "Connection: Upgrade", f"Sec-WebSocket-Key: {KEY}", "Sec-WebSocket-Version: 13"]
        if origin:
            h.append(f"Origin: {origin}")
        w.write(("\r\n".join(h) + "\r\n\r\n").encode())
        status = (await r.readuntil(b"\r\n\r\n")).split(b"\r\n")[0].decode()
        return r, w, status

    async def recv(self, r):
        b1, b2 = await asyncio.wait_for(r.readexactly(2), 5)
        n = b2 & 0x7F
        if n == 126:
            n = struct.unpack(">H", await r.readexactly(2))[0]
        return b1 & 0x0F, await r.readexactly(n)

    async def test_page_and_redirect(self):
        resp = await self.http(b"GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
        self.assertIn(b"302", resp.split(b"\r\n")[0])
        self.assertIn(b"Location: /plugins/LyrionJS/", resp)

    async def test_proxy_streams_audio_and_strips_origin(self):
        resp = await self.http(f"GET /stream.mp3?player=x HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n"
                               f"Origin: http://127.0.0.1:{self.port}\r\nConnection: close\r\n\r\n".encode())
        self.assertIn(b"200 OK", resp.split(b"\r\n")[0])
        self.assertTrue(resp.endswith(b"a" * 200000))
        self.assertNotIn("Origin", self.web_head, "LMS's CSRF check must not see the page's origin")

    async def test_session_helo_pipe_and_resume(self):
        r, w, status = await self.ws(origin=f"http://127.0.0.1:{self.port}")
        self.assertIn("101", status)
        w.write(frame(json.dumps({"hello": 1}).encode(), 0x1))
        op, data = await self.recv(r)
        hello = json.loads(data)
        self.assertEqual((op, hello["resumed"], hello["hold"]), (1, False, 10))
        w.write(frame(helo([2, 0x4C, 0x4A, 9, 9, 9])))
        for _ in range(50):
            if self.slim_rx:
                break
            await asyncio.sleep(0.02)
        self.assertTrue(self.slim_rx.startswith(b"HELO"), "HELO piped to LMS")
        sw = self.slim_writers[0]
        sw.write(b"\x00\x05strmq")
        await sw.drain()
        _, got = await self.recv(r)
        self.assertEqual(got, b"\x00\x05strmq")
        w.transport.abort()                   # drop; LMS sends more meanwhile
        await asyncio.sleep(0.2)
        sw.write(b"\x00\x05strmt")
        await sw.drain()
        await asyncio.sleep(0.2)
        r2, w2, _ = await self.ws()
        w2.write(frame(json.dumps({"resume": {"session": hello["session"], "secret": hello["secret"], "received": 7}}).encode(), 0x1))
        op, data = await self.recv(r2)
        self.assertEqual(json.loads(data)["replay"], 7)
        _, missed = await self.recv(r2)
        self.assertEqual(missed, b"\x00\x05strmt")
        w2.close()

    async def test_refusals(self):
        _, w, status = await self.ws(origin="http://evil.example")
        self.assertIn("403", status)
        w.close()
        r, w, _ = await self.ws()
        w.write(frame(json.dumps({"hello": 1}).encode(), 0x1))
        await self.recv(r)
        w.write(frame(helo([0, 4, 0x20, 1, 2, 3])))
        op, data = await self.recv(r)
        self.assertEqual((op, struct.unpack(">H", data[:2])[0]), (0x8, 1008))
        w.close()
        r, w, _ = await self.ws()
        w.write(frame(json.dumps({"resume": {"session": "nope", "secret": "x", "received": 0}}).encode(), 0x1))
        op, data = await self.recv(r)
        self.assertEqual(struct.unpack(">H", data[:2])[0], 4404)
        w.close()
        resp = await self.http(b"GET /plugins/LyrionJS/ws HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
        self.assertIn(b"400", resp.split(b"\r\n")[0])


if __name__ == "__main__":
    unittest.main()
