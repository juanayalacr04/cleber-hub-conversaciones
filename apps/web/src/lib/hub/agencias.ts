"use server";

/**
 * Catálogo de agencias de Cleber: cleber.catalogo_quiter_workshops_dealers_warehouses (repo api, DB/Cleber), por la ruta
 * /interno/api-db del gateway con su propia API key (CLEBER_API_DB_URL / CLEBER_API_DB_KEY). SOLO SERVIDOR.
 *
 * Se filtra por el id de la marca, que es su código (p. ej. "TO"). Antes se revisa que esté entre las marcas que el
 * usuario puede ver (Hub.consultaUsuarioActual): así nadie consulta agencias de una marca que no es suya.
 * El hub guarda las agencias por valor como texto: el id numérico del catálogo (107 → "107").
 */

import { auth } from "@/lib/auth";
import type { ApiResponse } from "@/lib/api";
import { consultaUsuarioActual } from "./usuario";

export interface AgenciaCatalogo {
  idAgencia: string;
  nombre: string;
  municipio: string | null;
  estado: string | null;
}

const FUNCION = "catalogo_quiter_workshops_dealers_warehouses";

/** CLEBER_API_DB_URL puede ser la base (…/interno/api-db) o ya la URL completa de la función (…/rpc/catalogo_…). */
function urlCatalogo(base: string) {
  const b = base.trim().replace(/\/+$/, "");
  return b.endsWith(`/rpc/${FUNCION}`) ? b : `${b}/rpc/${FUNCION}`;
}

interface AgenciaApi { id: number | string; nombre: string; nombreMunicipio?: string | null; nombreEstado?: string | null }

export async function consultaAgenciasMarca(idMarca: string): Promise<ApiResponse<{ agencias: AgenciaCatalogo[] }>> {
  const base = process.env.CLEBER_API_DB_URL;
  const key = process.env.CLEBER_API_DB_KEY;
  if (!base || !key) {
    return { successful: false, errorCode: "CONFIGURACION", errorMessage: "Falta CLEBER_API_DB_URL o CLEBER_API_DB_KEY" };
  }
  const session = await auth();
  if (!session?.idToken || session.error) {
    return { successful: false, errorCode: "SESION_EXPIRADA", errorMessage: "Inicia sesión de nuevo" };
  }

  const yo = await consultaUsuarioActual();
  if (!yo.successful) return yo;
  const marca = yo.info.marcasVisibles.find((m) => m.idMarca === idMarca);
  if (!marca) return { successful: false, errorCode: "SIN_PERMISO", errorMessage: "No tienes acceso a esta marca" };

  let res: Response;
  try {
    res = await fetch(urlCatalogo(base), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Profile": "cleber", Prefer: "params=single-object", "x-api-key": key },
      body: JSON.stringify({
        action: "Cleber.catalogoQuiterWorkshopsDealersWarehouses",
        params: { estados: [], municipios: [], agencias: [], marcas: [marca.idMarca], workshops: [], warehouses: [], empresas: [] },
      }),
      cache: "no-store",
    });
  } catch (e) {
    console.error("catalogo_quiter_workshops_dealers_warehouses: sin respuesta", e);
    return { successful: false, errorCode: "SIN_CONEXION", errorMessage: "No se pudo contactar el catálogo de agencias" };
  }
  if (!res.ok) {
    console.error(`catalogo_quiter_workshops_dealers_warehouses: HTTP ${res.status}`, await res.text().catch(() => ""));
    return { successful: false, errorCode: `HTTP_${res.status}`, errorMessage: `El catálogo de agencias respondió HTTP ${res.status}` };
  }
  const r = (await res.json()) as ApiResponse<{ agencias?: AgenciaApi[] }>;
  if (!r.successful) return r;
  const agencias = (r.info.agencias ?? [])
    .map((a) => ({ idAgencia: String(a.id), nombre: a.nombre, municipio: a.nombreMunicipio ?? null, estado: a.nombreEstado ?? null }))
    .sort((a, b) => a.idAgencia.localeCompare(b.idAgencia, undefined, { numeric: true }));   // por id (107 antes que 1001)
  return { successful: true, info: { agencias } };
}
