import pytest

from core import tools


@pytest.fixture(autouse=True)
def _limpio():
    tools.clear()
    yield
    tools.clear()


def test_mismo_tool_distinta_vertical():
    llamadas = []
    tools.tool("cita_agendada", vertical="ventas")(lambda c, p: llamadas.append("ventas"))
    tools.tool("cita_agendada", vertical="servicio")(lambda c, p: llamadas.append("servicio"))
    tools.dispatch("cita_agendada", {"vertical": "ventas"}, {})
    tools.dispatch("cita_agendada", {"vertical": "servicio"}, {})
    assert llamadas == ["ventas", "servicio"]


def test_default_cuando_no_hay_handler_de_vertical():
    llamadas = []
    tools.tool("guardar_nombre")(lambda c, p: llamadas.append("default"))
    assert tools.dispatch("guardar_nombre", {"vertical": "servicio"}, {})
    assert llamadas == ["default"]


def test_sin_handler_es_noop():
    assert tools.dispatch("desconocido", {"vertical": "ventas"}, {}) is False


def test_handler_duplicado_falla():
    tools.tool("x", vertical="ventas")(lambda c, p: None)
    with pytest.raises(ValueError):
        tools.tool("x", vertical="ventas")(lambda c, p: None)
