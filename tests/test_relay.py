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


VECTORS = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugin", "t", "vectors.json")))


class Pure(unittest.TestCase):
    """The same vectors as the plugin's tests (plugin/t/vectors.json)."""

    def test_origin(self):
        for origin, hosts, want, name in VECTORS["origin"]:
            with self.subTest(name):
                self.assertEqual(relay.origin_allowed(origin, *hosts), want)

    def test_helo(self):
        for hexbytes, want, name in VECTORS["helo"]:
            with self.subTest(name):
                self.assertEqual(relay.helo_mac(bytes.fromhex(hexbytes)), want)

    def test_client_frames(self):
        for hexbytes, count, rest, name in VECTORS["clientFrames"]:
            with self.subTest(name):
                buf = bytearray.fromhex(hexbytes)
                got = relay.client_frames(buf)
                if count is None:
                    self.assertIsNone(got)
                else:
                    self.assertEqual((len(got), buf.hex()), (count, rest))

    def test_replay_buffer(self):
        s = relay.Session("a", "b")
        s.keep(b"x" * 1000)
        self.assertEqual(s.replay_from(400), b"x" * 600)
        self.assertIsNone(s.replay_from(1001))
        self.assertEqual(s.replay_from("990"), b"x" * 10, "digits as a string, as the plugin accepts")
        for bad in ("1e3", "x", 5.5, True, None):
            self.assertIsNone(s.replay_from(bad))
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
            self.web_requests = getattr(self, "web_requests", 0) + 1
            if head.startswith(b"HEAD"):
                w.write(b"HTTP/1.1 200 OK\r\nContent-Length: 12345\r\n\r\n")   # and no body
                await w.drain()
                await asyncio.sleep(1)                                             # nor a close
            elif b"/stream.mp3" in head:
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


    async def hello(self):
        r, w, _ = await self.ws()
        w.write(frame(json.dumps({"hello": 1}).encode(), 0x1))
        _, data = await self.recv(r)
        return r, w, json.loads(data)

    async def close_code(self, r):
        while True:
            op, data = await self.recv(r)
            if op == 0x8:
                return struct.unpack(">H", data[:2])[0]

    async def test_head_answered_without_waiting_for_a_body(self):
        resp = await asyncio.wait_for(self.http(b"HEAD /music/1/cover.jpg HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"), 0.8)
        self.assertIn(b"200 OK", resp)
        self.assertIn(b"Content-Length: 12345", resp)

    async def test_cross_site_post_refused_before_lms(self):
        body = b'{"method":"slim.request","params":["",["stop"]]}'
        resp = await self.http(b"POST /jsonrpc.js HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://evil.example\r\n"
                               b"Content-Length: " + str(len(body)).encode() + b"\r\nConnection: close\r\n\r\n" + body)
        self.assertIn(b"403", resp.split(b"\r\n")[0])
        self.assertFalse(getattr(self, "web_requests", 0), "LMS never saw it")
        resp = await self.http(f"POST /jsonrpc.js HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\nOrigin: http://127.0.0.1:{self.port}\r\n"
                               f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode() + body)
        self.assertIn(b"200", resp.split(b"\r\n")[0], "the page's own POST goes through")

    async def test_resume_replay_comes_before_live_data(self):
        r, w, h = await self.hello()
        w.write(frame(helo([2, 0x4C, 0x4A, 7, 7, 7])))
        for _ in range(50):
            if self.slim_writers and self.slim_rx:
                break
            await asyncio.sleep(0.02)
        sw = self.slim_writers[0]
        w.transport.abort()
        await asyncio.sleep(0.1)
        sw.write(b"\x00\x05strm1")
        await sw.drain()
        await asyncio.sleep(0.1)
        r2, w2, _ = await self.ws()
        w2.write(frame(json.dumps({"resume": {"session": h["session"], "secret": h["secret"], "received": 0}}).encode(), 0x1))
        sw.write(b"\x00\x05strm2")             # LMS keeps talking while the resume is answered
        await sw.drain()
        op, data = await self.recv(r2)
        self.assertEqual(op, 0x1, "the resume answer comes first")
        got = b""
        while len(got) < 14:
            got += (await self.recv(r2))[1]
        self.assertEqual(got, b"\x00\x05strm1\x00\x05strm2", "replay, then live, nothing lost or doubled")
        w2.close()

    async def test_every_helo_checked(self):
        r, w, _ = await self.hello()
        w.write(frame(helo([2, 0x4C, 0x4A, 1, 1, 1])))
        w.write(frame(helo([0, 4, 0x20, 1, 1, 1])))
        self.assertEqual(await self.close_code(r), 1008)
        await asyncio.sleep(0.05)
        self.assertEqual(self.slim_rx.count(b"HELO"), 1, "the second HELO never reached LMS")
        w.close()

    async def test_split_frame_and_players_off(self):
        r, w, _ = await self.hello()
        h = helo([2, 0x4C, 0x4A, 2, 2, 2])
        w.write(frame(h[:10]))
        await asyncio.sleep(0.05)
        self.assertEqual(self.slim_rx, b"", "half a HELO waits")
        w.write(frame(h[10:]))
        for _ in range(50):
            if self.slim_rx:
                break
            await asyncio.sleep(0.02)
        self.assertEqual(bytes(self.slim_rx), h)
        w.close()
        self.relay.players = False
        r, w, _ = await self.ws()
        w.write(frame(json.dumps({"hello": 1}).encode(), 0x1))
        self.assertEqual(await self.close_code(r), 4403)
        w.close()

    async def test_no_hello_times_out(self):
        old, relay.HELLO_WAIT = relay.HELLO_WAIT, 0.2
        try:
            r, w, _ = await self.ws()
            self.assertEqual(await self.close_code(r), 1008)
            w.close()
        finally:
            relay.HELLO_WAIT = old

    async def test_config_json(self):
        resp = await self.http(b"GET /plugins/LyrionJS/config.json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
        self.assertEqual(json.loads(resp.split(b"\r\n\r\n", 1)[1])["enabled"], 1)
        self.assertNotIn(b"Set-Cookie", resp)

    async def test_config_json_keeps_the_mac_in_a_cookie(self):
        resp = await self.http(b"GET /plugins/LyrionJS/config.json?mac=02%3A4c%3A4a%3A0a%3A0b%3A0c HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
        self.assertIn(b"Set-Cookie: lj_mac=02:4c:4a:0a:0b:0c; Max-Age=34560000; SameSite=Strict", resp)
        resp = await self.http(b"GET /plugins/LyrionJS/config.json?mac=00:04:20:0a:0b:0c HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
        self.assertNotIn(b"Set-Cookie", resp)


    async def test_resume_reports_what_arrived_and_policy_closes_end_the_session(self):
        r, w, h = await self.hello()
        hl = helo([2, 0x4C, 0x4A, 5, 5, 5])
        w.write(frame(hl))
        for _ in range(50):
            if self.slim_rx:
                break
            await asyncio.sleep(0.02)
        w.transport.abort()
        await asyncio.sleep(0.1)
        r2, w2, _ = await self.ws()
        w2.write(frame(json.dumps({"resume": {"session": h["session"], "secret": h["secret"], "received": "0"}}).encode(), 0x1))
        _, data = await self.recv(r2)
        self.assertEqual(json.loads(data)["got"], len(hl), "the bytes of the page's messages that arrived")
        w2.write(frame(helo([0, 4, 0x20, 9, 9, 9])))       # then breaks the rules
        self.assertEqual(await self.close_code(r2), 1008)
        await asyncio.sleep(0.05)
        self.assertNotIn(h["session"], self.relay.sessions, "a refused session is ended, not held")
        w2.close()

    async def test_malformed_resume_and_a_session_without_helo(self):
        for bad in ({"resume": {"session": ["a"], "secret": "x", "received": 0}}, {"resume": {"session": "x", "secret": 5}}):
            r, w, _ = await self.ws()
            w.write(frame(json.dumps(bad).encode(), 0x1))
            self.assertEqual(await self.close_code(r), 4404)
            w.close()
        r, w, _ = await self.ws()
        w.write(frame(("[" * 5000 + "]" * 5000).encode(), 0x1))   # deeply nested
        self.assertEqual(await self.close_code(r), 1008)
        w.close()
        old, relay.HELLO_WAIT = relay.HELLO_WAIT, 0.3
        try:
            r, w, _ = await self.hello()
            self.assertEqual(await self.close_code(r), 1008, "no HELO in time")
            w.close()
        finally:
            relay.HELLO_WAIT = old

    def test_log_text_is_one_safe_line(self):
        self.assertEqual(relay.log_safe("a\nb\x1b[31mc\u2028d"), "a b [31mc d")


if __name__ == "__main__":
    unittest.main()
