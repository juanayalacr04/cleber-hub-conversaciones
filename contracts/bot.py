"""Contratos de la función 3 (bot): petición y resultado de un turno, y resumen para el expediente.

La función 3 no guarda estado y no ejecuta tools de negocio (D14): devuelve texto. Las acciones
que el bot necesita las pide a la función 2 (ver `contracts.actions`). El campo `actions` solo lo
llena el bot externo (`type: "external"`), que conserva su contrato de devolver acciones.

Las credenciales de Abacus no viajan: la función 3 las lee de Secret Manager por `bot_id`.
El historial solo viaja para el bot externo; ChatLLM y los workflows guardan la sesión en Abacus
con `externalSessionId` (= `conversation_id`).
"""
from dataclasses import dataclass, field

from contracts.base import ContractError, SCHEMA_VERSION, as_dict, check_version, optional, required


@dataclass
class HistoryItem:
    role: str                       # "customer" | "bot"
    text: str

    def to_dict(self) -> dict:
        return {"role": self.role, "text": self.text}

    @classmethod
    def from_dict(cls, data: dict) -> "HistoryItem":
        data = as_dict(data, "history")
        role = required(data, "role", name="history")
        if role not in ("customer", "bot"):
            raise ContractError(f"history: role desconocido {role!r}")
        return cls(role=role, text=optional(data, "text", str, "", "history"))


@dataclass
class Expediente:
    """Lo que el bot sabe del cliente (1.38): datos y los últimos resúmenes. Arranca vacío (D15)."""
    datos: dict = field(default_factory=dict)
    resumenes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"datos": self.datos, "resumenes": self.resumenes}

    @classmethod
    def from_dict(cls, data: dict | None) -> "Expediente":
        if not data:
            return cls()
        data = as_dict(data, "expediente")
        return cls(datos=optional(data, "datos", dict, {}, "expediente"),
                   resumenes=optional(data, "resumenes", list, [], "expediente"))


@dataclass
class BotRequest:
    """C. Función 2 → función 3: un turno."""
    bot_id: str
    conversation_id: str
    message: str                    # último mensaje del cliente (con el contexto antepuesto si aplica)
    customer_phone: str = ""
    history: list[HistoryItem] | None = None   # solo para `type: "external"`
    expediente: Expediente = field(default_factory=Expediente)

    def to_dict(self) -> dict:
        return {
            "schemaVersion": SCHEMA_VERSION, "botId": self.bot_id, "conversationId": self.conversation_id,
            "message": self.message, "customerPhone": self.customer_phone,
            "history": None if self.history is None else [h.to_dict() for h in self.history],
            "expediente": self.expediente.to_dict(),
        }

    @classmethod
    def from_dict(cls, data: dict) -> "BotRequest":
        name = "BotRequest"
        data = as_dict(data, name)
        check_version(data)
        history = optional(data, "history", list, None, name)
        return cls(
            bot_id=required(data, "botId", name=name), conversation_id=required(data, "conversationId", name=name),
            message=required(data, "message", name=name), customer_phone=optional(data, "customerPhone", str, "", name),
            history=None if history is None else [HistoryItem.from_dict(h) for h in history],
            expediente=Expediente.from_dict(data.get("expediente")),
        )


@dataclass
class BotError:
    code: str                       # p. ej. "bot_error", "timeout", "bot_no_configurado"
    message: str = ""
    retryable: bool = False

    def to_dict(self) -> dict:
        return {"code": self.code, "message": self.message, "retryable": self.retryable}

    @classmethod
    def from_dict(cls, data: dict) -> "BotError":
        data = as_dict(data, "error")
        return cls(code=required(data, "code", name="error"), message=optional(data, "message", str, "", "error"),
                   retryable=optional(data, "retryable", bool, False, "error"))


@dataclass
class BotAction:
    """Acción devuelta por el bot externo: `{"name", "params"}`."""
    name: str
    params: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"name": self.name, "params": self.params}

    @classmethod
    def from_dict(cls, data: dict) -> "BotAction":
        data = as_dict(data, "action")
        return cls(name=required(data, "name", name="action"), params=optional(data, "params", dict, {}, "action"))


@dataclass
class BotResponse:
    """C. Función 3 → función 2: el resultado del turno."""
    ok: bool
    text: str = ""
    motivo: str | None = None       # clasificación del motivo (hoy `detect_action`)
    handoff: bool = False           # el bot pidió escalar; la función 2 decide si procede
    handoff_motivo: str | None = None
    actions: list[BotAction] = field(default_factory=list)   # solo bot externo
    error: BotError | None = None

    def to_dict(self) -> dict:
        return {
            "schemaVersion": SCHEMA_VERSION, "ok": self.ok, "text": self.text, "motivo": self.motivo,
            "handoff": self.handoff, "handoffMotivo": self.handoff_motivo,
            "actions": [a.to_dict() for a in self.actions],
            "error": self.error.to_dict() if self.error else None,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "BotResponse":
        name = "BotResponse"
        data = as_dict(data, name)
        check_version(data)
        ok = required(data, "ok", bool, name)
        error = BotError.from_dict(data["error"]) if data.get("error") else None
        if not ok and error is None:
            raise ContractError(f"{name}: ok=false exige 'error'")
        return cls(
            ok=ok, text=optional(data, "text", str, "", name), motivo=optional(data, "motivo", str, None, name),
            handoff=optional(data, "handoff", bool, False, name),
            handoff_motivo=optional(data, "handoffMotivo", str, None, name),
            actions=[BotAction.from_dict(a) for a in optional(data, "actions", list, [], name)], error=error,
        )


@dataclass
class SummaryRequest:
    """Función 2 → función 3, al cerrar una conversación (1.38). Corre fuera del camino de respuesta."""
    bot_id: str
    conversation_id: str
    history: list[HistoryItem]
    previous_summaries: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "schemaVersion": SCHEMA_VERSION, "botId": self.bot_id, "conversationId": self.conversation_id,
            "history": [h.to_dict() for h in self.history], "previousSummaries": self.previous_summaries,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "SummaryRequest":
        name = "SummaryRequest"
        data = as_dict(data, name)
        check_version(data)
        return cls(
            bot_id=required(data, "botId", name=name), conversation_id=required(data, "conversationId", name=name),
            history=[HistoryItem.from_dict(h) for h in required(data, "history", list, name)],
            previous_summaries=optional(data, "previousSummaries", list, [], name),
        )


@dataclass
class SummaryResponse:
    ok: bool
    summary: str = ""
    error: BotError | None = None

    def to_dict(self) -> dict:
        return {"schemaVersion": SCHEMA_VERSION, "ok": self.ok, "summary": self.summary,
                "error": self.error.to_dict() if self.error else None}

    @classmethod
    def from_dict(cls, data: dict) -> "SummaryResponse":
        name = "SummaryResponse"
        data = as_dict(data, name)
        check_version(data)
        ok = required(data, "ok", bool, name)
        error = BotError.from_dict(data["error"]) if data.get("error") else None
        if not ok and error is None:
            raise ContractError(f"{name}: ok=false exige 'error'")
        return cls(ok=ok, summary=optional(data, "summary", str, "", name), error=error)
