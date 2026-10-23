#!/usr/bin/env python3
"""LyrionJS dev relay: run the page against a real LMS without installing the plugin.

FOR DEVELOPMENT ONLY. It follows the plugin's protocol, rules and close codes
(docs/ARCHITECTURE.md) so the page has one code path, and proxies everything else to the LMS you
name. Two differences, by design: a page that doesn't take what is sent within SEND_WAIT is
dropped (the plugin counts writes queued to it), and diagnostics are always printed.

  GET  /  and  /plugins/LyrionJS/   the page (lyrionjs.html next to this file, read per request)
  WS   /plugins/LyrionJS/ws         Slimproto byte pipe: hello/resume, HELO MAC check, 10 s hold
  POST /plugins/LyrionJS/log        page diagnostics, printed here
  anything else                     proxied to LMS's web server (JSON-RPC, /stream.mp3, artwork…)

Standard library only (Python 3.8+):  python3 relay.py --lms 192.168.1.20 [--port 9100]
Without --lms it uses the first LMS that answers UDP discovery.
"""

import argparse
import asyncio
import base64
import hashlib
import json
import logging
import os
import re
import secrets
import socket
import struct
import sys
import time
from urllib.parse import parse_qs, urlsplit

LOG = logging.getLogger("lyrionjs-dev")
HERE = os.path.dirname(os.path.abspath(__file__))
PAGE = os.path.join(HERE, "lyrionjs.html")
WS_GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
HOLD = 10            # seconds a dropped page's LMS connection is kept
HELLO_WAIT = 10      # seconds a new socket has to say hello
IDLE = 30            # seconds of silence before an attached socket is dropped
SEND_WAIT = 10       # seconds a page may take to accept what is sent to it
REPLAY_BYTES = 256 * 1024
MAX_MESSAGE = 64 * 1024
MAX_SESSIONS = 32
MAX_SOCKETS = 64
LOG_PER_MIN = 120
VERSION = "dev"
# Close codes, as the plugin's (docs/ARCHITECTURE.md)
GOING, PROTOCOL, DROPPED, POLICY, TOO_BIG, ERROR, TRY_LATER = 1001, 1002, 1006, 1008, 1009, 1011, 1013
REPLACED, DISABLED, NO_RESUME = 4000, 4403, 4404
MAC_PREFIX = b"\x02\x4c\x4a"
MAX_HEADER = 64 * 1024
MAX_BODY = 8 * 1024 * 1024
HOP = {"connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"}


# ---------------------------------------------------------------------------
# Discovery (only to find a server when --lms isn't given)
# ---------------------------------------------------------------------------

def parse_discovery_reply(data):
    """An LMS discovery answer: 'E' then TLVs (4-byte tag, 1-byte length, value)."""
    if not data or data[:1] != b"E":
        return None
    out, i = {}, 1
    while i + 5 <= len(data):
        tag, n = data[i:i + 4].decode("ascii", "replace"), data[i + 4]
        val = data[i + 5:i + 5 + n]
        if len(val) < n:
            break
        out[tag] = val.decode("utf-8", "replace")
        i += 5 + n
    return out


def discover(timeout=2.0):
    req = b"e" + b"".join(t + b"\0" for t in (b"NAME", b"JSON", b"VERS"))
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        s.settimeout(0.25)
        s.sendto(req, ("255.255.255.255", 3483))
        end = time.time() + timeout
        while time.time() < end:
            try:
                data, (ip, _) = s.recvfrom(2048)
            except socket.timeout:
                continue
            info = parse_discovery_reply(data)
            if info:
                return ip, int(info.get("JSON") or 9000), info.get("NAME", ip)
    return None


# ---------------------------------------------------------------------------
# HTTP and WebSocket plumbing
# ---------------------------------------------------------------------------

class Request:
    def __init__(self, method, target, headers, body):
        self.method, self.target, self.headers, self.body = method, target, headers, body
        self.path = urlsplit(target).path
        self.query = {k: v[0] for k, v in parse_qs(urlsplit(target).query).items()}

    def header(self, name):
        return self.headers.get(name.lower(), "")


async def read_request(reader):
    try:
        head = await reader.readuntil(b"\r\n\r\n")
    except asyncio.LimitOverrunError:
        raise ValueError("header too large")
    except asyncio.IncompleteReadError as e:
        if e.partial.strip():
            raise ValueError("truncated request")
        return None
    lines = head.decode("latin-1").split("\r\n")
    parts = lines[0].split(" ")
    if len(parts) != 3:
        raise ValueError("bad request line")
    headers = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    if "transfer-encoding" in headers:
        raise ValueError("chunked request bodies are not supported")
    n = int(headers.get("content-length") or 0)
    if n < 0 or n > MAX_BODY:
        raise ValueError("body too large")
    body = await reader.readexactly(n) if n else b""
    return Request(parts[0], parts[1], headers, body)


def response(status, reason, headers=(), body=b"", length=None):
    """length: for a HEAD answer, the length the GET body would have."""
    n = len(body) if length is None else length
    out = [f"HTTP/1.1 {status} {reason}"] + [f"{k}: {v}" for k, v in headers] + [f"Content-Length: {n}"]
    return ("\r\n".join(out) + "\r\n\r\n").encode("latin-1") + body


def plain(status, text):
    return response(status, text, [("Content-Type", "text/plain")], text.encode())


def _with_port(host, port):
    return host if re.search(r":\d+$", host) else host + port


def origin_allowed(origin, *hosts):
    """Same rule as the plugin: no Origin, or an Origin naming the Host (or a proxy's
    X-Forwarded-Host) it was sent to; a host without a port has the Origin scheme's."""
    if not origin:
        return True
    m = re.fullmatch(r"(https?)://([^/]+)", origin, re.I)
    if not m:
        return False
    port = ":443" if m.group(1).lower() == "https" else ":80"
    ohost = _with_port(m.group(2), port).lower()
    return any(ohost == _with_port(h, port).lower()
               for value in hosts if value for h in re.split(r"\s*,\s*", value) if h)


def log_safe(text):
    """Text from a page made safe for one log line, as the plugin does."""
    return re.sub(r"[\x00-\x1f\x7f\u2028\u2029]+", " ", text)


def helo_mac(data):
    """'' if more bytes are needed, None if refused, else the MAC string."""
    if len(data) < 16:
        return ""
    if data[:4] != b"HELO" or data[10:13] != MAC_PREFIX:
        return None
    return ":".join(f"{b:02x}" for b in data[10:16])


def client_frames(buf):
    """Splits the complete Slimproto frames off the front of buf (a bytearray, consumed).
    Returns them, or None if the bytes can't be Slimproto."""
    out = []
    while len(buf) >= 8:
        op, n = bytes(buf[:4]), struct.unpack(">I", buf[4:8])[0]
        if not all(0x20 <= b <= 0x7E for b in op) or n > MAX_MESSAGE:
            return None
        if len(buf) < 8 + n:
            break
        out.append(bytes(buf[:8 + n]))
        del buf[:8 + n]
    return None if len(buf) > MAX_MESSAGE else out


class WebSocket:
    def __init__(self, reader, writer):
        self.r, self.w, self.closed = reader, writer, False

    async def recv(self):
        """(opcode, payload) of the next data message; pings answered here; None on close."""
        message, msg_op = bytearray(), None
        while True:
            b1, b2 = await self.r.readexactly(2)
            fin, op, masked, n = b1 & 0x80, b1 & 0x0F, b2 & 0x80, b2 & 0x7F
            if n == 126:
                n = struct.unpack(">H", await self.r.readexactly(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", await self.r.readexactly(8))[0]
            if not masked:
                raise ProtocolError(PROTOCOL)
            if n > MAX_MESSAGE or len(message) + n > MAX_MESSAGE:
                raise ProtocolError(TOO_BIG)
            if op & 0x8 and (not fin or n > 125):
                raise ProtocolError(PROTOCOL)
            mask = await self.r.readexactly(4)
            data = bytes(b ^ mask[i & 3] for i, b in enumerate(await self.r.readexactly(n)))
            if op == 0x8:
                return None
            if op == 0x9:
                await self.send(data, 0xA)
                continue
            if op == 0xA:
                continue
            if op in (0x1, 0x2) and msg_op is None:
                msg_op = op
            elif op != 0x0 or msg_op is None:
                raise ProtocolError(PROTOCOL)    # a new message inside another, or no message
            message += data
            if fin:
                return msg_op, bytes(message)

    def write(self, data, op=0x2):
        """Queues a frame; nothing else can come between its bytes."""
        if self.closed:
            return
        n = len(data)
        hdr = struct.pack(">BB", 0x80 | op, n) if n < 126 else \
            struct.pack(">BBH", 0x80 | op, 126, n) if n < 65536 else struct.pack(">BBQ", 0x80 | op, 127, n)
        self.w.write(hdr + data)

    async def drain(self):
        """Waits for the page to take what is queued; a page that doesn't is dropped."""
        try:
            await asyncio.wait_for(self.w.drain(), SEND_WAIT)
        except asyncio.TimeoutError:
            self.abort()
            raise ConnectionError("page not reading")

    async def send(self, data, op=0x2):
        self.write(data, op)
        await self.drain()

    def abort(self):
        self.closed = True
        self.w.transport.abort()

    async def close(self, code=1000, reason=""):
        if not self.closed:
            try:
                self.write(struct.pack(">H", code) + reason.encode()[:100], 0x8)
                self.closed = True
                await asyncio.wait_for(self.w.drain(), 2)
            except (OSError, ConnectionError, asyncio.TimeoutError):
                pass
            self.closed = True
        try:
            self.w.close()
        except OSError:
            pass


class ProtocolError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


# ---------------------------------------------------------------------------
# Sessions: the same model as the plugin's Bridge.pm
# ---------------------------------------------------------------------------

class Session:
    def __init__(self, sid, secret):
        self.id, self.secret = sid, secret
        self.up_r = self.up_w = None
        self.ws = None
        self.sent, self.buf, self.buf_start = 0, bytearray(), 0
        self.out, self.mac, self.got = bytearray(), None, 0
        self.hold_task = self.pump_task = None

    def keep(self, data):
        self.buf += data
        self.sent += len(data)
        over = len(self.buf) - REPLAY_BYTES
        if over > 0:
            del self.buf[:over]
            self.buf_start += over

    def replay_from(self, received):
        # As the plugin: a whole number, also when sent as a string of digits.
        if isinstance(received, str) and received.isdigit():
            received = int(received)
        if isinstance(received, bool) or not isinstance(received, int) or received > self.sent or received < self.buf_start:
            return None
        return bytes(self.buf[received - self.buf_start:])


class Relay:
    def __init__(self, lms_host, lms_port, slim_port=3483, page=PAGE, players=True):
        self.lms_host, self.lms_port, self.slim_port, self.page = lms_host, lms_port, slim_port, page
        self.players = players     # the plugin's "enabled" setting
        self.log_times = []
        self.sessions = {}
        self.sockets = 0

    async def handle(self, reader, writer):
        try:
            while True:
                try:
                    req = await asyncio.wait_for(read_request(reader), 120)
                except (ValueError, asyncio.IncompleteReadError) as e:
                    writer.write(plain(400, "Bad Request"))
                    LOG.info("bad request: %s", e)
                    break
                if req is None:
                    break
                keep = await self.dispatch(req, reader, writer)
                await writer.drain()
                if not keep or req.header("connection").lower() == "close":
                    break
        except (asyncio.TimeoutError, ConnectionError, OSError):
            pass
        finally:
            try:
                writer.close()
            except OSError:
                pass

    async def dispatch(self, req, reader, writer):
        p = req.path
        if p == "/plugins/LyrionJS/ws":
            if req.method != "GET" or req.header("upgrade").lower() != "websocket" or not req.header("sec-websocket-key"):
                writer.write(plain(400, "WebSocket only"))
                return True
            if not self.same_origin(req):
                writer.write(plain(403, "Forbidden origin"))
                return True
            if self.sockets >= MAX_SOCKETS:
                writer.write(plain(503, "Too many sockets"))
                return True
            self.sockets += 1
            try:
                await self.websocket(req, reader, writer)
            finally:
                self.sockets -= 1
            return False
        if p == "/plugins/LyrionJS/config.json" and req.method in ("GET", "HEAD"):
            body = json.dumps({"enabled": int(self.players), "defaultOutput": "auto", "clientDiagnostics": 1,
                               "version": VERSION}).encode()
            headers = [("Content-Type", "application/json"), ("Cache-Control", "no-store")]
            mac = req.query.get("mac", "").lower()
            if re.fullmatch(r"02:4c:4a(?::[0-9a-f]{2}){3}", mac):   # kept for the page, as the plugin does
                headers.append(("Set-Cookie", f"lj_mac={mac}; Max-Age=34560000; SameSite=Strict"))
            writer.write(response(200, "OK", headers, body if req.method == "GET" else b"", length=len(body)))
            return True
        if p == "/plugins/LyrionJS/log" and req.method == "POST":
            if not self.same_origin(req):
                writer.write(plain(403, "Forbidden origin"))
                return True
            now = time.monotonic()
            self.log_times = [t for t in self.log_times if now - t < 60]
            if len(self.log_times) >= LOG_PER_MIN:
                writer.write(plain(429, "Too many"))
                return True
            self.log_times.append(now)
            try:
                msg = json.loads(req.body or b"{}")
                lines = msg.get("lines") if isinstance(msg, dict) else None
                if isinstance(lines, list):
                    who = log_safe(str(msg.get("id", "-"))[:32])
                    for line in lines[:200]:
                        LOG.info("page [%s] %s", who, log_safe(str(line)[:600]))
            except (ValueError, RecursionError):
                pass
            writer.write(plain(200, "ok"))
            return True
        if p in ("/", "/plugins/LyrionJS", "/plugins/LyrionJS/", "/plugins/LyrionJS/index.html") and req.method in ("GET", "HEAD"):
            if p in ("/", "/plugins/LyrionJS"):
                writer.write(response(302, "Found", [("Location", "/plugins/LyrionJS/")]))
                return True
            try:
                with open(self.page, "rb") as f:
                    body = f.read()
            except OSError:
                writer.write(plain(404, "lyrionjs.html not found: run build.py"))
                return True
            writer.write(response(200, "OK", [("Content-Type", "text/html; charset=utf-8"), ("Cache-Control", "no-cache")],
                                  body if req.method == "GET" else b"", length=len(body)))
            return True
        # LMS checks that a POST comes from its own pages (Origin against Host). The proxy hides
        # the page's Origin from LMS, so it does that check itself.
        if req.method not in ("GET", "HEAD") and not self.same_origin(req):
            writer.write(plain(403, "Forbidden origin"))
            return True
        return await self.proxy(req, writer)

    @staticmethod
    def same_origin(req):
        return origin_allowed(req.header("origin"), req.header("host"), req.header("x-forwarded-host"))

    # -- the Slimproto pipe ----------------------------------------------------

    async def websocket(self, req, reader, writer):
        accept = base64.b64encode(hashlib.sha1(req.header("sec-websocket-key").encode() + WS_GUID).digest()).decode()
        writer.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
        await writer.drain()
        ws = WebSocket(reader, writer)
        session = None
        code = 1000
        try:
            try:
                first = await asyncio.wait_for(ws.recv(), HELLO_WAIT)
            except asyncio.TimeoutError:
                raise ProtocolError(POLICY)
            if first is None:
                return
            op, data = first
            msg = json.loads(data) if op == 0x1 else None
            if not isinstance(msg, dict):
                raise ProtocolError(POLICY)
            if isinstance(msg.get("resume"), dict):
                session = await self.resume(ws, msg["resume"])
            elif msg.get("hello"):
                session = await self.new_session(ws)
            else:
                raise ProtocolError(POLICY)
            opened = time.monotonic()
            while True:
                # A session must say which player it is (HELO) within HELLO_WAIT, as in the plugin.
                wait = IDLE if session.mac else max(0.05, HELLO_WAIT - (time.monotonic() - opened))
                try:
                    m = await asyncio.wait_for(ws.recv(), wait)
                except asyncio.TimeoutError:
                    if not session.mac:
                        raise ProtocolError(POLICY)
                    LOG.info("session %s: socket silent, dropped", session.id[:8])
                    ws.abort()
                    raise ConnectionError("silent")
                if m is None:
                    return
                op, data = m
                if op == 0x2:
                    await self.to_lms(session, data)
        except ProtocolError as e:
            code = e.code
        except (ValueError, UnicodeDecodeError, RecursionError, TypeError, AttributeError):
            code = POLICY                         # not the hello the protocol asks for
        except (asyncio.IncompleteReadError, ConnectionError, OSError):
            code = DROPPED
        finally:
            if code != DROPPED:
                await ws.close(code)
            else:
                ws.closed = True
            if session is not None and session.ws is ws:
                session.ws = None
                if code in (POLICY, PROTOCOL, TOO_BIG):
                    await self.end_session(session, code)   # refused: not held for a resume
                elif session.id in self.sessions:
                    session.hold_task = asyncio.ensure_future(self.hold(session))

    async def to_lms(self, s, data):
        """Whole Slimproto frames only, and every HELO checked, as in the plugin."""
        s.got += len(data)   # what the page sent, counted for its resume
        s.out += data
        frames = client_frames(s.out)
        if frames is None:
            raise ProtocolError(POLICY)
        for f in frames:
            if f[:4] == b"HELO":
                mac = helo_mac(f)
                if not mac:
                    raise ProtocolError(POLICY)
                if s.mac is None:
                    for other in list(self.sessions.values()):
                        if other is not s and other.mac == mac:
                            await self.end_session(other, REPLACED)
                    s.mac = mac
                elif mac != s.mac:
                    raise ProtocolError(POLICY)
            elif s.mac is None:
                raise ProtocolError(POLICY)
        if frames and s.up_w is not None:
            s.up_w.write(b"".join(frames))
            await asyncio.wait_for(s.up_w.drain(), SEND_WAIT)

    async def new_session(self, ws):
        if not self.players:
            raise ProtocolError(DISABLED)
        if len(self.sessions) >= MAX_SESSIONS:
            raise ProtocolError(TRY_LATER)
        try:
            r, w = await asyncio.wait_for(asyncio.open_connection(self.lms_host, self.slim_port), 5)
        except (OSError, asyncio.TimeoutError) as e:
            LOG.error("can't reach LMS Slimproto at %s:%s: %s", self.lms_host, self.slim_port, e)
            raise ProtocolError(ERROR)
        sock = w.get_extra_info("socket")
        if sock is not None:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        s = Session(secrets.token_hex(16), secrets.token_hex(16))
        s.up_r, s.up_w, s.ws = r, w, ws
        self.sessions[s.id] = s
        ws.write(json.dumps({"session": s.id, "secret": s.secret, "resumed": False, "hold": HOLD}).encode(), 0x1)
        s.pump_task = asyncio.ensure_future(self.pump(s))
        await ws.drain()
        LOG.info("new session %s", s.id[:8])
        return s

    async def resume(self, ws, r):
        if not self.players:
            raise ProtocolError(DISABLED)
        sid = r.get("session")
        s = self.sessions.get(sid) if isinstance(sid, str) else None
        secret = r.get("secret")
        if not s or not isinstance(secret, str) or not secrets.compare_digest(secret, s.secret) \
                or s.replay_from(r.get("received")) is None:
            raise ProtocolError(NO_RESUME)
        if s.hold_task:
            s.hold_task.cancel()
            s.hold_task = None
        old, s.ws = s.ws, None
        if old is not None:
            await old.close(REPLACED)
        if s.id not in self.sessions:
            raise ProtocolError(NO_RESUME)      # ended meanwhile
        # The reply, the replay and attaching happen with no await between them, so nothing LMS
        # sends can land before the replay or be missed by it.
        missed = s.replay_from(r.get("received"))
        ws.write(json.dumps({"session": s.id, "secret": s.secret, "resumed": True, "hold": HOLD,
                             "replay": len(missed), "got": s.got}).encode(), 0x1)
        if missed:
            ws.write(missed)
        s.ws = ws
        await ws.drain()
        LOG.info("resumed session %s (%d bytes replayed)", s.id[:8], len(missed))
        return s

    async def pump(self, s):
        """LMS -> page: keep everything for a resume, forward to the page when attached."""
        try:
            while True:
                data = await s.up_r.read(65536)
                if not data:
                    break
                s.keep(data)
                ws = s.ws
                if ws is not None:
                    try:
                        await ws.send(data)
                    except (ConnectionError, OSError):
                        ws.abort()   # its handler sees the drop and starts the hold
        except (ConnectionError, OSError):
            pass
        await self.end_session(s, 1001)

    async def hold(self, s):
        try:
            await asyncio.sleep(HOLD)
        except asyncio.CancelledError:
            return
        if s.ws is None:
            await self.end_session(s, 0)

    async def end_session(self, s, code):
        if self.sessions.pop(s.id, None) is None:
            return
        for t in (s.hold_task, s.pump_task):
            if t is not None and t is not asyncio.current_task():
                t.cancel()
        if s.up_w is not None:
            try:
                s.up_w.close()
            except OSError:
                pass
        if s.ws is not None:
            await s.ws.close(code or 1001)
            s.ws = None
        LOG.info("ended session %s (%s)", s.id[:8], code)

    # -- everything else goes to LMS --------------------------------------------

    async def proxy(self, req, writer):
        try:
            r, w = await asyncio.wait_for(asyncio.open_connection(self.lms_host, self.lms_port), 5)
        except (OSError, asyncio.TimeoutError):
            writer.write(plain(502, "LMS unreachable"))
            return True
        hdrs = [f"{req.method} {req.target} HTTP/1.1", f"Host: {self.lms_host}:{self.lms_port}", "Connection: close"]
        for k, v in req.headers.items():
            # LMS's CSRF check compares Origin with Host: the page is ours, so LMS sees a local client.
            if k in HOP or k in ("host", "origin", "referer", "content-length"):
                continue
            hdrs.append(f"{k}: {v}")
        if req.body:
            hdrs.append(f"Content-Length: {len(req.body)}")
        w.write(("\r\n".join(hdrs) + "\r\n\r\n").encode("latin-1") + req.body)
        try:
            head = await asyncio.wait_for(r.readuntil(b"\r\n\r\n"), 60)
        except (asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError, OSError):
            w.close()
            writer.write(plain(504, "LMS did not answer"))
            return True
        lines = head.decode("latin-1").split("\r\n")
        out, length, chunked = [lines[0].replace("HTTP/1.0", "HTTP/1.1", 1)], None, False
        for line in lines[1:]:
            if ":" not in line:
                continue
            k, v = line.split(":", 1)
            kl = k.strip().lower()
            if kl == "content-length":
                try:
                    length = int(v.strip())
                except ValueError:
                    w.close()
                    writer.write(plain(502, "Bad answer from LMS"))
                    return False
            if kl == "transfer-encoding" and "chunked" in v.lower():
                chunked = True
            if kl in HOP or kl == "content-length":
                continue
            out.append(f"{k.strip()}: {v.strip()}")
        status = (lines[0].split(" ") + ["", ""])[1]
        if req.method == "HEAD" or status in ("204", "304") or status.startswith("1"):
            # No body follows, whatever the headers say; a HEAD keeps the length a GET would have.
            if length is not None and req.method == "HEAD":
                out.append(f"Content-Length: {length}")
            writer.write(("\r\n".join(out) + "\r\n\r\n").encode("latin-1"))
            w.close()
            return not chunked
        keep = length is not None and not chunked
        out.append(f"Content-Length: {length}" if keep else "Connection: close")
        if chunked:
            out.append("Transfer-Encoding: chunked")
        writer.write(("\r\n".join(out) + "\r\n\r\n").encode("latin-1"))
        try:
            remaining = length
            while remaining is None or remaining > 0:   # streamed as it arrives (audio)
                chunk = await asyncio.wait_for(r.read(65536 if remaining is None else min(65536, remaining)), 300)
                if not chunk:
                    break
                if remaining is not None:
                    remaining -= len(chunk)
                writer.write(chunk)
                await writer.drain()
        except asyncio.TimeoutError:
            keep = False
        finally:
            w.close()
        return keep


async def main_async(args):
    if args.lms:
        host, _, port = args.lms.partition(":")
        lms = (socket.gethostbyname(host), int(port or 9000), host)
    else:
        lms = await asyncio.get_running_loop().run_in_executor(None, discover)
        if not lms:
            sys.exit("No LMS answered discovery; pass --lms HOST")
    LOG.info("LMS: %s at %s:%s", lms[2], lms[0], lms[1])
    relay = Relay(lms[0], lms[1], args.slim_port, players=not args.no_players)
    srv = await asyncio.start_server(relay.handle, args.bind, args.port, limit=MAX_HEADER)
    LOG.info("LyrionJS dev relay on http://%s:%s/plugins/LyrionJS/  (development only)", args.bind, args.port)
    async with srv:
        await srv.serve_forever()


def main():
    p = argparse.ArgumentParser(description="LyrionJS dev relay (emulates the LMS plugin; development only)")
    p.add_argument("--lms", help="LMS host[:http port]; default: UDP discovery")
    p.add_argument("--slim-port", type=int, default=3483, help="LMS Slimproto port")
    p.add_argument("--bind", default="127.0.0.1")
    p.add_argument("--port", type=int, default=9100)
    p.add_argument("--no-players", action="store_true", help="refuse browser players, as with the plugin switched off")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        asyncio.run(main_async(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
