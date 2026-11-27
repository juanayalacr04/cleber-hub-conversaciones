/**
 * Ofertas reales de valuación (schema `valuacion`, repo toma-unidades-en-taller): tipos de lo que devuelven las
 * acciones `Valuacion.*` y cómo se muestran.
 *
 * Modelo (docs/flujo-ofertas.md): el estado lo calcula la base (VIGENTE / NO_VIGENTE / CERRADA); la etiqueta, el
 * envío y el motivo de la evaluación dan el detalle. El valuador no elige el estado: hace acciones, y `puede` dice
 * cuáles permite la base en cada oferta.
 */

export type EstadoOferta = "VIGENTE" | "NO_VIGENTE" | "CERRADA";
export type EstadoEnvio = "SIN_ENVIAR" | "SOLICITADO" | "ENVIADO" | "FALLIDO";
export type TipoEtiqueta = "VIGENTE" | "NO_VIGENTE" | "CIERRE";
export type EstadoVobo = "PENDIENTE" | "AUTORIZADO" | "RECHAZADO";

export interface Oferta {
  idOferta: number;
  version: number;
  idAgencia: string;
  nombreAgencia: string | null;
  idMarca: string;
  idCita: string;
  fechaCita: string;
  horaCita: string | null;
  fechaGeneracion: string;
  estado: EstadoOferta;
  razonNoVigente: string | null;   // RECHAZADA | VENCIDA | motivo de la evaluación (FUERA_DE_CRITERIOS, ...)
  motivoEvaluacion: string;
  esRetomada: boolean;
  retomadaEn: string | null;
  tipoServicio: string | null;
  vehiculo: { idv: string | null; placa: string | null; vin: string | null; marca: string | null; modelo: string | null; anio: number | null; kilometraje: number | null };
  contacto: { nombre: string | null; email: string | null; telefono: string | null; telefonoOriginal: string | null; claveCliente: string | null };
  mercado: { valorVenta: number | null; valorCompra: number | null; publicaciones: number | null };
  montoSugeridoVenta: number | null;
  montoSugeridoVentaCompra: number | null;
  montoOferta: number | null;
  /** VoBo del monto: fuera de ± `margen` sobre el sugerido lo autoriza un GERENTE o ADMINISTRADOR. `estado: null` = no lo requiere */
  vobo: {
    estado: EstadoVobo | null;
    margen: number | null;
    /** Rango sin VoBo; null si la oferta no tiene sugerido (cualquier monto lo requiere) */
    montoMinimo: number | null;
    montoMaximo: number | null;
    /** Al que regresa el monto si se rechaza */
    montoPrevio: number | null;
    solicitadoEn: string | null;
    solicitadoPor: string | null;
    motivoSolicitud: string | null;
    notificadoEn: string | null;
    resueltoEn: string | null;
    resueltoPor: string | null;
    motivoResolucion: string | null;
  };
  etiqueta: { idEtiqueta: string; nombre: string; tipo: TipoEtiqueta; motivo: string | null } | null;
  envio: { estado: EstadoEnvio; solicitadoEn: string | null; enviadaEn: string | null; idConversacion: string | null };
  cierre: { cerradaEn: string; cerradaPor: string | null } | null;
  /** Lo que permite el estado de la oferta; el permiso del usuario lo valida la base (ver puedeAutorizarVobo) */
  puede: { calibrar: boolean; descartar: boolean; retomar: boolean; enviar: boolean; registrarRespuesta: boolean; cerrar: boolean; resolverVobo: boolean };
  actualizadoEn: string;
}

export interface Etiqueta {
  idEtiqueta: string;
  nombre: string;
  tipo: TipoEtiqueta;
  momento: "ANTES_DE_ENVIO" | "DESPUES_DE_ENVIO";
  esRequiereMotivo: boolean;
  origenes: string[];
}

export interface EventoHistorial {
  evento: string;
  origen: string;
  usuario: string | null;
  estadoAnterior: EstadoOferta | null;
  estadoNuevo: EstadoOferta | null;
  etiquetaAnterior: string | null;
  etiquetaNueva: string | null;
  montoAnterior: number | null;
  montoNuevo: number | null;
  motivo: string | null;
  registradoEn: string;
}

/** Resultado de un criterio de la Lambda; `cumple: null` = no evaluado. */
interface Criterio { cumple: boolean | null; valor: number | null }

/** `evaluacion` de la cita (citas_evaluadas.evaluacion), tal como la devuelve la Lambda. */
export interface EvaluacionCita {
  cotizada: boolean;
  cumpleCriterios: boolean | null;
  motivo: string;
  detalle: string | null;
  error: { codigo: string; mensaje: string } | null;
  criterios: {
    anio: Criterio & { min: number; max: number };
    kilometraje: Criterio & { min: number; max: number };
    mantenimientos: Criterio & { minimo: number; aniosHistorial: number };
    publicaciones?: Criterio & { minimo: number | null };
  } | null;
}

export interface ConsultaOfertas {
  fechaGeneracion: string;
  conteo: Record<EstadoOferta, number>;
  ofertas: Oferta[];
}

export interface DetalleOferta {
  oferta: Oferta;
  evaluacion: Record<string, unknown> | null;
  historial: EventoHistorial[];
}

/** Configuración de una agencia (valuacion.configuraciones_agencias), como la devuelve consultaConfiguracion. */
export interface ConfiguracionAgencia {
  idAgencia: string;
  idTallerQuiter: string;
  nombreAgencia: string;
  idMarca: string;
  esActivo: boolean;
  criterios: {
    minYear: number; maxYear: number;
    minKm: number; maxKm: number;
    /** Al menos `minMantenimientos` en los últimos `aniosHistorial` años */
    minMantenimientos: number; aniosHistorial: number;
    minPublicaciones: number;
    tiposServicio: string[];
  };
  /**
   * % que se descuenta al precio de venta y al promedio venta-compra (0–100), y el margen en pesos (±) que el valuador
   * puede mover el monto sobre el sugerido sin VoBo del gerente
   */
  montos: { pctDescuentoVenta: number; pctDescuentoVentaCompra: number; margenAjuste: number };
  meta: { citasEsperadasDia: number; pctMetaEnvio: number; metaDiaria: number };
  actualizadoPor: string | null;
  actualizadoEn: string;
}

export type GuardaConfiguracion = Pick<ConfiguracionAgencia, "idAgencia" | "idTallerQuiter" | "nombreAgencia" | "idMarca" | "esActivo" | "criterios"> & {
  /** margenAjuste opcional: sin él la base conserva el guardado (agencia nueva: 15,000) */
  montos: { pctDescuentoVenta: number; pctDescuentoVentaCompra: number; margenAjuste?: number };
  meta: { citasEsperadasDia: number; pctMetaEnvio: number };
};

// ---------- Cómo se muestra ----------

export const ESTADOS: { id: EstadoOferta; label: string; tono: string }[] = [
  { id: "VIGENTE", label: "Vigente", tono: "agent" },
  { id: "NO_VIGENTE", label: "No vigente", tono: "closed" },
  { id: "CERRADA", label: "Cerrada", tono: "mod" },
];
export const estadoInfo = (e: EstadoOferta) => ESTADOS.find((x) => x.id === e)!;

const MOTIVOS_CRITERIO = ["FUERA_DE_CRITERIOS", "SIN_MANTENIMIENTOS_SUFICIENTES", "MERCADO_INSUFICIENTE"];
const MOTIVOS_SIN_COTIZACION = ["TRADUCCION_FALLIDA", "VERSION_NO_IDENTIFICADA", "COTIZACION_FALLIDA", "SIN_DATOS_MERCADO"];
const MOTIVOS_DATOS = ["SIN_IDENTIFICADOR_VEHICULO", "VEHICULO_NO_ENCONTRADO"];

/** Texto de cada motivo de la evaluación de la Lambda. */
export const MOTIVO_EVALUACION: Record<string, string> = {
  COTIZADA: "Cumple criterios",
  FUERA_DE_CRITERIOS: "Fuera de criterios (año, kilometraje o tipo de servicio)",
  SIN_MANTENIMIENTOS_SUFICIENTES: "Sin mantenimientos suficientes",
  MERCADO_INSUFICIENTE: "Pocas publicaciones en el mercado",
  TRADUCCION_FALLIDA: "No se pudo traducir el vehículo para Intelimotor",
  VERSION_NO_IDENTIFICADA: "No se identificó la versión del vehículo",
  COTIZACION_FALLIDA: "Falló la cotización de Intelimotor",
  SIN_DATOS_MERCADO: "Sin datos de mercado",
  SIN_IDENTIFICADOR_VEHICULO: "La cita no trae identificador del vehículo",
  VEHICULO_NO_ENCONTRADO: "No se encontró el vehículo",
};

/** Agrupa las ofertas de cada pestaña en filtros rápidos. */
export type Grupo =
  | "por_autorizar" | "por_enviar" | "enviando" | "enviadas" | "con_respuesta"
  | "rechazadas" | "no_cumple" | "sin_cotizacion" | "datos_incompletos" | "vencidas"
  | "cerradas";

export const GRUPOS: Record<EstadoOferta, { id: Grupo; label: string }[]> = {
  VIGENTE: [
    { id: "por_autorizar", label: "Por autorizar" },
    { id: "por_enviar", label: "Por enviar" },
    { id: "enviando", label: "Enviando" },
    { id: "enviadas", label: "Enviadas sin respuesta" },
    { id: "con_respuesta", label: "Con respuesta" },
  ],
  NO_VIGENTE: [
    { id: "rechazadas", label: "Rechazadas" },
    { id: "no_cumple", label: "No cumplen criterios" },
    { id: "sin_cotizacion", label: "Sin oferta de Intelimotor" },
    { id: "datos_incompletos", label: "Datos incompletos" },
    { id: "vencidas", label: "Vencidas" },
  ],
  CERRADA: [{ id: "cerradas", label: "Cerradas" }],
};

/** Línea de detalle bajo el estado (lo acordado: estado + detalle). */
export function detalleOferta(o: Oferta): { texto: string; grupo: Grupo; tono: string } {
  if (o.estado === "CERRADA") {
    return { texto: o.etiqueta?.tipo === "CIERRE" ? o.etiqueta.nombre : "Cerrada", grupo: "cerradas", tono: "mod" };
  }
  if (o.estado === "VIGENTE") {
    if (o.etiqueta?.tipo === "VIGENTE") return { texto: o.etiqueta.nombre, grupo: "con_respuesta", tono: "agent" };
    switch (o.envio.estado) {
      case "ENVIADO": return { texto: "Enviada, sin respuesta", grupo: "enviadas", tono: "bot" };
      case "SOLICITADO": return { texto: "Enviando…", grupo: "enviando", tono: "bot" };
      case "FALLIDO": return { texto: "Envío fallido", grupo: "por_enviar", tono: "crit" };
    }
    // Sin enviar: primero lo que pide el VoBo del monto
    if (o.vobo?.estado === "PENDIENTE") return { texto: "Pendiente de VoBo", grupo: "por_autorizar", tono: "wait" };
    if (o.vobo?.estado === "RECHAZADO") return { texto: "Por enviar · VoBo rechazado", grupo: "por_enviar", tono: "crit" };
    return { texto: o.esRetomada ? "Por enviar · retomada" : "Por enviar", grupo: "por_enviar", tono: "wait" };
  }
  const razon = o.razonNoVigente ?? "";
  if (razon === "RECHAZADA") return { texto: o.etiqueta?.nombre ?? "Rechazada", grupo: "rechazadas", tono: "crit" };
  if (razon === "VENCIDA") return { texto: "Vencida (no se envió a tiempo)", grupo: "vencidas", tono: "closed" };
  if (MOTIVOS_CRITERIO.includes(razon)) return { texto: "No cumple criterios", grupo: "no_cumple", tono: "closed" };
  if (MOTIVOS_SIN_COTIZACION.includes(razon)) return { texto: "Sin oferta de Intelimotor", grupo: "sin_cotizacion", tono: "closed" };
  if (MOTIVOS_DATOS.includes(razon)) return { texto: "Datos incompletos", grupo: "datos_incompletos", tono: "closed" };
  return { texto: "No vigente", grupo: "vencidas", tono: "closed" };
}

/** Por qué no está vigente, en una línea (columna "Motivo"). */
export function motivoNoVigente(o: Oferta): string {
  if (o.razonNoVigente === "RECHAZADA") return o.etiqueta?.motivo || o.etiqueta?.nombre || "Rechazada";
  if (o.razonNoVigente === "VENCIDA") return "No se envió el día de generación";
  return MOTIVO_EVALUACION[o.razonNoVigente ?? o.motivoEvaluacion] ?? o.motivoEvaluacion;
}

/**
 * Roles de valuación con el permiso `autorizar` (toma-unidades-en-taller: Datos_maestros/roles_permisos.sql). Solo
 * decide si la pantalla ofrece Autorizar / Rechazar; la base vuelve a validar el permiso y la agencia.
 */
const ROLES_AUTORIZAN_VOBO = ["GERENTE", "ADMINISTRADOR"];

export function puedeAutorizarVobo(u: { esSuperAdmin: boolean; marcas: { idMarca: string; modulos: Record<string, { rol: string } | undefined> }[] } | null, idMarca: string): boolean {
  if (!u) return false;
  if (u.esSuperAdmin) return true;
  const rol = u.marcas.find((m) => m.idMarca === idMarca)?.modulos.valuacion?.rol;
  return !!rol && ROLES_AUTORIZAN_VOBO.includes(rol);
}

/** ¿El monto requiere VoBo con el rango de la oferta? Sin sugerido (rango null), siempre. */
export function montoRequiereVobo(o: Oferta, monto: number): boolean {
  const { montoMinimo, montoMaximo } = o.vobo ?? {};
  if (montoMinimo == null || montoMaximo == null) return true;
  return monto < Number(montoMinimo) || monto > Number(montoMaximo);
}
