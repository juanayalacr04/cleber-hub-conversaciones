"""Único lugar donde viven los clientes compartidos (regla de §7.4).

Ningún otro módulo debe crear su propio cliente de Firestore ni su propio executor.
"""
import os
from concurrent.futures import ThreadPoolExecutor

FIRESTORE_DATABASE = os.environ.get("FIRESTORE_DATABASE", "(default)")

_db = None
_executor = ThreadPoolExecutor(max_workers=int(os.environ.get("EXECUTOR_WORKERS", "8")))


def get_db():
    global _db
    if _db is None:
        from google.cloud import firestore
        _db = firestore.Client(database=FIRESTORE_DATABASE)
    return _db


def get_executor() -> ThreadPoolExecutor:
    return _executor


def run_transaction(fn, *args, db=None):
    """Ejecuta `fn(transaction, *args)` en una transacción de Firestore con reintentos.

    Los webhooks corren en instancias concurrentes: todo "leer y luego escribir" que no pueda
    repetirse (round robin, claims, idempotencia) debe pasar por aquí.
    """
    from google.cloud import firestore
    db = db or get_db()
    return firestore.transactional(fn)(db.transaction(), *args)
