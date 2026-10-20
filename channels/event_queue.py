"""La cola entre el router y las reglas (tarea 1.34): el router publica un `ChannelEvent`, la función 2 lo consume.

    INCOMING_TOPIC   tema de Pub/Sub, `projects/<proyecto>/topics/<tema>`. Sin él, el evento se procesa en proceso (desarrollo local)
    PUBSUB_REGION    región del extremo de publicación (`us-central1`): el orden por clave solo se respeta publicando siempre al mismo extremo

Por qué Pub/Sub con clave de orden: dos mensajes seguidos del cliente deben procesarse uno tras otro (hoy los resuelve el claim de
Firestore, `core/claims.py`, pero la cola evita que compitan). La clave es `ChannelEvent.ordering_key` (número del bot + cliente): con
una suscripción push, Pub/Sub entrega de a uno por clave y no pasa al siguiente hasta recibir el 2xx del anterior.

`publish` es **síncrono**: no regresa hasta que la cola aceptó el evento, y falla si no lo aceptó. El router responde 200 al proveedor solo
después; si falla, responde 500 y el proveedor reintenta. En segundo plano el evento se podría perder: una Cloud Function puede
congelarse al responder.
"""
import logging
import os

from contracts.messages import ChannelEvent

log = logging.getLogger(__name__)

PUBLISH_TIMEOUT = 10
_publisher = None


def configure(publisher) -> None:
    """Fija quién publica: un objeto con `publish(event)`. Lo cablea `main.py`; las pruebas ponen uno falso."""
    global _publisher
    _publisher = publisher


def publish(event: ChannelEvent) -> None:
    """Publica el evento o lanza. Nunca regresa sin que la cola lo haya aceptado."""
    if _publisher is None:
        raise RuntimeError("la cola no está configurada (event_queue.configure)")
    _publisher.publish(event)


class PubSubPublisher:
    """Publicador de Pub/Sub con orden por clave. El cliente se crea al primer uso: importar este módulo no exige la biblioteca."""

    def __init__(self, topic: str, region: str = "us-central1"):
        self.topic, self.region, self._client = topic, region, None

    def _get_client(self):
        if self._client is None:
            from google.cloud import pubsub_v1
            self._client = pubsub_v1.PublisherClient(
                publisher_options=pubsub_v1.types.PublisherOptions(enable_message_ordering=True),
                client_options={"api_endpoint": f"{self.region}-pubsub.googleapis.com:443"},
            )
        return self._client

    def publish(self, event: ChannelEvent) -> None:
        import json
        client, key = self._get_client(), event.ordering_key
        future = client.publish(self.topic, json.dumps(event.to_dict()).encode("utf-8"), ordering_key=key, kind=event.kind)
        try:
            future.result(timeout=PUBLISH_TIMEOUT)
        except Exception:
            client.resume_publish(self.topic, key)     # tras un fallo, Pub/Sub bloquea la clave hasta que se reanude
            raise


def from_env(env=None, direct=None):
    """Publicador según el entorno: Pub/Sub si hay `INCOMING_TOPIC`; si no, `direct` (procesar en proceso)."""
    env = os.environ if env is None else env
    topic = (env.get("INCOMING_TOPIC") or "").strip()
    if topic:
        return PubSubPublisher(topic, env.get("PUBSUB_REGION") or "us-central1")
    log.warning("INCOMING_TOPIC sin configurar: los eventos se procesan en proceso, sin cola ni orden por conversación")
    return direct


class DirectPublisher:
    """Sin cola (desarrollo local): el evento se procesa en proceso, en segundo plano. No hay orden por conversación."""

    def __init__(self, process, run):
        self.process, self.run = process, run

    def publish(self, event: ChannelEvent) -> None:
        self.run(self.process, event)
