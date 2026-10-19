"""Tiny DevTools-protocol client (standard library only) shared by the headless runners."""
import base64
import json
import os
import socket
import struct

CANDIDATES = [
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]


def find_browser(explicit=None):
    if explicit:
        return explicit
    for p in CANDIDATES:
        if os.path.exists(p):
            return p
    raise SystemExit('No Chrome/Edge found; pass --browser <path>')


class WebSocket:
    """Just enough RFC 6455 for talking to the DevTools endpoint."""

    def __init__(self, url):
        assert url.startswith('ws://')
        host_port, _, path = url[5:].partition('/')
        host, _, port = host_port.partition(':')
        self.sock = socket.create_connection((host, int(port)), timeout=60)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((
            f'GET /{path} HTTP/1.1\r\nHost: {host_port}\r\nUpgrade: websocket\r\n'
            f'Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n'
        ).encode())
        resp = b''
        while b'\r\n\r\n' not in resp:
            resp += self.sock.recv(4096)
        if b' 101 ' not in resp.split(b'\r\n')[0]:
            raise RuntimeError('WebSocket handshake failed: ' + resp.decode(errors='replace'))
        self.buf = resp.split(b'\r\n\r\n', 1)[1]

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError('socket closed')
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send(self, text):
        data = text.encode()
        header = bytearray([0x81])
        n = len(data)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack('>H', n)
        else:
            header.append(0x80 | 127)
            header += struct.pack('>Q', n)
        mask = os.urandom(4)
        header += mask
        self.sock.sendall(bytes(header) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def recv(self):
        message = b''
        while True:
            b1, b2 = self._read(2)
            fin, opcode, n = b1 & 0x80, b1 & 0x0F, b2 & 0x7F
            if n == 126:
                n = struct.unpack('>H', self._read(2))[0]
            elif n == 127:
                n = struct.unpack('>Q', self._read(8))[0]
            payload = self._read(n)
            if opcode == 0x9:  # ping -> pong
                self.sock.sendall(bytes([0x8A, 0x80]) + os.urandom(4))
                continue
            if opcode == 0x8:
                raise ConnectionError('closed by browser')
            message += payload
            if fin:
                return message.decode()


class Cdp:
    def __init__(self, ws_url):
        self.ws = WebSocket(ws_url)
        self.next_id = 0
        self.events = []  # protocol events seen while waiting for replies

    def pump(self, seconds=0.0):
        """Reads pending events for a moment (used to collect console errors)."""
        import time
        self.ws.sock.settimeout(max(seconds, 0.05))
        end = time.time() + seconds
        try:
            while True:
                msg = json.loads(self.ws.recv())
                if 'method' in msg:
                    self.events.append(msg)
                if time.time() >= end:
                    break
        except (socket.timeout, TimeoutError):
            pass
        finally:
            self.ws.sock.settimeout(60)

    def call(self, method, **params):
        self.next_id += 1
        want = self.next_id
        self.ws.send(json.dumps({'id': want, 'method': method, 'params': params}))
        while True:
            msg = json.loads(self.ws.recv())
            if 'method' in msg:
                self.events.append(msg)
            if msg.get('id') == want:
                if 'error' in msg:
                    raise RuntimeError(f'{method}: {msg["error"]}')
                return msg.get('result', {})

    def eval(self, expression, await_promise=False):
        res = self.call('Runtime.evaluate', expression=expression, returnByValue=True, awaitPromise=await_promise)
        if 'exceptionDetails' in res:
            raise RuntimeError('page exception: ' + json.dumps(res['exceptionDetails'])[:400])
        return res.get('result', {}).get('value')
