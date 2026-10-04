#!/usr/bin/env bash
#
# Levanta la feria completa para revisarla: backend, app y datos de
# ejemplo. Ctrl+C corta todo.
#
#   ./probar.sh              en el simulador de iPhone
#   ./probar.sh telefono     con QR, para escanear con Expo Go
#
set -euo pipefail
cd "$(dirname "$0")"

MODO="${1:-simulador}"
PUERTO_APP=8082

echo "→ Backend…"
# La feria abre miércoles y sábado; para revisar cualquier día se
# usa el interruptor de desarrollo.
# `--env-file-if-exists` es nativo de Node: lee backend/.env si está
# —donde van las credenciales de la pasarela— y no se queja si no.
FERIA_SIEMPRE_ABIERTA=1 node --env-file-if-exists=backend/.env \
  backend/src/servidor.ts > /tmp/feria-backend.log 2>&1 &
BACKEND=$!
trap 'kill $BACKEND 2>/dev/null || true' EXIT

until curl -s -m 1 localhost:4000/salud > /dev/null 2>&1; do sleep 1; done
echo "  listo en http://localhost:4000"

echo "→ Datos de ejemplo…"
node backend/src/escenario.ts 2>/dev/null | tail -16

echo "→ App…"
cd app
if [ "$MODO" = "telefono" ]; then
  # Con QR: hay que estar en la misma wifi que el Mac.
  npx expo start --port $PUERTO_APP
else
  npx expo start --ios --port $PUERTO_APP
fi
