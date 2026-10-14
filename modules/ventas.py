"""Reglas de negocio de la vertical Ventas: Lead, cita, escalamiento y opt-out sobre Salesforce.

Son handlers del registro de `core.tools` (§4): el núcleo detecta y despacha, este módulo ejecuta.
La mecánica compartida (token, REST, Flow, comentario anexado) vive en `crm/`; aquí solo está lo
que es regla de Ventas. Todo handler se auto-excluye si el bot no trae `salesforceConfig`: un bot
de Twilio sin Salesforce no crea Leads ni exige uno para escalar.

Lo que antes estaba hardcodeado y ahora es configuración de `organizations/{id}.salesforceConfig`
(los valores por omisión son los de producción actual):
  rrFlowName                nombre del Flow de round robin            (RRAgenteIACLEBER)
  marcaRR, ownerId, bdcFallbackOwnerId, vehicleType, leadCreationEnabled
  seminuevoOwnerId          owner del Lead de Seminuevos
  seminuevoRecordTypeId     RecordType del Lead de Seminuevos
  situationMap              {situacion: {status, validacion, razon}} para descartar el Lead
"""
import logging
import time
from datetime import datetime, timedelta, timezone

from google.cloud import firestore

from ai import engine
from ai.parsing import detect_handoff, extract_bot_response
from core import handoff as ho, outcomes
from core.claims import claim, release_claim
from core.conversations import add_message
from core.db import get_db
from core.scheduled_contact import local_to_utc, org_timezone
from core.tools import tool
from crm import salesforce

log = logging.getLogger(__name__)
V = "ventas"

DEFAULT_RR_FLOW = "RRAgenteIACLEBER"
DEFAULT_SEMINUEVO_OWNER_ID = "005Vz000003s7stIAA"       # fallback si la ruta "seminuevo" no define owner
DEFAULT_SEMINUEVO_RECORD_TYPE_ID = "0123k000001MUFuAAO"  # RecordType Seminuevos
SALESFORCE_DT = "%Y-%m-%dT%H:%M:%S+0000"

# Descarte del Lead por situación (GCL_RazonNoCompra__c, Status, Validacion_Prospecto__c)
DEFAULT_SITUATION_MAP = {
    "servicio_postventa": {"razon": "Servicio"},
    "seminuevo": {"razon": "Seminuevo"},
    "fuera_de_alcance": {"razon": "No Lead", "status": "Descartado"},
    # El cliente pidió no ser contactado: no "no compró", así que no se escribe razón de no compra
    "finalizado_por_cliente": {"razon": None, "validacion": "Finalizado por cliente"},
}

CITA_INPUT_INVALIDO_MESSAGE = (
    "Disculpa, tuve un problema al registrar la fecha y hora de tu cita. "
    "¿Me confirmas de nuevo qué día y a qué hora te gustaría visitarnos?"
)
HANDOFF_NO_LEAD_CONTEXT = (
    "<<CONTEXTO>> El cliente solicitó un asesor pero no existe lead registrado. "
    "Para poder transferirlo DEBES crear el lead primero. Pasos obligatorios: "
    "1) Pídele únicamente su nombre completo (ya tienes su teléfono). "
    "2) En cuanto te dé el nombre, usa el tool Crear_Lead con nombre y teléfono del cliente. "
    '3) Cuando el sistema confirme "Lead creado exitosamente", usa inmediatamente el tool '
    "Transferir_a_Asesor para escalarlo con el asesor. "
    "No le digas que lo estás transfiriendo hasta que el lead esté creado."
)


# --------------------------------------------------------------------------- reglas puras

def lead_input_has_completion_data(tool_input: dict) -> bool:
    """El tool de Lead trae modelo o agencia: el Lead ya está "completo"."""
    return bool(tool_input.get("familia_modelo") or tool_input.get("concesionaria"))


def parse_appointment_datetime(tool_input: dict, timezone_name: str = "America/Mexico_City") -> datetime | None:
    """Fecha (YYYY-MM-DD) y hora (HH:MM) del tool de cita -> datetime UTC, o None si falta o no parsea.

    Antes se caía a valores por defecto (hoy, 09:00), lo que creaba citas con fecha inventada
    cuando el tool llegaba sin parámetros.
    """
    fecha, hora = (tool_input.get("fecha") or "").strip(), (tool_input.get("hora") or "").strip()
    if not fecha or not hora:
        return None
    try:
        return local_to_utc(datetime.fromisoformat(f"{fecha}T{hora}:00"), timezone_name)
    except ValueError:
        return None


def phone_10(raw_phone: str) -> str:
    """Últimos 10 dígitos de un teléfono ('whatsapp:+52XXXXXXXXXX')."""
    return "".join(c for c in raw_phone if c.isdigit())[-10:]


def build_lead_record(sf_config: dict, conv_data: dict, tool_input: dict, sf_brand_code: str, seminuevo: bool = False) -> dict:
    """Arma el registro del Lead a partir de la conversación y del tool.

    `seminuevo=True` es el flujo del menú de bienvenida (situación "seminuevo", detectada antes de
    que exista cualquier Lead): asignación directa al equipo de Seminuevos en vez de reglas.
    """
    first = (tool_input.get("nombre") or "").strip()
    last = (tool_input.get("apellido") or "").strip()
    if not last:  # el tool no mandó apellido: se parte el nombre del cliente
        parts = (conv_data.get("customerName") or "").strip().split(" ", 1)
        parts = [p for p in parts if p]
        first = first or (parts[0] if parts else "")
        last = parts[1] if len(parts) >= 2 else (first or "Sin Nombre")
        if len(parts) == 1:
            first = ""

    phone = phone_10(conv_data.get("customerPhone", ""))
    concesionaria = tool_input.get("concesionaria", "")
    modelo = tool_input.get("familia_modelo", "")
    # Solo se llena "Modelo"; el resto de la plantilla lo completa un asesor. En el flujo de
    # seminuevo el "motivo" trae lo que el bot ya recopiló y va directo en "Comentarios".
    comentarios = (tool_input.get("motivo") or "").strip() if seminuevo else ""
    description = (f"Modelo:{modelo}\nMedio contacto preferido:\nHorario contacto:\nFecha estimada compra:\n\nComentarios:{comentarios}")

    record = {
        "FirstName": first, "LastName": last, "Celular__c": phone, "Phone": phone,
        "Status": "Contactado", "GCL_Marca__c": sf_brand_code, "GCL_Concesionaria__c": concesionaria,
        "LeadSource": "IA CLEBER", "GCL_ComentarioLanding__c": description,
        "Validacion_Prospecto__c": "Con respuesta", "ReglasAsignacion__c": not seminuevo,
    }
    seminuevo_record_type = sf_config.get("seminuevoRecordTypeId") or DEFAULT_SEMINUEVO_RECORD_TYPE_ID
    if seminuevo:
        owner = sf_config.get("seminuevoOwnerId") or DEFAULT_SEMINUEVO_OWNER_ID
        record.update({
            "Fecha_Deal__c": None, "OwnerId": owner, "GCL_ResponsableBDC__c": owner, "GCL_TipoAuto__c": "Seminuevo",
            "RecordTypeId": seminuevo_record_type, "Validacion_Prospecto__c": "Llamada urgente",
        })
        return record

    if lead_input_has_completion_data(tool_input):
        record["Fecha_Deal__c"] = datetime.now(timezone.utc).strftime(SALESFORCE_DT)
    else:  # Lead incompleto (solo nombre): contactado pero sin validar y sin fecha de deal
        record["Validacion_Prospecto__c"] = "Sin validar"
        record["Fecha_Deal__c"] = None
    record["Familia_de_modelo__c"] = modelo
    if sf_config.get("ownerId"):
        record["OwnerId"] = sf_config["ownerId"]
    if sf_config.get("vehicleType") == "seminuevo":
        record.update({"GCL_TipoAuto__c": "Seminuevo", "RecordTypeId": seminuevo_record_type,
                       "ReglasAsignacion__c": False})  # TEMPORAL en pruebas: el Owner se queda en ownerId
    return record


# --------------------------------------------------------------------------- operaciones en Salesforce

def create_salesforce_lead(sf_config: dict, conv_data: dict, tool_input: dict, sf_brand_code: str, seminuevo: bool = False) -> str | None:
    """Crea el Lead y devuelve su Id. Con `leadCreationEnabled: false` simula (Id QA-SIMULATED-...)."""
    record = build_lead_record(sf_config, conv_data, tool_input, sf_brand_code, seminuevo)
    if not sf_config.get("leadCreationEnabled", True):
        simulated = f"QA-SIMULATED-{int(time.time() * 1000)}"
        log.info("crear_lead_simulated lead_id=%s seminuevo=%s", simulated, seminuevo)
        return simulated
    lead_id = salesforce.create_lead(sf_config, record)
    log.info("crear_lead %s lead_id=%s seminuevo=%s", "ok" if lead_id else "error", lead_id, seminuevo)
    return lead_id


_UPDATE_FIELDS = {
    "status_raw": "Status",  # valor directo, sin traducir
    "familia_modelo": "Familia_de_modelo__c",
    "concesionaria": "GCL_Concesionaria__c",
    "validacion_prospecto": "Validacion_Prospecto__c",
    "fecha_deal": "Fecha_Deal__c",
}


def update_salesforce_lead(sf_config: dict, lead_id: str, tool_input: dict, timezone_name: str = "America/Mexico_City") -> bool:
    """Actualiza campos de un Lead existente. Con `leadCreationEnabled: false` no escribe."""
    if not sf_config.get("leadCreationEnabled", True):
        log.info("actualizar_lead_simulated lead_id=%s", lead_id)
        return True

    def value(key):
        raw = tool_input.get(key)
        return raw.strip() if isinstance(raw, str) and raw.strip() else None

    patch = {}
    for key, field in _UPDATE_FIELDS.items():
        if key == "familia_modelo" and sf_config.get("vehicleType") == "seminuevo":
            continue  # el RecordType Seminuevo no acepta Familia_de_modelo__c en el layout
        if value(key):
            patch[field] = value(key)
    if value("status"):
        patch["Status"] = "Asignado"  # el bot manda "En Proceso"; Salesforce exige "Asignado"
    if value("nombre"):
        first, _, rest = value("nombre").partition(" ")
        patch["FirstName"], patch["LastName"] = first, rest or first
    if value("comentarios"):
        ok, current = salesforce.get_lead_field(sf_config, lead_id, "GCL_ComentarioLanding__c")
        if ok:  # si no se pudo leer, escribir borraría el historial: se omite el campo
            patch["GCL_ComentarioLanding__c"] = salesforce.build_appended_comment(current, value("comentarios"), timezone_name)
        else:
            log.warning("actualizar_lead_comentario_skipped lead_id=%s reason=read_failed", lead_id)

    if not patch:
        log.info("actualizar_lead_no_fields lead_id=%s", lead_id)
        return False
    return salesforce.patch_lead(sf_config, lead_id, patch)


def find_existing_appointment(sf_config: dict, lead_id: str) -> str | None:
    """Cita más reciente del Lead, para reagendarla con PATCH (None si no hay o la consulta falla)."""
    records = salesforce.query(
        sf_config,
        f"SELECT Id FROM Event WHERE WhoId='{salesforce.soql_quote(lead_id)}' AND Subject LIKE 'Cita presencial%' ORDER BY CreatedDate DESC LIMIT 1",
    )
    return records[0]["Id"] if records else None


def create_salesforce_appointment(sf_config: dict, lead_id: str, tool_input: dict, conv_data: dict, timezone_name: str = "America/Mexico_City") -> bool:
    """Crea (o reagenda) el Event de la cita y deja el Lead en Status=Cita.

    Salesforce no permite borrar Events (un Flow lo impide), así que una cita previa se reagenda
    con PATCH en vez de borrarla o crear una segunda.
    """
    start = parse_appointment_datetime(tool_input, timezone_name)
    if start is None:
        log.warning("crear_cita_input_invalido lead_id=%s fecha=%r hora=%r", lead_id, tool_input.get("fecha"), tool_input.get("hora"))
        return False

    name = (conv_data.get("customerName") or "").strip()
    concesionaria = tool_input.get("concesionaria", "")
    start_iso, end_iso = start.strftime(SALESFORCE_DT), (start + timedelta(hours=1)).strftime(SALESFORCE_DT)
    event = {
        "Subject": f"Cita presencial - {name}".strip(" -"), "Location": concesionaria,
        "ActivityDateTime": start_iso, "StartDateTime": start_iso, "EndDateTime": end_iso,
        "WhoId": lead_id, "Description": f"Cita de Ventas en {concesionaria} - {name}".strip(" -"), "Type": "Cita presencial",
    }

    existing = find_existing_appointment(sf_config, lead_id)
    if existing:
        ok, _ = salesforce.call(sf_config, "PATCH", salesforce.sobject_path("Event", existing), {k: v for k, v in event.items() if k != "WhoId"})
    else:
        ok, _ = salesforce.call(sf_config, "POST", salesforce.sobject_path("Event"), event)
    if not ok:
        return False
    salesforce.patch_lead(sf_config, lead_id, {"Status": "Cita", "Validacion_Prospecto__c": "Finalizado con cita"})
    return True


def patch_lead_owner_id(sf_config: dict, lead_id: str, owner_id: str, validacion_prospecto: str | None = "Llamada urgente") -> bool:
    fields = {"OwnerId": owner_id}
    if validacion_prospecto is not None:
        fields["Validacion_Prospecto__c"] = validacion_prospecto
    return salesforce.patch_lead(sf_config, lead_id, fields)


def call_rr_agente_flow(sf_config: dict, lead_id: str, marca_rr: str) -> bool:
    """Invoca el Flow de round robin de Salesforce para reasignar el owner del Lead."""
    flow = sf_config.get("rrFlowName") or DEFAULT_RR_FLOW
    ok = salesforce.call_flow(sf_config, flow, [{"leadId": lead_id, "marcaRR": marca_rr}])
    log.info("rr_flow %s flow=%s lead_id=%s marca_rr=%s", "ok" if ok else "fallo", flow, lead_id, marca_rr)
    return ok


def assign_by_schedule(bot: dict, sf_config: dict, lead_id: str, conv_id: str = "") -> None:
    """Asigna asesor respetando el horario: Flow de round robin dentro de horario, owner de BDC fuera.

    No toca Validacion_Prospecto__c (ya la fijó el llamador).
    """
    marca_rr = sf_config.get("marcaRR", "")
    if not marca_rr:
        return
    if ho.check_business_hours(bot.get("scheduleConfig")):
        call_rr_agente_flow(sf_config, lead_id, marca_rr)
    elif sf_config.get("bdcFallbackOwnerId"):
        patch_lead_owner_id(sf_config, lead_id, sf_config["bdcFallbackOwnerId"], validacion_prospecto=None)
    else:
        log.info("rr_bdc_fallback_skipped_no_owner conv_id=%s lead_id=%s", conv_id, lead_id)


def patch_lead_situacion(sf_config: dict, lead_id: str, situacion: str) -> bool:
    """Descarta el Lead por transferencia o descarte según la situación (Cerrado/Perdido o Descartado)."""
    rule = {**DEFAULT_SITUATION_MAP.get(situacion, {"razon": situacion}), **(sf_config.get("situationMap") or {}).get(situacion, {})}
    fields = {"Status": rule.get("status", "Cerrado/Perdido"), "Validacion_Prospecto__c": rule.get("validacion", "Sin validar"), "Fecha_Deal__c": None}
    if rule.get("razon") is not None:
        fields["GCL_RazonNoCompra__c"] = rule["razon"]
    return salesforce.patch_lead(sf_config, lead_id, fields)


def update_lead_on_stop(sf_config: dict, lead_id: str) -> bool:
    """Opt-out: Validacion 'Finalizado por cliente', Status 'Nuevo' y sin Fecha_Deal."""
    return salesforce.patch_lead(sf_config, lead_id, {"Validacion_Prospecto__c": "Finalizado por cliente", "Status": "Nuevo", "Fecha_Deal__c": None})


def reset_lead_sin_respuesta(sf_config: dict, lead_id: str) -> bool:
    """Cierre por inactividad sin que el cliente respondiera nunca (mismo patrón que el opt-out)."""
    return salesforce.patch_lead(sf_config, lead_id, {"Validacion_Prospecto__c": "Sin validar", "Status": "Nuevo", "Fecha_Deal__c": None})


def update_lead_on_handoff(sf_config: dict, lead_id: str) -> None:
    """Al escalar: Lead 'Contactado' con llamada urgente y Flow de round robin."""
    update_salesforce_lead(sf_config, lead_id, {"validacion_prospecto": "Llamada urgente", "status_raw": "Contactado"})
    if sf_config.get("marcaRR"):
        call_rr_agente_flow(sf_config, lead_id, sf_config["marcaRR"])


def handoff_lead_seminuevo(bot: dict, conv_data: dict, conv_id: str, route: dict, tool_input: dict | None = None, db=None) -> bool:
    """Destino "lead": saca la conversación del bot para seguirla desde Salesforce.

    - Inbound (menú de bienvenida): todavía no hay Lead (el cliente elige antes de que el bot de
      autos nuevos cree uno), así que se crea el Lead de Seminuevos asignado al owner de la ruta.
    - Outbound: el cliente ya llegó con un Lead de autos nuevos (lead_webhook): se deja intacto y
      solo se deriva al round robin de Salesforce.
    """
    db = db or get_db()
    sf_config = bot.get("salesforceConfig") or {}
    if not conv_data.get("leadId"):
        # Guard atómico contra Firestore, no contra el snapshot: dos mensajes seguidos corren en paralelo
        claimed, concurrent_lead_id = claim(conv_id, "leadId", "leadCreationClaimedAt", db=db)
        if not claimed:
            conv_data["leadId"] = concurrent_lead_id
        else:
            # El owner sale de la ruta (pestaña Situaciones del bot): es la única fuente, vacío -> el por defecto
            cfg = {**sf_config, "seminuevoOwnerId": (route.get("seminuevoOwnerId") or "").strip()}
            org = db.collection("organizations").document(conv_data.get("organizationId", "")).get()
            brand = (org.to_dict().get("sfBrandCode") or "") if org.exists else ""
            lead_id = create_salesforce_lead(cfg, conv_data, tool_input or {}, brand, seminuevo=True)
            if lead_id:
                conv_data["leadId"] = lead_id
                # Se resetea lastCustomerMessageAt (patrón de lead_webhook): el mensaje con que eligió
                # "seminuevo" ya lo dejó seteado, y sin el reset su respuesta real al asesor de BDC no
                # cuenta como "primera respuesta" y Fecha_Deal__c nunca se llena.
                conv_data["lastCustomerMessageAt"] = None
                db.collection("conversations").document(conv_id).update({"leadId": lead_id, "lastCustomerMessageAt": firestore.DELETE_FIELD})
                add_message(conv_id, "bot", f'<<CONTEXTO>> LeadID: "{lead_id}" | Lead creado exitosamente', db=db)
            else:
                release_claim(conv_id, "leadCreationClaimedAt", db=db)
                add_message(conv_id, "bot", "<<CONTEXTO>> No se pudo crear el Lead en Salesforce", db=db)
    elif sf_config.get("marcaRR"):
        assign_by_schedule(bot, sf_config, conv_data["leadId"], conv_id)
    else:
        log.info("seminuevo_rr_skipped_sin_marca conv_id=%s", conv_id)

    # Se saca la conversación del bot como un handoff con assignmentMode "salesforce", sin asignar agente
    db.collection("conversations").document(conv_id).update({
        "status": "with_agent", "assignedAgentId": None, "assignedAt": firestore.SERVER_TIMESTAMP,
        "waitingStartedAt": firestore.SERVER_TIMESTAMP, "situationHandoffSentAt": firestore.SERVER_TIMESTAMP,
    })
    return True


def respond_handoff_no_lead(turn) -> None:
    """Handoff pedido sin Lead: NO escala de entrada.

    Re-invoca al bot con un <<CONTEXTO>> (etiqueta que ya entiende) para que pida los datos y cree
    el Lead. El bot puede resolver Crear_Lead y Transferir_a_Asesor en este mismo turno, así que
    se vuelve a revisar handoff y horario sobre esa respuesta; si no, se escaparía el gate de
    horario y la conversación nunca pasaría a waiting_agent.
    """
    add_message(turn.conv_id, "system", HANDOFF_NO_LEAD_CONTEXT, db=turn.db)
    result = engine.send_to_bot(turn.bot, turn.messages + [{"is_user": True, "text": HANDOFF_NO_LEAD_CONTEXT}],
                                conv_id=turn.conv_id, customer_phone=turn.customer)
    handoff = detect_handoff(result, turn.bot.get("type", "chatllm"))
    if handoff["triggered"]:
        schedule = turn.bot.get("scheduleConfig", {}) or {}
        if not ho.check_business_hours(schedule):
            ho.block_handoff_out_of_hours(turn.conv_id, turn.conv_data, turn.bot, turn.customer, turn.incoming.to_number,
                                          schedule, "sin lead", send=turn.send_plain, db=turn.db)
            return
        turn.say(extract_bot_response(result))
        ho.apply_handoff_status(turn.conv_id, turn.conv_data.get("teamId"), turn.org_id, handoff_reason=handoff["motivo"], db=turn.db)
        turn.db.collection("conversations").document(turn.conv_id).update({"handoffReason": handoff["motivo"]})
        return
    turn.say(extract_bot_response(result))


# --------------------------------------------------------------------------- handlers

def _sf(params: dict) -> dict:
    """Config de Salesforce del bot; vacía si el bot no usa Salesforce (el handler se auto-excluye)."""
    return (params.get("bot") or {}).get("salesforceConfig") or {}


def _brand_code(db, org_id: str) -> str:
    org = db.collection("organizations").document(org_id or "").get()
    return (org.to_dict().get("sfBrandCode") or "") if org.exists else ""


@tool("crear_lead", vertical=V)
def _crear_lead(conv: dict, p: dict) -> None:
    """Tool Crear_Lead. Va antes del handoff: si el bot lo pide en el mismo turno, el Lead debe existir."""
    turn, sf = p["turn"], _sf(p)
    if not sf or conv.get("leadId"):
        return
    turn.flags["lead_attempted"] = True
    claimed, concurrent = claim(turn.conv_id, "leadId", "leadCreationClaimedAt", db=turn.db)
    if not claimed:
        conv["leadId"] = concurrent  # otra invocación ya creó (o está creando) el Lead: se sigue con ese
        return
    lead_id = create_salesforce_lead(sf, conv, p["input"], _brand_code(turn.db, conv.get("organizationId") or turn.org_id))
    if lead_id:
        conv["leadId"] = lead_id
        fields = {"leadId": lead_id}
        if lead_input_has_completion_data(p["input"]):
            fields["completedLead"] = True
        turn.db.collection("conversations").document(turn.conv_id).update(fields)
        add_message(turn.conv_id, "bot", f'<<CONTEXTO>> LeadID: "{lead_id}" | Lead creado exitosamente', db=turn.db)
    else:
        release_claim(turn.conv_id, "leadCreationClaimedAt", db=turn.db)
        add_message(turn.conv_id, "bot", "<<CONTEXTO>> No se pudo crear el Lead en Salesforce", db=turn.db)


@tool("actualizar_lead", vertical=V)
def _actualizar_lead(conv: dict, p: dict) -> None:
    turn, sf = p["turn"], _sf(p)
    if sf and conv.get("leadId"):
        # Se espera este future (el turno espera todos al final): la instancia podría congelar el CPU
        # antes de que el PATCH termine y dejar campos sin actualizar.
        turn.fire(update_salesforce_lead, sf, conv["leadId"], p["input"], org_timezone(turn.org_id, turn.db))
    else:
        log.info("actualizar_lead_skipped conv_id=%s reason=sin leadId o sin Salesforce", turn.conv_id)
    if lead_input_has_completion_data(p["input"]):
        turn.fire(turn.db.collection("conversations").document(turn.conv_id).update, {"completedLead": True})


@tool("crear_cita", vertical=V)
def _crear_cita(conv: dict, p: dict) -> None:
    turn, sf = p["turn"], _sf(p)
    tz = org_timezone(turn.org_id, turn.db)
    if parse_appointment_datetime(p["input"], tz) is None:
        # Sin fecha/hora usables no se agenda nada, y se reemplaza la confirmación del bot (que sería
        # falsa) por una petición de repetir los datos: una cita con fecha inventada es peor que ninguna.
        turn.response = CITA_INPUT_INVALIDO_MESSAGE
        return
    turn.fire(turn.db.collection("conversations").document(turn.conv_id).update,
              {"appointmentStatus": "cita_bot", "appointmentDate": firestore.SERVER_TIMESTAMP})
    turn.fire(outcomes.set_conversation_outcome, turn.conv_id, "cita_bot", db=turn.db)
    if sf and conv.get("leadId"):
        turn.fire(create_salesforce_appointment, sf, conv["leadId"], p["input"], conv, tz)
        turn.fire(assign_by_schedule, turn.bot, sf, conv["leadId"], turn.conv_id)


@tool("handoff_gate", vertical=V)
def _handoff_gate(conv: dict, p: dict) -> None:
    """Escalar exige Lead (el asesor lo trabaja en Salesforce). Sin Lead, el bot lo pide primero."""
    turn = p["turn"]
    if not _sf(p) or conv.get("leadId"):
        return
    # Si ya se intentó crear el Lead en este turno (haya tenido éxito o no), el handoff ya se resolvió
    if p["trigger"] == "tool call" and turn.flags.get("lead_attempted"):
        return
    respond_handoff_no_lead(turn)
    turn.stop = True


@tool("handoff_applied", vertical=V)
def _handoff_applied(conv: dict, p: dict) -> None:
    turn, sf = p["turn"], _sf(p)
    if sf and conv.get("leadId"):
        turn.fire(update_lead_on_handoff, sf, conv["leadId"])


@tool("handoff_blocked_out_of_hours", vertical=V)
def _handoff_blocked(conv: dict, p: dict) -> None:
    """Fuera de horario el Lead se deja con el owner de BDC; el job de Salesforce lo reasigna al abrir el horario."""
    sf = _sf(p)
    if sf and conv.get("leadId") and sf.get("bdcFallbackOwnerId"):
        patch_lead_owner_id(sf, conv["leadId"], sf["bdcFallbackOwnerId"])


@tool("opt_out", vertical=V)
def _opt_out(conv: dict, p: dict) -> None:
    turn, sf = p["turn"], _sf(p)
    if sf and conv.get("leadId"):
        turn.fire(update_lead_on_stop, sf, conv["leadId"])


@tool("first_customer_reply", vertical=V)
def _first_reply(conv: dict, p: dict) -> None:
    """Primera respuesta del cliente a un Lead ya creado: Validacion 'Con respuesta' y fecha de deal."""
    turn, sf = p["turn"], _sf(p)
    if sf and conv.get("leadId"):
        turn.fire(update_salesforce_lead, sf, conv["leadId"], {
            "validacion_prospecto": "Con respuesta", "status_raw": "Contactado",
            "fecha_deal": datetime.now(timezone.utc).strftime(SALESFORCE_DT),
        })


@tool("situacion_destino_lead", vertical=V)
def _situacion_destino_lead(conv: dict, p: dict) -> None:
    p["result"] = handoff_lead_seminuevo(p["bot"], conv, p["conv_id"], p["route"], p.get("tool_input"), p.get("db"))


@tool("situacion_resuelta", vertical=V)
def _situacion_resuelta(conv: dict, p: dict) -> None:
    """Una situación notificada con éxito descarta el Lead previo. "seminuevo" nunca lo toca: un asesor
    y la escalera de inactividad lo siguen trabajando (decisión del negocio)."""
    sf = _sf(p)
    if p["situacion"] != "seminuevo" and conv.get("leadId") and sf:
        patch_lead_situacion(sf, conv["leadId"], p["situacion"])
