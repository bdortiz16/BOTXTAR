# BOTXTAR

Aplicacion para registrar los envios (remesas) y avisar automaticamente al
grupo de Telegram del pais correspondiente.

Reemplaza el circuito actual de **Wix + formularios de Google**: el operador ya
no escribe el total a mano ni pasa por 10 paginas de formulario, y cada
operacion queda guardada para el informe contable.

---

## Que hace

0. **Inicio.** Al entrar se ve como va el dia: operaciones, lo recibido por
   moneda, lo pagado, lo que se envio al grupo y nadie marco como pagado, y las
   ultimas operaciones. Desde ahi se abre un envio nuevo, el informe o los
   ajustes.
1. **Fecha y pais.** Se elige la fecha y se abre la cuadricula de paises.
   Estan los grupos que ya existen (Peru, Chile, Brasil, Mexico) mas Colombia,
   Venezuela, Ecuador y USDT, y hay un boton **Otro pais** para agregar
   cualquier destino nuevo con su moneda y su grupo de Telegram.
2. **Monto y tasa.** Se escriben los dos numeros y **el sistema calcula el
   total solo**: 10.000 PEN x tasa 1.000 = 10.000.000 COP. El total aparece en
   vivo mientras se escribe. La tasa admite multiplicar o dividir.
3. **Tipo de entrega.** Transferencia o entrega en efectivo.
   - *Transferencia*: nombre, tipo y numero de documento, banco, numero y tipo
     de cuenta, y monto. El banco se elige de una lista con busqueda (154
     bancos y billeteras precargados); si falta alguno, se escribe y queda
     guardado para la proxima. La busqueda ignora acentos y mayusculas.
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

## Instalacion local

Requiere **Node.js 22.5 o superior**. En local no hace falta base de datos:
usa el SQLite que ya trae Node, sin compilar ni levantar nada.

```bash
npm install
cp .env.example .env      # completa TELEGRAM_BOT_TOKEN y APP_USERS
npm start                 # http://localhost:3000
```

Pruebas:

```bash
npm test                                        # contra SQLite
PGTEST_URL=postgres://usuario@host:5432 npm run test:pg   # contra Postgres
```

## Configuracion

| Variable | Para que sirve |
| --- | --- |
| `POSTGRES_URL` / `DATABASE_URL` | Base Postgres. **Obligatoria en Vercel.** Si no esta, se usa SQLite en disco. |
| `SESSION_SECRET` | Firma de la sesion. Opcional: si falta, se genera y se guarda sola. |
| `SIGNUP_CODE` | Codigo de invitacion para crear cuentas desde la pagina. |
| `TELEGRAM_BOT_TOKEN` | Token del bot de BotFather. Sin el, la app guarda pero no envia. |
| `TELEGRAM_FALLBACK_CHAT_ID` | Grupo para los paises que aun no tienen el suyo. |
| `APP_USERS` | Cuentas de respaldo por variable, como `bryan:clave`. Opcional. |
| `TIMEZONE` | Zona horaria de la fecha por defecto y los informes. |
| `DB_FILE` | Ruta del archivo SQLite, solo si no se usa Postgres. |
| `ALLOW_ANONYMOUS` | Modo sin clave para trastear en local. Se ignora en produccion. |

> **Nada de esto bloquea el arranque.** La app funciona sin ninguna variable
> configurada y muestra los avisos dentro, en la pantalla principal, donde se
> ven y se pueden atender. Bloquear el arranque resultaba peor que el problema
> que intentaba evitar: dejaba la app inservible con un mensaje que no decia
> que arreglar.

### Modo de prueba (sin base de datos)

Si se despliega en Vercel sin `POSTGRES_URL`, la app **funciona igual** pero
guarda en `/tmp`, que se borra cuando la instancia se recicla. Sirve para
revisar la interfaz; no para llevar la contabilidad.

En ese modo la app muestra un aviso rojo permanente en la pantalla principal.
Se quita solo en cuanto se conecta una base.

**Las cuentas creadas desde la pagina tambien se borran.** Cuando eso pasa, el
login lo dice tal cual —"no hay ninguna cuenta guardada"— y lleva a crearla de
nuevo, en vez de culpar a la clave. Para tener un acceso estable mientras
tanto, define `APP_USERS`: son credenciales que viven en la variable de
entorno, asi que sobreviven a cualquier reinicio.

```
APP_USERS=bryan:tu-clave-secreta
```

### Cuentas

La pagina publica (`/`) tiene **Ingresar** y **Crear cuenta**; la aplicacion
vive en `/app`.

- La **primera cuenta** se puede crear sin codigo y queda como administrador.
- A partir de ahi hace falta `SIGNUP_CODE`. Si no esta definido, el registro
  queda cerrado. Configuralo apenas crees tu cuenta.
- Las claves se guardan con **scrypt**, con sal distinta por usuario. Nunca se
  guarda ni se registra la clave en claro.
- `APP_USERS` sigue funcionando como respaldo, util si alguien se queda fuera.

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
  server.js       arranque de Express y manejo de errores
  config.js       variables de entorno y revision de produccion
  db/
    index.js      elige el motor segun el entorno
    schema.js     esquema y datos iniciales (paises y bancos)
    sqlite.js     motor local: el SQLite que trae Node
    postgres.js   motor de produccion (Vercel Postgres o Neon)
  money.js        aritmetica exacta de dinero (BigInt escalado a 8 decimales)
  currencies.js   decimales reales de cada moneda (COP y CLP sin centavos)
  operations.js   calculo, validaciones y persistencia de operaciones
  telegram.js     plantillas del mensaje y envio con reintentos
  report.js       informe contable y exportacion a CSV
  routes/api.js   API HTTP
  auth.js         sesion firmada con HMAC, sin dependencias
  users.js        cuentas y cifrado de claves con scrypt
  setup-page.js   pantalla de que falta configurar
api/index.js      punto de entrada para Vercel
public/
  index.html      pagina publica de botxtar.com
  app.html        la aplicacion
test/             90 pruebas, que corren contra SQLite y contra Postgres
```

Toda la capa de datos habla el mismo SQL: lo unico que cambia entre motores es
como se declara la clave primaria y la numeracion de los parametros, asi que
la misma suite de pruebas se ejecuta contra los dos.

### El sistema de diseño

La interfaz sigue las Human Interface Guidelines, y lo que se puede medir esta
cubierto por pruebas (`test/design.test.js`), no queda a criterio:

- **Contraste**: cada par de color que lleva texto se comprueba contra el
  minimo de 4.5:1, en tema claro y en oscuro. El violeta de marca se partio en
  dos tokens porque un mismo color no puede servir de texto sobre fondo oscuro
  y de relleno con texto blanco encima sin fallar uno de los dos.
- **Areas tactiles**: 44pt minimo. Un boton pequeño reduce el texto, nunca el
  area donde se toca.
- **Escala tipografica**: nueve estilos, ninguno por debajo de los 11pt
  minimos; el cuerpo se queda en 17pt, que ademas evita que el navegador haga
  zoom al enfocar un campo.
- **Claro y oscuro**: colores semanticos con las dos variantes. En oscuro las
  superficies que avanzan son mas claras que el fondo, que es lo que da la
  sensacion de profundidad.
- **Material translucido**: solo en la capa funcional (barra superior, barra
  de reparto, avisos flotantes), nunca en las tarjetas. Con respaldo solido
  para navegadores sin `backdrop-filter` y para quien pidio reducir
  transparencia.
- **Texto en oracion**, no en mayusculas. El estado de una operacion se dice
  con palabra ademas de con color.
- Se respetan `prefers-reduced-motion` y las areas seguras del telefono.

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

## Despliegue en Vercel

El repositorio ya trae `vercel.json` y `api/index.js`, asi que Vercel detecta
la app sola. Lo unico imprescindible es la base de datos.

**1. Crear la base.** En el panel de Vercel: *Storage -> Create Database ->
Postgres*, y conectarla al proyecto. Vercel inyecta `POSTGRES_URL` solo. Si
prefieres Neon o Supabase, copia su cadena de conexion en `DATABASE_URL`.

**2. Variables de entorno** (*Settings -> Environment Variables*):

```
SESSION_SECRET=<32 bytes en hex>
APP_USERS=bryan:tu-clave
TELEGRAM_BOT_TOKEN=<token de BotFather>
TIMEZONE=America/Bogota
NODE_ENV=production
```

**3. Limpiar el Build Command.** Si el proyecto se creo con otra plantilla,
en *Settings -> Build & Development Settings* puede haber quedado
`vite build`, que falla con `vite: command not found` porque este repo no usa
Vite. `vercel.json` ya lo sobrescribe; si el panel insiste, desactiva el
"Override" de Build Command.

**4. Dominio.** Apunta `botxar.com` al proyecto, o enlaza desde el boton
ENVIOS de la pagina de Wix.

El esquema y los paises iniciales se crean solos en la primera peticion; no
hay que correr migraciones a mano.

### Otras opciones

Tambien corre en Railway, Render o un VPS. Ahi puedes quedarte con SQLite si
montas un **volumen persistente** para `DB_FILE`; si el disco es efimero, se
pierden las operaciones en cada despliegue.

En cualquier caso: `NODE_ENV=production`, `SECURE_COOKIES=1` detras de HTTPS,
y copia periodica de la base.
