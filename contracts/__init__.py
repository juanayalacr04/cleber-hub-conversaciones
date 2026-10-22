"""Contratos entre las tres funciones (tarea 1.33). Ver el módulo de cada uno:

  messages   A. router → reglas (ChannelEvent: IncomingMessage, DeliveryStatus u OutboundRecord, por la cola) y B. reglas → router (OutgoingMessage, SendResult)
  bot        C. reglas → bot (BotRequest, BotResponse) y resumen del expediente (SummaryRequest, SummaryResponse)
  actions    D. bot → reglas (ActionRequest, ActionResponse): `POST /actions/execute`

Este paquete no importa nada del resto del repo.
"""
from contracts.actions import ActionError, ActionRequest, ActionResponse
from contracts.base import SCHEMA_VERSION, ContractError
from contracts.bot import (BotAction, BotError, BotRequest, BotResponse, Expediente, HistoryItem,
                           SummaryRequest, SummaryResponse)
from contracts.messages import ChannelEvent, DeliveryStatus, IncomingMessage, Media, OutboundRecord, OutgoingMessage, SendResult

__all__ = [
    "SCHEMA_VERSION", "ContractError",
    "IncomingMessage", "Media", "OutgoingMessage", "SendResult", "ChannelEvent", "DeliveryStatus", "OutboundRecord",
    "BotRequest", "BotResponse", "BotAction", "BotError", "Expediente", "HistoryItem",
    "SummaryRequest", "SummaryResponse",
    "ActionRequest", "ActionResponse", "ActionError",
]
