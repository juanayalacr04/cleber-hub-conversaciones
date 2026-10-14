import pytest
from google.cloud import firestore


@pytest.fixture(autouse=True)
def _transacciones_sin_cliente_real(monkeypatch):
    """`firestore.transactional` exige un cliente real; con FakeDB la función corre tal cual."""
    monkeypatch.setattr(firestore, "transactional", lambda fn: fn)


@pytest.fixture(autouse=True)
def _caches_limpias():
    from core import broadcasts
    broadcasts.clear_instructions_cache()
    yield
    broadcasts.clear_instructions_cache()


@pytest.fixture(autouse=True)
def _sin_firestore_real(monkeypatch):
    """Ninguna prueba puede abrir un cliente real de Firestore: usaría las credenciales de la máquina."""
    def prohibido(*args, **kwargs):
        raise RuntimeError("la prueba intentó usar Firestore real: pasa db=FakeDB() a la función")
    monkeypatch.setattr(firestore, "Client", prohibido)
