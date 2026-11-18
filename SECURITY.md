# Seguridad

## Modelo de seguridad

- El servidor escucha **solo en `127.0.0.1`**: no es accesible desde otros equipos de la red.
- La API rechaza peticiones cuyo `Host` no sea `localhost` / `127.0.0.1` (protección contra *DNS rebinding*).
- Las peticiones que modifican algo exigen la cabecera `X-Hakchi-Web: 1`, que otras webs no pueden enviar
  sin permiso CORS (protección contra *CSRF*).
- La conexión con la consola usa SSH con las credenciales públicas por defecto de hakchi (`root` sin contraseña).
  Eso es lo normal en hakchi: la consola solo es accesible por el cable USB.
- Los módulos (`.hmod`) se ejecutan como `root` en la consola. Instala solo módulos de fuentes de confianza.

## Reportar una vulnerabilidad

Si encuentras un problema de seguridad, **no abras un issue público**. Usa la opción
[Report a vulnerability](https://github.com/kevinvarela/hakchi-web/security/advisories/new) de GitHub.
