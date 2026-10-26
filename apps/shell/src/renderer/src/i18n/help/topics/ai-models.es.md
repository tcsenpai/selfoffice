# Modelos de IA y ajustes

## Proveedores y modelos

Los modelos y las claves se configuran en Configuración (la fila de cuenta de la parte inferior izquierda de Inicio):

![La ventana de configuración](img/settings-general.png)

- **Claude (suscripción)** (predeterminado): usa su inicio de sesión local de la CLI `claude` — ejecute `claude login` una vez; modelos sonnet, opus, haiku; solo texto, sin imágenes. También se admite **Codex CLI**, y los servidores locales como Ollama o LM Studio funcionan como endpoints personalizados compatibles con OpenAI.
- **Búsqueda web y medios**: la búsqueda web funciona sin clave (cadena gratuita; los proveedores con clave son opcionales). La generación de imágenes y el análisis de medios siguen desactivados hasta que se configure un proveedor de AI Media.
- **Endpoints personalizados (BYOK)**: Configuración ▸ IA toma una URL base y una clave API por protocolo: compatible con OpenAI, Anthropic, Gemini, DeepSeek, DashScope (qwen) y más. Las claves se guardan en el archivo de ajustes de la aplicación en este equipo y se envían solo en las cabeceras de la petición. Atlas Cloud figura entre los protocolos integrados.
- Se puede elegir un modelo distinto por capacidad: chat/generación, generación de imágenes, análisis de imágenes.
- **Probar conexión**: comprueba que el endpoint sea accesible y que el modelo esté visible antes de guardar.
- Las URL base pueden llevar una ruta y una cadena de consulta (estilo pasarela); las rutas del endpoint se concatenan correctamente.

## Integración con la CLI (tipo Codex)

- Los ajustes aceptan la ruta de un programa CLI local (los directorios personales no ASCII y un prefijo ~ funcionan; ~ se expande automáticamente); Detectar modelos sondea los modelos disponibles de esa CLI.
- La validación solo comprueba la existencia: no impone restricciones de juego de caracteres.

## Cuándo se aplican los cambios

- Los cambios de modelo y de endpoint se aplican de inmediato; una conversación en curso mantiene la configuración anterior hasta su siguiente vuelta.
