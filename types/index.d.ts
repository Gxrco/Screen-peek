export type Shot = {
  id: string
  tool: string
  label: string
  at: number
  status: 'running' | 'done' | 'error' | 'no-image'
  mime?: string
  bytes?: number
  /** Copia de la imagen en /tmp/screen-peek/<sesión>/, escrita al llegar. */
  file?: string
}

export type Activity = { id: string; tool: string; label: string; at: number; isDone: boolean }

declare module 'claude-code' {
  interface PluginState {
    'screen-peek': { shots: Shot[]; activity: Activity[]; selected: string | null; showActivity: boolean; imageRevision: number }
  }
}
