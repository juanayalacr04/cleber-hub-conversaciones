"""Stubs locales de proveedores externos (tarea 0.3). Solo biblioteca estándar.

Uso:  python dev/stubs/server.py [puerto]     (por defecto 8089)

Rutas:
  POST /twilio/*      -> 201 con un SID falso
  POST /meta/*        -> 200 con un messages[0].id falso
  POST /valuetext/*   -> 200
  POST /abacus/*      -> 200 con un segmento de texto vacío
  GET  /_calls        -> lista de todas las llamadas recibidas
  POST /_reset        -> vacía la lista
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

CALLS: list[dict] = []

RESPONSES = {
    "twilio": (201, {"sid": "SMstub000000000000000000000000000", "status": "queued"}),
    "meta": (200, {"messages": [{"id": "wamid.stub"}]}),
    "valuetext": (200, {"status": "ok"}),
    "abacus": (200, {"success": True, "result": {"segments": [{"title": "response", "segment": ""}]}}),
}


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/_calls":
            return self._send(200, CALLS)
        self._send(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode(errors="replace")
        if self.path == "/_reset":
            CALLS.clear()
            return self._send(200, {"ok": True})
        CALLS.append({"path": self.path, "body": raw})
        provider = self.path.strip("/").split("/")[0]
        status, body = RESPONSES.get(provider, (404, {"error": "unknown provider"}))
        self._send(status, body)

    def log_message(self, fmt, *args):
        print(f"[stub] {self.command} {self.path}")


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8089
    print(f"Stubs escuchando en http://localhost:{port}")
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
