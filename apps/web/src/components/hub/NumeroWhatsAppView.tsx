"use client";

/**
 * Números de WhatsApp de un módulo de la marca activa (hub_cleber), con el mismo layout que la pantalla de Ventas y Servicio
 * (app/(app)/[module]/(ported)/whatsapp): tarjetas con todos los números y un diálogo para dar de alta o editar cada uno.
 * Lee con Hub.consultaConfiguracionModulo y guarda con Hub.guardaNumero (administrador del módulo; los demás solo ven).
 * Cada módulo tiene un solo número ACTIVO por marca (A8): los demás pueden existir inactivos.
 *
 * El diálogo también captura la plantilla del módulo: la de la oferta (`plantillas.ofertaValuacion`), la que manda el hub
 * cuando el valuador pulsa Enviar (modules/valuacion.py), o la de verificación (`plantillas.verificacionTelefono`), la que se
 * manda al cliente para que confirme que su número es el correcto (modules/verificacion.py). Con Twilio, "Consultar" lee la
 * plantilla en Twilio (Hub.consultaPlantillaProveedor, Lambda hub-acciones-usuario) y muestra su vista previa con datos de
 * ejemplo; al guardar, su cuerpo y botones quedan en `texto`, que es lo que ve el chat. Con Meta y ValueText el texto se
 * captura a mano.
 * Ninguna credencial se captura aquí: Twilio usa la cuenta del ambiente (todos los números están en ella) y el token de Meta
 * va en Secrets Manager.
 */

import { useCallback, useEffect, useState } from "react";
import { signOut } from "next-auth/react";
import {
  ArrowDown, ArrowUp, Bot, Eye, EyeOff, FileText, Loader2, MoreVertical, Pencil, Phone, Plus, RefreshCw, Search, Users2, X,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import type { ModuleDef, ModuloEnHub } from "@/lib/modules";
import {
  consultaConfiguracionModulo, consultaPlantillaProveedor, guardaEquipo, guardaNumero, type ConfiguracionModulo, type GuardaNumero,
  type Numero, type PlantillaProveedor, type Proveedor,
} from "@/lib/hub/configuracion";
import { mensajeError } from "@/lib/hub/errores";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { noAbre, tarjetaClicable } from "./tarjeta";

/** Datos que Valuación manda en el contexto de cada oferta (Valuacion.solicitaEnvio), con un ejemplo ya formateado. */
const DATOS: { llave: string; etiqueta: string; ejemplo: string }[] = [
  { llave: "nombreCliente", etiqueta: "Nombre del cliente", ejemplo: "Juan Pérez" },
  { llave: "vehiculo", etiqueta: "Vehículo", ejemplo: "TOYOTA COROLLA 2020" },
  { llave: "kilometraje", etiqueta: "Kilometraje", ejemplo: "64,000 km" },
  { llave: "montoOferta", etiqueta: "Monto de la oferta", ejemplo: "270,000" },
  { llave: "agencia", etiqueta: "Agencia", ejemplo: "Toyota Satélite" },
  { llave: "fechaCita", etiqueta: "Fecha de la cita", ejemplo: "12 de noviembre" },
  { llave: "horaCita", etiqueta: "Hora de la cita", ejemplo: "09:30" },
];

/** Lo propio de cada módulo: la llave de la plantilla en `numeros.plantillas`, sus textos y sus variables. */
interface ConfigModulo {
  modulo: "valuacion" | "verificacion";
  nombre: string;
  llave: string;
  titulo: string;
  descripcion: string;
  encabezado: string;
  resumen: string;
  sinNumeros: string;
  etiquetaPlantilla: string;
  nombrePlaceholder: string;
  textoPlaceholder: string;
  notaTexto: string;
  variables: { llave: string; etiqueta: string; ejemplo: string }[];
  variablesIniciales: string[];
  notaVariables: string;
  notaVistaPrevia: string;
  notaConsulta: string;
  equipoPorDefecto: string | null;
  avisoVariables: string | null;
}

const CONFIG: Record<ModuloEnHub, ConfigModulo> = {
  valuacion: {
    modulo: "valuacion", nombre: "Valuación", llave: "ofertaValuacion",
    titulo: "Plantilla de la oferta", descripcion: "Número de Valuación de la marca y plantilla de la oferta.",
    encabezado: "Número de Valuación de la marca", resumen: "Valuación tiene un solo número activo por marca",
    sinNumeros: "Agrega el número de WhatsApp desde el que se envían las ofertas de Valuación.",
    etiquetaPlantilla: "Plantilla de oferta", nombrePlaceholder: "Valuación Toyota",
    textoPlaceholder: "Hola {{1}}, gracias por agendar el servicio de tu {{2}}...",
    notaTexto: "Cómo se ve el mensaje en el dashboard. Usa {{1}}, {{2}}... para las variables.",
    variables: DATOS, variablesIniciales: ["nombreCliente", "vehiculo", "agencia", "montoOferta"],
    notaVariables: "Qué dato de la oferta va en cada variable de la plantilla.",
    notaVistaPrevia: "Con datos de ejemplo. Así se verá la oferta en el chat del dashboard.",
    notaConsulta: "Consulta la plantilla para ver su vista previa y elegir el dato de cada variable.",
    equipoPorDefecto: "Valuación", avisoVariables: null,
  },
  verificacion: {
    modulo: "verificacion", nombre: "Verificación", llave: "verificacionTelefono",
    titulo: "Plantilla de verificación", descripcion: "Número de Verificación de la marca y plantilla que se manda al cliente.",
    encabezado: "Número de Verificación de la marca", resumen: "Verificación tiene un solo número activo por marca",
    sinNumeros: "Agrega el número de WhatsApp desde el que se piden las verificaciones a los clientes.",
    etiquetaPlantilla: "Plantilla de verificación", nombrePlaceholder: "Verificación Toyota",
    textoPlaceholder: "¿Es correcto este número de WhatsApp? Confirma con el botón.",
    notaTexto: "Cómo se ve el mensaje en el dashboard.",
    variables: [], variablesIniciales: [],
    notaVariables: "",
    notaVistaPrevia: "Con datos de ejemplo. Así se verá el mensaje en el chat del dashboard.",
    notaConsulta: "Consulta la plantilla para ver su vista previa.",
    equipoPorDefecto: null,
    avisoVariables: "La plantilla de verificación no debe llevar variables: solo pide al cliente confirmar que el número es correcto.",
  },
};

const ejemploDe = (cfg: ConfigModulo, llave: string) => cfg.variables.find((d) => d.llave === llave)?.ejemplo ?? `[${llave}]`;

/**
 * Por proveedor: qué id de cuenta pide (null: ninguno), qué id de plantilla y qué credencial va en Secrets Manager.
 * Twilio no pide nada: todos los números están en la cuenta de Twilio del ambiente (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN).
 */
const PROVEEDORES: Record<Proveedor, {
  nombre: string; corto: string; color: string; campoCuenta: "metaPhoneNumberId" | "valuetextSenderId" | null;
  etiquetaCuenta: string; placeholderCuenta: string; etiquetaPlantilla: string; pistaPlantilla: string; credencial: string | null;
  notaCredenciales: string;
}> = {
  twilio: {
    nombre: "Twilio", corto: "Twilio", color: "border-green-500 text-[var(--ok)]", campoCuenta: null,
    etiquetaCuenta: "", placeholderCuenta: "",
    etiquetaPlantilla: "Content SID", pistaPlantilla: "De la plantilla aprobada en Twilio (Content Template Builder); empieza con HX.",
    credencial: null, notaCredenciales: "Usa la cuenta de Twilio del ambiente: no hay que capturar Account SID ni token.",
  },
  meta: {
    nombre: "Meta (WhatsApp Cloud API)", corto: "Meta", color: "border-blue-500 text-[var(--info)]", campoCuenta: "metaPhoneNumberId",
    etiquetaCuenta: "Phone Number ID", placeholderCuenta: "ID numérico del número en Meta",
    etiquetaPlantilla: "Nombre de la plantilla", pistaPlantilla: "Tal como está aprobada en WhatsApp Manager.", credencial: "metaAccessToken",
    notaCredenciales: "",
  },
  valuetext: {
    nombre: "ValueText", corto: "ValueText", color: "border-purple-500 text-purple-700", campoCuenta: "valuetextSenderId",
    etiquetaCuenta: "Sender ID (ValueText)", placeholderCuenta: "Identificador del remitente en ValueText",
    etiquetaPlantilla: "Template ID", pistaPlantilla: "Plantilla de ValueText.", credencial: null,
    notaCredenciales: "ValueText usa las credenciales de Salesforce del ambiente.",
  },
};

interface Borrador {
  nombre: string;
  telefono: string;
  proveedor: Proveedor;
  idCuenta: string;
  idEquipo: string;
  idBot: string;
  ventana: string;
  esActivo: boolean;
  plantillaId: string;
  idioma: string;
  variables: string[];
  texto: string;
}

const VACIO: Borrador = {
  nombre: "", telefono: "", proveedor: "twilio", idCuenta: "", idEquipo: "", idBot: "", ventana: "96", esActivo: true,
  plantillaId: "", idioma: "es_MX", variables: [], texto: "",
};

const vacio = (cfg: ConfigModulo): Borrador => ({ ...VACIO, variables: [...cfg.variablesIniciales] });

const cuentaDe = (n: Numero) => {
  const campo = PROVEEDORES[n.proveedor].campoCuenta;
  return campo ? n.configProveedor?.[campo] : undefined;
};

const plantillaDeNumero = (n: Numero, cfg: ConfigModulo) => (n.plantillas?.[cfg.llave] ?? null) as Record<string, unknown> | null;

function aBorrador(n: Numero, cfg: ConfigModulo): Borrador {
  const p = plantillaDeNumero(n, cfg) ?? {};
  const texto = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : "");
  return {
    nombre: n.nombre, telefono: n.telefono, proveedor: n.proveedor,
    idCuenta: cuentaDe(n) ?? "",
    idEquipo: n.idEquipo ?? "", idBot: n.idBotDefault ?? "", ventana: String(n.ventanaReaperturaHoras), esActivo: n.esActivo,
    plantillaId: n.proveedor === "twilio" ? texto("contentSid") : texto("templateName"),
    idioma: texto("templateLanguage") || "es_MX",
    variables: Array.isArray(p.variables) ? (p.variables as string[]) : [...cfg.variablesIniciales],
    texto: texto("texto"),
  };
}

/** plantillas.<llave del módulo> en la forma que lee el backend; null si no hay id de plantilla. */
function plantillaDe(d: Borrador, cfg: ConfigModulo): Record<string, unknown> | null {
  const id = d.plantillaId.trim();
  if (!id) return null;
  const base = {
    ...(cfg.variables.length > 0 ? { variables: d.variables } : {}),
    ...(d.texto.trim() ? { texto: d.texto.trim() } : {}),
  };
  if (d.proveedor === "twilio") return { contentSid: id, ...base };
  if (d.proveedor === "meta") return { templateName: id, templateLanguage: d.idioma.trim() || "es", ...base };
  return { templateName: id, ...base };
}

/** {{1}}, {{2}}... con el ejemplo del dato elegido para cada variable; las que no tienen dato se dejan como están. */
const conEjemplos = (texto: string, variables: string[], cfg: ConfigModulo) =>
  texto.replace(/\{\{\s*(\d+)\s*\}\}/g, (m, i) => (variables[Number(i) - 1] ? ejemploDe(cfg, variables[Number(i) - 1]) : m));

/** Cuántas variables numeradas ({{1}}…{{n}}) usa la plantilla del proveedor. */
const cuantasVariables = (p: PlantillaProveedor) => Math.max(0, ...p.variables.filter((v) => /^\d+$/.test(v)).map(Number));

/** Texto que guarda el chat: cuerpo y botones, en la misma forma que channels/campaign_templates.render_text. */
const textoDePlantilla = (p: PlantillaProveedor) =>
  p.cuerpo + (p.botones.length ? "\n\n" + p.botones.map((b) => `[${b.titulo}]`).join("  ") : "");

/** Error de una acción del hub → mensaje para el usuario. */
function mensajeGuardado(r: { errorCode: string; errorMessage: string; info?: unknown }, cfg: ConfigModulo) {
  const info = (r.info ?? {}) as { motivo?: string };
  if (info.motivo === "TELEFONO_EN_USO") return "Ese teléfono ya está activo en otro número del hub.";
  if (info.motivo === "NUMERO_EXISTENTE") return `${cfg.nombre} ya tiene un número activo en esta marca: desactívalo primero o guarda este como inactivo.`;
  return mensajeError(r, cfg.nombre);
}

export function NumeroWhatsAppView({ mod }: { mod: ModuleDef }) {
  const cfg = CONFIG[mod.id as ModuloEnHub];
  const { userData } = useAuth();
  const idMarca = userData?.organizationId ?? null;
  const [conf, setConf] = useState<ConfiguracionModulo | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Diálogo: null = cerrado; editando = null → alta
  const [abierto, setAbierto] = useState(false);
  const [editando, setEditando] = useState<Numero | null>(null);
  const [form, setForm] = useState<Borrador>(() => vacio(cfg));
  const [guardando, setGuardando] = useState(false);
  // Twilio: la plantilla consultada y el Content SID con que se consultó (solo vale si sigue siendo el capturado)
  const [consultada, setConsultada] = useState<{ id: string; plantilla: PlantillaProveedor } | null>(null);
  const [consultando, setConsultando] = useState(false);
  const [errorConsulta, setErrorConsulta] = useState<string | null>(null);

  const sesionVencida = (r: { errorCode: string; errorMessage: string }) => { toast.error(mensajeError(r)); signOut({ redirectTo: "/login" }); };

  const carga = useCallback(async () => {
    if (!idMarca) return;
    setError(null);
    const r = await consultaConfiguracionModulo({ idMarca, modulo: cfg.modulo });
    if (r.successful) { setConf(r.info); return; }
    if (r.errorCode === "SESION_EXPIRADA") return sesionVencida(r);
    setError(mensajeError(r));
  }, [idMarca, cfg.modulo]);

  useEffect(() => { setConf(null); carga(); }, [carga]);

  const nombreEquipo = (id: string | null) => (id ? conf?.equipos.find((e) => e.idEquipo === id)?.nombre ?? "—" : "Sin equipo");
  const nombreBot = (id: string | null) => (id ? conf?.bots.find((b) => b.idBot === id)?.nombre ?? "—" : "Sin bot");

  /** Lee la plantilla en Twilio (Lambda hub-acciones) y deja una variable por cada {{n}} que use, conservando lo elegido. */
  const consultaPlantilla = async (id: string) => {
    if (!idMarca || !id) return;
    setConsultando(true);
    setErrorConsulta(null);
    try {
      const r = await consultaPlantillaProveedor({ idMarca, modulo: cfg.modulo, idPlantilla: id });
      if (!r.successful) {
        if (r.errorCode === "SESION_EXPIRADA") return sesionVencida(r);
        setConsultada(null);
        // Los de Twilio traen la causa en errorMessage; mensajeError los traduciría como errores del envío de la oferta
        setErrorConsulta(["PROVEEDOR_NO_CONFIGURADO", "ERROR_PROVEEDOR"].includes(r.errorCode) ? r.errorMessage : mensajeError(r));
        return;
      }
      const n = cuantasVariables(r.info);
      setConsultada({ id, plantilla: r.info });
      setForm((x) => (x.plantillaId.trim() === id
        ? { ...x, variables: cfg.variables.length > 0 ? Array.from({ length: n }, (_, i) => x.variables[i] ?? "") : [] }
        : x));
    } finally {
      setConsultando(false);
    }
  };

  const abreAlta = () => {
    const hayActivo = conf?.numeros.some((n) => n.esActivo) ?? false;
    setEditando(null);
    setForm({ ...vacio(cfg), idEquipo: conf?.equipos.find((e) => e.esActivo)?.idEquipo ?? "", esActivo: !hayActivo });
    setConsultada(null);
    setErrorConsulta(null);
    setAbierto(true);
  };
  const abreEdicion = (n: Numero) => {
    const b = aBorrador(n, cfg);
    setEditando(n);
    setForm(b);
    setConsultada(null);
    setErrorConsulta(null);
    setAbierto(true);
    if (n.proveedor === "twilio" && b.plantillaId) consultaPlantilla(b.plantillaId);   // la vista previa de lo guardado
  };

  /** Guarda en hub_cleber. Sin equipos en el módulo crea el equipo por defecto (solo Valuación) para que sus valuadores vean sus conversaciones. */
  const guarda = async (p: Omit<GuardaNumero, "idMarca" | "modulo">, exito: string) => {
    if (!idMarca) return false;
    setGuardando(true);
    try {
      let idEquipo = p.idEquipo;
      if (!p.idNumero && !idEquipo && (conf?.equipos.length ?? 0) === 0 && cfg.equipoPorDefecto) {
        const e = await guardaEquipo({ idMarca, modulo: cfg.modulo, nombre: cfg.equipoPorDefecto });
        if (!e.successful) { toast.error(mensajeError(e)); return false; }
        idEquipo = e.info.equipo.idEquipo;
      }
      const r = await guardaNumero({ ...p, ...(idEquipo !== undefined ? { idEquipo } : {}), idMarca, modulo: cfg.modulo });
      if (!r.successful) {
        if (r.errorCode === "SESION_EXPIRADA") sesionVencida(r); else toast.error(mensajeGuardado(r, cfg));
        return false;
      }
      toast.success(exito);
      await carga();
      return true;
    } finally {
      setGuardando(false);
    }
  };

  const f = form;
  const prov = PROVEEDORES[f.proveedor];
  const ventana = Number(f.ventana);
  const idPlantilla = f.plantillaId.trim();
  const esTwilio = f.proveedor === "twilio";
  const vigente = esTwilio && consultada?.id === idPlantilla ? consultada.plantilla : null;
  // Editando sin cambiar el Content SID: si no se pudo consultar, se conserva lo guardado (variables y texto)
  const guardadaSinCambio = esTwilio && editando?.proveedor === "twilio" && idPlantilla === aBorrador(editando, cfg).plantillaId;
  // La plantilla de verificación no lleva variables: si la consultada las trae, no se puede guardar
  const variablesNoPermitidas = !!cfg.avisoVariables && !!vigente && cuantasVariables(vigente) > 0;
  const errorForm =
    !f.nombre.trim() ? "Captura el nombre para mostrar"
    : f.telefono.replace(/\D/g, "").length < 10 ? "Captura el número de teléfono (al menos 10 dígitos)"
    : prov.campoCuenta && !f.idCuenta.trim() ? `Captura el ${prov.etiquetaCuenta}`
    : f.ventana === "" || !Number.isInteger(ventana) || ventana < 0 || ventana > 720 ? "La ventana de reapertura va de 0 a 720 horas"
    : esTwilio && idPlantilla && !vigente && !guardadaSinCambio ? "Consulta la plantilla de Twilio antes de guardar"
    : variablesNoPermitidas ? "La plantilla de verificación no debe llevar variables: usa una plantilla sin {{n}}"
    : idPlantilla && f.variables.some((v) => !v) ? "Elige el dato de cada variable de la plantilla"
    : null;

  const guardaForm = async () => {
    if (errorForm) { toast.error(errorForm); return; }
    // Las demás plantillas del número se conservan; la del módulo se reemplaza (o se quita si no hay id)
    const otras = Object.fromEntries(Object.entries(editando?.plantillas ?? {}).filter(([k]) => k !== cfg.llave));
    // Twilio: el chat guarda el texto de la plantilla consultada (el envío ya no tiene que pedírselo a Twilio)
    const plantilla = plantillaDe(vigente ? { ...f, texto: textoDePlantilla(vigente) } : f, cfg);
    const ok = await guarda({
      ...(editando ? { idNumero: editando.idNumero } : {}),
      nombre: f.nombre.trim(), telefono: f.telefono.trim(), proveedor: f.proveedor,
      // Twilio guarda {}: así también se limpia el Account SID que haya quedado de antes
      configProveedor: prov.campoCuenta ? { [prov.campoCuenta]: f.idCuenta.trim() } : {},
      idEquipo: f.idEquipo || (editando ? null : undefined), idBotDefault: f.idBot || null,
      ventanaReaperturaHoras: ventana, esActivo: f.esActivo,
      plantillas: { ...otras, ...(plantilla ? { [cfg.llave]: plantilla } : {}) },
    }, editando ? "Número actualizado" : "Número agregado");
    if (ok) setAbierto(false);
  };

  const cambiaEstado = (n: Numero) =>
    guarda({ idNumero: n.idNumero, esActivo: !n.esActivo }, n.esActivo ? "Número desactivado" : "Número activado");

  const edita = (cambio: Partial<Borrador>) => setForm((x) => ({ ...x, ...cambio }));
  const selectorDato = (i: number) => (
    <Select value={f.variables[i] || "none"} onValueChange={(x) => edita({ variables: f.variables.map((y, j) => (j === i ? (x === "none" ? "" : x) : y)) })}>
      <SelectTrigger className="h-8"><SelectValue placeholder="Elige un dato" /></SelectTrigger>
      <SelectContent>
        <SelectItem value="none">Elige un dato</SelectItem>
        {cfg.variables.map((o) => <SelectItem key={o.llave} value={o.llave}>{o.etiqueta}</SelectItem>)}
      </SelectContent>
    </Select>
  );
  const mueve = (i: number, delta: number) => {
    const v = [...f.variables];
    [v[i], v[i + delta]] = [v[i + delta], v[i]];
    edita({ variables: v });
  };

  if (!idMarca) {
    return (
      <div>
        <div className="mb-8"><h1 className="text-2xl font-bold">Números de WhatsApp</h1><p className="text-muted-foreground">{cfg.encabezado}</p></div>
        <Card><CardContent className="py-8 text-center"><p className="text-muted-foreground">Necesitas pertenecer a una marca para ver los números.</p></CardContent></Card>
      </div>
    );
  }
  if (error) {
    return (
      <div>
        <div className="mb-8"><h1 className="text-2xl font-bold">Números de WhatsApp</h1></div>
        <Card><CardContent className="py-8 text-center space-y-3">
          <p className="text-muted-foreground">No se pudieron cargar los números: {error}</p>
          <Button variant="outline" onClick={carga}>Reintentar</Button>
        </CardContent></Card>
      </div>
    );
  }
  if (!conf) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }

  const puedeEditar = conf.puedeEditar;
  const numeros = [...conf.numeros].sort((a, b) => Number(b.esActivo) - Number(a.esActivo) || a.nombre.localeCompare(b.nombre));

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">Números de WhatsApp</h1>
          <p className="text-muted-foreground">
            {numeros.length} número{numeros.length !== 1 ? "s" : ""} configurado{numeros.length !== 1 ? "s" : ""} · {cfg.resumen}
          </p>
        </div>
        {puedeEditar && (
          <Button onClick={abreAlta}><Plus className="mr-2 h-4 w-4" />Agregar número</Button>
        )}
      </div>

      {numeros.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <div className="rounded-full bg-muted p-4 mb-4"><Phone className="h-8 w-8 text-muted-foreground" /></div>
            <h3 className="text-lg font-medium mb-2">No hay números configurados</h3>
            <p className="text-muted-foreground text-center mb-4">{cfg.sinNumeros}</p>
            {puedeEditar && <Button onClick={abreAlta}><Plus className="mr-2 h-4 w-4" />Agregar número</Button>}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {numeros.map((n) => {
            const p = PROVEEDORES[n.proveedor];
            const plantilla = plantillaDeNumero(n, cfg);
            const idPlantilla = plantilla && (plantilla.contentSid ?? plantilla.templateName);
            const cuenta = cuentaDe(n);
            return (
              <Card key={n.idNumero} {...tarjetaClicable(puedeEditar ? () => abreEdicion(n) : null, `Editar el número ${n.nombre}`)}>
                <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
                  <div>
                    <CardTitle className="text-lg flex items-center gap-2"><Phone className="h-5 w-5 text-[var(--ok)]" />{n.nombre}</CardTitle>
                    <p className="text-sm text-muted-foreground mt-1 font-mono">{n.telefono}</p>
                  </div>
                  {puedeEditar && (
                    <div {...noAbre}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label="Acciones del número"><MoreVertical className="h-4 w-4" /></Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => abreEdicion(n)}><Pencil className="mr-2 h-4 w-4" />Editar</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => cambiaEstado(n)} disabled={guardando}>
                          {n.esActivo ? <><EyeOff className="mr-2 h-4 w-4" />Desactivar</> : <><Eye className="mr-2 h-4 w-4" />Activar</>}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    </div>
                  )}
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Badge variant={n.esActivo ? "default" : "secondary"}>{n.esActivo ? "Activo" : "Inactivo"}</Badge>
                      <Badge variant="outline" className={p.color}>{p.corto}</Badge>
                    </div>
                    <div className="space-y-2 text-sm">
                      <div className="flex items-center gap-2"><Users2 className="h-4 w-4 text-muted-foreground" /><span>Equipo: {nombreEquipo(n.idEquipo)}</span></div>
                      <div className="flex items-center gap-2"><Bot className="h-4 w-4 text-muted-foreground" /><span>Bot: {nombreBot(n.idBotDefault)}</span></div>
                      <div className="flex items-center gap-2"><RefreshCw className="h-4 w-4 text-muted-foreground" /><span>Ventana reapertura: {n.ventanaReaperturaHoras}h</span></div>
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        <span>{cfg.etiquetaPlantilla}: {idPlantilla ? <span className="font-mono">{String(idPlantilla)}</span> : <span className="text-[var(--warn)]">sin configurar</span>}</span>
                      </div>
                    </div>
                    <div className="pt-2 border-t space-y-1">
                      {cuenta && <p className="text-xs text-muted-foreground">{p.etiquetaCuenta}: {cuenta.slice(0, 10)}…</p>}
                      {n.proveedor === "twilio" && <p className="text-xs text-muted-foreground">Cuenta de Twilio del ambiente</p>}
                      {p.credencial && (
                        <p className="text-xs text-muted-foreground">
                          Credencial en Secrets Manager: <span className="font-mono">hub/dev/numbers/{n.idNumero}</span> ({p.credencial})
                        </p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={abierto} onOpenChange={(o) => !guardando && setAbierto(o)}>
        <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editando ? "Editar número de WhatsApp" : "Agregar número de WhatsApp"}</DialogTitle>
            <DialogDescription>{cfg.descripcion}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="wa-tel">Número de teléfono</Label>
              <Input id="wa-tel" placeholder="+525512345678" value={f.telefono} onChange={(e) => edita({ telefono: e.target.value })} />
              <p className="text-xs text-muted-foreground">Formato: +[código país][número], o 10 dígitos para México</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="wa-nombre">Nombre para mostrar</Label>
              <Input id="wa-nombre" placeholder={cfg.nombrePlaceholder} value={f.nombre} onChange={(e) => edita({ nombre: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Proveedor</Label>
              <Select value={f.proveedor} onValueChange={(v) => edita({ proveedor: v as Proveedor, idCuenta: "", plantillaId: "" })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(PROVEEDORES) as Proveedor[]).map((k) => <SelectItem key={k} value={k}>{PROVEEDORES[k].nombre}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {prov.campoCuenta ? (
              <div className="space-y-2">
                <Label htmlFor="wa-cuenta">{prov.etiquetaCuenta}</Label>
                <Input id="wa-cuenta" placeholder={prov.placeholderCuenta} value={f.idCuenta} onChange={(e) => edita({ idCuenta: e.target.value })} />
                {prov.credencial ? (
                  <p className="text-xs text-muted-foreground">
                    La credencial ({prov.credencial}) no se captura aquí: va en AWS Secrets Manager,
                    en <span className="font-mono">hub/dev/numbers/{editando?.idNumero ?? "<id del número>"}</span>.
                  </p>
                ) : <p className="text-xs text-muted-foreground">{prov.notaCredenciales}</p>}
              </div>
            ) : <p className="text-xs text-muted-foreground">{prov.notaCredenciales}</p>}
            <div className="space-y-2">
              <Label>Equipo</Label>
              {conf.equipos.length > 0 ? (
                <Select value={f.idEquipo || "none"} onValueChange={(v) => edita({ idEquipo: v === "none" ? "" : v })}>
                  <SelectTrigger><SelectValue placeholder="Seleccionar equipo" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Sin equipo</SelectItem>
                    {conf.equipos.map((e) => <SelectItem key={e.idEquipo} value={e.idEquipo}>{e.nombre}{e.esActivo ? "" : " (inactivo)"}</SelectItem>)}
                  </SelectContent>
                </Select>
              ) : <p className="text-xs text-muted-foreground">{cfg.equipoPorDefecto ? `Al guardar se crea el equipo ${cfg.equipoPorDefecto}.` : `${cfg.nombre} no usa equipos.`}</p>}
            </div>
            <div className="space-y-2">
              <Label>Bot por defecto</Label>
              <Select value={f.idBot || "none"} onValueChange={(v) => edita({ idBot: v === "none" ? "" : v })} disabled={conf.bots.length === 0}>
                <SelectTrigger><SelectValue placeholder="Seleccionar bot" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Sin bot</SelectItem>
                  {conf.bots.map((b) => <SelectItem key={b.idBot} value={b.idBot}>{b.nombre}{b.esActivo ? "" : " (inactivo)"}</SelectItem>)}
                </SelectContent>
              </Select>
              {conf.bots.length === 0 && <p className="text-xs text-muted-foreground">Aún no hay bots de {cfg.nombre} en esta marca.</p>}
            </div>

            <div className="pt-2 border-t space-y-2">
              <p className="text-sm font-medium">Configuración de conversaciones</p>
              <div className="space-y-2">
                <Label htmlFor="wa-ventana">Ventana de reapertura (horas)</Label>
                <Input id="wa-ventana" type="number" min="0" max="720" placeholder="96" value={f.ventana} onChange={(e) => edita({ ventana: e.target.value })} />
                <p className="text-xs text-muted-foreground">Si el cliente vuelve a escribir dentro de estas horas, sigue la misma conversación. 0 = nunca.</p>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={f.esActivo} onChange={(e) => edita({ esActivo: e.target.checked })} />Número activo
              </label>
            </div>

            <div className="pt-2 border-t space-y-2">
              <p className="text-sm font-medium">{cfg.titulo}</p>
              <div className="space-y-2">
                <Label htmlFor="wa-plantilla">{prov.etiquetaPlantilla}</Label>
                <div className="flex gap-2">
                  <Input id="wa-plantilla" placeholder={esTwilio ? "HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" : "nombre_plantilla_aprobada"}
                    value={f.plantillaId} onChange={(e) => { edita({ plantillaId: e.target.value }); setErrorConsulta(null); }} />
                  {esTwilio && (
                    <Button type="button" variant="outline" disabled={!idPlantilla || consultando} onClick={() => consultaPlantilla(idPlantilla)}>
                      {consultando ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}Consultar
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{prov.pistaPlantilla} Sin plantilla, el envío falla con &quot;Falta configurar la plantilla&quot;.</p>
                {errorConsulta && <p className="text-xs text-[var(--crit)]">No se pudo consultar la plantilla: {errorConsulta}</p>}
              </div>
              {f.proveedor === "meta" && (
                <div className="space-y-2">
                  <Label htmlFor="wa-idioma">Idioma de la plantilla</Label>
                  <Input id="wa-idioma" placeholder="es_MX" value={f.idioma} onChange={(e) => edita({ idioma: e.target.value })} />
                </div>
              )}
              {esTwilio ? (
                vigente ? (
                  <>
                    <p className="text-xs text-muted-foreground">
                      Plantilla <span className="font-mono">{vigente.nombre ?? idPlantilla}</span>{vigente.idioma ? ` · ${vigente.idioma}` : ""}
                    </p>
                    {f.variables.length > 0 && (
                      <div className="space-y-2">
                        <Label>Variables</Label>
                        {f.variables.map((_, i) => (
                          <div key={i} className="flex items-center gap-1">
                            <span className="font-mono text-xs w-10 shrink-0">{`{{${i + 1}}}`}</span>
                            {selectorDato(i)}
                          </div>
                        ))}
                        <p className="text-xs text-muted-foreground">{cfg.notaVariables}</p>
                      </div>
                    )}
                    {variablesNoPermitidas && <p className="text-xs text-[var(--crit)]">{cfg.avisoVariables}</p>}
                    <div className="space-y-2">
                      <Label>Vista previa</Label>
                      <div className="rounded-md border bg-muted p-3 space-y-2">
                        <p className="text-sm whitespace-pre-wrap">{conEjemplos(vigente.cuerpo, f.variables, cfg)}</p>
                        {vigente.botones.map((b, i) => (
                          <div key={i} className="rounded-md border bg-background py-1.5 text-center text-sm text-[var(--info)]">
                            {conEjemplos(b.titulo, f.variables, cfg)}
                          </div>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground">{cfg.notaVistaPrevia}</p>
                    </div>
                  </>
                ) : idPlantilla && !errorConsulta ? (
                  <p className="text-xs text-muted-foreground">
                    {consultando ? "Consultando la plantilla en Twilio…"
                      : guardadaSinCambio ? "Consulta la plantilla para ver su vista previa; si no, se conserva lo guardado."
                      : cfg.notaConsulta}
                  </p>
                ) : null
              ) : (
                <>
                  {cfg.variables.length > 0 && (
                    <div className="space-y-2">
                      <Label>Variables</Label>
                      {f.variables.map((_, i) => (
                        <div key={i} className="flex items-center gap-1">
                          <span className="font-mono text-xs w-10 shrink-0">{`{{${i + 1}}}`}</span>
                          {selectorDato(i)}
                          <Button type="button" variant="ghost" size="icon" className="h-8 w-8" disabled={i === 0} onClick={() => mueve(i, -1)} aria-label="Subir"><ArrowUp className="h-4 w-4" /></Button>
                          <Button type="button" variant="ghost" size="icon" className="h-8 w-8" disabled={i === f.variables.length - 1} onClick={() => mueve(i, 1)} aria-label="Bajar"><ArrowDown className="h-4 w-4" /></Button>
                          <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={() => edita({ variables: f.variables.filter((_, j) => j !== i) })} aria-label="Quitar"><X className="h-4 w-4" /></Button>
                        </div>
                      ))}
                      <Button type="button" variant="outline" size="sm" onClick={() => edita({ variables: [...f.variables, ""] })}><Plus className="mr-1 h-3 w-3" />Agregar variable</Button>
                      <p className="text-xs text-muted-foreground">En el mismo orden que las variables de la plantilla aprobada.</p>
                    </div>
                  )}
                  <div className="space-y-2">
                    <Label htmlFor="wa-texto">Texto en el chat</Label>
                    <Textarea id="wa-texto" rows={4} placeholder={cfg.textoPlaceholder} value={f.texto} onChange={(e) => edita({ texto: e.target.value })} />
                    <p className="text-xs text-muted-foreground">{cfg.notaTexto}</p>
                    {f.texto.trim() && (
                      <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground whitespace-pre-wrap">{conEjemplos(f.texto, f.variables, cfg)}</div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAbierto(false)} disabled={guardando}>Cancelar</Button>
            <Button onClick={guardaForm} disabled={guardando}>
              {guardando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{editando ? "Guardar" : "Agregar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
