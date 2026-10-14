"""Firestore en memoria con la parte de la API que usa el núcleo (consultas, batch, subcolecciones)."""
import itertools
from datetime import datetime, timezone

from google.cloud import firestore

_ids = itertools.count(1)
_MIN = datetime.min.replace(tzinfo=timezone.utc)


def _key(v):
    return _MIN if v is None else v


class FakeSnapshot:
    def __init__(self, ref, data):
        self.reference, self.id, self._data = ref, ref.id, data
        self.exists = data is not None

    def to_dict(self):
        return dict(self._data) if self._data is not None else None


class FakeDoc:
    def __init__(self, db, path, id):
        self._db, self._path, self.id = db, path, id

    @property
    def _store(self):
        return self._db.data.setdefault(self._path, {})

    def get(self, transaction=None):
        return FakeSnapshot(self, self._store.get(self.id))

    def set(self, data, merge=False):
        if merge and self.id in self._store:
            self._store[self.id].update(data)
        else:
            self._store[self.id] = dict(data)

    def update(self, data):
        if self.id not in self._store:
            raise KeyError(f"{self._path}/{self.id} no existe")
        self._store[self.id].update(data)

    def collection(self, name):
        return FakeQuery(self._db, f"{self._path}/{self.id}/{name}")


class FakeQuery:
    def __init__(self, db, path, filters=(), order=None, lim=None):
        self._db, self._path, self._filters, self._order, self._lim = db, path, tuple(filters), order, lim

    def document(self, id=None):
        return FakeDoc(self._db, self._path, id or f"auto{next(_ids)}")

    def where(self, field, op, value):
        return FakeQuery(self._db, self._path, self._filters + ((field, op, value),), self._order, self._lim)

    def order_by(self, field, direction="ASCENDING"):
        return FakeQuery(self._db, self._path, self._filters, (field, direction), self._lim)

    def limit(self, n):
        return FakeQuery(self._db, self._path, self._filters, self._order, n)

    def _match(self, data):
        for field, op, value in self._filters:
            actual = data
            for part in field.split("."):
                actual = actual.get(part) if isinstance(actual, dict) else None
            if op == "==" and actual != value:
                return False
            if op == "in" and actual not in value:
                return False
        return True

    def stream(self):
        rows = [(i, d) for i, d in self._db.data.get(self._path, {}).items() if self._match(d)]
        if self._order:
            field, direction = self._order
            rows.sort(key=lambda r: _key(r[1].get(field)), reverse=direction == firestore.Query.DESCENDING)
        else:
            rows.sort(key=lambda r: r[0])
        if self._lim is not None:
            rows = rows[: self._lim]
        return iter(FakeSnapshot(FakeDoc(self._db, self._path, i), d) for i, d in rows)


class FakeBatch:
    def __init__(self):
        self._ops = []

    def set(self, ref, data):
        self._ops.append(lambda: ref.set(data))

    def update(self, ref, data):
        self._ops.append(lambda: ref.update(data))

    def commit(self):
        for op in self._ops:
            op()


class FakeDB:
    def __init__(self):
        self.data: dict[str, dict] = {}

    def collection(self, name):
        return FakeQuery(self, name)

    def batch(self):
        return FakeBatch()

    def seed(self, path: str, id: str, data: dict):
        self.data.setdefault(path, {})[id] = dict(data)
        return self
