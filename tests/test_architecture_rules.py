"""Reglas de import de §7.4, verificadas automáticamente."""
import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP = {".git", ".venv", "node_modules", "tests", "dev", "__pycache__"}


def _py_files(base: Path):
    for p in base.rglob("*.py"):
        if not SKIP & set(p.relative_to(ROOT).parts):
            yield p


def _imports(path: Path):
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            for a in node.names:
                yield a.name
        elif isinstance(node, ast.ImportFrom) and node.module:
            yield node.module


def test_core_no_importa_de_modules():
    for f in _py_files(ROOT / "core"):
        malos = [m for m in _imports(f) if m.split(".")[0] == "modules"]
        assert not malos, f"{f.name} importa de modules: {malos}"


def test_core_sin_if_vertical():
    for f in _py_files(ROOT / "core"):
        for node in ast.walk(ast.parse(f.read_text(encoding="utf-8"))):
            if isinstance(node, ast.If):
                src = ast.unparse(node.test)
                assert "vertical ==" not in src and "vertical in" not in src, f"{f.name}: if {src}"


def test_ningun_archivo_se_llama_twilio():
    assert not [p for p in _py_files(ROOT) if p.stem == "twilio"]


def test_clientes_globales_solo_en_core_db():
    for f in _py_files(ROOT):
        if f == ROOT / "core" / "db.py":
            continue
        txt = f.read_text(encoding="utf-8")
        assert "firestore.Client(" not in txt, f"{f.name} crea su propio cliente de Firestore"
        assert "ThreadPoolExecutor(" not in txt, f"{f.name} crea su propio executor"
