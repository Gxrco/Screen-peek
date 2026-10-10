import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// PNG rojo de 4×2 píxeles.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAEElEQVR4nGP4z8AARwzIHABvqgf5gNwAKAAAAABJRU5ErkJggg=='
const TOOL = 'mcp__playwright__browser_take_screenshot'
const SESSION = 'sesion-de-prueba'

const PROPS = {
  title: 'Lo que ve Claude',
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
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.id', () => ({ value: SESSION }))
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_$, e) => (store.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('fs.read', (_$, e) => {
    const base64 = disk.get(e.path)
    if (base64 === undefined) throw new Error('ENOENT')
    return { value: { base64 } }
  })
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    if (e.argv[0] === 'sh' && e.argv[4]) disk.set(e.argv[4], String(e.init?.stdin))
    return { value: ok }
  })
  return { runs, store, disk }
}

const mount = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'screen-peek', surface, component: 'Pane', props: PROPS, requestId: 'screen-peek' })

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
    else expect(await ui.find({ type: 'Text', text: /no dibuja imágenes/ })).toBeDefined()
  }
})

test('un snapshot sin imagen queda marcado', async ($, on) => {
  engine(on)
  const tool = 'mcp__playwright__browser_snapshot'
  on('tool.call', { tool }, () => ({ result: { content: [{ type: 'text', text: '- button "OK"' }], isError: false } }))

  await $.tool.call({ tool })

  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: /sin imagen/ })).toBeDefined()
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
