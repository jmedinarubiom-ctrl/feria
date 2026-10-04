# Node 24 ejecuta TypeScript directo: no hay paso de compilación.
FROM node:24-slim

WORKDIR /app

# Las dependencias se instalan antes de copiar el código para que
# cambiar una línea de fuente no invalide la caché de npm.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# `src` incluye el panel (`src/panel`) y las fotos de referencia
# del catálogo (`src/fotos`): viajan con la imagen, así que un
# despliegue nuevo no deja el catálogo sin fotos.
COPY src ./src

ENV NODE_ENV=production
ENV PORT=4000

# La base y las fotos que sube el operador NO viajan con la imagen.
# Sin un volumen montado acá, cada despliegue empieza con la base
# vacía y sin las fotos cargadas desde el panel.
ENV FERIA_DATOS=/datos
VOLUME ["/datos"]

EXPOSE 4000

# El orquestador manda SIGTERM al desplegar. El servidor registra su
# propio manejador y cierra el pool de conexiones antes de salir, que
# es lo que hace falta corriendo como PID 1: sin manejador explícito,
# Node en PID 1 ignora la señal y el deploy espera hasta el timeout.
CMD ["node", "src/servidor.ts"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4000)+'/salud').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
