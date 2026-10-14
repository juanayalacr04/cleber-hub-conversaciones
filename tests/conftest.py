import pytest
from google.cloud import firestore


@pytest.fixture(autouse=True)
def _transacciones_sin_cliente_real(monkeypatch):
    """`firestore.transactional` exige un cliente real; con FakeDB la función corre tal cual."""
    monkeypatch.setattr(firestore, "transactional", lambda fn: fn)
