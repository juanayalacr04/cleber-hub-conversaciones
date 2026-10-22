"""Mueve a `secrets` las credenciales que todavía están en los documentos de números y bots (tarea 1.41).

    python dev/migrate_secrets.py --project ambiente-desarrollo-ti --database dev-hub-conversaciones [--dry-run]

Hay que dar el proyecto y la base explícitos y además tenerlos en el entorno (`GOOGLE_CLOUD_PROJECT` y `FIRESTORE_DATABASE`): si no
coinciden, no hace nada. Es idempotente y no pisa lo que ya esté en `secrets`.
"""
import argparse
import os
import sys
from pathlib import Path


def check_target(project: str, database: str, env) -> None:
    problems = []
    if env.get("GOOGLE_CLOUD_PROJECT") != project:
        problems.append(f"GOOGLE_CLOUD_PROJECT debe ser {project!r} (es {env.get('GOOGLE_CLOUD_PROJECT')!r})")
    if env.get("FIRESTORE_DATABASE") != database:
        problems.append(f"FIRESTORE_DATABASE debe ser {database!r} (es {env.get('FIRESTORE_DATABASE')!r})")
    if problems:
        raise SystemExit("No se migra nada:\n  - " + "\n  - ".join(problems))


def pending(db) -> dict:
    """Cuántos documentos de cada tipo todavía traen credenciales, sin tocar nada."""
    from core import credentials
    counts = {}
    for kind, (collection, _) in credentials.KINDS.items():
        counts[kind] = sum(1 for snap in db.collection(collection).stream() if credentials.split(kind, snap.to_dict() or {})[1])
    return counts


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--project", required=True)
    parser.add_argument("--database", required=True)
    parser.add_argument("--dry-run", action="store_true", help="solo cuenta cuántos documentos migraría")
    args = parser.parse_args(argv)
    check_target(args.project, args.database, os.environ)

    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from core import credentials
    from core.db import get_db   # después de verificar el entorno: lee FIRESTORE_DATABASE al importarse

    db = get_db()
    if args.dry_run:
        print("Documentos con credenciales por migrar:", pending(db))
        return 0
    print("Documentos migrados:", credentials.migrate(db))
    return 0


if __name__ == "__main__":
    sys.exit(main())
