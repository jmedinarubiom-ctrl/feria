# Publicar en la App Store

Lo que ya está hecho en el código y lo que falta, en orden. Todo lo
de esta lista que dice «tú» necesita tu cuenta de Apple o de Google:
nadie más puede hacerlo.

## Ya está listo

- **Identificador**: `cl.feria.app`. Nombre: «Feria App». Solo iPhone
  (sin iPad, así no piden capturas de iPad).
- **Iniciar sesión con Apple**: programado y verificado en el
  servidor (`APPLE_CLIENT_IDS=cl.feria.app`). Apple lo exige cuando
  la app ofrece Google. El botón aparece solo en iPhone.
- **Eliminar la cuenta desde la app** (regla 5.1.1 de Apple):
  compradores en Perfil → Tus datos; feriantes y repartidores en
  Salir → Más opciones → Eliminar mi cuenta.
- **Cuenta de prueba para el revisor**: el correo de `REVISION_CORREO`
  entra siempre con el código de `REVISION_CODIGO` (los dos están en
  `backend/.env`). Es una cuenta de comprador común.
- **Permisos explicados** en español: ubicación, fotos, cámara y
  notificaciones.
- **Cifrado**: declarado que la app solo usa el cifrado estándar
  (HTTPS), así no pregunta en cada envío.
- **Pagos**: son productos físicos y se cobran con Mercado Pago. No
  corresponde la compra dentro de la app de Apple.
- **Perfil de compilación** `produccion` en `app/eas.json`, apuntando
  al servidor de Supabase.
- **Sitio público** (`sitio/`): privacidad, términos, soporte y cómo
  eliminar la cuenta. Se regenera con
  `cd backend && node --env-file=.env herramientas/sitio.mjs`.

## Lo que falta, en orden

1. **Tú: cuenta Apple Developer** — developer.apple.com/programs,
   USD 99 al año. Como persona se activa en uno o dos días; como
   empresa piden un número D-U-N-S y tarda más. El nombre de esa
   cuenta es el que aparece como vendedor en la tienda.
2. **Tú: datos de la empresa** en `backend/.env` (`LEGAL_RAZON_SOCIAL`,
   `LEGAL_RUT`, `LEGAL_REPRESENTANTE`, `LEGAL_DOMICILIO`,
   `LEGAL_CORREO`). Sin ellos la política de privacidad dice «por
   completar» y Apple la rechaza.
3. **Publicar el sitio** de `sitio/` en una dirección pública. Apple
   pide la dirección de la política de privacidad y la de soporte.
4. **Tú: cliente de Google para iPhone** — en Google Cloud, donde
   creaste los otros dos: Credenciales → Crear → ID de cliente de
   OAuth → iOS → paquete `cl.feria.app`. Me das ese id (es público) y
   lo pongo en `eas.json` como `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` y en
   `GOOGLE_CLIENT_IDS` del servidor. Sin él, en iPhone se entra con
   Apple o con correo, que alcanza para publicar.
5. **Compilar** (pide tu usuario de Apple en la terminal; EAS crea
   solo los certificados y la llave de notificaciones):

       cd app && npx eas-cli build --platform ios --profile produccion

6. **Enviar a App Store Connect**:

       cd app && npx eas-cli submit --platform ios --profile produccion

7. **Tú: la ficha** en appstoreconnect.apple.com, con los textos de
   abajo, las capturas y las respuestas de privacidad.
8. **Probar con TestFlight** en un iPhone real antes de mandar a
   revisión: ingreso con Apple, un pedido completo, notificaciones.

## Textos para la ficha

- **Nombre**: Feria App
- **Subtítulo** (30): La feria libre en tu casa
- **Categoría**: Comida y bebida. Secundaria: Compras.
- **Edad**: 4+
- **Palabras clave** (100): feria,verduras,frutas,delivery,despacho,valparaíso,viña,pescado,queso,huevos,mercado,fresco
- **Descripción**:

  Compra en la feria libre y recibe en tu casa el mismo día.

  Feria App te acerca los puestos de las ferias de la Región de
  Valparaíso: frutas y verduras de temporada, pescados y mariscos,
  quesos, huevos y abarrotes, al precio de la feria.

  • Elige tu feria y arma tu pedido en minutos.
  • Precio fijo por producto, sin importar el puesto.
  • Marca en el mapa el punto exacto de entrega.
  • Paga seguro con Mercado Pago.
  • Sigue tu pedido en vivo hasta que llega a tu puerta.

  Si algo no llega como esperabas, lo reponemos o te devolvemos el
  dinero.

  ¿Tienes un puesto o repartes? Desde tu perfil puedes pedir sumarte.

- **Dirección de soporte** y **de privacidad**: las del sitio
  publicado (`…/index.html` y `…/privacidad.html`).

## Notas para la revisión (se copian tal cual, con los datos de .env)

    Feria App vende productos físicos (alimentos de feria libre) con
    despacho a domicilio en la Región de Valparaíso, Chile. El pago se
    hace con Mercado Pago; no hay contenido ni servicios digitales.

    Cuenta de prueba (comprador):
      1. En la pantalla de inicio elija «Con mi correo».
      2. Correo: <REVISION_CORREO>
      3. Toque «Enviar código» y escriba: <REVISION_CODIGO>

    El servicio opera los días de feria (miércoles y sábado). Fuera de
    ese horario se puede recorrer el catálogo y armar el carrito.
    Para eliminar la cuenta: Perfil → Tus datos → Eliminar mi cuenta.

## Privacidad de la app (las «etiquetas» de Apple)

Datos que se recogen y quedan vinculados a la persona, todos para
«funcionalidad de la app», ninguno para seguimiento ni publicidad:

| Dato | Para qué |
|---|---|
| Nombre | Entregar el pedido |
| Correo | Ingreso y comprobante |
| Teléfono | Ingreso y contacto del repartidor |
| Dirección física | Entrega |
| Ubicación precisa | Punto de entrega (comprador), ruta (repartidor) |
| Historial de compras | Pedidos |
| Identificador de usuario | Cuenta |
| Identificador del dispositivo | Notificaciones |

No se usan datos para rastrear entre apps ni se comparten con
terceros para publicidad.

## Riesgos conocidos en la revisión

- **Probar fuera de horario**: si el revisor intenta pagar un día
  sin feria, no va a poder. Está explicado en las notas; si aun así
  lo rechazan, se le puede abrir la feria ese día desde el panel.
- **Revocar el acceso de Apple al eliminar la cuenta**: Apple pide
  que, al eliminar una cuenta creada con «Iniciar sesión con Apple»,
  la app revoque ese permiso. Hoy la cuenta se borra pero no se
  revoca; hacerlo necesita una llave que se crea con la cuenta de
  desarrollador. Queda como pendiente para cuando exista.
- **Boleta y Mercado Pago de producción**: no los revisa Apple, pero
  la app no debería publicarse cobrando con credenciales de prueba.
