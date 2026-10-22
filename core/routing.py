"""Ruteo de situaciones: qué pasa cuando el bot detecta algo fuera de su alcance (tarea 1.6).

Las rutas son configuración (`bots/{id}.situationRouting[]`): cada una liga una situación con un
destino. El motor es núcleo; lo que cada módulo hace con su CRM al resolver la situación se despacha
como evento al registro de handlers:

  destino "cambiar_bot"   mismo número y conversación, otra IA (se redenormaliza `vertical`)
  destino "interno"       abre una conversación nueva en otro número de la plataforma
  destino "externo"       POST a un sistema fuera de la plataforma
  destino "ninguno"       solo cierra la conversación
  destino "lead"          lo resuelve el módulo (evento `situacion_destino_lead`)

  evento `situacion_resuelta` tras notificar con éxito (p. ej. Ventas descarta el Lead previo)
"""
import json
import logging

from google.cloud import firestore

from ai import engine
from core import http
from core.conversations import add_message, create_new_conversation, resolve_vertical, update_conversation_status
from core.db import get_db
from core.numbers import get_bot_by_id
from core.tools import dispatch
from crm import salesforce, templates

log = logging.getLogger(__name__)

DEFAULT_SWITCH_INTRO = "Conversación transferida desde el bot de {origen}."


def build_switch_context(conv_data: dict, situacion: str, motivo: str, route: dict | None = None) -> str:
    """Contexto que recibe el bot destino al tomar la conversación.

    El bot nuevo arranca con sesión vacía en Abacus (el externalSessionId es el mismo conv_id, pero
    el historial vive por deployment), así que este texto es lo único que sabe de lo que pasó antes.
    La introducción se puede fijar por ruta (`route.contextIntro`).
    """
    origen = conv_data.get("vertical") or "la plataforma"
    intro = (route or {}).get("contextIntro") or DEFAULT_SWITCH_INTRO.format(origen=origen)
    parts = [f'Situación: "{situacion}"']
    if conv_data.get("customerName"):
        parts.append(f'Cliente: "{conv_data["customerName"]}"')
    phone = (conv_data.get("customerPhone") or "").replace("whatsapp:", "")
    if phone:
        parts.append(f'Teléfono: "{phone}"')
    if conv_data.get("leadId"):
        parts.append(f'Lead ID: "{conv_data["leadId"]}"')
    if motivo:
        parts.append(f'Motivo: "{motivo}"')
    return (
        f"<<CONTEXTO>> {intro} A partir de ahora la atiendes tú por el mismo número de WhatsApp: "
        "saluda y sigue tu flujo normal. No respondas a este contexto, el cliente no lo ve. " + " | ".join(parts)
    )


def switch_conversation_bot(route: dict, conv_data: dict, conv_id: str, situacion: str, motivo: str, db=None) -> bool:
    """Cambia el bot que responde la conversación, sin cambiar de número ni cerrarla.

    No toca el lead ni el equipo: solo cambia la "inteligencia". El bot destino queda activo hasta
    que la conversación se cierre. Es un cambio de una sola vía por conversación
    (`situationHandoffSentAt` bloquea un segundo cambio).
    """
    db = db or get_db()
    target_id = route.get("internalBotId", "")
    target = get_bot_by_id(target_id, db) if target_id else None
    if not target:
        log.warning("situacion_bot_destino_invalido bot_id=%s", target_id)
        return False
    if target.get("status") != "active":
        log.warning("situacion_bot_destino_inactivo bot_id=%s", target_id)
        return False

    context = build_switch_context(conv_data, situacion, motivo, route)
    add_message(conv_id, "system", context, db=db)

    # Marca para la lista, el Kanban y el buscador. "botId" NO se toca: la reapertura busca la
    # conversación por el botId del canal (el default del número), no por el bot activo.
    brand = None
    org_id = target.get("organizationId")
    if org_id:
        org = db.collection("organizations").document(org_id).get()
        if org.exists:
            brand = org.to_dict().get("salesforceConfig", {}).get("marcaRR") or None

    new_vertical = resolve_vertical(db, target.get("teamId") or conv_data.get("teamId"), target)
    updates = {
        "activeBotId": target_id, "activeBotSince": firestore.SERVER_TIMESTAMP,
        "situationHandoffSentAt": firestore.SERVER_TIMESTAMP,
        "botName": target.get("name"), "botBrand": brand, "botCategory": target.get("category"),
    }
    if new_vertical:
        updates["vertical"] = new_vertical  # los tools siguientes despachan al módulo nuevo (§4.8)
        conv_data["vertical"] = new_vertical
    db.collection("conversations").document(conv_id).update(updates)

    conv_data["activeBotId"] = target_id
    conv_data["_switchContext"] = context
    log.info("situacion_bot_cambiado conv_id=%s situacion=%s bot_id=%s vertical=%s", conv_id, situacion, target_id, new_vertical)
    return True


def run_switched_bot(bot: dict, conv_id: str, conv_data: dict, messages: list, customer_phone: str = "") -> dict:
    """Corre el mensaje actual del cliente contra el bot recién activado.

    Antepone el contexto de la transferencia al último mensaje del cliente (misma llamada, sin
    round-trip extra) porque el bot destino no tiene historial.
    """
    context = conv_data.get("_switchContext") or ""
    switched = list(messages)
    if switched and switched[-1].get("is_user"):
        switched[-1] = {"is_user": True, "text": f"{context}\n\n{switched[-1].get('text', '')}".strip()}
    else:
        switched.append({"is_user": True, "text": context})
    return engine.send_to_bot(bot, switched, conv_id=conv_id, customer_phone=customer_phone)


def notify_situacion_externa(route: dict, conv_data: dict, conv_id: str, situacion: str, motivo: str) -> bool:
    """POST a un sistema externo (bot fuera de la plataforma) sobre la situación detectada."""
    url = route.get("externalUrl", "")
    if not url:
        log.warning("situacion_externa_sin_url situacion=%s", situacion)
        return False
    payload = {
        "event": "situacion_detectada", "situacion": situacion, "targetPhone": route.get("externalTargetPhone", ""),
        "phone": conv_data.get("customerPhone"), "customerName": conv_data.get("customerName"),
        "leadId": conv_data.get("leadId"), "organizationId": conv_data.get("organizationId"),
        "brand": conv_data.get("botBrand"), "motivo": motivo, "sourceConversationId": conv_id,
    }
    try:
        status, _ = http.request(url, json.dumps(payload).encode("utf-8"), {"Content-Type": "application/json"}, timeout=10)
        return 200 <= status < 300
    except Exception as e:
        log.error("situacion_externa_error situacion=%s error=%s", situacion, e)
        return False


def notify_situacion_interna(route: dict, conv_data: dict, motivo: str, db=None) -> bool:
    """Abre una conversación nueva en el número interno configurado y le envía su plantilla.

    Hoy solo el proveedor ValueText sabe enviar la plantilla (se inserta en el SMS bucket de
    Salesforce); con Twilio o Meta devuelve False. Generalizarlo a los tres proveedores es la
    Fase 5 del plan.
    """
    db = db or get_db()
    wa_id = route.get("internalWhatsappNumberId", "")
    wa_doc = db.collection("whatsappNumbers").document(wa_id).get() if wa_id else None
    if not wa_doc or not wa_doc.exists:
        log.warning("situacion_interna_no_wa_number wa_id=%s", wa_id)
        return False

    wa_number = wa_doc.to_dict()
    if wa_number.get("provider", "twilio") != "valuetext":
        log.warning("situacion_interna_proveedor_no_soportado provider=%s", wa_number.get("provider"))
        return False

    target_bot_id = wa_number.get("defaultBotId")
    target_bot = get_bot_by_id(target_bot_id, db) if target_bot_id else None
    phone = conv_data.get("customerPhone", "")
    new_conv_id, _, _ = create_new_conversation(
        db, target_bot_id, wa_number.get("organizationId"), phone, team_id=wa_number.get("teamId"),
        whatsapp_number_id=wa_doc.id, bot_config=target_bot, channel="whatsapp",
        customer_name=conv_data.get("customerName"),
    )
    lead_id = conv_data.get("leadId", "")
    if lead_id:
        db.collection("conversations").document(new_conv_id).update({"leadId": lead_id})
    add_message(new_conv_id, "system", f"<<CONTEXTO>> Transferido desde {conv_data.get('vertical') or 'otro módulo'} | Motivo: {motivo or 'no especificado'}", db=db)

    org = db.collection("organizations").document(wa_number.get("organizationId")).get()
    vertical = resolve_vertical(db, wa_number.get("teamId"), target_bot)
    sf_config = salesforce.resolve_config(org.to_dict().get("salesforceConfig", {}) if org.exists else {}, vertical)
    bucket_id = templates.send_valuetext_template(
        sf_config, wa_number.get("valuetextSenderId", ""), phone, lead_id, template_id=wa_number.get("situationTemplateId") or None)
    log.info("situacion_interna_enviada conv_id=%s bucket_id=%s", new_conv_id, bucket_id)
    return bool(bucket_id)


def process_situacion_handoff(bot: dict, conv_data: dict, conv_id: str, situacion: str, motivo: str,
                              tool_input: dict | None = None, db=None):
    """Resuelve la situación detectada según la ruta configurada en el bot.

    Returns:
        "switched"  se cambió el bot que responde; el llamador corre el mensaje contra el bot nuevo.
        True        se notificó al destino; la conversación quedó resuelta.
        False       no se hizo nada; sigue el flujo normal del bot.

    Sin ruta configurada no se hace nada (ni transferencia, ni cierre): una marca que no tiene
    resuelto el flujo no genera efectos secundarios aunque su modelo devuelva el tool.
    """
    db = db or get_db()
    if conv_data.get("situationHandoffSentAt"):
        log.info("situacion_ya_notificada conv_id=%s", conv_id)
        return False

    route = next((r for r in bot.get("situationRouting", []) if r.get("situacion") == situacion), None)
    if not route:
        log.info("situacion_sin_ruta situacion=%s bot_id=%s", situacion, bot.get("id"))
        return False

    destino = route.get("destino")
    if destino == "lead":
        params = {"bot": bot, "conv_id": conv_id, "route": route, "tool_input": tool_input or {}, "result": False, "db": db}
        dispatch("situacion_destino_lead", conv_data, params)
        return params["result"]
    if destino == "cambiar_bot":
        return "switched" if switch_conversation_bot(route, conv_data, conv_id, situacion, motivo, db) else False

    if destino == "ninguno":
        ok = True
    elif destino == "interno":
        ok = notify_situacion_interna(route, conv_data, motivo, db)
    else:
        ok = notify_situacion_externa(route, conv_data, conv_id, situacion, motivo)
    if not ok:
        return False

    dispatch("situacion_resuelta", conv_data, {"bot": bot, "conv_id": conv_id, "situacion": situacion, "motivo": motivo, "route": route, "db": db})
    update_conversation_status(conv_id, "closed", db=db)
    db.collection("conversations").document(conv_id).update({
        "closedReason": "situation_handoff", "situationHandoffSentAt": firestore.SERVER_TIMESTAMP,
        "manualClose": True, "assignedAgentId": None,
    })
    return True
