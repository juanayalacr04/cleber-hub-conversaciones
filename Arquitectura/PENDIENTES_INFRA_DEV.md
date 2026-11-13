# Pendientes de infraestructura — ambiente de desarrollo

Revisión del 2026-11-13, al configurar el API Gateway del hub y de valuación ([`GUIA_API_GATEWAY.md`](GUIA_API_GATEWAY.md)). Para quien administra la cuenta de AWS de desarrollo.

## Contexto

| | Desarrollo | Producción |
|---|---|---|
| Cuenta de AWS | `807746362931` | `386458449724` |
| VPC | `vpc-9edb67e4` | `vpc-562fec33` |
| PostgREST | EC2 con nombre público `ec2-3-89-235-189.compute-1.amazonaws.com:3000` | EC2 `api-cleber-postgrest` (`10.0.1.80:3000`), solo privado |
| Cómo llega el API Gateway a PostgREST | **Temporal:** integración HTTP directa a la dirección pública del EC2 | VPC Link `g55dvn` → NLB interno → PostgREST |
| Grupo de seguridad de PostgREST | `sg-0095c3ac42151c9e4` (`postgrest-dev-sg`) | — |

En desarrollo, el API Gateway, la Lambda `authorizer-google-dev` y PostgREST están en la cuenta `807746362931`. El VPC Link y el NLB de producción no sirven para dev: un VPC Link no cruza cuentas ni VPCs.

## Pendientes

### Seguridad (prioridad alta)

| # | Pendiente | Por qué importa | Qué hacer |
|---|-----------|-----------------|-----------|
| S1 | **PostgREST de dev abierto a internet**: regla de entrada `3000-3001` desde `0.0.0.0/0` en `postgrest-dev-sg` | Cualquiera que conozca la URL llama a PostgREST **sin pasar por el API Gateway ni por el authorizer**, y puede mandar el `X-User-Email` que quiera: se salta toda la identidad y los permisos. `db_dev_01` tiene correos de usuarios y teléfonos de clientes | Cuando exista el acceso privado (I1), quitar la regla `0.0.0.0/0` y dejar solo el origen del NLB o de la VPC |
| S2 | **SSH (22) abierto a internet** (`0.0.0.0/0`) | El servidor recibe intentos de entrada automáticos de todo internet | Restringir a la IP de la oficina o VPN, o quitar SSH y usar AWS Systems Manager Session Manager |
| S3 | **Puertos 4000 y 5000-5001 abiertos a internet** | No se sabe qué servicio los usa; cada puerto abierto es superficie de ataque | Identificar qué escucha ahí. Si no se usa, cerrar; si se usa, restringir el origen |
| S4 | Mitigación mientras S1 siga abierto (opcional) | Que una llamada directa a PostgREST no funcione aunque el puerto esté abierto | El gateway agrega un header fijo y secreto en la integración (p. ej. `X-Gateway-Secret`), y PostgREST lo valida en una función `db-pre-request`; sin él, rechaza. Requiere cambiar la configuración de PostgREST de dev |

### Conectividad

| # | Pendiente | Qué hacer |
|---|-----------|-----------|
| I1 | **Reemplazar la integración HTTP directa por una privada**, como en producción | En la cuenta `807746362931`: un NLB interno en `vpc-9edb67e4` con el EC2 de PostgREST como destino (puerto 3000), un VPC Link del API Gateway de dev hacia ese NLB y las rutas `/toma-unidades` y `/hub` con integración *VPC Link*. Después, S1 |
| I2 | **El nombre `ec2-3-89-235-189…` puede cambiar** | Si la instancia se detiene y no tiene Elastic IP, cambia su IP pública y la integración se rompe. Asignar una Elastic IP, o resolverlo con I1 (el NLB usa la instancia, no su IP pública) |

### Verificaciones pendientes (guía, pasos 6 y 7)

| # | Pendiente | Cómo |
|---|-----------|------|
| V1 | Que el mapeo `X-User-Email ← context.authorizer.email` **sobrescriba** el header que mande el cliente | Paso 7.2 de la guía: llamar con un `X-User-Email` falso y comprobar que la respuesta trae el correo real |
| V2 | Qué hace PostgREST con el header `Authorization: Bearer <id_token de Google>` | Paso 7.1. Si responde 401 o `PGRST300`, aplicar el plan B del paso 6 (`X-Id-Token`) |

### Para pasar a producción

| # | Pendiente |
|---|-----------|
| P1 | Desplegar `authorizer-google` (prd) en la cuenta `386458449724` (`.\deploy.ps1 prd`) y registrarlo en `z66x2zyooj` |
| P2 | Rutas `/toma-unidades/{proxy+}` y `/hub/{proxy+}` en `z66x2zyooj` con VPC Link `g55dvn` (pasos 3 a 5 de la guía, tal cual) |
| P3 | Cliente OAuth de producción y URIs de Vercel (paso 0) |
| P4 | Acordar con el dueño del API Gateway dónde vive el código del authorizer (repo `api`) y si es compartido con otros sistemas, p. ej. `autorizaciones` ([guía, "Pendientes de acordar"](GUIA_API_GATEWAY.md#pendientes-de-acordar)) |

## Responsables

| Tema | Responsable |
|------|-------------|
| Cuenta de AWS de desarrollo (S1–S4, I1, I2) | _por definir_ |
| API Gateway de producción (P1, P2, P4) | _por definir_ |
| Hub y valuación (V1, V2, P3) | Juan Ayala |
