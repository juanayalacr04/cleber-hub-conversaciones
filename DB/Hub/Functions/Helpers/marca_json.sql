/**
    Objeto Marca.

    { idMarca, nombre, sfCalendario, idSalesforce, esActiva, esSeminuevos, creadoEn, actualizadoEn }   idMarca = código de la marca

    El horario y la configuración de Salesforce no van aquí: los edita su propia pantalla.

    @Acceso No-Publica
*/
CREATE OR REPLACE FUNCTION hub_cleber.marca_json(m hub_cleber.marcas)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'idMarca',       m.id_marca,
    'nombre',        m.nombre,
    'sfCalendario',  m.sf_calendario,
    'idSalesforce',  m.id_salesforce,
    'esActiva',      m.es_activa,
    'esSeminuevos',  m.es_seminuevos,
    'creadoEn',      m.creado_en,
    'actualizadoEn', m.actualizado_en
  );
$$;

-- Solo el super admin administra marcas.
CREATE OR REPLACE FUNCTION hub_cleber.exige_super_admin(p_usuario hub_cleber.usuarios)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT coalesce((p_usuario).es_super_admin, false) OR coalesce((p_usuario).es_sistema, false) THEN
    PERFORM hub_cleber.error_de_aplicacion('SIN_PERMISO', 'Solo un super admin administra las marcas');
  END IF;
END;
$$;
