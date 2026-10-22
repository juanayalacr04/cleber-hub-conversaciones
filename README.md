Primer versión de centralización de plataformas comercial y servicio.

Diseño y plan en [`Arquitectura/`](Arquitectura/PLAN_TRABAJO_CENTRALIZACION.md).

## Desarrollo local (Fase 0)

```
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements-dev.txt
.venv/Scripts/python -m pytest          # registro de handlers + reglas de arquitectura
.venv/Scripts/python dev/stubs/server.py # stubs de WhatsApp y Abacus en :8089
```

Emuladores de Firebase (`firebase.json` ya los configura): requieren `firebase-tools` y Java 11 o superior.

Estructura: `core/` (común, nunca importa de `modules/`), `channels/`, `ai/`, `crm/`, `modules/` (reglas por vertical), `integrations/`, `jobs/`.
