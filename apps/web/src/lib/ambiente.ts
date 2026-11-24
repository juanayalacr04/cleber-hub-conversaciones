/**
 * Ambiente de la web. Es solo para la pantalla: en producción no se pregunta a quién enviar la oferta, se manda al cliente.
 * Quien decide de verdad es el hub (variable AMBIENTE de sus Lambdas): aunque esta variable estuviera mal, un envío con
 * destino de prueba en producción se ignora allá, y uno sin destino fuera de producción se rechaza.
 *
 *   NEXT_PUBLIC_AMBIENTE=prd      producción (Vercel, entorno Production)
 *   NEXT_PUBLIC_AMBIENTE=qa       QA: la pastilla del menú dice QA
 *   cualquier otro / vacía        desarrollo y pruebas (pastilla DEV): el valuador elige el teléfono de destino
 */
export const esProduccion = ["prd", "prod", "produccion", "producción"].includes((process.env.NEXT_PUBLIC_AMBIENTE ?? "").trim().toLowerCase());

const ambiente = (process.env.NEXT_PUBLIC_AMBIENTE ?? "").trim().toLowerCase();

/** Pastilla de ambiente del menú: "QA" en QA, nada en producción, "DEV" en cualquier otro caso (dev, local o sin definir). */
export const etiquetaAmbiente: string | null = esProduccion ? null : ["qa"].includes(ambiente) ? "QA" : "DEV";
