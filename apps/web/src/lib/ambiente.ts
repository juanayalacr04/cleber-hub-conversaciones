/**
 * Ambiente de la web. Es solo para la pantalla: en producción no se pregunta a quién enviar la oferta, se manda al cliente.
 * Quien decide de verdad es el hub (variable AMBIENTE de sus Lambdas): aunque esta variable estuviera mal, un envío con
 * destino de prueba en producción se ignora allá, y uno sin destino fuera de producción se rechaza.
 *
 *   NEXT_PUBLIC_AMBIENTE=prd      producción (Vercel, entorno Production)
 *   cualquier otro / vacía        desarrollo y pruebas: el valuador elige el teléfono de destino
 */
export const esProduccion = ["prd", "prod", "produccion", "producción"].includes((process.env.NEXT_PUBLIC_AMBIENTE ?? "").trim().toLowerCase());
