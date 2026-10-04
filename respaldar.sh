#!/usr/bin/env bash
#
# Respaldo de la feria: base de datos y fotos subidas.
#
#   ./respaldar.sh                 deja el respaldo en ./respaldos
#   ./respaldar.sh /ruta/destino   o donde le digas
#
# Las dos cosas en el mismo archivo a propósito. Un respaldo que se
# lleve la base pero no las fotos deja un catálogo con huecos, y eso
# se descubre el día que hace falta restaurar.
#
# Para restaurar:
#   tar xzf feria-AAAA-MM-DD.tar.gz -C /donde/sea
#   - con Postgres:  psql "$DATABASE_URL" < base.sql
#   - con PGlite:    copiar la carpeta datos/ de vuelta
#
set -euo pipefail
cd "$(dirname "$0")"

DESTINO="${1:-./respaldos}"
FECHA=$(date +%Y-%m-%d-%H%M)
TRABAJO=$(mktemp -d)
trap 'rm -rf "$TRABAJO"' EXIT

mkdir -p "$DESTINO"
DATOS="${FERIA_DATOS:-backend/datos}"

echo "→ Base de datos…"
if [ -n "${DATABASE_URL:-}" ]; then
  # Postgres de verdad: un volcado lógico, que se restaura en
  # cualquier versión y se puede leer con un editor de texto.
  pg_dump --no-owner --no-privileges "$DATABASE_URL" > "$TRABAJO/base.sql"
  echo "  volcado de Postgres: $(du -h "$TRABAJO/base.sql" | cut -f1)"
elif [ -d "$DATOS" ]; then
  # PGlite guarda un directorio de Postgres completo. Copiarlo con
  # el servidor andando puede dejarlo a medias, así que se avisa.
  if [ -f "$DATOS/postmaster.pid" ]; then
    echo "  ⚠ el servidor está corriendo: el respaldo puede quedar inconsistente."
    echo "    Para un respaldo confiable, paralo antes — o usa Postgres con DATABASE_URL."
  fi
  cp -R "$DATOS" "$TRABAJO/datos"
  echo "  copia de PGlite: $(du -sh "$TRABAJO/datos" | cut -f1)"
else
  echo "  ⚠ no hay ni DATABASE_URL ni $DATOS: no se respaldó ninguna base."
fi

echo "→ Fotos subidas…"
if [ -d "$DATOS/fotos" ]; then
  mkdir -p "$TRABAJO/fotos"
  cp -R "$DATOS/fotos/." "$TRABAJO/fotos/"
  echo "  $(find "$TRABAJO/fotos" -type f | wc -l | tr -d ' ') archivos"
else
  echo "  (ninguna todavía; las de referencia vienen con el código)"
fi

ARCHIVO="$DESTINO/feria-$FECHA.tar.gz"
tar czf "$ARCHIVO" -C "$TRABAJO" .
echo
echo "✓ $ARCHIVO  ($(du -h "$ARCHIVO" | cut -f1))"

# Dejar solo los últimos 14: un respaldo que llena el disco deja de
# ser un respaldo y se convierte en una caída.
ls -1t "$DESTINO"/feria-*.tar.gz 2>/dev/null | tail -n +15 | while read -r viejo; do
  rm -f "$viejo"
  echo "  (borrado el viejo $(basename "$viejo"))"
done
