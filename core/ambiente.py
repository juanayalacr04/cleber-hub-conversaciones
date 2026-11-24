"""Etiqueta del ambiente para los correos (variable AMBIENTE de la Lambda): "QA" en qa, "" en producción, "DEV" en lo demás."""
import os


def etiqueta_ambiente() -> str:
    ambiente = (os.environ.get("AMBIENTE") or "").strip().lower()
    if ambiente in ("prd", "prod", "produccion", "producción"):
        return ""
    return "QA" if ambiente == "qa" else "DEV"


def asunto_con_ambiente(asunto: str) -> str:
    etiqueta = etiqueta_ambiente()
    return f"[{etiqueta}] {asunto}" if etiqueta else asunto


def aviso_ambiente_html() -> str:
    etiqueta = etiqueta_ambiente()
    if not etiqueta:
        return ""
    return (f'<p style="margin: 0 0 16px;"><span style="display: inline-block; padding: 2px 10px; background-color: #f59e0b; '
            f'color: #000; font-size: 12px; font-weight: bold; border-radius: 4px;">Ambiente {etiqueta}</span></p>')
