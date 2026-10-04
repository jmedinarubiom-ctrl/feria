#!/usr/bin/env bash
#
# La feria andando desde este computador, accesible desde internet.
#
#   ./feria.sh
#
# Levanta un túnel público y el backend detrás, y vigila los dos:
# si alguno se cae, lo vuelve a levantar solo. Ctrl+C corta todo.
#
# Sirve para probar con feriantes de verdad sin pagar hosting: el
# teléfono de cada uno llega al servidor desde cualquier red, no
# hace falta que estén en tu wifi.
#
# Lo que NO es: un despliegue. Depende de que este computador esté
# encendido, conectado y sin dormirse, y la dirección cambia cada
# vez. Para abrir de verdad, ver DESPLEGAR.md.
#
set -euo pipefail
cd "$(dirname "$0")"

PUERTO=4000
SUBDOMINIO="${1:-feria-valpo}"

mkdir -p .registro
LOG_BACKEND=.registro/backend.log
LOG_TUNEL=.registro/tunel.log

limpiar() {
  echo
  echo "→ Cerrando…"
  trap '' TERM
  kill 0 2>/dev/null || true
}
trap limpiar EXIT INT TERM

if lsof -ti:$PUERTO >/dev/null 2>&1; then
  echo "⚠ Ya hay algo escuchando en el puerto $PUERTO."
  echo "  Páralo primero:  lsof -ti:$PUERTO | xargs kill"
  exit 1
fi

vigilar() {
  local nombre="$1" registro="$2"; shift 2
  while true; do
    "$@" >> "$registro" 2>&1 || true
    echo "  ⟳ $nombre se cayó, levantando de nuevo…"
    sleep 2
  done
}

# ---------------------------------------------------------------
# El túnel va PRIMERO, porque la dirección la decide él.
#
# Se pide un subdominio fijo, pero si está tomado localtunnel
# asigna otro al azar sin avisar. La primera versión de este script
# daba por buena la que había pedido, y todo quedaba apuntando a
# una dirección que no existía. Ahora se lee la que de verdad dio.
# ---------------------------------------------------------------
echo "→ Túnel…"
: > "$LOG_TUNEL"
vigilar "el túnel" "$LOG_TUNEL" \
  npx --yes localtunnel --port "$PUERTO" --subdomain "$SUBDOMINIO" &

PUBLICA=""
for _ in $(seq 1 40); do
  PUBLICA=$(grep -oE 'https://[a-z0-9-]+\.loca\.lt' "$LOG_TUNEL" 2>/dev/null | tail -1 || true)
  [ -n "$PUBLICA" ] && break
  sleep 1
done
if [ -z "$PUBLICA" ]; then
  echo "⚠ El túnel no dio una dirección. Mirá $LOG_TUNEL"
  exit 1
fi
echo "  $PUBLICA"
[ "$PUBLICA" = "https://$SUBDOMINIO.loca.lt" ] || \
  echo "  (el subdominio '$SUBDOMINIO' estaba tomado; se usó este)"

# El backend necesita su dirección pública para que Mercado Pago
# pueda avisarle de los pagos.
export URL_PUBLICA="$PUBLICA"
export FERIA_SIEMPRE_ABIERTA=1

echo "→ Backend…"
: > "$LOG_BACKEND"
vigilar "el backend" "$LOG_BACKEND" \
  node --env-file-if-exists=backend/.env backend/src/servidor.ts &

until curl -s -m 1 "http://localhost:$PUERTO/salud" >/dev/null 2>&1; do sleep 1; done
echo "  listo en http://localhost:$PUERTO"

# Se comprueba el código HTTP, no que curl no falle: un 503 del
# túnel también devuelve éxito y daría el arranque por bueno.
echo "→ Comprobando desde internet…"
LISTO=no
for _ in $(seq 1 30); do
  if [ "$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$PUBLICA/salud")" = "200" ]; then
    LISTO=si; break
  fi
  sleep 2
done

if [ "$LISTO" = "si" ]; then
  cat <<FIN

  ────────────────────────────────────────────────────────
   Panel:  http://localhost:$PUERTO/admin

   En la app: pantalla de ingreso → tocar la dirección →
   escribir:  $PUBLICA
  ────────────────────────────────────────────────────────

   Ctrl+C corta todo. Los registros quedan en .registro/

FIN
else
  echo "  ⚠ El túnel no responde desde fuera. Adentro sí funciona:"
  echo "    http://localhost:$PUERTO"
fi

wait
