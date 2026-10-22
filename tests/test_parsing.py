from ai.parsing import clean_chatllm_text, detect, detect_action, extract_bot_response, find_tool_params_in_segments


def _collapsible(title, params_text):
    return {"title": title, "segment": {"segment": params_text}}


def _ok(result):
    return {"success": True, "result": result}


# ---- chatllm ----

def test_chatllm_toolresults_es_el_camino_primario():
    r = _ok({"toolResults": [{"toolName": "Crear_Lead", "input": {"nombre": "Ana"}}]})
    assert detect(r, "chatllm", "Crear_Lead") == {"triggered": True, "input": {"nombre": "Ana"}}


def test_chatllm_trampa_de_los_dos_segments_con_el_mismo_title():
    """Abacus emite primero un segment de texto sin params y luego el que sí los trae.
    Quedarse con el primero que hace match del title perdía el 100% de los params."""
    segments = [
        {"title": "Executing Crear_Cita_Ventas_Salesforce", "segment": {"segment": "Voy a agendar tu cita."}},
        _collapsible("Executing Crear_Cita_Ventas_Salesforce", '```python\nparams = {"fecha": "2026-10-20", "hora": "11:00"}\n```'),
    ]
    out = detect(_ok({"segments": segments}), "chatllm", "Crear_Cita_Ventas_Salesforce")
    assert out == {"triggered": True, "input": {"fecha": "2026-10-20", "hora": "11:00"}}


def test_chatllm_segments_con_params_anidados():
    seg = _collapsible("Executing Crear_Lead", 'params = {"datos": {"nombre": "Ana", "tel": "55"}, "origen": "web"}')
    out = find_tool_params_in_segments({"segments": [seg]}, "Crear_Lead")
    assert out == {"datos": {"nombre": "Ana", "tel": "55"}, "origen": "web"}


def test_chatllm_tool_sin_params_parseables_devuelve_vacio_pero_disparado():
    seg = {"title": "Executing Crear_Lead", "segment": {"segment": "sin params"}}
    assert detect(_ok({"segments": [seg]}), "chatllm", "Crear_Lead") == {"triggered": True, "input": {}}


def test_chatllm_otro_tool_no_dispara():
    seg = _collapsible("Executing Actualizar_Lead", 'params = {"a": 1}')
    assert detect(_ok({"segments": [seg]}), "chatllm", "Crear_Lead") == {"triggered": False}


# ---- workflow ----

def test_workflow_action_segment_en_texto_plano():
    r = _ok({"response": {"segments": [
        {"type": "text", "id": "reply", "segment": "Claro, te confirmo."},
        {"type": "text", "id": "action", "segment": " confirmar_cita "},
    ]}})
    assert detect(r, "workflow", "confirmar_cita") == {"triggered": True, "input": {}}
    assert detect_action(r, "workflow", {"confirmar_cita", "cancelar_cita"}) == "confirmar_cita"


def test_workflow_accion_fuera_del_vocabulario_se_ignora():
    r = _ok({"response": {"segments": [{"id": "action", "segment": "inventada"}]}})
    assert detect_action(r, "workflow", {"confirmar_cita"}) is None


def test_workflow_clasifica_motivo_por_tool():
    r = _ok({"toolResults": [{"toolName": "Clasificar_Motivo", "input": {"motivo": "interes_cita"}}]})
    assert detect_action(r, "workflow", {"interes_cita", "otro_motivo"}, tool_name="Clasificar_Motivo") == "interes_cita"


# ---- external ----

def test_external_actions_del_contrato():
    r = _ok({"response": "ok", "actions": [{"name": "oferta_aceptada", "params": {"vin": "X1"}}]})
    assert detect(r, "external", "oferta_aceptada") == {"triggered": True, "input": {"vin": "X1"}}
    assert detect_action(r, "external", {"oferta_aceptada"}) == "oferta_aceptada"


def test_vertex_ai_es_alias_de_external():
    r = _ok({"actions": [{"name": "x", "params": {}}]})
    assert detect(r, "vertex_ai", "x")["triggered"] is True


# ---- robustez y texto ----

def test_respuesta_con_error_o_sin_exito_no_dispara():
    assert detect({"error": "boom"}, "chatllm", "Crear_Lead") == {"triggered": False}
    assert detect({"success": False}, "chatllm", "Crear_Lead") == {"triggered": False}
    assert detect(_ok({}), "motor_raro", "Crear_Lead") == {"triggered": False}


def test_limpia_artefactos_de_chatllm():
    text = 'Executing Crear_Lead\n\n{"a": 1}\nHola, ¿en qué te ayudo?'
    assert clean_chatllm_text(text) == "Hola, ¿en qué te ayudo?"


def test_limpia_eco_de_tool_solo_si_queda_respuesta():
    tools = ("Crear_Lead",)
    assert clean_chatllm_text("Crear_Lead(nombre=Ana)\nListo, te contactarán.", tools) == "Listo, te contactarán."
    assert clean_chatllm_text("Crear_Lead(nombre=Ana)", tools) == "Crear_Lead(nombre=Ana)"


def test_extract_bot_response_formatos():
    assert extract_bot_response({"error": "x"}).startswith("Lo siento")
    assert extract_bot_response(_ok({"response": "Hola"})) == "Hola"
    wf = _ok({"response": {"segments": [{"type": "text", "id": "reply", "segment": "Hola"}, {"type": "text", "id": "action", "segment": "x"}]}})
    assert extract_bot_response(wf) == "Hola"
    chat = _ok({"messages": [{"is_user": True, "text": "hi"}, {"is_user": False, "text": "Buenas"}]})
    assert extract_bot_response(chat) == "Buenas"
