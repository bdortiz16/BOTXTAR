# BOTXTAR

Aplicacion para registrar los envios (remesas) y avisar automaticamente al
grupo de Telegram del pais correspondiente.

Reemplaza el circuito actual de **Wix + formularios de Google**: el operador ya
no escribe el total a mano ni pasa por 10 paginas de formulario, y cada
operacion queda guardada para el informe contable.

---

## Que hace

1. **Fecha y pais.** Se elige la fecha y se abre la cuadricula de paises.
   Estan los grupos que ya existen (Peru, Chile, Brasil, Mexico) mas Colombia,
   Venezuela, Ecuador y USDT, y hay un boton **Otro pais** para agregar
   cualquier destino nuevo con su moneda y su grupo de Telegram.
2. **Monto y tasa.** Se escriben los dos numeros y **el sistema calcula el
   total solo**: 10.000 PEN x tasa 1.000 = 10.000.000 COP. El total aparece en
   vivo mientras se escribe. La tasa admite multiplicar o dividir.
3. **Tipo de entrega.** Transferencia o entrega en efectivo.
   - *Transferencia*: nombre, tipo y numero de documento, banco, numero y tipo
     de cuenta, y monto.
   - *Efectivo*: ciudad, punto de entrega, quien recibe, telefono, hora y monto.
4. **Fraccionamiento.** Si el cliente quiere el dinero repartido en varias
   cuentas, se agregan las que hagan falta. Una barra fija muestra
   **Total / Repartido / Restante** y no deja continuar hasta que cuadre exacto.
5. **Venta de USDT.** Opcional, dentro de la misma operacion: cantidad, precio
   por USDT, moneda de cobro, red y contraparte. Sale en el mensaje y suma en
   el informe.
6. **Enviar.** Se revisa el mensaje tal cual va a llegar y se manda al grupo de
   Telegram del pais. Queda registrado el id del mensaje enviado.
7. **Informe.** Totales por moneda (recibido y pagado), desglose por pais, por
   tipo de entrega y de USDT, con exportacion a CSV (una fila por cuenta, que
   es como se concilia contra el extracto del banco).

### Como se resolvio lo del monto en el fraccionamiento

La duda era si poner el total o dejarlo editable. Se hacen las dos cosas:

- La **primera cuenta llega precargada con el total completo**. En el caso
  normal (una sola cuenta) no hay que escribir nada.
- El monto **siempre es editable**. Al bajarlo a 3.000.000, el restante pasa a
  7.000.000 en el acto.
- Al agregar otra cuenta, **esa cuenta llega precargada con lo que falta**.
  Asi tres cuentas salen en tres toques.
- El boton **Repartir igual** divide el total entre las cuentas que haya y
  ajusta el sobrante en la ultima, sin perder un peso.
- No se puede enviar si la suma no da exacto. El servidor lo vuelve a validar,
  asi que tampoco se puede saltar desde fuera de la app.

---

## Instalacion

Requiere **Node.js 22.5 o superior** (usa el SQLite que trae Node, sin
compilar nada).

```bash
npm install
cp .env.example .env      # completa TELEGRAM_BOT_TOKEN y APP_USERS
npm start                 # http://localhost:3000
```

Pruebas:

```bash
npm test
```

## Configuracion

| Variable | Para que sirve |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Token del bot de BotFather. Sin el, la app guarda pero no envia. |
| `TELEGRAM_FALLBACK_CHAT_ID` | Grupo para los paises que aun no tienen el suyo. |
| `APP_USERS` | Operadores, como `bryan:clave,jose:otraclave`. |
| `SESSION_SECRET` | Firma de la sesion. Genera uno largo y no lo cambies. |
| `TIMEZONE` | Zona horaria de la fecha por defecto y los informes. |
| `DB_FILE` | Ruta del archivo SQLite. Ponlo en disco persistente. |

> Si no defines `APP_USERS` ni `ADMIN_PASSWORD`, la app arranca **sin clave**.
> Sirve para probar en local; nunca la publiques asi.

### Conectar los grupos de Telegram

Un solo bot atiende todos los paises; lo que cambia es el grupo destino.

1. Agrega el bot al grupo del pais y dale permiso de escribir.
2. Escribe cualquier mensaje en el grupo.
3. Abre `https://api.telegram.org/bot<TOKEN>/getUpdates` y copia el
   `chat.id` (el de un grupo empieza por `-100`).
4. Pegalo en **Ajustes › Grupo por pais**.

Si el grupo usa temas (foros), guarda ademas el `message_thread_id` del tema
en el campo correspondiente del pais.

### Formato del mensaje

En **Ajustes › Formato del mensaje** hay dos plantillas listas, con vista
previa en vivo (una cuenta o tres cuentas mas USDT).

**Como hoy** deja el mensaje identico al que llega ahora a los grupos:

```
NUEVO PAGO 📍: 20/8/2026 13:40:50

Monto: 5100

BANCOLOMBIA
Juan Ramirez
AHORROS
11548736279
CEDULA
1088354953

2876400
```

**Mejorado** agrega lo que hoy no se ve:

```
📍 NUEVO PAGO · 20260820-007
🗓 20/8/2026 13:40:50
🇧🇷 Brasil ➡️ 🇨🇴 Colombia

💵 Monto: 5.100,00 BRL
📈 Tasa: 564
💰 Total: 2.876.400 COP

🏦 BANCOLOMBIA
Juan Ramirez
AHORROS · 11548736279
CEDULA 1088354953
💸 2.876.400 COP

👤 bryan
```

Que cambia y por que:

- **Referencia** (`20260820-007`) para poder citar un pago concreto en el
  grupo y encontrarlo despues en el informe.
- **Tasa y moneda**: hoy el mensaje dice `Monto: 5100` sin decir de que moneda
  ni a que tasa, asi que no se puede verificar el total desde el grupo.
- **Total con moneda**, en vez de un numero suelto al final.
- **Cuentas y documentos en `<code>`**: en Telegram se copian de un toque y
  dejan de convertirse en enlaces de telefono (que es por lo que hoy salen en
  azul y al tocarlos abren el marcador).
- **Fraccionamiento numerado** (`1/3`, `2/3`, `3/3`) con el monto de cada
  cuenta, para que quien paga sepa cuantas transferencias faltan.
- **Venta de USDT** y **entregas en efectivo** con su bloque propio.

Se puede editar libremente. Marcadores disponibles:

```
{{folio}} {{fecha}} {{fecha_hora}} {{hora}} {{pais}} {{pais_destino}}
{{monto_origen}} {{monto_origen_num}} {{moneda_origen}} {{tasa}}
{{monto_destino}} {{monto_destino_num}} {{moneda_destino}} {{tipo}}
{{cliente}} {{destinos}} {{destinos_simple}} {{usdt}} {{notas}} {{operador}}
```

Acepta el HTML que admite Telegram (`<b>`, `<i>`, `<code>`). Los bloques
`{{destinos}}` (mejorado) y `{{destinos_simple}}` (como hoy) se arman solos
segun el tipo de entrega y la cantidad de cuentas.

---

## Como esta hecho

Una sola dependencia (Express). La base es SQLite a traves del modulo
`node:sqlite` que ya viene con Node, asi que no hay que compilar nada ni
levantar un servidor de base de datos.

```
src/
  server.js      arranque de Express y manejo de errores
  config.js      lectura de variables de entorno
  db.js          esquema SQLite y datos iniciales (paises y bancos)
  money.js       aritmetica exacta de dinero (BigInt escalado a 8 decimales)
  currencies.js  decimales reales de cada moneda (COP y CLP sin centavos)
  operations.js  calculo, validaciones y persistencia de operaciones
  telegram.js    plantilla del mensaje y envio con reintentos
  report.js      informe contable y exportacion a CSV
  routes/api.js  API HTTP
  auth.js        sesion firmada con HMAC, sin dependencias
public/          interfaz movil (HTML, CSS y JS sin framework)
test/            43 pruebas: dinero, operaciones, informe y API completa
```

### Por que el dinero no usa numeros normales

Con `Number`, `0.1 + 0.2` da `0.30000000000000004`. En una operacion de
10.000.000 COP repartida en tres cuentas eso significa descuadres de centavos
que despues no cuadran contra el banco. Todos los importes se manejan como
enteros `BigInt` escalados a 8 decimales y solo se redondean al final, con los
decimales reales de cada moneda.

Los campos de importe aceptan cualquier forma de escribir (`10000`,
`10.000.000`, `1.234,56`) y muestran el numero ya agrupado mientras se teclea,
asi que la advertencia de *"no colocar comas ni puntos"* del formulario viejo
deja de hacer falta.

---

## Despliegue

Cualquier servicio que corra Node 22 sirve (Railway, Render, Fly, un VPS).
Lo unico importante:

- Monta un **volumen persistente** para `DB_FILE`. Si el disco es efimero, se
  pierden las operaciones en cada despliegue.
- Pon `NODE_ENV=production` y `SECURE_COOKIES=1` detras de HTTPS.
- Haz copia periodica del archivo `.db`.

Para seguir usando el dominio actual, apunta `botxar.com` a este servicio o
enlaza a el desde el boton **ENVIOS** de la pagina de Wix.
