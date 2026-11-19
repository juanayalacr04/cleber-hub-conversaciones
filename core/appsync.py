"""Publicador de AppSync Events por HTTP con IAM (DISENO_BACKEND_AWS.md §6). Lo usa core/tiempo_real.py.

    tiempo_real.configure(appsync.Publicador.de_entorno())     # None si el ambiente no tiene APPSYNC_EVENTS_URL

POST https://<api>.appsync-api.<region>.amazonaws.com/event  { "channel": "/hub/...", "events": ["<json>", ...] }
firmado con SigV4 (servicio `appsync`) con las credenciales del rol de la Lambda, que necesita `appsync:EventPublish`
sobre el namespace (arn:aws:appsync:<region>:<cuenta>:apis/<apiId>/channelNamespace/hub).

Variables de entorno (en la Lambda o en el secreto SECRET_NAME):
    APPSYNC_EVENTS_URL   endpoint HTTP de la API de eventos (con o sin "/event"); sin ella no se publica
    AWS_REGION           la pone Lambda
"""
import json
import logging
import os

from core import http

log = logging.getLogger(__name__)

MAX_EVENTOS = 5      # límite de AppSync por petición
TIMEOUT = 3          # un aviso no debe demorar la operación que lo originó


def _url(valor: str) -> str:
    valor = valor.strip().rstrip("/")
    if not valor.startswith("http"):
        valor = f"https://{valor}"
    return valor if valor.endswith("/event") else f"{valor}/event"


class Publicador:
    def __init__(self, url: str, region: str | None = None, credenciales=None):
        self.url = _url(url)
        self.region = region or os.environ.get("AWS_REGION") or "us-east-1"
        self._credenciales = credenciales

    @classmethod
    def de_entorno(cls) -> "Publicador | None":
        url = (os.environ.get("APPSYNC_EVENTS_URL") or "").strip()
        return cls(url) if url else None

    def _firma(self, cuerpo: bytes) -> dict:
        from botocore.auth import SigV4Auth
        from botocore.awsrequest import AWSRequest
        if self._credenciales is None:
            import boto3
            self._credenciales = boto3.Session().get_credentials()
        peticion = AWSRequest(method="POST", url=self.url, data=cuerpo,
                              headers={"content-type": "application/json", "accept": "application/json"})
        # get_frozen_credentials: las del rol de Lambda rotan; se toman las vigentes en cada firma
        SigV4Auth(self._credenciales.get_frozen_credentials(), "appsync", self.region).add_auth(peticion)
        return dict(peticion.headers.items())

    def __call__(self, canal: str, eventos: list[dict]) -> None:
        """Publica en un canal. Lanza si AppSync no lo acepta (tiempo_real lo registra y sigue)."""
        for i in range(0, len(eventos), MAX_EVENTOS):
            lote = [json.dumps(e, ensure_ascii=False, default=str) for e in eventos[i:i + MAX_EVENTOS]]
            cuerpo = json.dumps({"channel": canal, "events": lote}).encode("utf-8")
            _, texto = http.request(self.url, cuerpo, self._firma(cuerpo), method="POST", timeout=TIMEOUT)
            fallidos = (json.loads(texto or "{}") or {}).get("failed") or []
            if fallidos:
                raise RuntimeError(f"AppSync rechazó {len(fallidos)} evento(s) en {canal}: {fallidos}")
