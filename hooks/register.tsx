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
const showActivity = atom({ plugin: 'screen-peek', key: 'showActivity' } as const, true)
const imageRevision = atom({ plugin: 'screen-peek', key: 'imageRevision' } as const, 0)

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

type Gallery = { shots: Shot[]; selected: string | null; showActivity: boolean }

const sessionFolder = async ($: EngineInterface) => {
  const id = await $.session.id()
  if (!SAFE_ID.test(id) || id.includes('..')) throw new Error('Invalid session id')
  return `${ROOT}/${id}`
}

// Keep the index beside its images: local and installed plugin copies have
// different $.store namespaces, and an Agents transition can recreate state.
const loadGallery = async ($: EngineInterface): Promise<Gallery> => {
  const folder = await sessionFolder($)
  const text = await $.fs.read(`${folder}/index.json`).catch(() => undefined)
  let saved: Partial<Gallery> | undefined
  if (text) {
    try { saved = JSON.parse(text) as Partial<Gallery> } catch { /* Recover from the store or image files below. */ }
  }
  const stored = saved?.shots ?? await $.store.get(await storeKey($))
  const list: Shot[] = Array.isArray(stored) ? stored.filter((s): s is Shot =>
    s && typeof s.id === 'string' && SAFE_ID.test(s.id) && !s.id.includes('..') &&
    typeof s.tool === 'string' && typeof s.label === 'string' && typeof s.at === 'number' &&
    ['running', 'done', 'error', 'no-image'].includes(s.status) &&
    (s.file === undefined || (typeof s.file === 'string' && s.file.startsWith(`${folder}/`) && !s.file.includes('..')))
  ).slice(-MAX_SHOTS) : []
  if (list.length === 0) {
    // Older versions saved images without a disk index. Recover those too.
    const files = await $.fs.list(folder).catch(() => [])
    const mimeByExt: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
    for (const file of files.filter(f => f.kind === 'file' && !f.isLink).sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      const match = /^([\w.-]+)\.(png|jpe?g|webp|gif)$/i.exec(file.name)
      if (!match || !match[1] || match[1].includes('..')) continue
      list.push({ id: match[1], tool: 'Read', label: `Saved screenshot · ${file.name}`, at: file.mtimeMs, status: 'done', mime: mimeByExt[match[2]!.toLowerCase()], bytes: file.size, file: `${folder}/${file.name}` })
    }
  }
  return {
    shots: list.slice(-MAX_SHOTS),
    selected: typeof saved?.selected === 'string' && list.some(s => s.id === saved?.selected) ? saved.selected : null,
    showActivity: typeof saved?.showActivity === 'boolean' ? saved.showActivity : true,
  }
}

const restoreGallery = async ($: EngineInterface) => {
  const current = await read($, shots)
  if (current.length > 0) return current
  const saved = await loadGallery($)
  if (saved.shots.length > 0) {
    await update($, shots, list => list.length > 0 ? list : saved.shots)
    await update($, selected, () => saved.selected)
    await update($, showActivity, () => saved.showActivity)
  }
  return saved.shots
}

const writeGallery = async ($: EngineInterface, list: Shot[]) => {
  if (list.length === 0) return
  const gallery: Gallery = { shots: list, selected: await read($, selected), showActivity: await read($, showActivity) }
  await $.fs.write(`${await sessionFolder($)}/index.json`, JSON.stringify(gallery))
}

const selectShot = async ($: EngineInterface, id: string | null) => {
  const list = await restoreGallery($)
  await update($, selected, () => id)
  await writeGallery($, list)
}

const toggleActivity = async ($: EngineInterface) => {
  const list = await restoreGallery($)
  await update($, showActivity, value => !value)
  await writeGallery($, list)
}

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
  await writeGallery($, list)
  const others = (await $.store.keys()).filter(k => k.startsWith('shots:') && k !== key)
  const stale = others.slice(0, Math.max(0, others.length - (MAX_SESSIONS - 1)))
  for (const old of stale) await $.store.delete(old)
  await remove($, stale.map(k => k.slice('shots:'.length)).filter(id => SAFE_ID.test(id)).map(id => `${ROOT}/${id}`))
}

// Cambia la lista de capturas, la guarda y borra del disco las que quedaron fuera.
const saveShots = async ($: EngineInterface, change: (list: Shot[]) => Shot[]) => {
  const before = await restoreGallery($)
  const after = await update($, shots, list => change(list.length > 0 ? list : before).slice(-MAX_SHOTS))
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
  if (!shot.file) return $.ui.toast('This screenshot was not saved to disk.')
  const ran = await $.process.run(['open', shot.file])
  if (ran.exitCode !== 0) $.ui.toast(`Could not open ${shot.file}`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'peek',
      description: 'Open the screenshots Claude sees',
    })
    const saved = await restoreGallery($)
    if (saved.length > 0) await $.ui.open({ id: PANE, title: 'What Claude sees' })
    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    const saved = await restoreGallery($)
    await update($, imageRevision, value => value + 1)
    if (saved.length > 0) await $.ui.open({ id: PANE, title: 'What Claude sees' })
    return next(e)
  })

  on('command.run', { command: 'peek' }, async $ => {
    await restoreGallery($)
    await update($, imageRevision, value => value + 1)
    await $.ui.open({ id: PANE, title: 'What Claude sees' })
    return { text: 'Screenshot panel opened.' }
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
      await update($, selected, () => null)
      await saveShots($, list => [...list, { id, tool: input.tool, label, at, status: 'running' } as Shot])
      $.ui.status('📸 capturing…')
      void $.ui.open({ id: PANE, title: 'What Claude sees' })
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
      await update($, selected, () => null)
      await saveShots($, list => (list.some(s => s.id === id) ? list.map(s => (s.id === id ? shot : s)) : [...list, shot]))
      void $.ui.open({ id: PANE, title: 'What Claude sees' })
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
    const current = await read($, shots)
    // Render hooks cannot write state. Read saved data directly if a view is
    // recreated without session.start; the next interaction hydrates the atoms.
    const recovered = current.length === 0 ? await loadGallery($) : undefined
    const list = recovered?.shots ?? current
    const log = await read($, activity)
    const chosen = recovered ? recovered.selected : await read($, selected)
    const activityVisible = recovered ? recovered.showActivity : await read($, showActivity)
    const revision = await read($, imageRevision)

    const foundIndex = chosen ? list.findIndex(s => s.id === chosen) : -1
    const index = foundIndex >= 0 ? foundIndex : list.length - 1
    const shot = list[index]
    const isLatest = index === list.length - 1
    const pick = (i: number) => {
      const target = list[Math.max(0, Math.min(list.length - 1, i))]
      if (target) return selectShot($, target.id === list[list.length - 1]?.id ? null : target.id)
    }

    const width = Math.max(1, Math.floor(e.props.bodyColumns))
    const height = Math.max(1, Math.floor(e.props.scroll.bodyRows))
    const narrow = width < 38
    const compact = height < 22
    const pending = log.filter(a => !a.isDone).length
    const status = !shot ? { color: 'subtle', text: '○ WAITING' }
      : !isLatest ? { color: 'warning', text: '◷ HISTORY' }
      : shot.status === 'running' ? { color: 'warning', text: '◌ CAPTURING' }
      : shot.status === 'error' ? { color: 'error', text: '× ERROR' }
      : { color: 'success', text: '● LIVE' }

    // Reserva filas para el marco, los controles y la actividad antes de
    // dimensionar la imagen. El panel estrecho usa etiquetas más cortas.
    const activityBudget = Math.max(0, Math.min(6, Math.floor((height - 16) / 3)))
    const activityCount = activityVisible ? Math.min(log.length, activityBudget) : 0
    const recentActivity = activityCount > 0 ? log.slice(-activityCount) : []
    const hasActivity = log.length > 0
    const chromeRows = 1 + (compact ? 0 : 1) + (shot ? 1 : 0) + 2
      + (shot?.status === 'done' && !compact ? 1 : 0)
      + (list.length > 0 ? 1 : 0) + (hasActivity ? 2 + activityCount : 0)
      + (compact ? 0 : 1)
    const room = Math.max(1, Math.min(255, height - chromeRows))
    const padding = width >= 12 ? 1 : 0
    const innerWidth = Math.max(1, Math.min(255, width - 2 - padding * 2))
    const px = shot?.status === 'done' ? await loadPixels($, shot) : undefined
    const ratio = px?.width && px.height ? px.height / px.width : 0.6
    // Una celda es aproximadamente dos veces más alta que ancha. Reduce
    // también el ancho de las capturas verticales para conservar su proporción.
    const columns = Math.max(1, Math.min(innerWidth, Math.floor(room * 2 / ratio)))
    const rows = Math.max(1, Math.min(room, Math.round(columns * ratio * 0.5)))
    const frameColor = shot?.status === 'error' ? 'error'
      : shot?.status === 'running' ? 'warning'
      : e.props.isFocused ? 'claude' : 'promptBorder'
    const metadata = [
      (shot?.mime ?? 'image/png').replace('image/', '').toUpperCase(),
      ...(px?.width && px.height ? [`${px.width} × ${px.height}`] : []),
      ...(shot?.bytes !== undefined ? [`${Math.ceil(shot.bytes / 1024)} KiB`] : []),
    ].join(' · ')

    const picture = () => {
      if (!shot) return (
        <Box flexDirection="column" gap={1}>
          <Text color="claude" bold>◇ Waiting for the first screenshot</Text>
          <Text dimColor>No screenshots yet. They will appear when Claude takes a screenshot or reads an image.</Text>
        </Box>
      )
      if (shot.status === 'running') return (
        <Box flexDirection="column" gap={1}>
          <Text color="warning" bold>◌ Processing screenshot…</Text>
          <Text dimColor>The image will appear when the tool finishes.</Text>
        </Box>
      )
      if (shot.status === 'error') return <Text color="error">✗ Screenshot failed or was interrupted: {shot.label}</Text>
      if (shot.status === 'no-image') return <Text dimColor>The tool returned no image (for example, an accessibility snapshot).</Text>
      if (!px) return <Text dimColor>Screenshot file not found. The temporary folder may have been cleared.</Text>
      if (px.mime !== 'image/png') return <Text dimColor>Image {px.mime}: the panel only renders PNG. Press o to open it.</Text>
      if ((shot.bytes ?? 0) > MAX_PNG_BYTES) return <Text dimColor>PNG is {Math.round((shot.bytes ?? 0) / 1024)} KiB, exceeding 2 MiB. Press o to open it.</Text>
      if (!Image) return <Text dimColor>This surface cannot display images. Press o to open it.</Text>
      return (
        <Box flexDirection="column" alignItems="center">
          <Image key={`shot-${shot.id}-${revision}`} source={{ png: px.base64 }} columns={columns} rows={rows} alt="This terminal cannot display images. Use Ghostty or kitty, or press o to open it." />
        </Box>
      )
    }

    return (
      <Box flexDirection="column" width={width}>
        <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap">
          <Text bold color="claude">{narrow ? '◈ PEEK' : '◈ SCREEN PEEK'}</Text>
          <Text color={status.color} bold>{status.text}</Text>
        </Box>
        {!compact && <Text dimColor>What Claude sees · {list.length} {list.length === 1 ? 'screenshot' : 'screenshots'}</Text>}
        {shot && (
          <Text wrap="truncate-end">
            <Text color="claude" bold>{index + 1}/{list.length}</Text> · <Text dimColor>{time(shot.at)}</Text> · {shot.label}
          </Text>
        )}
        <Box
          key="preview"
          flexDirection="column"
          borderStyle="round"
          borderColor={frameColor}
          hover={{ borderColor: 'claude' }}
          paddingX={padding}
          alignItems="stretch"
        >
          {picture()}
        </Box>
        {shot?.status === 'done' && !compact && (
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text dimColor wrap="truncate-end">{metadata}</Text>
            </Box>
            <Text color={isLatest ? 'success' : 'warning'}>{isLatest ? 'Latest' : 'Saved'}</Text>
          </Box>
        )}
        {list.length > 0 && (
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {list.length > 1 && <Button key="previous" plain hotkey="p" dimColor={index <= 0} onPress={() => pick(index - 1)}>◀</Button>}
            {list.length > 1 && <Button key="next" plain hotkey="n" dimColor={isLatest} onPress={() => pick(index + 1)}>▶</Button>}
            {list.length > 1 && <Button key="latest" plain hotkey="l" dimColor={isLatest} onPress={() => selectShot($, null)}>{narrow ? '●' : 'Live'}</Button>}
            {shot?.file && <Button key="open" plain hotkey="o" onPress={() => void openShot($, shot)}>{narrow ? '↗' : 'Open ↗'}</Button>}
            {shot?.status === 'done' && <Button key="refresh" plain hotkey="r" onPress={async () => { await restoreGallery($); await update($, imageRevision, value => value + 1) }}>↻</Button>}
          </Box>
        )}
        {hasActivity && (
          <Box flexDirection="column" marginTop={1}>
            <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap">
              <Button key="activity" plain hotkey="a" onPress={() => toggleActivity($)}>{`${activityVisible ? '▾' : '▸'} ${narrow ? 'Activity' : 'Browser activity'}`}</Button>
              <Text color={pending > 0 ? 'warning' : 'subtle'}>{pending > 0 ? `${pending} running` : `${log.length} actions`}</Text>
            </Box>
            {activityCount > 0 && recentActivity.map(a => (
              <Box key={a.id} flexDirection="row" gap={1}>
                <Text color={a.isDone ? 'success' : 'warning'}>{a.isDone ? '✓' : '◌'}</Text>
                <Text dimColor>{time(a.at)}</Text>
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Text dimColor={a.isDone} color={a.isDone ? 'text' : 'warning'} wrap="truncate-end">{a.label}</Text>
                </Box>
              </Box>
            ))}
          </Box>
        )}
        {!compact && <Text dimColor>{e.props.isFocused ? 'Tab: controls · Esc: return to Claude' : 'Click the panel to use keyboard shortcuts'}</Text>}
      </Box>
    )
  })
}
