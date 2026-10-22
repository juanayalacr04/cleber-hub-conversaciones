"""Datos de prueba para el proyecto de desarrollo (tarea 0.2 diferida: se trabaja directo sobre GCP dev).

    python dev/seed.py --email tu@correo.com            siembra los datos de prueba y te deja como superadmin de las dos marcas
    python dev/seed.py --clean                          borra todo lo sembrado (los documentos cuyo ID empieza con `demo-`)

Se NIEGA a correr si no estás apuntando al proyecto y la base de desarrollo del hub:

    GOOGLE_CLOUD_PROJECT=ambiente-desarrollo-ti    FIRESTORE_DATABASE=dev-hub-conversaciones

Es idempotente: volver a correrlo reescribe los mismos documentos, no duplica. Todo lleva el prefijo `demo-` en su ID, así que
no toca nada que no haya sembrado él. Los agentes de prueba (`demo-agent-*`) no tienen cuenta de Google: existen para poder
asignarles conversaciones y ver las listas; tu usuario es el único con el que se inicia sesión.

Qué siembra: dos marcas (Honda y Kia) para probar el aislamiento, tres equipos, dos agentes, un bot y un número por equipo, plantillas,
etiquetas, siete conversaciones en todos los estados (con mensajes y una nota) y una campaña en borrador con tres destinatarios.
Los números no tienen credenciales de Twilio: un envío real falla con "credentials not configured", que es lo que se quiere en dev.
"""
import argparse
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

PROJECT = "ambiente-desarrollo-ti"
DATABASE = "dev-hub-conversaciones"
PREFIX = "demo-"


def check_target(env) -> None:
    """Falla si el entorno no apunta al proyecto y la base de desarrollo del hub."""
    problems = []
    if env.get("GOOGLE_CLOUD_PROJECT") != PROJECT:
        problems.append(f"GOOGLE_CLOUD_PROJECT debe ser {PROJECT!r} (es {env.get('GOOGLE_CLOUD_PROJECT')!r})")
    if env.get("FIRESTORE_DATABASE") != DATABASE:
        problems.append(f"FIRESTORE_DATABASE debe ser {DATABASE!r} (es {env.get('FIRESTORE_DATABASE')!r})")
    if problems:
        raise SystemExit("No se siembra nada:\n  - " + "\n  - ".join(problems))


def build(now: datetime) -> list[tuple[str, dict]]:
    """Todos los documentos de prueba como (ruta, datos). La ruta alterna colección y documento."""
    def ago(**kw):
        return now - timedelta(**kw)

    docs: list[tuple[str, dict]] = []

    def add(path, data):
        docs.append((path, data))

    # ── Organizaciones ──
    add("organizations/demo-honda", {"name": "Honda (demo)", "plan": "enterprise", "sfBrandCode": "DEMOHO", "settings": {"timezone": "America/Mexico_City"},
                                      "salesforceConfig": {"vehicleType": "nuevo", "marcaRR": "HO"}, "createdAt": ago(days=30)})
    add("organizations/demo-kia", {"name": "Kia (demo)", "plan": "enterprise", "sfBrandCode": "DEMOKI", "settings": {"timezone": "America/Mexico_City"},
                                    "salesforceConfig": {"vehicleType": "nuevo"}, "createdAt": ago(days=30)})

    # ── Equipos ──
    add("teams/demo-honda-ventas", {"organizationId": "demo-honda", "name": "Ventas Honda", "description": "Equipo de ventas de prueba", "vertical": "ventas",
                                     "assignmentMode": "manual", "optOutAction": "close", "status": "active", "activeConversations": 0,
                                     "semaphoreThresholds": {"yellowMinutes": 5, "redMinutes": 15}, "createdAt": ago(days=29)})
    add("teams/demo-honda-servicio", {"organizationId": "demo-honda", "name": "Servicio Honda", "description": "Equipo de servicio de prueba",
                                       "vertical": "servicio", "assignmentMode": "round_robin", "optOutAction": "close", "status": "active",
                                       "activeConversations": 0, "createdAt": ago(days=29)})
    add("teams/demo-kia-ventas", {"organizationId": "demo-kia", "name": "Ventas Kia", "description": "Otra marca: no debe verse desde Honda",
                                   "vertical": "ventas", "assignmentMode": "manual", "status": "active", "activeConversations": 0, "createdAt": ago(days=29)})

    # ── Agentes de prueba (sin cuenta de Google) ──
    for n, (name, team) in enumerate((("Ana Agente (demo)", "demo-honda-ventas"), ("Beto Agente (demo)", "demo-honda-servicio")), start=1):
        add(f"users/demo-agent-{n}", {"id": f"demo-agent-{n}", "email": f"agente{n}@demo.invalid", "name": name, "role": "agent", "photoURL": None,
                                      "organizationId": "demo-honda", "organizationIds": ["demo-honda"], "teamId": team, "orgTeams": {"demo-honda": team},
                                      "isAvailable": True, "activeConversations": 0, "status": "offline", "createdAt": ago(days=20), "lastLoginAt": None})

    # ── Bots y números ──
    bot_base = {"status": "active", "description": "Bot de prueba: no está conectado a ningún motor real",
                "twilioConfig": {"phoneNumber": "", "accountSid": "", "authToken": ""}, "abacusConfig": {"deploymentId": "", "deploymentToken": ""},
                "handoffConfig": {"enabled": True, "triggerKeywords": ["asesor", "humano"]}, "createdAt": ago(days=28)}
    add("bots/demo-bot-ventas", {**bot_base, "name": "Bot Ventas (demo)", "type": "chatllm", "vertical": "ventas", "category": "Ventas", "organizationId": "demo-honda"})
    add("bots/demo-bot-servicio", {**bot_base, "name": "Bot Servicio (demo)", "type": "workflow", "vertical": "servicio", "category": "Servicio",
                                    "organizationId": "demo-honda"})
    add("bots/demo-bot-kia", {**bot_base, "name": "Bot Kia (demo)", "type": "chatllm", "vertical": "ventas", "category": "Ventas", "organizationId": "demo-kia"})
    number_base = {"provider": "twilio", "status": "active", "twilioAccountSid": "", "twilioAuthToken": "", "createdAt": ago(days=27)}
    add("whatsappNumbers/demo-num-ventas", {**number_base, "organizationId": "demo-honda", "phoneNumber": "whatsapp:+528100000001", "displayName": "Ventas Honda (demo)",
                                             "teamId": "demo-honda-ventas", "defaultBotId": "demo-bot-ventas"})
    add("whatsappNumbers/demo-num-servicio", {**number_base, "organizationId": "demo-honda", "phoneNumber": "whatsapp:+528100000002", "displayName": "Servicio Honda (demo)",
                                               "teamId": "demo-honda-servicio", "defaultBotId": "demo-bot-servicio"})
    add("whatsappNumbers/demo-num-kia", {**number_base, "organizationId": "demo-kia", "phoneNumber": "whatsapp:+528100000003", "displayName": "Ventas Kia (demo)",
                                          "teamId": "demo-kia-ventas", "defaultBotId": "demo-bot-kia"})

    # ── Plantillas y etiquetas ──
    add("templates/demo-tpl-saludo", {"organizationId": "demo-honda", "name": "Saludo", "category": "General", "vertical": "ventas",
                                       "content": "Hola, gracias por escribirnos. ¿En qué te puedo ayudar?", "createdAt": ago(days=20)})
    add("templates/demo-tpl-cita", {"organizationId": "demo-honda", "name": "Confirmar cita", "category": "Citas", "vertical": "ventas",
                                     "content": "Tu cita queda confirmada. Te esperamos.", "createdAt": ago(days=20)})
    add("labels/demo-label-urgente", {"organizationId": "demo-honda", "teamId": "demo-honda-ventas", "name": "Urgente", "color": "red", "createdAt": ago(days=20)})
    add("labels/demo-label-seguimiento", {"organizationId": "demo-honda", "teamId": "demo-honda-ventas", "name": "Seguimiento", "color": "blue", "createdAt": ago(days=20)})

    # ── Conversaciones ──
    def conversation(cid, phone, name, status, team, number, bot, org, vertical, last_text, last_sender, minutes_ago, **extra):
        return (f"conversations/{cid}", {
            "id": cid, "customerPhone": phone, "customerName": name, "status": status, "organizationId": org, "teamId": team, "vertical": vertical,
            "whatsappNumberId": number, "botId": bot, "assignedBotId": bot, "assignedAgentId": None, "priority": "normal", "tags": [], "labelIds": [],
            "channel": "whatsapp", "direction": "inbound", "lastMessagePreview": last_text, "lastMessageSender": last_sender,
            "lastMessageAt": ago(minutes=minutes_ago), "lastCustomerMessageAt": ago(minutes=minutes_ago + (0 if last_sender == "customer" else 3)),
            "createdAt": ago(minutes=minutes_ago + 60), **extra})

    V, S, K = ("demo-honda-ventas", "demo-num-ventas", "demo-bot-ventas"), ("demo-honda-servicio", "demo-num-servicio", "demo-bot-servicio"), \
              ("demo-kia-ventas", "demo-num-kia", "demo-bot-kia")
    conversations = [
        (conversation("demo-c-bot", "whatsapp:+528155550001", "Laura Pérez", "bot", *V[:1], V[1], V[2], "demo-honda", "ventas",
                      "Claro, ¿qué modelo te interesa?", "bot", 4, botName="Bot Ventas (demo)"),
         [("customer", "Hola, quiero información de la CR-V", 10), ("bot", "¡Hola Laura! Con gusto. ¿Buscas nueva o seminueva?", 9),
          ("customer", "Nueva", 6), ("bot", "Claro, ¿qué modelo te interesa?", 4)]),
        (conversation("demo-c-espera", "whatsapp:+528155550002", "Carlos Ruiz", "waiting_agent", V[0], V[1], V[2], "demo-honda", "ventas",
                      "Quiero hablar con un asesor", "customer", 12, handoffReason="keyword", waitingStartedAt=ago(minutes=12)),
         [("customer", "Me interesa una Civic", 30), ("bot", "Excelente elección. ¿Quieres que te comparta precios?", 28),
          ("customer", "Quiero hablar con un asesor", 12)]),
        (conversation("demo-c-asignada", "whatsapp:+528155550003", "María López", "with_agent", V[0], V[1], V[2], "demo-honda", "ventas",
                      "Perfecto, te agendo el sábado", "agent", 25, assignedAgentId="demo-agent-1", assignedAgentType="human",
                      assignedAt=ago(minutes=40), waitingStartedAt=ago(minutes=45), labelIds=["demo-label-urgente"]),
         [("customer", "Quiero probar la HR-V", 60), ("bot", "Te paso con un asesor.", 58), ("customer", "¿Tienen para el sábado?", 30),
          ("agent", "Perfecto, te agendo el sábado", 25)]),
        (conversation("demo-c-cerrada", "whatsapp:+528155550004", "Pedro Gómez", "closed", V[0], V[1], V[2], "demo-honda", "ventas",
                      "Gracias, quedo atento", "customer", 600, closedAt=ago(minutes=590), closedReason="Venta cerrada", manualClose=True),
         [("customer", "Ya compré, gracias", 620), ("agent", "¡Felicidades!", 610), ("customer", "Gracias, quedo atento", 600)]),
        (conversation("demo-c-servicio", "whatsapp:+528155550005", "Ana Torres", "waiting_agent", S[0], S[1], S[2], "demo-honda", "servicio",
                      "Mi auto hace un ruido al frenar", "customer", 8, waitingStartedAt=ago(minutes=8)),
         [("customer", "Mi auto hace un ruido al frenar", 8)]),
        (conversation("demo-c-cita", "whatsapp:+528155550006", "Luis Mena", "with_agent", V[0], V[1], V[2], "demo-honda", "ventas",
                      "Cita agendada para el viernes 10:00", "agent", 90, assignedAgentId="demo-agent-1", assignedAgentType="human",
                      appointmentStatus="cita_agente", conversationOutcome="cita_agente_bdc", labelIds=["demo-label-seguimiento"]),
         [("customer", "Quiero una cita", 120), ("agent", "Cita agendada para el viernes 10:00", 90)]),
        (conversation("demo-c-kia", "whatsapp:+528155550007", "Sofía Ramos", "waiting_agent", K[0], K[1], K[2], "demo-kia", "ventas",
                      "Busco un Sportage", "customer", 15, waitingStartedAt=ago(minutes=15)),
         [("customer", "Busco un Sportage", 15)]),
    ]
    for (path, data), messages in conversations:
        add(path, data)
        for n, (sender, text, minutes) in enumerate(messages, start=1):
            mid = f"{data['id']}-m{n}"
            add(f"{path}/messages/{mid}", {"id": mid, "conversationId": data["id"], "sender": sender, "text": text, "mediaUrl": None,
                                           "agentId": "demo-agent-1" if sender == "agent" else None, "createdAt": ago(minutes=minutes)})
    add("conversations/demo-c-asignada/notes/demo-note-1", {"authorId": "demo-agent-1", "authorName": "Ana Agente (demo)",
                                                            "text": "Cliente con prisa, prefiere llamada.", "createdAt": ago(minutes=20)})

    # ── Campaña en borrador ──
    add("broadcasts/demo-bc-1", {"id": "demo-bc-1", "organizationId": "demo-honda", "vertical": "servicio", "name": "Recordatorio de servicio (demo)",
                                  "whatsappNumberId": "demo-num-servicio", "botId": "demo-bot-servicio", "templateName": "recordatorio_servicio",
                                  "templateBody": "Te recordamos tu cita de servicio.", "templateLanguage": "es", "templateComponents": [], "type": "manual",
                                  "status": "draft", "totalRecipients": 3, "sentCount": 0, "deliveredCount": 0, "failedCount": 0,
                                  "createdBy": "demo-agent-1", "createdAt": ago(hours=2), "completedAt": None, "botInstructions": "Confirma la cita."})
    for n, (phone, name) in enumerate((("+528155551001", "Cliente Uno"), ("+528155551002", "Cliente Dos"), ("+528155551003", "Cliente Tres")), start=1):
        add(f"broadcasts/demo-bc-1/recipients/demo-bc-1-r{n}", {"id": f"demo-bc-1-r{n}", "phone": phone, "name": name, "variables": {"taller": "Norte"},
                                                                 "salesforceRecordId": None, "conversationId": None, "status": "pending", "errorMessage": None,
                                                                 "whatsappMessageId": None, "sentAt": None})
    return docs


def ref(db, path: str):
    """Documento de una ruta `coleccion/doc[/coleccion/doc...]`."""
    parts = path.split("/")
    node = db
    for collection, doc_id in zip(parts[::2], parts[1::2]):
        node = node.collection(collection).document(doc_id)
        if node is not db and (collection, doc_id) != (parts[-2], parts[-1]):
            pass
    return node


def seed(db, now: datetime | None = None) -> int:
    """Escribe los documentos de prueba. Devuelve cuántos."""
    docs = build(now or datetime.now(timezone.utc))
    for path, data in docs:
        ref(db, path).set(data)
    return len(docs)


def link_user(db, email: str, now: datetime | None = None) -> str:
    """Deja a `email` como superadmin de las dos marcas de prueba. Devuelve el ID del documento."""
    email = email.strip().lower()
    for candidate in dict.fromkeys([email, email.upper()]):
        found = next(iter(db.collection("users").where("email", "==", candidate).limit(1).stream()), None)
        if found:
            break
    else:
        raise SystemExit(f"No hay un usuario con el correo {email!r} en esta base. Inicia sesión en el dashboard una vez (o crea el documento "
                         "inicial en users) y vuelve a correr el script.")
    found.reference.update({"organizationId": "demo-honda", "organizationIds": ["demo-honda", "demo-kia"]})
    return found.id


def clean(db) -> int:
    """Borra todo lo sembrado: los documentos con ID `demo-`, sus mensajes, notas y destinatarios."""
    deleted = 0
    for path, _ in reversed(build(datetime.now(timezone.utc))):
        snapshot = ref(db, path).get()
        if snapshot.exists:
            snapshot.reference.delete()
            deleted += 1
    return deleted


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--email", help="tu correo de Google: queda como superadmin de las marcas de prueba")
    parser.add_argument("--clean", action="store_true", help="borra los datos de prueba")
    args = parser.parse_args(argv)
    if not args.clean and not args.email:
        parser.error("indica --email para sembrar, o --clean para borrar")

    check_target(os.environ)
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from core.db import get_db   # después de verificar el entorno: lee FIRESTORE_DATABASE al importarse

    db = get_db()
    if args.clean:
        print(f"Borrados {clean(db)} documentos de prueba.")
        return 0
    print(f"Sembrados {seed(db)} documentos en {PROJECT} / {DATABASE}.")
    print(f"Usuario {link_user(db, args.email)} ahora es de demo-honda y demo-kia.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
