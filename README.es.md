<div align="center">

[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Español** · [Français](README.fr.md) · [Deutsch](README.de.md) · [Русский](README.ru.md) · [Português](README.pt.md)

</div>

<p align="center">
  <img src="icon.svg" width="88" alt="">
</p>

<h1 align="center">Predicción del siguiente mensaje</h1>

<p align="center">
  <b>Un plugin para el cuadro de entrada de DeepSeek Harness</b><br>
  Cuando el asistente termina, tu siguiente mensaje más probable ya te espera en el cuadro de entrada.<br>
  <kbd>Tab</kbd> lo inserta, <kbd>Esc</kbd> lo descarta y <b>nunca envía nada por ti</b>.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/versi%C3%B3n-0.4.1-4d6bfe" alt="versión 0.4.1">
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-0.2.2--rc.1-1f2937" alt="DeepSeek Harness 0.2.2-rc.1">
  <img src="https://img.shields.io/badge/idiomas-9-8250df" alt="idiomas 9">
  <img src="https://img.shields.io/badge/dependencias%20externas-0-2ea44f" alt="dependencias externas 0">
  <a href="https://github.com/KungerChen/dsh-next-message-predictor/actions/workflows/ci.yml"><img src="https://github.com/KungerChen/dsh-next-message-predictor/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/licencia-MIT-blue" alt="licencia MIT">
</p>

<p align="center">
  <img src="docs/images/demo.png" width="760" alt="Demostración: cuando el asistente responde, aparece una sugerencia gris en el cuadro de entrada; se pide otra; Tab la inserta">
</p>

<p align="center">
  <sub>Aparece una sugerencia → pide otra si no encaja → <kbd>Tab</kbd> la inserta y puedes seguir editando antes de enviar</sub>
</p>

---

## Por qué usarlo

Al trabajar con un asistente, muchas respuestas son cortas y fáciles de adivinar: «continúa», «ejecuta las pruebas», «enséñame los cambios». Este plugin escribe ese seguimiento por adelantado y lo deja en el cuadro de entrada.

<table>
<tr>
<td width="33%" valign="top">

### ⌨️ Menos tecleo

Los seguimientos habituales, a una tecla. Una vez insertado, el texto es como cualquier otro que hayas escrito: se puede editar y deshacer.

</td>
<td width="33%" valign="top">

### 🤫 Sin interrupciones

En cuanto empiezas a escribir, la sugerencia se aparta. No aparece durante la composición del IME ni con un menú abierto. Si el modelo no está seguro, no ofrece nada.

</td>
<td width="33%" valign="top">

### 🛡️ No se extralimita

Solo pone texto en el cuadro de entrada. En el plugin no hay ningún código de «enviar mensaje»; enviar es siempre decisión tuya.

</td>
</tr>
<tr>
<td valign="top">

### 💰 Coste bajo control

Por defecto usa un modelo de bajo coste, con límites diarios de solicitudes y de tokens. Las frases cortas que repites se ofrecen directamente, sin llamar al modelo.

</td>
<td valign="top">

### 🔒 La privacidad primero

Antes de enviar se ocultan las posibles claves, tokens, direcciones de correo y números de teléfono. El navegador nunca sube tu borrador. Las estadísticas locales guardan números, no texto.

</td>
<td valign="top">

### 📊 Uso transparente

Las solicitudes, la tasa de aceptación, el tiempo de respuesta y el uso de tokens de los últimos 7 días están en la página de ajustes, para que veas si merece la pena.

</td>
</tr>
</table>

## Funciones

### La sugerencia está en el propio cuadro de entrada

Cuando el asistente termina, si el cuadro de entrada está vacío, aparece una sugerencia gris justo donde ibas a escribir. Sin ventanas emergentes y sin ocupar espacio.

<p align="center">
  <img src="docs/images/suggestion.png" width="720" alt="Una sugerencia gris en el cuadro de entrada, con «Tab: aceptar» y «Otra» a la derecha">
</p>

| Tecla | Qué hace |
|---|---|
| <kbd>Tab</kbd> o <kbd>→</kbd> | Inserta la sugerencia en el cuadro de entrada, donde puedes seguir editando; <kbd>Ctrl</kbd>+<kbd>Z</kbd> deshace solo esa inserción |
| <kbd>Esc</kbd> | Oculta la sugerencia |
| <kbd>Alt</kbd>+<kbd>\\</kbd> (configurable) | Predice al instante; si ya hay una sugerencia, pasa a otra. Una sola llamada trae varias alternativas, así que cambiar es inmediato |
| Escribir sin más | La sugerencia desaparece al momento; vuelve cuando vacías el cuadro de entrada |

### Tres modos, un clic

¿No quieres estudiar cada opción? Elige un modo. Puedes deshacerlo o afinarlo después.

<p align="center">
  <img src="docs/images/modes.png" width="720" alt="La tarjeta de modos: Equilibrado, Ahorro, Calidad">
</p>

| Modo | Cuándo predice | Modelo | Contexto | Límite diario | Indicado para |
|---|---|---|---|---|---|
| **Equilibrado** (Recomendado) | Automáticamente tras cada respuesta | Un modelo concreto de bajo coste | 12 mensajes | 200 solicitudes | El uso diario |
| **Ahorro** | Solo cuando pulsas «Predecir» o el atajo | Un modelo concreto de bajo coste | 6 mensajes | 60 solicitudes | Controlar el coste al máximo |
| **Calidad** | Automáticamente tras cada respuesta | El modelo de la sesión | 20 mensajes | 200 solicitudes | Sugerencias más ajustadas |

Un modo solo cambia el disparador, la estrategia de modelo, el tamaño del contexto y los límites. No toca el interruptor principal, el atajo, el idioma ni las opciones de privacidad, y conserva el modelo que hayas introducido.

### Nueve idiomas de interfaz

La página de ajustes, los botones del cuadro de entrada y sus descripciones están disponibles en 简体中文, English, 日本語, 한국어, Español, Français, Deutsch, Русский, Português. Por defecto el plugin sigue el idioma configurado en DeepSeek Harness; también puedes elegir uno en **Ajustes → Predicción → Idioma**, y se aplica al instante. Las sugerencias, en cambio, siguen siempre el idioma de tu conversación.

<p align="center">
  <img src="docs/images/languages.png" width="720" alt="La parte superior de la página de ajustes en inglés, japonés, español y ruso">
</p>

### A un clic en la barra lateral

Pulsa «Añadir a la barra lateral» y aparecerá una entrada en la barra lateral izquierda de DSH; a partir de ahí, consultar el estado o cambiar de modo ya no requiere pasar por Ajustes. La versión junto al título te dice siempre cuál tienes instalada.

<table>
<tr>
<td width="30%" align="center" valign="middle">
  <img src="docs/images/sidebar-entry.png" width="230" alt="La entrada «Predicción» en la barra lateral izquierda">
</td>
<td width="70%" align="center" valign="middle">
  <img src="docs/images/page-header.png" width="560" alt="La versión junto al título de la página y el botón «Quitar de la barra lateral»">
</td>
</tr>
</table>

### Cuánto usas, de un vistazo

<details>
<summary><b>Ver la página de ajustes completa</b> (básico, modos, origen de las sugerencias, modelo, últimos 7 días)</summary>
<br>
<p align="center">
  <img src="docs/images/settings.png" width="640" alt="La página de ajustes completa">
</p>
</details>

> La mayoría de las capturas muestran la interfaz en chino. Proceden de una conversación de demostración y las genera un script de este repositorio con un modelo simulado local; por eso el modelo aparece como Mock y las cifras son pequeñas. En el uso real, las sugerencias las genera el modelo que hayas configurado en DSH.

## Instalación

Requiere DeepSeek Harness `0.2.2-rc.1` (`>=0.2.2-rc.1 <0.3.0`). El plugin no tiene dependencias externas ni necesita compilarse. Se instala con un solo comando:

```powershell
dsh plugin --profile desktop add github:KungerChen/dsh-next-message-predictor
```

Lo que va tras `--profile` es el perfil que usas a diario: `desktop` en la aplicación de escritorio, `web` en la versión web. Después, **cierra DSH por completo y vuelve a abrirlo**.

<details>
<summary>No se encuentra el comando <code>dsh</code>, o quieres instalar desde una carpeta local</summary>

La línea de comandos `dsh` está en la carpeta de instalación de DeepSeek Harness y se puede invocar por su ruta completa. Si quieres modificar el código, clona el repositorio e instala desde la carpeta local:

```powershell
git clone https://github.com/KungerChen/dsh-next-message-predictor.git
$dsh = '<carpeta de instalación de DSH>\resources\runtime\cli\bin\dsh.cmd'
& $dsh plugin --profile desktop add '<carpeta del plugin>'
```

`<carpeta de instalación de DSH>` es donde está instalado DeepSeek Harness; `<carpeta del plugin>` es la carpeta que acabas de clonar.

</details>

Después, tres pasos para empezar:

1. Abre **Ajustes → Predicción** y activa «Activar la predicción». Viene desactivado: hasta que lo actives no se muestra ninguna sugerencia ni se llama a ningún modelo.
2. Elige uno en «Modo». El predeterminado es «Equilibrado».
3. Para tenerlo más a mano, pulsa «Añadir a la barra lateral» en la esquina superior derecha.

<details>
<summary>Actualizar y desinstalar</summary>

**Actualizar**: si instalaste desde GitHub, desinstala y vuelve a ejecutar el comando de instalación; si instalaste desde una carpeta local, ejecuta `git pull` en ella. Después reinicia DSH. Recargar la página no basta: la página sería nueva y la parte en segundo plano seguiría siendo antigua, y la página de ajustes avisaría de que las versiones no coinciden.

**Desinstalar**:

```powershell
dsh plugin --profile desktop remove dsh-next-message-predictor
```

Activa un solo plugin de predicción para el cuadro de entrada por perfil. Si se detecta otro, este plugin se pausa solo y explica el motivo en la página de ajustes.

</details>

## Qué envía

Cada predicción es una única solicitud al modelo, sin reintentos automáticos. Contiene fragmentos de los **mensajes del usuario y las respuestas finales de texto del asistente** más recientes de la sesión actual: por defecto, como máximo 12 mensajes y unos 2.000 tokens.

- No incluye argumentos ni resultados de herramientas, razonamiento ni el prompt del sistema.
- Antes de enviar, las posibles claves privadas, claves de API, tokens, contraseñas, direcciones de correo, números de móvil y de identidad, y el nombre de usuario en las rutas de la carpeta personal se sustituyen por marcadores (se basa en reglas; no puede garantizar que lo detecte todo).
- La página del navegador solo envía identificadores de sesión y de turno, nunca el borrador, los adjuntos ni texto de la conversación; el contenido para el modelo lo lee la parte en segundo plano de los registros de sesión del propio DSH.
- «Dar prioridad a los mensajes cortos frecuentes» solo compara los mensajes cortos que has enviado en este equipo; no se llama a ningún modelo.

La descripción completa, y cómo borrar los datos locales, está en [Privacidad y límites de los datos](docs/PRIVACY.md).

## Preguntas frecuentes

<details>
<summary><b>¿Enviará un mensaje por mí?</b></summary>

No. Aceptar una sugerencia solo pone texto en el cuadro de entrada, mediante la interfaz de inserción del propio cuadro; el plugin no contiene ninguna llamada que envíe o confirme.

</details>

<details>
<summary><b>¿Cuánto cuesta?</b></summary>

Cada predicción es una llamada muy breve al modelo (por defecto, 96 tokens de salida como máximo). Los límites diarios predeterminados son 200 solicitudes y 500.000 tokens; una vez alcanzados, ese día no se hacen más llamadas. Para gastar menos, elige el modo «Ahorro», que solo predice cuando lo pides. El uso real aparece en «Últimos 7 días», en la página de ajustes.

</details>

<details>
<summary><b>¿Por qué a veces no hay sugerencia?</b></summary>

Es deliberado: cuando el modelo no está seguro no ofrece nada, y la salida que incumple las reglas (demasiado larga, de varias líneas, con el tono del asistente) se descarta. La línea de estado de la página de ajustes indica por qué no hay ninguna ahora mismo. Cuando quieras una, pulsa <kbd>Alt</kbd>+<kbd>\\</kbd>.

</details>

<details>
<summary><b>¿Son precisas las sugerencias?</b></summary>

Se le dan bien los seguimientos cortos y claros: confirmar, pedir una verificación, preguntar un detalle. No puede adivinar lo que solo tú sabes, y en ese caso lo correcto es que guarde silencio.

</details>

## Documentación

La documentación detallada está escrita en chino.

| Documento | Contenido |
|---|---|
| [Guía de uso](docs/USER-GUIDE.md) | Teclas, cada elemento de la página de ajustes, modos, la entrada de la barra lateral, preguntas frecuentes |
| [Referencia de configuración](docs/CONFIGURATION.md) | Valores predeterminados e intervalos de todas las opciones, valores de los tres modos |
| [Privacidad y límites de los datos](docs/PRIVACY.md) | Qué se envía, archivos locales, cómo borrar los datos |
| [Arquitectura](docs/ARCHITECTURE.md) | Las mitades Host y navegador, el flujo de las solicitudes, el protocolo |
| [Desarrollo y verificación](docs/DEVELOPMENT.md) | Compilación, pruebas, verificación de extremo a extremo, regenerar las capturas |
| [Compatibilidad](docs/COMPATIBILITY.md) | El contrato confirmado con DSH 0.2.2-rc.1 y las alternativas |
| [Registro de cambios](CHANGELOG.md) | Cambios de cada versión |
| [Índice de la documentación](docs/README.md) | Todos los documentos, incluidas las notas anteriores de verificación y optimización |

## Contribuir

```powershell
npm run build   # genera lib/client.js a partir de src/shared + src/client
npm test        # ejecuta las pruebas unitarias y de integración
npm run check   # compilación + pruebas + comprobación de sintaxis
```

No hace falta `npm install` ni empaquetador; se requiere Node.js 22 o posterior. Para añadir o corregir una traducción, edita `src/client/locales/<idioma>.js`; las pruebas comprueban que todos los idiomas tengan las mismas claves.

## Limitaciones conocidas

- Verificado únicamente en DSH `0.2.2-rc.1`.
- Guardar un ajuste hace que el host reinicie la parte en segundo plano del plugin; la predicción en curso se cancela.
- Varias ventanas comparten los resultados de predicción; ocultar una sugerencia en una ventana no se sincroniza con las demás en tiempo real.
- La paleta de comandos y el diálogo de comentarios se reconocen por el foco y por rasgos modales; un error de detección solo supone una sugerencia menos, nunca una pulsación robada.

## Licencia

Publicado bajo la [licencia MIT](LICENSE). La elección de los puntos de extensión y la interacción «sugerencia gris + Tab para aceptar + Esc para ocultar» se inspiran en `dsh-composer-prediction`, también con licencia MIT; no se ha copiado su código. Consulta [NOTICE](NOTICE).
