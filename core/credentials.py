"""Credenciales de números y bots fuera de los datos que lee el navegador (tarea 1.41; DISENO_BACKEND_AWS.md §4.5).

Los tokens de Twilio y Meta, el de verificación del webhook de Meta, las claves de Abacus y la del bot externo nunca viajan en
el documento (o la fila) del número o del bot: ese solo conserva la lista de credenciales ya configuradas (`secretsSet` en
Firestore, `secretos_configurados` en hub_cleber), para que la pantalla muestre "configurado" sin conocer el valor.

    numbers/{id}    twilioAuthToken, metaAccessToken, metaWebhookVerifyToken
    bots/{id}       twilioConfig.authToken, abacusConfig.deploymentToken, abacusConfig.apiKey, externalConfig.apiKey, ...

La lectura (`reveal`) devuelve el documento con las credenciales ya puestas donde el código las espera, así el resto no cambia.

Dónde se guardan lo decide el almacén (`SECRETOS_EN`):
  - `firestore` (por omisión, mientras Ventas y Servicio sigan en GCP): la colección `secrets`, sin reglas en firestore.rules
    (el navegador no la puede leer). `secrets/numbers__{id}`, `secrets/bots__{id}`.
  - `aws`: AWS Secrets Manager, un secreto por número o bot, `<SECRETOS_PREFIJO>/numbers/{id}` con el JSON
    `{ "ruta.con.puntos": "valor" }`. Es lo que usan las Lambdas del hub.
La interfaz es la misma en los dos; el parámetro `db` solo lo usa el de Firestore. Cuando Ventas y Servicio terminen de
mudarse a AWS, se borra el almacén de Firestore (y `migrate`).

Caché en memoria de 60 s por instancia: una credencial rotada llega a todas las instancias en menos de un minuto.
"""
import copy
import json
import logging
import os
import time

log = logging.getLogger(__name__)

COLLECTION = "secrets"
TTL = 60

NUMBER_SECRETS = ("twilioAuthToken", "metaAccessToken", "metaWebhookVerifyToken")
BOT_SECRETS = ("twilioConfig.authToken", "abacusConfig.deploymentToken", "abacusConfig.apiKey", "externalConfig.apiKey",
               "vertexAiConfig.apiKey")
KINDS = {"numbers": ("whatsappNumbers", NUMBER_SECRETS), "bots": ("bots", BOT_SECRETS)}

_cache: dict[str, dict] = {}
_almacen = None


def clear_cache() -> None:
    _cache.clear()


def secret_id(kind: str, doc_id: str) -> str:
    return f"{kind}__{doc_id}"


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


# --------------------------------------------------------------------------- almacenes

class AlmacenFirestore:
    """Colección `secrets` de Firestore (el de siempre)."""

    def _ref(self, db, kind, doc_id):
        if db is None:
            from core.db import get_db   # import local: el almacén de AWS no necesita Firestore
            db = get_db()
        return db.collection(COLLECTION).document(secret_id(kind, doc_id))

    def lee(self, db, kind: str, doc_id: str) -> dict:
        """`{ruta: valor}` de las credenciales guardadas."""
        stored = self._ref(db, kind, doc_id).get()
        nested = (stored.to_dict() or {}) if stored.exists else {}
        return {dotted: value for dotted in paths(kind) if isinstance(value := _get(nested, dotted), str) and value}

    def guarda(self, db, kind: str, doc_id: str, values: dict) -> None:
        ref = self._ref(db, kind, doc_id)
        if ref.get().exists:
            ref.update(values)       # las claves con puntos son rutas: no pisan a sus hermanas
        else:
            nested: dict = {}
            for dotted, value in values.items():
                _put(nested, dotted, value)
            ref.set(nested)

    def quita(self, db, kind: str, doc_id: str, dotted_paths: list) -> None:
        from google.cloud import firestore
        ref = self._ref(db, kind, doc_id)
        if dotted_paths and ref.get().exists:
            ref.update({p: firestore.DELETE_FIELD for p in dotted_paths})

    def borra(self, db, kind: str, doc_id: str) -> None:
        self._ref(db, kind, doc_id).delete()

    def numero_por_token_de_verificacion(self, db, token: str) -> str | None:
        if db is None:
            from core.db import get_db
            db = get_db()
        for snap in db.collection(COLLECTION).where("metaWebhookVerifyToken", "==", token).limit(5).stream():
            if snap.id.startswith("numbers__"):
                return snap.id.removeprefix("numbers__")
        return None


class AlmacenSecretsManager:
    """AWS Secrets Manager: un secreto por número o bot con el JSON plano `{ruta: valor}`.

    `cliente` es un cliente de boto3 (`secretsmanager`); las pruebas pasan uno falso.
    """

    def __init__(self, prefijo: str, cliente=None):
        self.prefijo = prefijo.strip("/")
        self._cliente = cliente

    @property
    def cliente(self):
        if self._cliente is None:
            import boto3   # import local: solo en AWS
            self._cliente = boto3.client("secretsmanager")
        return self._cliente

    def nombre(self, kind: str, doc_id: str) -> str:
        return f"{self.prefijo}/{kind}/{doc_id}"

    def _no_existe(self, e: Exception) -> bool:
        return getattr(e, "response", {}).get("Error", {}).get("Code") == "ResourceNotFoundException"

    def _lee_todo(self, kind, doc_id) -> dict | None:
        try:
            valor = self.cliente.get_secret_value(SecretId=self.nombre(kind, doc_id))
        except Exception as e:
            if self._no_existe(e):
                return None
            raise
        try:
            datos = json.loads(valor.get("SecretString") or "{}")
        except ValueError:
            log.error("credenciales: el secreto %s no es JSON", self.nombre(kind, doc_id))
            return {}
        return datos if isinstance(datos, dict) else {}

    def lee(self, db, kind: str, doc_id: str) -> dict:
        datos = self._lee_todo(kind, doc_id) or {}
        return {p: v for p in paths(kind) if isinstance(v := datos.get(p), str) and v}

    def _escribe(self, kind, doc_id, datos: dict, existe: bool) -> None:
        cuerpo = json.dumps(datos, ensure_ascii=False)
        if existe:
            self.cliente.put_secret_value(SecretId=self.nombre(kind, doc_id), SecretString=cuerpo)
        else:
            self.cliente.create_secret(Name=self.nombre(kind, doc_id), SecretString=cuerpo,
                                       Description=f"Credenciales del hub ({kind} {doc_id})")

    def guarda(self, db, kind: str, doc_id: str, values: dict) -> None:
        actual = self._lee_todo(kind, doc_id)
        self._escribe(kind, doc_id, {**(actual or {}), **values}, actual is not None)

    def quita(self, db, kind: str, doc_id: str, dotted_paths: list) -> None:
        actual = self._lee_todo(kind, doc_id)
        if actual is None or not any(p in actual for p in dotted_paths):
            return
        self._escribe(kind, doc_id, {k: v for k, v in actual.items() if k not in dotted_paths}, True)

    def borra(self, db, kind: str, doc_id: str) -> None:
        try:
            # Sin ventana de recuperación: si no, el mismo nombre no se puede volver a crear durante días
            self.cliente.delete_secret(SecretId=self.nombre(kind, doc_id), ForceDeleteWithoutRecovery=True)
        except Exception as e:
            if not self._no_existe(e):
                raise

    def numero_por_token_de_verificacion(self, db, token: str) -> str | None:
        # Secrets Manager no busca por valor. En AWS el webhook de Meta se verifica con un token por ambiente
        # (META_WEBHOOK_VERIFY_TOKEN; Meta configura un webhook por app, no por número): ver channels/webhooks.py.
        return None


def almacen():
    """Almacén según `SECRETOS_EN` (firestore por omisión, o aws con `SECRETOS_PREFIJO`)."""
    global _almacen
    if _almacen is None:
        donde = (os.environ.get("SECRETOS_EN") or "firestore").strip().lower()
        if donde == "aws":
            prefijo = (os.environ.get("SECRETOS_PREFIJO") or "").strip()
            if not prefijo:
                raise RuntimeError("SECRETOS_EN=aws requiere SECRETOS_PREFIJO (p. ej. hub/dev)")
            _almacen = AlmacenSecretsManager(prefijo)
        elif donde == "firestore":
            _almacen = AlmacenFirestore()
        else:
            raise RuntimeError(f"SECRETOS_EN desconocido: {donde!r} (firestore o aws)")
    return _almacen


def configure(nuevo) -> None:
    """Fija el almacén (las pruebas ponen uno falso; None vuelve a leer el entorno)."""
    global _almacen
    _almacen = nuevo
    _cache.clear()


# --------------------------------------------------------------------------- interfaz

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
    values = almacen().lee(db, kind, doc_id)
    _cache[key] = {"values": values, "expires": time.time() + TTL}
    return values


def reveal(db, kind: str, doc_id: str | None, data: dict) -> dict:
    """Copia de `data` con las credenciales puestas donde el código las espera."""
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
    """Guarda credenciales sin tocar las demás del mismo número o bot."""
    if not values:
        return
    almacen().guarda(db, kind, doc_id, values)
    _cache.pop(secret_id(kind, doc_id), None)


def clear(db, kind: str, doc_id: str, dotted_paths) -> None:
    """Borra las credenciales indicadas."""
    wanted = [p for p in dotted_paths if p in paths(kind)]
    if wanted:
        almacen().quita(db, kind, doc_id, wanted)
    _cache.pop(secret_id(kind, doc_id), None)


def delete(db, kind: str, doc_id: str) -> None:
    almacen().borra(db, kind, doc_id)
    _cache.pop(secret_id(kind, doc_id), None)


def mark_configured(db, kind: str, doc_id: str) -> list:
    """Actualiza `secretsSet` del documento de Firestore con las credenciales que hay ahora. Devuelve la lista.

    En hub_cleber el equivalente es la acción Hub.marcaSecretosConfigurados (la llama quien guarda el número o el bot).
    """
    configured = sorted(load(db, kind, doc_id, use_cache=False))
    db.collection(KINDS[kind][0]).document(doc_id).update({"secretsSet": configured})
    return configured


def find_number_by_verify_token(db, token: str) -> str | None:
    """ID del número de Meta cuyo token de verificación es `token` (el GET de verificación del webhook no trae el número)."""
    if not token:
        return None
    return almacen().numero_por_token_de_verificacion(db, token)


def migrate(db) -> dict:
    """Mueve las credenciales que todavía están en los documentos de números y bots al almacén. Idempotente.

    Si el almacén ya tiene un valor, ese gana y el del documento solo se descarta. Devuelve cuántos documentos cambió por tipo.
    """
    from google.cloud import firestore
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
