import type { Env } from './types'

export type Ctx = {
  env: Env
  request: Request
  url: URL
  actor: string
  /** Readers may look at everything and download exports, but change nothing. */
  readOnly: boolean
  today: string
}
