# Cambios acordados — Flujo del bot de Toma de Autos

**Documento base:** `Flujo_del_Bot_—_Toma_de_Autos_8a6bdc6d.pdf` (v1.0)  
**Estado:** alcance acordado; pendiente de implementación.  
**Criterio:** describir cambios funcionales. Las diferencias de nombres de estados o de redacción no son faltantes si el comportamiento se cumple.

## Resumen del flujo acordado

1. El Hub envía el mensaje inicial por WhatsApp con la plantilla aprobada y sus botones. Las acciones de botones se determinan por el `payload`, no por el texto visible. El bot ya interpreta respuestas escritas en texto libre; se conserva ese comportamiento.
2. Para **Vender y estrenar** y **Solo vender**, la conversación permanece con el bot, sin asignación automática inmediata a un asesor. Se mantienen las respuestas actuales del bot.
3. La elección del cliente se registra en la oferta de Valuación y produce el correo interno correspondiente. Repetir la opción actual no duplica el aviso; cambiar a otra opción sí produce el aviso de la nueva rama mientras la oferta siga abierta.
4. **Por ahora no** cierra el flujo sin correo interno ni campaña posterior.
5. Al llegar la fecha y hora de la cita, si el cliente nunca envió un mensaje, el Hub cierra la conversación y la oferta por inactividad. Si el cliente sí escribió antes de la cita, no hay cierre automático: el valuador decide cuándo cerrar la conversación.
6. Si se recibe una respuesta después de la cita, no se ejecuta la rama normal. Se deriva a Valuación con un motivo visible, por ejemplo: “Respuesta recibida después de la cita de servicio”.
7. Preguntas cubiertas por la base de conocimiento siguen siendo atendidas por el bot. Audio, imagen o documento se marcan para atención humana. La baja cierra solo la conversación actual; no agrega una exclusión global del teléfono.

---

## Repo: `cleber-hub-conversaciones`

### Cambios requeridos

- **Envío y resultado del mensaje inicial**
  - Mantener el uso de plantilla aprobada con los botones existentes.
  - Validar que no se intente enviar si falta una variable requerida o el monto es nulo/cero/no autorizado. Marcar el envío como fallido; no reintentar esos errores permanentes.
  - Ante fallos transitorios de WhatsApp, reintentar hasta **3 intentos en total** (envío inicial más hasta dos reintentos), con retroceso exponencial.
  - Si se agotan los intentos, conservar el comportamiento actual: notificación en la plataforma y actualización de la oferta; **no enviar correo al BDC**.
  - Alinear el resultado de envío con Valuación para que la oferta quede actualizada y no se considere enviada si el proveedor no confirmó el envío.

- **Decisiones de botones y conversación**
  - Enrutar los tres botones mediante `button_payload` (`OPT_VENDER_ESTRENAR`, `OPT_SOLO_VENDER`, `OPT_POR_AHORA_NO`).
  - No ejecutar una segunda vez la misma rama ni volver a notificar por una repetición de la opción actual. Si cambia la opción, registrar el nuevo resultado y emitir el evento para la nueva rama mientras Valuación permita la transición.
  - En las ramas 1 y 2 no hacer handoff automático. Seguir atendiendo preguntas con el bot y permitir cambio de opción mientras la oferta permanezca abierta.
  - Conservar las respuestas actuales del bot y la interpretación actual de texto libre.
  - Para `OPT_POR_AHORA_NO`, enviar la respuesta actual, cerrar el flujo y no programar otra campaña desde este flujo.

- **Inactividad y respuestas tardías**
  - Aplicar el plazo configurado para que, al llegar la fecha y hora de la cita, se cierre por inactividad únicamente si el cliente no envió ningún mensaje antes de la cita.
  - Al cerrar por esta condición, emitir el resultado de “no responde” a Valuación para cerrar también la oferta. No agregar recordatorios previos ni campañas posteriores.
  - Si hubo al menos un mensaje del cliente antes de la cita, no cerrar automáticamente al llegar la cita; el cierre queda a criterio del valuador.
  - Ante un mensaje recibido después de la fecha y hora programadas, no ejecutar la rama de aceptación/rechazo. Derivar a Valuación, dejando visible el motivo de la derivación en el contexto/datos de la conversación.
  - Comparar con la fecha y hora de cita en la zona horaria local de México.

- **Medios y baja**
  - Para audio, imagen o documento, responder con cortesía y marcar/derivar la conversación para atención humana.
  - La solicitud de baja cierra únicamente esa conversación; no crear una lista global de exclusión ni afectar otras campañas por ahora.

- **Configuración de destinatarios para avisos**
  - Agregar configuración administrable desde el Hub, por agencia y tipo de aviso (Opción 1 y Opción 2).
  - Permitir direcciones de correo como texto libre, una por línea, con varias direcciones y titulares/respaldo en la misma lista.
  - El envío debe poder usar las direcciones configuradas para la agencia asociada a la conversación/oferta.

### Criterios de aceptación del Hub

- Payload válido elige la rama aunque cambie la etiqueta visible del botón.
- Un webhook duplicado no duplica respuesta, transición ni aviso; volver a elegir la misma opción tampoco duplica el correo.
- Una opción distinta se procesa una vez si la oferta sigue abierta.
- El vencimiento solo cierra automáticamente si no hubo mensaje del cliente antes de la cita; si sí hubo mensaje, la conversación queda para decisión del valuador.
- Una respuesta posterior a la cita no dispara la rama normal y queda derivada a Valuación con motivo visible.
- Reintento transitorio del mensaje inicial hasta tres intentos; error permanente sin reintento; agotados los intentos, estado/notificación de plataforma como hoy, sin correo al BDC.
- Baja solo cierra la conversación actual.

---

## Repo: `toma-unidades-en-taller` (Valuación)

### Cambios requeridos

- **Procesamiento de resultados de conversación**
  - Al recibir el evento de resultado del Hub, traducir la opción a la etiqueta/estado funcional equivalente y actualizar la oferta.
  - Para la misma opción ya registrada, no volver a enviar el correo.
  - Permitir cambio entre opciones mientras la oferta no esté cerrada y emitir el correo correspondiente al nuevo resultado.
  - Procesar el evento de “no responde” del Hub y cerrar la oferta solo cuando corresponda a la regla de inactividad acordada.
  - Para respuesta posterior a la cita, aceptar la derivación informativa sin aplicar la rama normal de aceptación/rechazo.

- **Correos de las ramas**
  - Implementar el envío desde Valuación al recibir el resultado del Hub, reutilizando `Cleber.enviarEmail` y el mecanismo de configuración por ambiente.
  - **Opción 1 — Vender y estrenar:** destinatario(s) configurado(s) para BDC Comercial / Gerente de Ventas. Asunto sugerido del PDF. Incluir nombre, teléfono y correo del cliente; modelo, año, VIN y kilometraje; fecha, hora y agencia de cita; monto preliminar; acción solicitada (asignar lead a ventas); folio de conversación y fecha/hora de respuesta.
  - **Opción 2 — Solo vender:** destinatarios configurados para Gerente de Servicio, Gerente de Seminuevos y Valuador. Asunto sugerido del PDF. Incluir nombre y teléfono; modelo, año, VIN y kilometraje; fecha, hora y agencia; monto preliminar; acción solicitada (preparar valuación durante la cita); folio y fecha/hora de respuesta.
  - **Opción 3 — Por ahora no:** no enviar correo.
  - Usar las direcciones disponibles de la configuración del Hub. Si una dirección es inválida o no existe, no reintentarla; enviar a las demás direcciones válidas y registrar el fallo en logs.
  - Para errores transitorios del correo, reintentar hasta **3 intentos en total**, con retroceso exponencial. No reintentar fallos permanentes. Si no hay destinatarios, registrar el error en logs. No agregar una vista/alerta de error en la plataforma: se revisa desde los logs cuando se reporte.
  - Incluir identificador de ambiente en el asunto en ambientes no productivos. En **PRD no** agregar identificador de ambiente.
  - Los fallos de correo no deben revertir ni bloquear la respuesta/resultado del cliente. Los logs deben permitir identificar oferta/conversación, rama, dirección afectada y causa, sin registrar secretos.

- **Mensaje inicial / actualización de oferta**
  - Cuando Valuación recibe la confirmación del Hub, marcar como enviada solo tras confirmación real del proveedor.
  - Si el Hub informa error final de envío, actualizar el estado de oferta como fallido y conservar la notificación actual de plataforma. No enviar correo al BDC por ese fallo.
  - Si faltan datos requeridos de plantilla o el monto no está autorizado, registrar el envío como fallido; por ahora no hay edición de datos ni reintento manual/automático.

### Criterios de aceptación de Valuación

- Eventos repetidos con el mismo identificador son idempotentes para oferta y correo.
- Misma opción no genera correo duplicado; cambio de opción en oferta abierta actualiza resultado y genera el aviso de la opción nueva.
- Oferta cerrada no acepta una nueva rama.
- Matriz de destinatarios y contenido mínimo coinciden con el PDF.
- Un correo fallido no bloquea la conversación; fallos y reintentos quedan en logs.
- Reintentos del correo se limitan a fallos transitorios y a tres intentos totales; destinatario inválido no se reintenta.
- Asunto con ambiente en no productivo, sin sufijo/identificador en PRD.
- “No responde” cierra la oferta al recibir el evento válido de inactividad; “Por ahora no” cierra sin aviso.

---

## Integración y orden sugerido

1. Definir el contrato entre repos para configuración de destinatarios por agencia/tipo de aviso y resultado de entrega del correo.
2. Implementar configuración y persistencia de destinatarios en el Hub.
3. Implementar payload, idempotencia de decisiones y cambios de opción en el Hub.
4. Implementar el envío de correo y la idempotencia/reintentos en Valuación.
5. Alinear eventos de cierre por inactividad, respuesta tardía y confirmación/fallo de envío entre ambos repos.
6. Probar el flujo integrado en un ambiente no productivo, verificando logs, estados de oferta, destinatarios, duplicados y reintentos antes de liberar.

## Fuera de alcance acordado por ahora

- Cambiar la redacción actual de las respuestas del bot.
- Campañas posteriores a “Por ahora no” o al cierre por inactividad.
- Exclusión global del teléfono tras la baja.
- Correo al BDC cuando falla definitivamente el WhatsApp inicial.
- Corrección de datos del cliente o reintento manual del mensaje inicial por datos faltantes/no autorizados.
- Mostrar en la interfaz los errores de los correos internos; se consultan en logs.
- Agregar recordatorios antes del cierre por inactividad.
