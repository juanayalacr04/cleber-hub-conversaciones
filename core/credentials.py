"""Credenciales de números y bots fuera de los documentos que lee el navegador (tarea 1.41).

Los tokens de Twilio y Meta, el de verificación del webhook de Meta, las claves de Abacus y la del bot externo viven en la colección
`secrets`, que no tiene ninguna regla en `firestore.rules`: el navegador no puede leerla, solo la función (con el Admin SDK).
El documento del número o del bot conserva únicamente `secretsSet`, la lista de credenciales ya configuradas, para que la pantalla
muestre "configurado" sin conocer el valor.

    secrets/numbers__{id}    twilioAuthToken, metaAccessToken, metaWebhookVerifyToken
    secrets/bots__{id}       twilioConfig.authToken, abacusConfig.deploymentToken, abacusConfig.apiKey, externalConfig.apiKey, ...

La lectura (`reveal`) devuelve el documento con las credenciales ya puestas donde el código las espera, así el resto no cambia.
Si todavía hay una credencial en el documento (datos anteriores a la migración), se sigue usando hasta que `migrate` la mueva; la de
`secrets` gana. Pasar a Secret Manager por credencial, cuando entre producción, cambia solo este módulo.
"""
import copy
import logging
import time

from google.cloud import firestore

from core.db import get_db

log = logging.getLogger(__name__)

COLLECTION = "secrets"
TTL = 60   # una credencial rotada llega a todas las instancias en menos de un minuto

NUMBER_SECRETS = ("twilioAuthToken", "metaAccessToken", "metaWebhookVerifyToken")
BOT_SECRETS = ("twilioConfig.authToken", "abacusConfig.deploymentToken", "abacusConfig.apiKey", "externalConfig.apiKey",
               "vertexAiConfig.apiKey")
KINDS = {"numbers": ("whatsappNumbers", NUMBER_SECRETS), "bots": ("bots", BOT_SECRETS)}

_cache: dict[str, dict] = {}


def clear_cache() -> None:
    _cache.clear()


def secret_id(kind: str, doc_id: str) -> str:
    return f"{kind}__{doc_id}"


def _ref(db, kind: str, doc_id: str):
    return db.collection(COLLECTION).document(secret_id(kind, doc_id))


def _get(data: dict, dotted: str):
    for part in dotted.split("."):
        data = data.get(part) if isinstance(data, dict) else None
    return data


def _put(data: dict, dotted: str, value) -> None:
    *parents, last = dotted.split(".")
    for part in parents:
        if not isinstance(data.get(part), dict):
            data[part] = {}
        data = data[part]
    data[last] = value


def _pop(data: dict, dotted: str) -> None:
    *parents, last = dotted.split(".")
    for part in parents:
        data = data.get(part) if isinstance(data, dict) else None
    if isinstance(data, dict):
        data.pop(last, None)


def paths(kind: str) -> tuple:
    return KINDS[kind][1]


def split(kind: str, data: dict) -> tuple[dict, dict]:
    """(datos sin credenciales, credenciales nuevas `{ruta: valor}`).

    Una credencial vacía o ausente no cambia nada: la pantalla manda el campo solo cuando se escribió uno nuevo. Tampoco cuenta
    la máscara de asteriscos con que las pantallas dibujan una credencial ya configurada: guardarla sobrescribiría la real.
    """
    public, found = copy.deepcopy(data), {}
    for dotted in paths(kind):
        value = _get(data, dotted)
        if isinstance(value, str) and value.strip() and set(value.strip()) != {"*"}:
            found[dotted] = value.strip()
        _pop(public, dotted)
    return public, found


def load(db, kind: str, doc_id: str, use_cache: bool = True) -> dict:
    """Credenciales guardadas de un número o bot, `{ruta: valor}`."""
    key = secret_id(kind, doc_id)
    cached = _cache.get(key)
    if use_cache and cached and time.time() < cached["expires"]:
        return cached["values"]
    stored = _ref(db, kind, doc_id).get()
    nested = (stored.to_dict() or {}) if stored.exists else {}
    values = {dotted: value for dotted in paths(kind) if isinstance(value := _get(nested, dotted), str) and value}
    _cache[key] = {"values": values, "expires": time.time() + TTL}
    return values


def reveal(db, kind: str, doc_id: str | None, data: dict) -> dict:
    """Copia de `data` con las credenciales de `secrets` puestas donde el código las espera."""
    if not doc_id:
        return data
    values = load(db, kind, doc_id)
    if not values:
        return data
    revealed = copy.deepcopy(data)
    for dotted, value in values.items():
        _put(revealed, dotted, value)
    return revealed


def store(db, kind: str, doc_id: str, values: dict) -> None:
    """Guarda credenciales sin tocar las demás del mismo documento."""
    if not values:
        return
    ref = _ref(db, kind, doc_id)
    if ref.get().exists:
        ref.update(values)       # las claves con puntos son rutas: no pisan a sus hermanas
    else:
        nested: dict = {}
        for dotted, value in values.items():
            _put(nested, dotted, value)
        ref.set(nested)
    _cache.pop(secret_id(kind, doc_id), None)


def clear(db, kind: str, doc_id: str, dotted_paths) -> None:
    """Borra las credenciales indicadas."""
    wanted = [p for p in dotted_paths if p in paths(kind)]
    ref = _ref(db, kind, doc_id)
    if wanted and ref.get().exists:
        ref.update({p: firestore.DELETE_FIELD for p in wanted})
    _cache.pop(secret_id(kind, doc_id), None)


def delete(db, kind: str, doc_id: str) -> None:
    _ref(db, kind, doc_id).delete()
    _cache.pop(secret_id(kind, doc_id), None)


def mark_configured(db, kind: str, doc_id: str) -> list:
    """Actualiza `secretsSet` del documento con las credenciales que hay ahora. Devuelve la lista."""
    configured = sorted(load(db, kind, doc_id, use_cache=False))
    db.collection(KINDS[kind][0]).document(doc_id).update({"secretsSet": configured})
    return configured


def find_number_by_verify_token(db, token: str) -> str | None:
    """ID del número de Meta cuyo token de verificación es `token` (el GET de verificación del webhook no trae el número)."""
    if not token:
        return None
    for snap in db.collection(COLLECTION).where("metaWebhookVerifyToken", "==", token).limit(5).stream():
        if snap.id.startswith("numbers__"):
            return snap.id.removeprefix("numbers__")
    return None


def migrate(db) -> dict:
    """Mueve las credenciales que todavía están en los documentos de números y bots a `secrets`. Idempotente.

    Si `secrets` ya tiene un valor, ese gana y el del documento solo se descarta. Devuelve cuántos documentos cambió por tipo.
    """
    moved = {}
    for kind, (collection, _) in KINDS.items():
        moved[kind] = 0
        for snap in db.collection(collection).stream():
            _, legacy = split(kind, snap.to_dict() or {})
            if not legacy:
                continue
            existing = load(db, kind, snap.id, use_cache=False)
            store(db, kind, snap.id, {p: v for p, v in legacy.items() if p not in existing})
            snap.reference.update({p: firestore.DELETE_FIELD for p in legacy})
            mark_configured(db, kind, snap.id)
            moved[kind] += 1
    return moved
