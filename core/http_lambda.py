"""Adaptador entre Lambda y el código que nació con functions_framework (DISENO_BACKEND_AWS.md §4.1).

    peticion = Peticion.de_evento(event)      # evento de API Gateway (proxy, REST v1) o de una Function URL
    peticion.get_json(silent=True), peticion.get_data(as_text=True), peticion.headers, peticion.args, peticion.method, peticion.path
    return respuesta(200, cuerpo, {"Content-Type": "application/json"})

Así `channels/router.py`, `core/actions.py` y `core/user_actions.py` reciben algo con la forma del `request` de Flask y casi no
cambian. `es_invocacion_directa(event)` distingue una invocación con lambda:InvokeFunction (el evento es el cuerpo).
"""
import base64
import json


class Headers(dict):
    """Headers sin distinguir mayúsculas (como los de Flask)."""

    def __init__(self, datos=None):
        super().__init__({str(k).lower(): v for k, v in (datos or {}).items()})

    def get(self, llave, default=None):
        return super().get(str(llave).lower(), default)

    def __getitem__(self, llave):
        return super().__getitem__(str(llave).lower())

    def __contains__(self, llave):
        return super().__contains__(str(llave).lower())


class Peticion:
    def __init__(self, method="POST", path="/", headers=None, args=None, cuerpo: bytes = b"", query_string: bytes | None = None):
        self.method = (method or "POST").upper()
        self.path = path or "/"
        self.headers = Headers(headers)
        self.args = dict(args or {})
        self._cuerpo = cuerpo or b""
        # La query tal como llegó (Twilio firma la URL completa). Sin ella se rearma desde args.
        if query_string is None:
            from urllib.parse import urlencode
            query_string = urlencode(self.args).encode("utf-8")
        self.query_string = query_string

    @classmethod
    def de_evento(cls, event: dict) -> "Peticion":
        contexto = event.get("requestContext") or {}
        method = event.get("httpMethod") or (contexto.get("http") or {}).get("method")
        path = event.get("path") or event.get("rawPath") or "/"
        cuerpo = event.get("body") or ""
        datos = base64.b64decode(cuerpo) if event.get("isBase64Encoded") else cuerpo.encode("utf-8")
        crudo = event.get("rawQueryString")
        return cls(method, path, event.get("headers"), event.get("queryStringParameters"), datos,
                   crudo.encode("utf-8") if crudo is not None else None)

    def get_data(self, as_text: bool = False):
        return self._cuerpo.decode("utf-8") if as_text else self._cuerpo

    def get_json(self, silent: bool = False):
        try:
            return json.loads(self._cuerpo.decode("utf-8") or "null")
        except ValueError:
            if silent:
                return None
            raise

    @property
    def form(self) -> dict:
        """Cuerpo application/x-www-form-urlencoded (Twilio), un valor por llave."""
        from urllib.parse import parse_qsl
        return dict(parse_qsl(self._cuerpo.decode("utf-8"), keep_blank_values=True))


def es_invocacion_directa(event) -> bool:
    """True si el evento NO viene de API Gateway ni de una Function URL (lambda:InvokeFunction manda el cuerpo tal cual)."""
    return not (isinstance(event, dict) and "requestContext" in event and ("body" in event or "httpMethod" in event))


def respuesta(status: int, cuerpo, headers: dict | None = None) -> dict:
    """Respuesta para API Gateway / Function URL. Un dict o lista se manda como JSON."""
    if isinstance(cuerpo, (dict, list)):
        texto = json.dumps(cuerpo, ensure_ascii=False, default=str)
        headers = {"Content-Type": "application/json", **(headers or {})}
    else:
        texto = "" if cuerpo is None else str(cuerpo)
    return {"statusCode": int(status), "headers": headers or {}, "body": texto}


def de_flask(resultado) -> dict:
    """Convierte lo que regresan los handlers estilo functions_framework — `cuerpo`, `(cuerpo, status)` o
    `(cuerpo, status, headers)` — en respuesta de Lambda."""
    if isinstance(resultado, tuple):
        cuerpo, status, *resto = resultado
        return respuesta(status, cuerpo, resto[0] if resto else None)
    return respuesta(200, resultado)
