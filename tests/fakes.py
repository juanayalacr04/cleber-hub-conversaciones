"""Firestore en memoria con la parte de la API que usa el núcleo (consultas, grupos, batch, transacciones, subcolecciones)."""
import itertools
from datetime import datetime, timezone

from google.cloud import firestore

_ids = itertools.count(1)
_MIN = datetime.min.replace(tzinfo=timezone.utc)


def _key(v):
    return _MIN if v is None else v


def _apply(doc: dict, updates: dict) -> None:
    for k, v in updates.items():
        if "." in k:  # ruta con puntos de update(): escribe dentro del mapa anidado
            head, _, rest = k.partition(".")
            if not isinstance(doc.get(head), dict):
                doc[head] = {}
            _apply(doc[head], {rest: v})
            continue
        if v is firestore.DELETE_FIELD:
            doc.pop(k, None)
        elif isinstance(v, firestore.Increment):
            doc[k] = doc.get(k, 0) + v.value
        elif isinstance(v, firestore.ArrayUnion):
            doc[k] = list(doc.get(k) or []) + list(v.values)
        elif isinstance(v, firestore.ArrayRemove):
            doc[k] = [x for x in (doc.get(k) or []) if x not in v.values]
        elif v is firestore.SERVER_TIMESTAMP:
            doc[k] = datetime.now(timezone.utc)
        else:
            doc[k] = v


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

    @property
    def parent(self):
        return FakeQuery(self._db, self._path)

    def get(self, transaction=None):
        return FakeSnapshot(self, self._store.get(self.id))

    def set(self, data, merge=False):
        if not (merge and self.id in self._store):
            self._store[self.id] = {}
        _apply(self._store[self.id], data)

    def update(self, data):
        if self.id not in self._store:
            raise KeyError(f"{self._path}/{self.id} no existe")
        _apply(self._store[self.id], data)

    def delete(self):
        self._store.pop(self.id, None)

    def collection(self, name):
        return FakeQuery(self._db, f"{self._path}/{self.id}/{name}")


class FakeQuery:
    def __init__(self, db, path, filters=(), order=None, lim=None, group=False):
        self._db, self._path, self._filters, self._order, self._lim, self._group = db, path, tuple(filters), order, lim, group

    def _derive(self, **kw):
        args = dict(filters=self._filters, order=self._order, lim=self._lim, group=self._group)
        args.update(kw)
        return FakeQuery(self._db, self._path, **args)

    @property
    def parent(self):
        """Documento padre de una subcolección (None para una colección de primer nivel)."""
        parts = self._path.split("/")
        return FakeDoc(self._db, "/".join(parts[:-2]), parts[-2]) if len(parts) > 1 else None

    def document(self, id=None):
        return FakeDoc(self._db, self._path, id or f"auto{next(_ids)}")

    def where(self, field, op, value):
        return self._derive(filters=self._filters + ((field, op, value),))

    def order_by(self, field, direction="ASCENDING"):
        return self._derive(order=(field, direction))

    def limit(self, n):
        return self._derive(lim=n)

    def _match(self, data):
        for field, op, value in self._filters:
            actual = data
            for part in field.split("."):
                actual = actual.get(part) if isinstance(actual, dict) else None
            if op == "==" and actual != value:
                return False
            if op == "in" and actual not in value:
                return False
            if op == "array_contains" and value not in (actual or []):
                return False
        return True

    def _paths(self):
        if self._group:
            return [p for p in self._db.data if p == self._path or p.endswith("/" + self._path)]
        return [self._path]

    def stream(self):
        rows = [(p, i, d) for p in self._paths() for i, d in self._db.data.get(p, {}).items() if self._match(d)]
        if self._order:
            field, direction = self._order
            rows.sort(key=lambda r: _key(r[2].get(field)), reverse=direction == firestore.Query.DESCENDING)
        else:
            rows.sort(key=lambda r: (r[0], r[1]))
        if self._lim is not None:
            rows = rows[: self._lim]
        return iter(FakeSnapshot(FakeDoc(self._db, p, i), d) for p, i, d in rows)


class FakeBatch:
    def __init__(self):
        self._ops = []

    def set(self, ref, data):
        self._ops.append(lambda: ref.set(data))

    def update(self, ref, data):
        self._ops.append(lambda: ref.update(data))

    def delete(self, ref):
        self._ops.append(ref.delete)

    def commit(self):
        for op in self._ops:
            op()


class FakeTransaction:
    """Sin concurrencia real: las escrituras se aplican al instante (suficiente para probar la lógica)."""

    def update(self, ref, data):
        ref.update(data)

    def set(self, ref, data):
        ref.set(data)


class FakeDB:
    def __init__(self):
        self.data: dict[str, dict] = {}

    def collection(self, name):
        return FakeQuery(self, name)

    def collection_group(self, name):
        return FakeQuery(self, name, group=True)

    def batch(self):
        return FakeBatch()

    def transaction(self):
        return FakeTransaction()

    def seed(self, path: str, id: str, data: dict):
        self.data.setdefault(path, {})[id] = dict(data)
        return self
