# Flujo centralizado de mensajes

Un solo flujo para los tres proveedores. El proveedor solo define cómo llega el mensaje y cómo se contesta; las reglas de negocio viven en módulos (Ventas, Servicio) que se enchufan al núcleo.

## Flujo de un mensaje entrante

```mermaid
flowchart TD
    A(["Cliente escribe por WhatsApp"]) --> B{"¿Por qué proveedor llegó?"}
    B -->|Twilio| C["Recibir webhook<br/>responder 200 de inmediato"]
    B -->|ValueText| C
    B -->|Meta| C

    C --> D["Normalizar el mensaje<br/>(teléfono, texto, nombre)"]
    D --> E["Buscar el bot activo<br/>del número de destino"]
    E --> F["Buscar o crear<br/>la conversación"]

    F --> G{"¿Un humano ya atiende<br/>desde otro sistema?"}
    G -->|Sí| G1["Solo guardar el mensaje"] --> FIN
    G -->|No| H["Guardar mensaje del cliente<br/>y reiniciar inactividad"]

    H --> I{"¿Dijo STOP?"}
    I -->|Sí| I1["Cerrar o pasar a asesor<br/>según config del bot"] --> FIN
    I -->|No| J{"¿Palabra clave<br/>de handoff?"}

    J -->|Sí| J1{"¿Se puede escalar?<br/>(módulo + horario)"}
    J1 -->|Sí| J2["Pasar a asesor<br/>avisar al cliente"] --> FIN
    J1 -->|No| J3["Avisar fuera de horario<br/>o frenar"] --> FIN

    J -->|No| K{"¿Estado de la<br/>conversación?"}
    K -->|con asesor| K1["No intervenir"] --> FIN
    K -->|esperando asesor| K2["Responder:<br/>'un asesor te atenderá'"] --> FIN
    K -->|bot| L["Enviar historial al bot de IA"]

    L --> L1["Durante el turno el bot pide<br/>sus acciones al endpoint del hub<br/>(CrearCitaQuiter, Crear_Lead...)"]
    L1 --> M["Clasificar el motivo<br/>de la conversación"]
    M --> N["Leer las acciones ya ejecutadas<br/>en el turno y su resultado"]
    N --> O{"¿El bot pidió<br/>handoff?"}

    O -->|Sí| O1{"¿Se puede escalar?"}
    O1 -->|Sí| O2["Responder y pasar a asesor"] --> FIN
    O1 -->|No| O3["Avisar fuera de horario<br/>o frenar"] --> FIN

    O -->|No| P["Bot externo: despachar sus<br/>actions[] como eventos<br/>(las demás ya corrieron)"]
    P --> Q{"¿Existe handler para<br/>la vertical de la conversación?"}
    Q -->|Ventas| Q1["Handler de Ventas<br/>(Lead, cita, Salesforce)"]
    Q -->|Servicio| Q2["Handler de Servicio"]
    Q -->|Ninguna| Q3["Handler por defecto del núcleo<br/>(nombre, situación, recordatorio)"]

    Q1 --> R
    Q2 --> R
    Q3 --> R
    R{"¿Algún handler ya<br/>contestó?"}
    R -->|Sí| FIN
    R -->|No| S["Responder al cliente<br/>guardar y enviar por el canal"] --> FIN

    FIN(["Fin del turno"])

    classDef inicio fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    classDef decision fill:#fef3c7,stroke:#d97706,color:#78350f
    classDef accion fill:#f3f4f6,stroke:#6b7280,color:#111827
    classDef modulo fill:#dcfce7,stroke:#16a34a,color:#14532d
    classDef fin fill:#fee2e2,stroke:#dc2626,color:#7f1d1d

    class A inicio
    class B,G,I,J,J1,K,O,O1,Q,R decision
    class C,D,E,F,H,L,L1,M,N,P,S,G1,I1,J2,J3,K1,K2,O2,O3 accion
    class Q1,Q2,Q3 modulo
    class FIN fin
```

**Leyenda:** azul = inicio, amarillo = decisión, gris = acción del núcleo, verde = lógica de negocio por módulo, rojo = fin.

## Qué decide el módulo y qué decide el núcleo

| Lo hace el núcleo (igual para todos) | Lo hace el módulo (según la vertical) |
|---|---|
| Recibir, normalizar y guardar el mensaje | Crear o actualizar el Lead en Salesforce |
| Detectar STOP, handoff y estado | Agendar la cita de ventas |
| Hablar con el bot de IA | Qué hacer al escalar o al cerrar por inactividad |
| Detectar qué tool pidió el bot | Reglas propias de cada área |
| Responder y guardar la respuesta | |

## Flujo aparte: el bot pide una acción

Desde el 16 de octubre de 2026 los bots de Abacus ya no devuelven acciones para que el hub las detecte: las piden por HTTP y reciben el resultado (§7.8 del plan).

```mermaid
sequenceDiagram
    participant R as Función 2 (reglas)
    participant B as Función 3 (bot)
    participant A as Abacus (Workflow o ChatLLM)
    R->>B: mensaje + expediente
    B->>A: conversación
    A->>R: POST /actions/execute<br/>{action, conversationId, idempotencyKey, data}
    Note over R: autentica al bot, valida que la acción<br/>esté habilitada y valida data.<br/>Cliente, marca y vertical salen de conversationId
    R->>R: registro de handlers (vertical de la conversación)
    R-->>A: {ok, status, result} o {ok:false, error:{code, retryable}}
    A-->>B: texto de respuesta
    B-->>R: texto
    R->>R: leer acciones del turno, responder y guardar
```

- **Workflow:** un paso HTTP. Ramifica según `error.code` y `retryable`.
- **ChatLLM:** un tool personalizado que hace el mismo POST. Falta confirmar que Abacus lo permite (tarea 1.47); si no, sigue la detección posterior.
- **Bot externo:** conserva `actions: [...]` en su respuesta; el pipeline las despacha.
- **Handoff:** el gate de horario y módulo se aplica dentro del endpoint; el bot recibe "escalado" o "fuera de horario".
- **Ojo:** la función 2 espera a la 3 mientras Abacus llama de vuelta a la 2 (reentrada, tarea 1.45).

## Flujo aparte: recordatorio por inactividad

```mermaid
flowchart TD
    A(["Cron del dashboard"]) --> B{"¿Cron autorizado?"}
    B -->|No| B1["Rechazar 401"] --> FIN
    B -->|Sí| C{"¿Qué tipo es?"}

    C -->|Contacto programado| C1["Enviar el contacto<br/>que el cliente pidió"] --> FIN
    C -->|Recordatorio| D{"¿La conversación sigue<br/>esperando respuesta?"}

    D -->|No| D1["Omitir"] --> FIN
    D -->|Sí| E{"¿Ventana de 24 h<br/>vencida?"}

    E -->|Sí| E1["Enviar plantilla aprobada"]
    E -->|No| E2["El bot redacta el recordatorio<br/>y se envía"]

    E1 --> F
    E2 --> F
    F["Registrar recordatorio enviado"] --> G{"¿Es el último?"}
    G -->|No| FIN
    G -->|Sí| H["Cerrar conversación<br/>motivo: inactividad"]
    H --> I["Avisar al módulo<br/>(ej. Ventas actualiza el Lead)"] --> FIN

    FIN(["Fin"])

    classDef decision fill:#fef3c7,stroke:#d97706,color:#78350f
    classDef accion fill:#f3f4f6,stroke:#6b7280,color:#111827
    classDef modulo fill:#dcfce7,stroke:#16a34a,color:#14532d
    classDef fin fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
    class B,C,D,E,G decision
    class B1,C1,D1,E1,E2,F,H accion
    class I modulo
    class FIN fin
```
