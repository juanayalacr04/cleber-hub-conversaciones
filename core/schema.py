"""Constantes y helpers del esquema (§7.3). Se escriben desde la primera conversación."""

VERTICALS = ("ventas", "servicio", "valuacion")
BOT_TYPES = ("chatllm", "workflow", "vertex_ai", "external")


def customer_id(org_id: str, phone: str) -> str:
    """ID de la ficha única: customers/{orgId}_{phone}. El teléfono se normaliza a dígitos."""
    digits = "".join(c for c in phone if c.isdigit())
    if not org_id or not digits:
        raise ValueError("org_id y phone son obligatorios")
    return f"{org_id}_{digits}"


def assert_unique_brand_code(db, sf_brand_code: str, org_id: str) -> None:
    """sfBrandCode único (0.15): get_whatsapp_number_by_brand resuelve con limit(1) sin orderBy."""
    docs = db.collection("organizations").where("sfBrandCode", "==", sf_brand_code).limit(2).stream()
    clash = [d.id for d in docs if d.id != org_id]
    if clash:
        raise ValueError(f"sfBrandCode {sf_brand_code!r} ya lo usa la organización {clash[0]}")
