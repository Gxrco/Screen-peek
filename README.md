# screen-peek

Mod para Claude Code que muestra **lo que ve el modelo mientras trabaja**: cada captura de pantalla que recibe (Playwright, Chrome DevTools o cualquier herramienta MCP que devuelva imágenes, y cada imagen que abre con `Read`) aparece en vivo en un panel lateral.

Útil cuando Claude trabaja en otro servidor (SSH, código remoto) y toma capturas que tú no puedes ver.

<img width="1200" height="657" alt="Screen Recording 2026-10-10 at 2 20 33 PM" src="https://github.com/user-attachments/assets/fc901410-27f3-4694-88ae-42154905fe88" />

## Instalación

En una sesión de Claude Code en la terminal, escribe:

```
/plugin install screen-peek --marketplace gxrco/screen-peek
```

1. Responde `y` para agregar el marketplace `github:gxrco/screen-peek`.
2. Pulsa Enter para instalarlo con alcance de usuario (queda activo en todas tus sesiones).
3. Verás `Installed screen-peek. Plugin is now active.` y funciona desde ese momento, sin reiniciar.

> El comando de instalación funciona en la terminal. Si después usas la app de escritorio, el mod instalado allí también se carga.

## Uso

| Acción | Cómo |
| --- | --- |
| Abrir el panel | `/peek` (se abre solo con la primera captura si la terminal tiene ≥ 144 columnas) |
| Captura anterior / siguiente | `p` / `n` |
| Volver a la más reciente | `l` |
| Abrir la captura en el visor del sistema | `o` |

Mientras una captura se está tomando, el panel muestra `⏳ Procesando captura…` y la barra de estado `📸 capturando…`. Debajo de la imagen hay un registro de la actividad del navegador (navegar, clics, scripts de Playwright).

## Requisitos y limitaciones

- Claude Code 2.1.296 o superior (versiones antiguas no cargan módulos de hooks y muestran `Failed to load hooks … expected record`).
- **Ver la imagen dentro del panel** requiere una terminal con el protocolo gráfico de kitty: **Ghostty** o **kitty**. En otras terminales (Warp, iTerm2, Terminal.app) el panel muestra un aviso y puedes abrir cada captura en el visor del sistema con `o`.
- El panel dibuja **PNG de hasta 2 MiB**. Las capturas JPEG se listan pero no se dibujan (pide `type: "png"` al tomarlas).
- "Abrir" usa el comando `open` de macOS.
- Solo aparecen imágenes que llegan al modelo. Si Claude toma una captura con un script y nunca la abre, el modelo tampoco la ve.
- Cada captura se guarda en `/tmp/screen-peek/<id-de-sesión>/` (las últimas 30 por sesión, de las 5 sesiones usadas más recientemente; las capturas y sesiones más antiguas se borran del disco). Al reanudar una sesión —por ejemplo, al volver desde la vista de Agents— el panel recupera sus capturas. macOS limpia `/tmp` periódicamente.

## Desarrollo

```
claude --plugin-dir ./screen-peek      # sesión con el mod cargado desde la carpeta
claude plugin validate ./screen-peek   # valida manifiesto, marketplace y hooks
claude plugin test ./screen-peek       # ejecuta tests/*.test.ts
```

Estructura:

```
.claude-plugin/plugin.json        manifiesto
.claude-plugin/marketplace.json   permite instalarlo con /plugin install
hooks/hooks.json                  apunta al módulo de hooks
hooks/register.tsx                lógica: captura de imágenes y panel
types/index.d.ts                  tipos del estado del mod
tests/screen-peek.test.ts         pruebas
```
