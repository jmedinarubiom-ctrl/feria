# Feria App — estado del proyecto

App de delivery de ferias libres de la Región de Valparaíso. La marca
es **Feria App**: ya no se llama «Feria Av. Argentina», que ahora es
solo el nombre de una de las ferias.
Escrito en español de Chile (tuteo: *tienes*, *puedes*, *avísame* —
nunca voseo rioplatense).

## El modelo de negocio, que es lo que explica el diseño

- **Varias ferias, una activa.** La tabla `ferias` tiene las siete
  principales del Gran Valparaíso (Av. Argentina, Marga Marga, Gómez
  Carreño 3º y 5º, El Belloto, Molino Prat, Peña Blanca). Solo
  Av. Argentina reparte; las demás el cliente las ve como
  «próximamente» hasta que el operador les carga feriantes y las
  enciende en el panel (Ferias). Cada feria tiene su horario, sus
  feriantes y sus pedidos; el catálogo y los precios son comunes.

- **Vendedor único**: la plataforma cobra y es la responsable
  tributaria. Juan Manuel es el operador.
- **No hay picker**. Cuando entra un pedido se parte por rubro y
  cada parte se **ofrece a todos los feriantes del rubro**. El
  primero que acepta se lo queda.
- **El repartidor va a ese puesto exacto** a retirar, y después
  entrega.
- **A los feriantes se les paga en efectivo, en persona, en la
  tarde.** No por la app.
- **Autogestión**: si nadie acepta en las tres rondas, el pedido
  **no se pierde ni se cancela** — cae en la cola del operador y va
  él a comprarlo. Es un estado real del sistema, no una excepción.

## Cómo correrlo

    ./probar.sh              # backend + datos de ejemplo + Metro
    ./feria.sh               # backend + túnel público (desde cualquier red)
    ./respaldar.sh           # respaldo de base y fotos (con RESPALDO_CLAVE sale cifrado)

    cd backend && npm test   # 279 pruebas (6 de carreras se saltan sin Postgres)
    cd backend && DATABASE_URL=… npm run test:postgres   # todas, contra Postgres real. VACÍA esa base.
    cd app && npx tsc --noEmit

El panel de administración está en `http://localhost:4000/admin`.

## Usuarios de prueba

Nadie tiene contraseña. Feriantes, repartidores y el operador entran
con un código por SMS a su teléfono. El comprador puede entrar igual,
o con un código al correo, o con Google o Apple (estos dos, apagados
hasta configurar las cuentas). Sin proveedor configurado el código
sale por pantalla y por la consola del servidor. Un número o correo
que no es de nadie queda registrado como cliente la primera vez que
confirma su código.

| Rol | Teléfono |
|---|---|
| Operador (Juan Manuel) | `+56900000009` |
| Feriante (José, verduras) | `+56911111111` |
| Repartidor (Diego) | `+56900000001` |
| Repartidor (Sofía) | `+56900000002` |

Hay ocho feriantes, `f-jose` a `f-hector`; ver `backend/src/db/semilla.ts`.
Son solo de desarrollo: con `NODE_ENV=production` la base arranca sin
gente, y los feriantes y repartidores de verdad se cargan en el panel
(Gente → Agregar).
Para probar como cliente: cualquier otro celular chileno, por ejemplo
`+56987654321`, o cualquier correo.

## Decisiones que no hay que deshacer

- **El motor tiene que estar siempre encendido.** Las ofertas vencen
  a los 90 segundos contados por un reloj *dentro* del proceso. Un
  hosting que duerme el servicio rompe el producto. Por eso el plan
  gratuito de Render no sirve.
- **El webhook de pago no es la fuente de verdad.** Se pierde. El
  servidor le pregunta a la pasarela por los cobros abiertos cada 8
  segundos (`revisarCobrosAbiertos`). El webhook es el camino
  rápido, no el único.
- **El punto del pedido lo marca el cliente** en la pantalla de pago
  (GPS, y ajuste en un mapa de OpenStreetMap dentro de un WebView).
  Si lo marca, se guarda tal cual —validado contra un contorno de la
  región— y `geo_precision` queda «marcado por el cliente (±N m)».
  Si no lo marca, el servidor ubica la dirección escrita con
  Nominatim, como antes. Las coordenadas sueltas que mande la app
  sin esa marca siguen sin creerse.
- **El cliente no puede cancelar.** Del otro lado hay un feriante
  apartando mercadería. Se resuelve por teléfono. Cancelar es solo
  del operador.
- **El comprador tiene cuenta por teléfono.** `POST /pedidos` exige
  sesión de cliente y el pedido queda con su `cliente_id`. Los
  campos del cuerpo se copian de a uno; nunca `...c.cuerpo`.
- **Correo, Google y Apple solo dan cuenta de comprador.** Los
  roles de la feria se abren únicamente con el teléfono, que es el
  número confirmado al que se llama. Quien entró sin teléfono no
  puede pedir ser feriante ni repartidor.
- **Los tokens de Google y Apple se verifican en el servidor**
  (`dominio/externo.ts`): firma, emisor, para qué app y vencimiento.
  Nunca se le cree a la app quién es la persona.
- **Los pedidos pagados no se borran, se anonimizan.** Eliminar una
  cuenta de cliente (`dominio/privacidad.ts`) quita nombre, teléfono,
  dirección y notas de sus pedidos y deja los montos: son ventas.
  Hay un test que revisa tabla por tabla que no quede nada.
- **Los textos legales son un borrador técnico** (`backend/src/legal/`).
  Los reemplaza un abogado; al cambiarlos se cambia `LEGAL_VERSION`.
- **Los datos de las ferias vienen de ODEPA/ASOF** (Localizador
  Nacional de Ferias Libres, agosto 2025). La lista completa de la
  región —115 ferias— está en `backend/src/datos/`, como referencia;
  las que la app usa están en `FERIAS` de `db/semilla.ts`. Los
  horarios hay que confirmarlos con cada feria.
- **El teléfono confirmado no es un campo de texto.** Se pone o se
  cambia solo confirmando un código que llega a ese número
  (`/cliente/telefono/*`). Los pedidos de quien tiene número
  confirmado salen con ese número, mande lo que mande la app.
- **El operador puede tener clave** (segundo factor, scrypt). Se
  pone en el panel. Con clave, el código del SMS solo no alcanza.
  Si la olvida: `UPDATE operadores SET clave_hash = NULL` a mano.
- **Tope de 20 intentos fallidos al día por teléfono o correo.** El
  operador saca del bloqueo a su equipo dictando un código desde el
  panel (esos códigos no cuentan para el tope).
- **Las sesiones se cierran a los 30 días sin uso**, y el token del
  WebSocket viaja en el primer mensaje, no en la dirección.
- **El catálogo tiene 45 productos en 5 rubros** (se agregó «Quesos
  y lácteos»). Los precios de los 29 que se sumaron en octubre de
  2026 son una estimación: hay que corregirlos en el panel. No
  Todos tienen foto de referencia de Wikimedia Commons (se bajan
  con `node herramientas/bajar-fotos.mjs`, que no pisa las que ya
  están). Los
  productos nuevos de la semilla llegan a una base existente una
  sola vez (`sembrarNovedades`).
- **Nadie se hace feriante o repartidor solo.** Desde la app se
  pide (Perfil → «¿Tienes un puesto o repartes?») y queda pendiente
  hasta que el operador lo aprueba en el panel. Mientras, y si lo
  rechazan o lo dan de baja, ese número entra como cliente.
- **Lo que no es del operador no muestra costos.** `/catalogo` y
  `/pedidos/:id` no traen `precio_costo` ni `monto_feriante`. Un
  pedido lo ve el operador y el cliente que lo hizo, nadie más.
- **El WebSocket se identifica con el token**, no con `?rol=` en la
  URL. Solo el cliente entra sin token, con el id de su pedido.
- **Un pago que llega tarde revive el pedido expirado.** Plata
  cobrada es un pedido que sale.
- **Solo Mercado Pago, y sin Shopify.** Se sacaron Flow y el webhook
  de Shopify: los pedidos entran solo por la app y se cobran solo
  con Mercado Pago. La interfaz `Pasarela` queda para los tests.
- **Las fotos de referencia viajan con el código** (`backend/src/fotos`),
  no en disco de datos: así un despliegue no deja el catálogo sin
  imágenes. Las que sube el operador sí van a `FERIA_DATOS`.

## Dónde corre (desde el 6 de octubre de 2026)

Juan Manuel no quiere Render. El servidor corre como **función de
Supabase** (`supabase/functions/api`, proyecto `feriapp`):
`https://umypcgakffoajvfkxnvp.supabase.co/functions/v1/api`.

- Es el mismo código de `backend/src`: `./desplegar-supabase.sh` lo
  copia adentro, carga las variables de `backend/.env` como secretos
  y despliega (`--codigo` para subir solo código). Antes, una vez:
  `npx supabase login`.
- `http/servidor.ts` separa `atender(peticion)` (sin sockets) de
  `iniciar()` (Node). La función usa `preparar()`: no migra ni
  siembra. **Las migraciones se aplican arrancando el servidor en el
  Mac** (`npm start` con el mismo `DATABASE_URL`).
- **El reloj lo pone la base**: pg_cron llama cada minuto a
  `POST /interno/latir` (con `FERIA_MOTOR_SECRETO`) y la función
  late 58 s (`motor.ts`). La tabla `motor` da el turno: si el Mac
  también está encendido, late uno solo. Se reprograma con
  `node --env-file=.env herramientas/programar-latido.mjs`.
- **Avisos en vivo por Supabase Realtime** (`realtime/difusion.ts`):
  la función no tiene WebSocket propio. Cada mensaje del bus sale
  como un aviso sin datos a canales de nombre secreto (HMAC); la
  app pide `/vivo`, se conecta (`abrirCanal` en `app/src/api.ts`) y
  al recibir un aviso vuelve a preguntar por la API. Si el canal no
  conecta, consulta cada 8 s (eso sí gasta la cuota de 500.000
  llamadas al mes). Un test compara los canales con `leRegistra`.
- **Sin HTML**: Supabase lo entrega como texto plano. El panel se
  abre desde el Mac (`localhost:4000/admin`, misma base) y
  `/pagos/retorno` redirige a `feria://pago` (`FERIA_SIN_HTML=1`).
  Las páginas `/legal/*` no sirven ahí: falta alojarlas en otro lado
  antes de publicar en tiendas.
- **Fotos en la base** (tabla `archivos`): la función no tiene
  disco. Las de referencia se suben con
  `node --env-file=.env herramientas/subir-fotos.mjs`; las que sube
  el operador se guardan solas.
- La función corre con `FERIA_EXPUESTA=1`: el código de ingreso por
  teléfono no sale en pantalla, se genera en el panel.
- La red `10.20.50.x` donde estuvo el Mac ese día **bloquea
  `*.supabase.co`** por HTTPS (conexión cortada): desde ahí la
  función no se puede probar con curl ni la APK entra por ese wifi.

Confiabilidad (6 de octubre de 2026):

- **Chequeo de salud**, solo lectura:
  `cd backend && node --env-file=.env herramientas/revisar.mjs`.
- **Alarmas al operador** (`dominio/alertas.ts`): cada minuto, con el
  latido, se revisa motor detenido, autogestiones, viajes sin
  repartidor por más de 5 minutos y errores internos. Un correo por
  problema nuevo, a `ALERTAS_CORREO` o, si no está, a la casilla de
  `CORREO_SMTP_USUARIO`. Si la función entera está caída nadie
  avisa: haría falta un monitor externo.
- **Errores internos** en la tabla `errores`; `GET /operador/errores`
  (todavía sin pantalla en el panel).
- **Respaldos**: pg_cron copia cada tabla al esquema `respaldo` todos
  los días (7 días; `herramientas/programar-respaldo.mjs`). Eso
  cubre borrados por error, no la pérdida del proyecto: para eso
  `./respaldar.sh`, que sin `pg_dump` baja la base en JSON
  (`herramientas/volcar.mjs`). No hay nada que lo corra solo.
- **La app con mala señal** (`pedir` en `app/src/api.ts`): tope de
  tiempo, las lecturas se reintentan dos veces, los envíos no.
- No se hizo una prueba automática de pedido completo contra el
  servidor real: crearía pedidos falsos y les avisaría a feriantes
  de verdad.

Auditoría del 6 de octubre (función publicada), pendientes:

- Revisado: Supabase descarta el `x-forwarded-for` que mande quien
  llama y pone la dirección real primero, así que el tope por IP no
  se salta falseándola. Sigue siendo débil por otra razón: vive en
  la memoria de cada copia de la función. Los topes por teléfono y
  correo están en la base y sí valen.
- `/auth/metodos` dice `sms: true` y `/auth/codigo` contesta
  «enviado» aunque no hay proveedor de SMS: el código solo queda en
  el registro de la función. Un comprador que elija teléfono se
  queda esperando.
- `FERIA_SIEMPRE_ABIERTA=1` viaja a la función: acepta pedidos a
  cualquier hora. Sirve para probar; quitarla de `.env` antes de
  abrir.
- Dos toques a «pagar» que caigan en copias distintas de la función
  pueden crear dos órdenes de cobro (el candado es en memoria).
- Una dirección mal escrita (`/pedidos/%E0%A4%A`) devuelve 500 desde
  la puerta de Supabase, antes de llegar a la función.

## Lo que falta, en orden

1. **Desplegar.** Todo listo: `render.yaml`, `DESPLEGAR.md`. Render
   no es obligatorio — `DESPLEGAR.md` tiene las alternativas; la más
   barata razonable es Render solo servidor + Supabase gratis
   (~USD 7/mes). Falta que Juan Manuel decida y ponga tarjeta.
   Mientras tanto `./feria.sh` da una dirección pública desde su
   Mac, pero localtunnel es inestable: ya falló tres veces (cambió
   de subdominio, 408, 503). Con `./feria.sh` el código de ingreso
   NO sale en la pantalla del teléfono (`FERIA_EXPUESTA=1`): se
   genera en el panel, Gente → Código.
   Para abrir hace falta además al menos un ingreso para
   compradores: el más barato es el código al correo (Resend); SMS
   es Twilio y cada mensaje se paga. Google y Apple están
   programados pero sin probar contra los servicios reales: faltan
   las cuentas (pasos en `DESPLEGAR.md`).
   Y que un abogado revise los términos y la política de privacidad
   (hoy son un borrador). La ley nueva de datos personales (21.719)
   entraría en vigencia en diciembre de 2026: confirmar la fecha.
2. **Boleta electrónica (SII).** Único bloqueante legal. Es el
   vendedor único: la boleta de cada venta es suya.
3. ~~Probar el driver de Postgres.~~ Hecho contra PostgreSQL 18
   local (`npm run test:postgres`). Desde el 6 de octubre de 2026 la
   base es **Supabase** (proyecto `feriapp`, región `us-west-2`,
   Session pooler): `DATABASE_URL` en `backend/.env`. Las 22 tablas
   tienen RLS encendido. Sin esa variable vuelve a PGlite
   (`backend/datos`). La región está lejos de Chile: cada consulta
   tarda ~0,5 s; al desplegar conviene un proyecto en São Paulo.
   Tras cambiar la contraseña de la base, el pooler tarda cerca de
   un minuto en aceptarla.
4. ~~Correo de respaldo al cliente.~~ Hecho: `dominio/comprobante.ts`
   lo manda al quedar pagado el pedido, una sola vez
   (`pedidos.comprobante_at`). No es la boleta.
5. **Logo en alta.** El original es 266×302; el ícono de 1024 px es
   una ampliación de 2,4×. Para publicar en tiendas hace falta el
   archivo grande.

El APK instalado es anterior al WebSocket con token: sigue
funcionando, pero se entera de los cambios cada 5 segundos en vez
de al instante. Hay que recompilarlo.

Pendientes conocidos, sin resolver:

- Feriantes y repartidores no pueden eliminar su cuenta ni descargar
  sus datos desde la app: se les da de baja en el panel y el borrado
  es a mano. Apple puede exigirlo al publicar.
- Los repartidores no son de una feria: todos ven los viajes de
  todas. Sirve dentro del Gran Valparaíso; para ferias lejanas
  (San Antonio, Los Andes) habría que asignarlos por zona.
- No hay zonas de reparto: un cliente puede pedir a una feria de
  otra comuna y el despacho cuesta lo mismo.
- Las ferias nuevas no tienen coordenadas (el localizador de ODEPA
  las muestra solo en el mapa).
- Una misma persona no puede ser feriante y comprar con el mismo
  número: el teléfono decide un solo rol.
- El freno por IP confía en `x-forwarded-for` salvo que se defina
  `PROXIES_DE_CONFIANZA` (cuántos proxies pone el hosting adelante).
  Hay que definirlo al desplegar; un número equivocado deja a todos
  compartiendo un límite.
- Números reasignados por la compañía: se mitiga con dos cosas. Las
  cuentas de cliente sin uso por 12 meses se vacían solas
  (`limpiarDatosViejos`), y quien vuelve tras 90 días a una cuenta
  con correo confirmado tiene que poner además un código que llega
  a ese correo. Entre 3 y 12 meses, una cuenta SIN correo sigue
  expuesta.
- Un viaje sin repartidor que lo tome no le avisa a nadie: solo se
  ve en «Pedidos en curso».
- El feriante confirma en su app solo el pago de HOY. Si se le paga
  al día siguiente, no tiene dónde confirmarlo.
- La ubicación de un feriante nuevo queda vacía (no hay dónde
  ponerla en el panel): su parada sale sin botón de mapa.

Sin auditar todavía: carga real (las carreras sí están probadas) y
accesibilidad.

## Cuentas y credenciales

- **GitHub**: `jmedinarubiom-ctrl/feria` (privado).
- **Expo**: cuenta `jmedinar`, proyecto `feria`. El `projectId` ya
  está en `app.json`, así que el push funciona en un build de
  verdad — no en Expo Go, que no lo soporta desde el SDK 53.
- **Mercado Pago**: hay credenciales **de prueba** en `backend/.env`
  (usuario de prueba `TESTUSER3721328324878363343`). Las de
  producción requieren verificar identidad con cédula, trámite que
  quedó pendiente.
- **Render**: cuenta creada, sin servicios. Pide tarjeta.

`backend/.env` no está en el repositorio. `backend/.env.example` sí,
con todo explicado.

## Android

    cd app && npx eas-cli build --platform android --profile apk

El APK sale apuntando a lo que diga `EXPO_PUBLIC_FERIA_API` en
`eas.json`. Una app standalone no puede descubrir el backend sola:
en Expo Go esa dirección sale de Metro, y en un APK no hay Metro.

`EXPO_PUBLIC_FERIA_API` acepta varias direcciones separadas por
coma: al abrir, la app prueba cuál responde (`buscarServidor` en
`app/src/api.ts`). El perfil `apk` trae las dos IP que ha tenido el
Mac (casa y la otra red); una red nueva se agrega ahí.

Para pasar la base local a Postgres sin borrar nada del destino:
`node --env-file=.env herramientas/copiar-a-postgres.mjs [carpeta] --si`
(en `backend/`).

Si queda apuntando mal, **no hace falta recompilar**: en la pantalla
de ingreso se toca la dirección de abajo y se escribe otra.
