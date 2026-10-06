#!/bin/bash
# Sube el servidor a Supabase como función («api») y le pasa las
# variables de backend/.env. Antes, una sola vez: npx supabase login
#
#   ./desplegar-supabase.sh            # código + variables
#   ./desplegar-supabase.sh --codigo   # solo el código
set -euo pipefail
cd "$(dirname "$0")"

ENV=backend/.env
[ -f "$ENV" ] || { echo "Falta $ENV"; exit 1; }

# El proyecto sale del usuario de DATABASE_URL (postgres.<proyecto>).
REF=$(node -e '
  const l = require("fs").readFileSync("backend/.env","utf8").split("\n").find(x => x.startsWith("DATABASE_URL="));
  if (!l) process.exit(1);
  const u = new URL(l.slice(13).trim());
  process.stdout.write(u.username.split(".")[1] ?? "");')
[ -n "$REF" ] || { echo "DATABASE_URL no es del pooler de Supabase"; exit 1; }
URL="https://$REF.supabase.co/functions/v1/api"

# Los secretos que la función necesita y que en el computador tenían
# un valor de desarrollo. Se generan una vez y quedan en .env.
for clave in FERIA_SECRETO FERIA_MOTOR_SECRETO; do
  grep -q "^$clave=" "$ENV" || echo "$clave=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')" >> "$ENV"
done

# El código de la función es una copia de backend/src.
# Las fotos no viajan en el paquete (pesan más de lo que la función
# acepta): se leen de la base. Se suben con herramientas/subir-fotos.mjs.
rsync -a --delete --delete-excluded --exclude panel --exclude datos \
  --exclude 'fotos/*.jpg' --exclude 'fotos/*.png' backend/src/ supabase/functions/api/src/

if [ "${1:-}" != "--codigo" ]; then
  TMP=$(mktemp); chmod 600 "$TMP"; trap 'rm -f "$TMP"' EXIT
  # Todo .env menos lo que es propio del computador.
  grep -E '^[A-Z_]+=' "$ENV" | grep -vE '^(PORT|FERIA_DB|FERIA_DATOS|URL_PUBLICA|FERIA_SIN_MOTOR|NODE_ENV)=' > "$TMP"
  cat >> "$TMP" <<VARS
URL_PUBLICA=$URL
FERIA_EXPUESTA=1
FERIA_SIN_HTML=1
PG_POOL_MAX=3
PG_POOL_REPOSO_MS=5000
VARS
  npx --yes supabase secrets set --project-ref "$REF" --env-file "$TMP" > /dev/null
  echo "variables cargadas"
fi

npx --yes supabase functions deploy api --project-ref "$REF" --use-api
echo
echo "Servidor: $URL"
