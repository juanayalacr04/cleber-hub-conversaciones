"""Capa de datos del hub sobre PostgreSQL (DISENO_MIGRACION_POSTGRES.md §7): un módulo por entidad, todo por core/postgrest.py.

Es lo único que llama el resto del código para leer o escribir datos del hub en hub_cleber. Mientras Ventas y Servicio sigan en
Firestore conviven con core/db.py; al terminar la mudanza (DISENO_BACKEND_AWS.md §8) lo reemplazan.
"""
