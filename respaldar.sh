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
# El respaldo trae nombres, teléfonos y direcciones de clientes.
# Con RESPALDO_CLAVE definida sale cifrado (AES-256):
#
#   RESPALDO_CLAVE='una frase larga' ./respaldar.sh
#
# Sin esa variable sale sin cifrar y avisa. La clave no se guarda en
# ninguna parte: si se pierde, el respaldo no se puede abrir.
#
# Para restaurar:
#   (si está cifrado)  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
#                        -in feria-AAAA-MM-DD.tar.gz.enc -out feria.tar.gz
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
# La dirección de la base puede venir del entorno o de backend/.env.
if [ -z "${DATABASE_URL:-}" ] && grep -q '^DATABASE_URL=' backend/.env 2>/dev/null; then
  DATABASE_URL=$(grep '^DATABASE_URL=' backend/.env | tail -1 | cut -d= -f2-)
  export DATABASE_URL
fi

if [ -n "${DATABASE_URL:-}" ] && ! command -v pg_dump > /dev/null; then
  # Sin pg_dump instalado: volcado en JSON, tabla por tabla.
  (cd backend && node herramientas/volcar.mjs "$TRABAJO/base.json.gz" | sed 's/→.*//;s/^/  /')
elif [ -n "${DATABASE_URL:-}" ]; then
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
if [ -n "${RESPALDO_CLAVE:-}" ]; then
  # La clave viaja por variable de entorno, no por argumento: los
  # argumentos de un proceso los ve cualquiera con `ps`.
  ARCHIVO="$ARCHIVO.enc"
  tar czf - -C "$TRABAJO" . \
    | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:RESPALDO_CLAVE -out "$ARCHIVO"
  chmod 600 "$ARCHIVO"
  echo
  echo "✓ $ARCHIVO  ($(du -h "$ARCHIVO" | cut -f1), cifrado)"
else
  tar czf "$ARCHIVO" -C "$TRABAJO" .
  chmod 600 "$ARCHIVO"
  echo
  echo "✓ $ARCHIVO  ($(du -h "$ARCHIVO" | cut -f1))"
  echo "  ⚠ SIN CIFRAR: trae datos personales de clientes. Para cifrarlo,"
  echo "    define RESPALDO_CLAVE antes de correr esto."
fi

# Dejar solo los últimos 14: un respaldo que llena el disco deja de
# ser un respaldo y se convierte en una caída.
ls -1t "$DESTINO"/feria-*.tar.gz "$DESTINO"/feria-*.tar.gz.enc 2>/dev/null | tail -n +15 | while read -r viejo; do
  rm -f "$viejo"
  echo "  (borrado el viejo $(basename "$viejo"))"
done
