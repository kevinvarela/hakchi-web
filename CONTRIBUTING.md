# Cómo contribuir

¡Gracias por querer mejorar **hakchi web**! Toda ayuda es bienvenida: reportar errores, probar con
tu consola, mejorar la documentación o enviar código.

## Reportar errores

Abre un [issue](https://github.com/kevinvarela/hakchi-web/issues) con la plantilla "Reportar un error".
Indica tu consola, tu sistema operativo y lo que muestra la terminal. **Nunca adjuntes ROMs** ni
enlaces a ROMs: el issue se cerrará.

## Probar con hardware real

La app se desarrolla sobre todo con la consola simulada (`npm run demo`). Los informes de cómo funciona
con consolas reales (SNES Mini EUR/USA/JPN, NES Mini, Famicom Mini) y distintas versiones de hakchi
son muy valiosos, sobre todo si algo falla.

## Enviar código

1. Haz un fork y crea una rama: `git checkout -b mi-mejora`
2. Instala las dependencias: `npm install`
3. Haz tus cambios. Prueba en modo demo: `npm run demo`
4. Pasa las pruebas: `npm test` (y añade pruebas para lo nuevo)
5. Abre un pull request explicando qué cambia y por qué.

### Reglas

- **Nada que pueda dañar la consola sin aviso.** Cualquier operación que escriba fuera de la carpeta de
  juegos o de módulos de hakchi debe estar muy justificada, avisar al usuario y estar probada.
- **Sin dependencias innecesarias.** El proyecto usa solo `express`, `multer` y `ssh2`.
- **La API solo escucha en `localhost`** y exige la cabecera `X-Hakchi-Web` en peticiones que cambian algo.
  No quites esas protecciones.
- **Sin ROMs, BIOS ni contenido con copyright** en el repositorio, ni siquiera en las pruebas
  (las pruebas generan ROMs sintéticas).
- Textos de la interfaz en español claro.

## Licencia

Al contribuir aceptas que tu código se publique bajo la licencia del proyecto,
[GPL-3.0-or-later](LICENSE).
