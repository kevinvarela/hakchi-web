#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later — Copyright (C) 2026 Kevin Varela
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "Necesitas instalar Node.js 18 o superior: https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm install --omit=dev --no-audit --no-fund

# Linux: la consola con hakchi aparece como una tarjeta de red USB (ID 04e8:6863) cuyo
# nombre cambia en cada conexión y que no recibe dirección IP. La configuramos aquí.
case " $* " in *" --demo "*) DEMO=1 ;; esac
if [ "$(uname)" = "Linux" ] && [ -z "$DEMO" ]; then
  IF=""
  for i in /sys/class/net/*; do
    d=$(readlink -f "$i/device/.." 2>/dev/null)
    [ "$(cat "$d/idVendor" 2>/dev/null)" = 04e8 ] && [ "$(cat "$d/idProduct" 2>/dev/null)" = 6863 ] && IF=$(basename "$i")
  done
  if [ -z "$IF" ]; then
    echo "AVISO: no se detecta la consola por USB. Conéctala, enciéndela y espera a que la tele muestre el menú."
  elif ! ip addr show "$IF" | grep -q 'inet 169\.254\.'; then
    echo "Configurando la red USB de la consola ($IF). Puede pedirte tu contraseña de Linux:"
    sudo ip link set "$IF" up && sudo ip addr add 169.254.1.2/16 dev "$IF" && echo "Red USB lista."
  else
    echo "Consola detectada en $IF."
  fi
fi

( sleep 2; (command -v open >/dev/null && open http://localhost:8080) || (command -v xdg-open >/dev/null && xdg-open http://localhost:8080) ) >/dev/null 2>&1 &
exec node server.js "$@"
