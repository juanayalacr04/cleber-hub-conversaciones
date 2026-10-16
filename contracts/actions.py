"""Contrato D: el bot pide una acción a la función 2 (`POST /actions/execute`, §7.8 del plan).

Aquí solo se fija la forma exterior. El schema de `data` y el valor de retorno de cada acción
los declara el registro de handlers (`core/tools.py`, tarea 1.43).

Reglas que el contrato no puede expresar pero el endpoint impone (1.44):
  - el cliente, la organización y la vertical salen de `conversation_id`, nunca de `data`;
  - un bot solo invoca las acciones que su configuración habilita;
  - un mismo `idempotency_key` no repite el efecto: devuelve el resultado ya calculado.
"""
from dataclasses import dataclass, field

from contracts.base import ContractError, SCHEMA_VERSION, as_dict, check_version, one_of, optional, required

# Códigos de error tipados: el workflow ramifica y el LLM puede explicarle al cliente.
SIN_DISPONIBILIDAD = "sin_disponibilidad"
DATOS_INVALIDOS = "datos_invalidos"
FUERA_DE_HORARIO = "fuera_de_horario"
ACCION_DESCONOCIDA = "accion_desconocida"
ACCION_NO_PERMITIDA = "accion_no_permitida"
CONVERSACION_NO_ENCONTRADA = "conversacion_no_encontrada"
NO_AUTORIZADO = "no_autorizado"
ERROR_EXTERNO = "error_externo"       # Salesforce, Quiter... falló; suele ser reintentable
ERROR_INTERNO = "error_interno"

# `ok: true` con estos estados.
STATUSES = ("done", "duplicate", "accepted")   # accepted: respuesta asíncrona (202), el resultado se consulta luego


@dataclass
class ActionRequest:
    action: str
    conversation_id: str
    idempotency_key: str
    data: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "schemaVersion": SCHEMA_VERSION, "action": self.action, "conversationId": self.conversation_id,
            "idempotencyKey": self.idempotency_key, "data": self.data,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "ActionRequest":
        name = "ActionRequest"
        data = as_dict(data, name)
        check_version(data)
        return cls(
            action=required(data, "action", name=name), conversation_id=required(data, "conversationId", name=name),
            idempotency_key=required(data, "idempotencyKey", name=name), data=optional(data, "data", dict, {}, name),
        )


@dataclass
class ActionError:
    code: str
    message: str = ""               # legible para el modelo, no la respuesta cruda del sistema externo
    retryable: bool = False

    def to_dict(self) -> dict:
        return {"code": self.code, "message": self.message, "retryable": self.retryable}

    @classmethod
    def from_dict(cls, data: dict) -> "ActionError":
        data = as_dict(data, "error")
        return cls(code=required(data, "code", name="error"), message=optional(data, "message", str, "", "error"),
                   retryable=optional(data, "retryable", bool, False, "error"))


@dataclass
class ActionResponse:
    ok: bool
    status: str | None = None       # uno de STATUSES cuando ok
    result: dict = field(default_factory=dict)   # corto y legible; handoff y fuera de horario viajan aquí
    error: ActionError | None = None

    @classmethod
    def success(cls, result: dict | None = None, status: str = "done") -> "ActionResponse":
        return cls(ok=True, status=one_of(status, STATUSES, "status", "ActionResponse"), result=result or {})

    @classmethod
    def failure(cls, code: str, message: str = "", retryable: bool = False) -> "ActionResponse":
        return cls(ok=False, error=ActionError(code, message, retryable))

    def to_dict(self) -> dict:
        return {
            "schemaVersion": SCHEMA_VERSION, "ok": self.ok, "status": self.status, "result": self.result,
            "error": self.error.to_dict() if self.error else None,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "ActionResponse":
        name = "ActionResponse"
        data = as_dict(data, name)
        check_version(data)
        ok = required(data, "ok", bool, name)
        if ok:
            status = one_of(required(data, "status", name=name), STATUSES, "status", name)
            return cls(ok=True, status=status, result=optional(data, "result", dict, {}, name))
        if not data.get("error"):
            raise ContractError(f"{name}: ok=false exige 'error'")
        return cls(ok=False, error=ActionError.from_dict(data["error"]))
