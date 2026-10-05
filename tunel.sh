#!/usr/bin/env bash
#
# Abre el backend a internet, sin desplegarlo.
#
#   ./tunel.sh
#
# Sirve para dos cosas que no funcionan con el servidor sólo en la
# red local:
#
#   1. Probar la app desde un teléfono que NO está en la misma wifi
#      —o que sí lo está, pero el router aísla los dispositivos
#      entre sí, que es lo que hacen casi todos los routers que
#      entregan las compañías de internet.
#   2. Que Mercado Pago pueda avisar cuando alguien paga. Su webhook
#      no puede alcanzar `localhost`.
#
# Es un parche de desarrollo, no un despliegue: la dirección vive
# mientras esta ventana esté abierta, y el tráfico pasa por un
# servicio de terceros. Para producción el backend va a un servidor
# propio con dominio y HTTPS.
#
set -euo pipefail

SUBDOMINIO="${1:-feria-valpo}"
PUERTO="${2:-4000}"

if ! curl -s -m 3 "http://localhost:$PUERTO/salud" > /dev/null 2>&1; then
  echo "⚠ El backend no responde en el puerto $PUERTO."
  echo "  Levántalo primero:  cd backend && npm start"
  exit 1
fi

echo "→ Abriendo https://$SUBDOMINIO.loca.lt → localhost:$PUERTO"
echo
echo "  Cuando aparezca la dirección, ponla en la app:"
echo "  pantalla de ingreso → tocar la dirección de abajo → pegarla."
echo
echo "  Y en backend/.env:  URL_PUBLICA=https://$SUBDOMINIO.loca.lt"
echo "  (para que Mercado Pago pueda avisar de los pagos)"
echo
exec npx --yes localtunnel --port "$PUERTO" --subdomain "$SUBDOMINIO"
