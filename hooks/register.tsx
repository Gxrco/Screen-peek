import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, Shot } from '../types'

const PANE = 'screen-peek'
const MAX_SHOTS = 30
const MAX_SESSIONS = 5
const MAX_PNG_BYTES = 2 * 1024 * 1024
const ROOT = '/tmp/screen-peek'

const shots = atom({ plugin: 'screen-peek', key: 'shots' } as const, [])
const activity = atom({ plugin: 'screen-peek', key: 'activity' } as const, [])
const selected = atom({ plugin: 'screen-peek', key: 'selected' } as const, null)

// Caché de píxeles del módulo. La fuente de verdad es el disco: cada captura se
// escribe en ROOT/<sesión>/ al llegar, y su índice queda en $.store bajo la
// sesión, así que una recarga del mod o salir a Agents y volver no la pierde.
const pixels = new Map<string, { base64: string; mime: string; width?: number; height?: number }>()

const BROWSER_TOOL = /playwright|browser|chrome|puppeteer|devtools/i
const CAPTURE_TOOL = /screenshot|snapshot|capture/i

type Found = { base64: string; mime: string }

// Busca bloques de imagen en cualquier forma de resultado: Read
// ({ type: 'image', file: { base64, type } }) o MCP ({ type: 'image', data, mimeType }).
const findImage = (value: unknown, depth = 0): Found | undefined => {
  if (depth > 5 || value === null || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImage(item, depth + 1)
      if (found) return found
    }
    return undefined
  }
  const obj = value as Record<string, unknown>
  if (obj.type === 'image') {
    if (typeof obj.data === 'string')
      return { base64: obj.data, mime: String(obj.mimeType ?? 'image/png') }
    const file = obj.file as Record<string, unknown> | undefined
    if (file && typeof file.base64 === 'string')
      return { base64: file.base64, mime: String(file.type ?? 'image/png') }
    const source = obj.source as Record<string, unknown> | undefined
    if (source && typeof source.data === 'string')
      return { base64: source.data, mime: String(source.media_type ?? 'image/png') }
  }
  for (const key of ['content', 'result', 'file', 'output']) {
    const found = findImage(obj[key], depth + 1)
    if (found) return found
  }
  return undefined
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// Ancho y alto del encabezado IHDR del PNG (bytes 16–23), sin decodificar todo.
const pngSize = (base64: string): { width: number; height: number } | undefined => {
  const bytes: number[] = []
  for (let i = 0; i + 3 < 44 && i + 3 < base64.length; i += 4) {
    const n = [0, 1, 2, 3].reduce((acc, k) => (acc << 6) | Math.max(0, B64.indexOf(base64[i + k] ?? 'A')), 0)
    bytes.push((n >> 16) & 255, (n >> 8) & 255, n & 255)
  }
  if (bytes.length < 24) return undefined
  const u32 = (o: number) => ((bytes[o]! << 24) >>> 0) + (bytes[o + 1]! << 16) + (bytes[o + 2]! << 8) + bytes[o + 3]!
  const size = { width: u32(16), height: u32(20) }
  return size.width > 0 && size.height > 0 ? size : undefined
}

const describe = (e: { tool: string } & Record<string, unknown>): string => {
  const short = e.tool.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '')
  const detail = e.url ?? e.file_path ?? e.element ?? e.filename ?? e.command ?? e.text
  const line = typeof detail === 'string' ? (detail.split('\n')[0] ?? '').trim().slice(0, 70) : ''
  return line ? `${short} · ${line}` : short
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

const time = (at: number) => new Date(at).toTimeString().slice(0, 8)

const storeKey = async ($: EngineInterface) => `shots:${await $.session.id()}`

const SAFE_ID = /^[\w.-]+$/

// Borra archivos o carpetas, solo dentro de ROOT.
const remove = async ($: EngineInterface, paths: string[]) => {
  const inside = paths.filter(p => p.startsWith(`${ROOT}/`) && !p.includes('..'))
  if (inside.length > 0) await $.process.run(['rm', '-rf', ...inside]).catch(() => undefined)
}

// Guarda el índice de la sesión en $.store. La clave se reescribe para quedar la
// última (las claves guardan su orden de inserción): así se conservan las
// MAX_SESSIONS usadas más recientemente, y de las demás se borra índice y carpeta.
const persist = async ($: EngineInterface, list: Shot[]) => {
  const key = await storeKey($)
  await $.store.delete(key)
  await $.store.set(key, list)
  const others = (await $.store.keys()).filter(k => k.startsWith('shots:') && k !== key)
  const stale = others.slice(0, Math.max(0, others.length - (MAX_SESSIONS - 1)))
  for (const old of stale) await $.store.delete(old)
  await remove($, stale.map(k => k.slice('shots:'.length)).filter(id => SAFE_ID.test(id)).map(id => `${ROOT}/${id}`))
}

// Cambia la lista de capturas, la guarda y borra del disco las que quedaron fuera.
const saveShots = async ($: EngineInterface, change: (list: Shot[]) => Shot[]) => {
  const before = await read($, shots)
  const after = await update($, shots, list => change(list).slice(-MAX_SHOTS))
  const kept = new Set(after.map(s => s.id))
  const dropped = before.filter(s => !kept.has(s.id))
  for (const s of dropped) pixels.delete(s.id)
  await remove($, dropped.flatMap(s => (s.file ? [s.file] : [])))
  await persist($, after)
}

const writeFile = async ($: EngineInterface, id: string, image: Found): Promise<string | undefined> => {
  const file = `${ROOT}/${await $.session.id()}/${id}.${EXT[image.mime] ?? 'png'}`
  const wrote = await $.process.run(['sh', '-c', 'mkdir -p "$(dirname "$1")" && base64 -d > "$1"', 'sh', file], { stdin: image.base64 })
  return wrote.exitCode === 0 ? file : undefined
}

// Píxeles de una captura: de la caché, o leídos del disco (tras una recarga).
const loadPixels = async ($: EngineInterface, shot: Shot) => {
  const cached = pixels.get(shot.id)
  if (cached || !shot.file) return cached
  const loaded = await $.fs.read(shot.file, { as: 'bytes' }).catch(() => undefined)
  if (!loaded) return undefined
  const mime = shot.mime ?? 'image/png'
  const px = { base64: loaded.base64, mime, ...(mime === 'image/png' ? pngSize(loaded.base64) : undefined) }
  pixels.set(shot.id, px)
  return px
}

const openShot = async ($: EngineInterface, shot: Shot) => {
  if (!shot.file) return $.ui.toast('Esta captura no se guardó en disco.')
  const ran = await $.process.run(['open', shot.file])
  if (ran.exitCode !== 0) $.ui.toast(`No se pudo abrir ${shot.file}`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'peek',
      description: 'Abre el panel con las capturas que ve el modelo',
    })
    // Al reanudar la sesión (p. ej. al volver desde Agents) el estado llega vacío:
    // se recupera el índice guardado para esta sesión.
    const saved = (await $.store.get(await storeKey($))) as Shot[] | undefined
    if (saved?.length && (await read($, shots)).length === 0)
      await update($, shots, () => saved.map(s => (s.status === 'running' ? { ...s, status: 'error' as const } : s)))
    return next(e)
  })

  on('command.run', { command: 'peek' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Lo que ve Claude' })
    return { text: 'Panel de capturas abierto.' }
  })

  on('tool.call', async ($, e, next) => {
    const input = e as { tool: string; tool_use_id: string } & Record<string, unknown>
    const isBrowser =
      BROWSER_TOOL.test(input.tool) ||
      (input.tool === 'Bash' && typeof input.command === 'string' && /playwright|screenshot|\.png\b/i.test(input.command))
    const maybeImage =
      (BROWSER_TOOL.test(input.tool) && CAPTURE_TOOL.test(input.tool)) ||
      (input.tool === 'Read' && typeof input.file_path === 'string' && /\.(png|jpe?g|webp|gif)$/i.test(input.file_path))
    const id = input.tool_use_id
    const label = describe(input)
    const at = Date.now()

    if (isBrowser)
      await update($, activity, list => [...list, { id, tool: input.tool, label, at, isDone: false } as Activity].slice(-50))

    if (maybeImage) {
      await saveShots($, list => [...list, { id, tool: input.tool, label, at, status: 'running' } as Shot])
      await update($, selected, () => null)
      $.ui.status('📸 capturando…')
      void $.ui.open({ id: PANE, title: 'Lo que ve Claude' })
    }

    const ran = await next(e)

    if (isBrowser)
      await update($, activity, list => list.map(a => (a.id === id ? { ...a, isDone: true } : a)))

    const image = ran.deny === undefined ? findImage(ran.result) : undefined
    if (image) {
      const size = image.mime === 'image/png' ? pngSize(image.base64) : undefined
      pixels.set(id, { ...image, ...size })
      const file = await writeFile($, id, image)
      const shot: Shot = { id, tool: input.tool, label, at, status: 'done', mime: image.mime, bytes: Math.floor((image.base64.length * 3) / 4), file }
      await saveShots($, list => (list.some(s => s.id === id) ? list.map(s => (s.id === id ? shot : s)) : [...list, shot]))
      await update($, selected, () => null)
      void $.ui.open({ id: PANE, title: 'Lo que ve Claude' })
    } else if (maybeImage) {
      const status: Shot['status'] = ran.deny !== undefined || ran.isError ? 'error' : 'no-image'
      await saveShots($, list => list.map(s => (s.id === id ? { ...s, status } : s)))
    }
    if (maybeImage || image) $.ui.status(undefined)

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const Image = e.surface === 'terminal' ? $.ui.resolve(e).Image : undefined
    const list = await read($, shots)
    const log = await read($, activity)
    const chosen = await read($, selected)

    const index = chosen ? list.findIndex(s => s.id === chosen) : list.length - 1
    const shot = list[index]
    const pick = (i: number) => {
      const target = list[Math.max(0, Math.min(list.length - 1, i))]
      if (target) void update($, selected, () => (target.id === list[list.length - 1]?.id ? null : target.id))
    }

    const columns = Math.max(20, Math.min(255, e.props.bodyColumns - 1))
    const px = shot?.status === 'done' ? await loadPixels($, shot) : undefined
    const ratio = px?.width && px.height ? px.height / px.width : 0.6
    // Una celda es ~2 veces más alta que ancha; se deja sitio a la cabecera y la actividad.
    const room = Math.max(6, e.props.scroll.bodyRows - 14)
    const rows = Math.max(6, Math.min(room, 255, Math.round(columns * ratio * 0.5)))

    const picture = () => {
      if (!shot) return <Text dimColor>Aún no hay capturas. Aparecerán aquí cuando el modelo tome o lea una.</Text>
      if (shot.status === 'running') return <Text color="yellow">⏳ Procesando captura: {shot.label}</Text>
      if (shot.status === 'error') return <Text color="red">✗ La captura falló o se interrumpió: {shot.label}</Text>
      if (shot.status === 'no-image') return <Text dimColor>La herramienta respondió sin imagen (p. ej. snapshot de accesibilidad).</Text>
      if (!px) return <Text dimColor>No se encontró el archivo de esta captura (¿se limpió /tmp?).</Text>
      if (px.mime !== 'image/png') return <Text dimColor>Imagen {px.mime}: el panel solo dibuja PNG. Pulsa o para abrirla.</Text>
      if ((shot.bytes ?? 0) > MAX_PNG_BYTES) return <Text dimColor>PNG de {Math.round((shot.bytes ?? 0) / 1024)} KiB: supera 2 MiB. Pulsa o para abrirla.</Text>
      if (!Image) return <Text dimColor>Esta superficie no dibuja imágenes; pulsa o para abrirla.</Text>
      return <Image key="shot" source={{ png: px.base64 }} columns={columns} rows={rows} alt="Esta terminal no dibuja imágenes (sí Ghostty o kitty). Pulsa o para abrirla." />
    }

    return (
      <Box flexDirection="column">
        {shot && (
          <Text bold>
            {index + 1}/{list.length} · {time(shot.at)} · {shot.label}
          </Text>
        )}
        {picture()}
        {list.length > 0 && (
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {list.length > 1 && <Button hotkey="p" onPress={() => pick(index - 1)}>◀ anterior</Button>}
            {list.length > 1 && <Button hotkey="n" onPress={() => pick(index + 1)}>siguiente ▶</Button>}
            {list.length > 1 && <Button hotkey="l" onPress={() => void update($, selected, () => null)}>en vivo</Button>}
            {shot?.file && <Button key="open" hotkey="o" onPress={() => void openShot($, shot)}>abrir</Button>}
          </Box>
        )}
        {log.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor bold>Actividad del navegador</Text>
            {log.slice(-8).map(a => (
              <Text key={a.id} dimColor={a.isDone} wrap="truncate-end">
                {a.isDone ? '✓' : '…'} {time(a.at)} {a.label}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
