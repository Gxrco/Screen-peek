import type { On, RenderPropsOf } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// PNG rojo de 4×2 píxeles.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAEElEQVR4nGP4z8AARwzIHABvqgf5gNwAKAAAAABJRU5ErkJggg=='
const TOOL = 'mcp__playwright__browser_take_screenshot'
const SESSION = 'sesion-de-prueba'

const PROPS = {
  title: 'What Claude sees',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

const ok = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

// Lo que hay debajo del mod: un $.store en memoria, el disco y los procesos lanzados.
const engine = (on: On, store = new Map<string, unknown>(), disk = new Map<string, string>()) => {
  const runs: string[][] = []
  const opened: string[] = []
  on('ui.open', (_$, e) => (opened.push(e.id), { value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.id', () => ({ value: SESSION }))
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_$, e) => (store.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('fs.read', (_$, e) => {
    const content = disk.get(e.path)
    if (content === undefined) throw new Error('ENOENT')
    return { value: e.as === 'bytes' ? { base64: content } : content }
  })
  on('fs.write', (_$, e) => (disk.set(e.path, e.text), { value: undefined }))
  on('fs.list', (_$, e) => ({ value: [...disk.keys()].filter(path => path.startsWith(`${e.path}/`) && !path.slice(e.path.length + 1).includes('/')).map((path, i) => ({ name: path.slice(e.path.length + 1), kind: 'file' as const, size: disk.get(path)!.length, mtimeMs: i, isLink: false })) }))
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    if (e.argv[0] === 'sh' && e.argv[4]) disk.set(e.argv[4], String(e.init?.stdin))
    return { value: ok }
  })
  return { runs, store, disk, opened }
}

const mount = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal', props: RenderPropsOf['Pane'] = PROPS) =>
  $.ui.mount({ plugin: 'screen-peek', surface, component: 'Pane', props, requestId: 'screen-peek' })

test('una captura de Playwright aparece en el panel', async ($, on) => {
  engine(on)
  on('tool.call', { tool: TOOL }, () => ({
    result: { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }], isError: false },
  }))

  await $.tool.call({ tool: TOOL })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount($, surface)
    expect(await ui.find({ type: 'Text', text: /1\/1 .* browser_take_screenshot/ })).toBeDefined()
    if (surface === 'terminal') expect(await ui.find({ type: 'Image' })).toBeDefined()
    else expect(await ui.find({ type: 'Text', text: /cannot display images/ })).toBeDefined()
  }
})

test('un snapshot sin imagen queda marcado', async ($, on) => {
  engine(on)
  const tool = 'mcp__playwright__browser_snapshot'
  on('tool.call', { tool }, () => ({ result: { content: [{ type: 'text', text: '- button "OK"' }], isError: false } }))

  await $.tool.call({ tool })

  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: /no image/ })).toBeDefined()
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
})

test('cada captura se guarda en disco y «abrir» abre esa copia', async ($, on) => {
  const { runs, store } = engine(on)
  on('tool.call', { tool: 'Read' }, () => ({ result: { type: 'image', file: { base64: PNG, type: 'image/png', originalSize: 70 } } }))

  await $.tool.call({ tool: 'Read', file_path: '/tmp/shots/01.png' })
  const ui = await mount($)
  await ui.press({ key: 'open' })

  const file = runs[0]?.[4]
  expect(file).toMatch(new RegExp('^/tmp/screen-peek/' + SESSION + '/.+\\.png$'))
  expect(runs.at(-1)).toEqual(['open', file])
  expect(store.get('shots:' + SESSION)).toMatchObject([{ status: 'done', file }])
})

test('al volver a la sesión (p. ej. desde Agents) las capturas siguen ahí', async ($, on) => {
  const file = '/tmp/screen-peek/' + SESSION + '/toolu_1.png'
  const saved = [{ id: 'toolu_1', tool: 'Read', label: 'Read · 01.png', at: 0, status: 'done', mime: 'image/png', bytes: 70, file }]
  engine(on, new Map([['shots:' + SESSION, saved]]), new Map([[file, PNG]]))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: /1\/1 .* 01\.png/ })).toBeDefined()
  expect(await ui.find({ type: 'Image' })).toBeDefined()
})

test('con más de 30 capturas se borra del disco la más vieja', async ($, on) => {
  const { runs, store } = engine(on)
  on('tool.call', { tool: TOOL }, () => ({
    result: { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }], isError: false },
  }))

  for (let i = 0; i < 31; i++) await $.tool.call({ tool: TOOL })

  const writes = runs.filter(r => r[0] === 'sh').map(r => r[4])
  const removed = runs.filter(r => r[0] === 'rm').flatMap(r => r.slice(2))
  expect(writes).toHaveLength(31)
  expect(removed).toEqual([writes[0]])
  expect(store.get('shots:' + SESSION)).toHaveLength(30)
})

test('solo se conservan las 5 sesiones más recientes', async ($, on) => {
  const older = ['s1', 's2', 's3', 's4', 's5']
  const { runs, store } = engine(on, new Map(older.map(id => ['shots:' + id, []])))
  on('tool.call', { tool: TOOL }, () => ({
    result: { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }], isError: false },
  }))

  await $.tool.call({ tool: TOOL })

  expect([...store.keys()]).toEqual(['shots:s2', 'shots:s3', 'shots:s4', 'shots:s5', 'shots:' + SESSION])
  expect(runs.filter(r => r[0] === 'rm')).toContainEqual(['rm', '-rf', '/tmp/screen-peek/s1'])
})

test('la captura cabe dentro del marco en un panel estrecho', async ($, on) => {
  engine(on)
  on('tool.call', { tool: TOOL }, () => ({
    result: { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }], isError: false },
  }))
  await $.tool.call({ tool: TOOL })

  const ui = await mount($, 'terminal', { ...PROPS, bodyColumns: 24, scroll: { offset: 0, bodyRows: 18 } })
  const image = await ui.find({ type: 'Image' })
  expect(image).toBeDefined()
  // Dos columnas de borde y dos de espacio interior.
  expect(image?.props.columns).toBeLessThanOrEqual(20)
  expect(image?.props.columns).toBeGreaterThan(0)
  expect(image?.props.rows).toBeGreaterThan(0)
  expect(image?.props.rows).toBeLessThanOrEqual(11)
  expect(await ui.find({ key: 'open' })).toBeDefined()
})

test('plegar la actividad deja más espacio a la captura y se puede revertir', async ($, on) => {
  engine(on)
  on('tool.call', { tool: TOOL }, () => ({
    result: { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }], isError: false },
  }))
  await $.tool.call({ tool: TOOL })

  const ui = await mount($, 'terminal', { ...PROPS, bodyColumns: 90, scroll: { offset: 0, bodyRows: 24 } })
  const before = await ui.find({ type: 'Image' })
  expect((await ui.find({ key: 'activity' }))?.text).toMatch(/▾/)

  await ui.press({ key: 'activity' })
  const folded = await ui.find({ type: 'Image' })
  expect((await ui.find({ key: 'activity' }))?.text).toMatch(/▸/)
  expect(folded?.props.rows).toBeGreaterThan(Number(before?.props.rows))

  await ui.press({ key: 'activity' })
  expect((await ui.find({ type: 'Image' }))?.props.rows).toBe(before?.props.rows)
})

test('los controles distinguen el historial de la vista en vivo', async ($, on) => {
  engine(on)
  on('tool.call', { tool: TOOL }, () => ({
    result: { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }], isError: false },
  }))
  await $.tool.call({ tool: TOOL })
  await $.tool.call({ tool: TOOL })

  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: /● LIVE/ })).toBeDefined()
  await ui.press({ key: 'previous' })
  expect(await ui.find({ type: 'Text', text: /◷ HISTORY/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1\/2 .* browser_take_screenshot/ })).toBeDefined()
  await ui.press({ key: 'latest' })
  expect(await ui.find({ type: 'Text', text: /● LIVE/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2\/2 .* browser_take_screenshot/ })).toBeDefined()
})

const savedShot = (id: string, at = 0) => ({
  id, tool: 'Read', label: `Read · ${id}.png`, at, status: 'done' as const,
  mime: 'image/png', bytes: 70, file: `/tmp/screen-peek/${SESSION}/${id}.png`,
})

test('a recreated pane restores screenshots without another session.start', async ($, on) => {
  const saved = savedShot('return-without-start')
  engine(on, new Map([['shots:' + SESSION, [saved]]]), new Map([[saved.file, PNG]]))

  const ui = await mount($)
  expect(await ui.find({ type: 'Image' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1\/1 .* return-without-start/ })).toBeDefined()
})

test('the disk index restores the selected image across plugin store namespaces', async ($, on) => {
  const list = [savedShot('disk-first'), savedShot('disk-second', 1)]
  const index = `/tmp/screen-peek/${SESSION}/index.json`
  const disk = new Map([
    ...list.map(s => [s.file, PNG] as [string, string]),
    [index, JSON.stringify({ shots: list, selected: list[0]!.id, showActivity: false })],
  ])
  engine(on, new Map(), disk)

  const ui = await mount($)
  expect(await ui.find({ type: 'Image' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1\/2 .* disk-first/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /◷ HISTORY/ })).toBeDefined()

  // The recovered drawing's controls must work while the session atoms start empty.
  await ui.press({ key: 'next' })
  expect(await ui.find({ type: 'Text', text: /2\/2 .* disk-second/ })).toBeDefined()
  expect(JSON.parse(disk.get(index)!)).toMatchObject({ selected: null, showActivity: false, shots: list })
})

test('older image files are recovered even without a store or disk index', async ($, on) => {
  const list = [savedShot('legacy-first'), savedShot('legacy-second')]
  engine(on, new Map(), new Map(list.map(s => [s.file, PNG])))

  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: /2\/2 .* legacy-second/ })).toBeDefined()
  expect(await ui.find({ type: 'Image' })).toBeDefined()
  await ui.press({ key: 'previous' })
  expect(await ui.find({ type: 'Text', text: /1\/2 .* legacy-first/ })).toBeDefined()
})

test('new screenshots retain restored history and return the saved view to live', async ($, on) => {
  const list = [savedShot('before-return-1'), savedShot('before-return-2')]
  const index = `/tmp/screen-peek/${SESSION}/index.json`
  const disk = new Map([
    ...list.map(s => [s.file, PNG] as [string, string]),
    [index, JSON.stringify({ shots: list, selected: list[0]!.id, showActivity: true })],
  ])
  const { store } = engine(on, new Map(), disk)
  on('tool.call', { tool: TOOL }, () => ({
    result: { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }], isError: false },
  }))

  await $.tool.call({ tool: TOOL })
  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: /3\/3 .* browser_take_screenshot/ })).toBeDefined()
  expect(store.get('shots:' + SESSION)).toHaveLength(3)
  expect(JSON.parse(disk.get(index)!)).toMatchObject({ selected: null })
})

test('navigation and activity visibility are saved with the image index', async ($, on) => {
  const { disk } = engine(on)
  on('tool.call', { tool: TOOL }, () => ({
    result: { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }], isError: false },
  }))
  await $.tool.call({ tool: TOOL })
  await $.tool.call({ tool: TOOL })

  const ui = await mount($)
  await ui.press({ key: 'previous' })
  await ui.press({ key: 'activity' })
  const saved = JSON.parse(disk.get(`/tmp/screen-peek/${SESSION}/index.json`)!)
  expect(saved.selected).toBe(saved.shots[0].id)
  expect(saved.showActivity).toBe(false)
})

test('reattaching reopens saved screenshots and refresh retransmits the selected image', async ($, on) => {
  const saved = savedShot('reattached')
  const { opened } = engine(on, new Map([['shots:' + SESSION, [saved]]]), new Map([[saved.file, PNG]]))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))

  await $.session.attach({ surface: 'terminal', clientId: 'returning-terminal' })
  expect(opened).toContain('screen-peek')
  const ui = await mount($)
  const before = await ui.find({ type: 'Image' })
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Image' }))?.key).not.toBe(before?.key)
})
