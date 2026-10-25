export type Env = {
  DB: D1Database
  FILES: R2Bucket
  ACCESS_TEAM_DOMAIN: string
  ACCESS_AUD: string
  /** JSON object mapping e-mail to role. Without it every signed-in user is admin. */
  ACCESS_ROLES?: string
}

export type Mode = 'small_business' | 'standard'
export type FilingPeriod = 'month' | 'quarter' | 'none'

export type TaxCode = 'DE19' | 'DE7' | 'RC_EU' | 'RC_OTHER' | 'FOREIGN_VAT' | 'ABROAD' | 'EXEMPT' | 'NONE'

export type CategoryKind = 'income' | 'expense' | 'asset' | 'tax_payment' | 'tax_refund' | 'private'

export type EntryStatus = 'draft' | 'posted' | 'discarded'

export type Regime = { validFrom: string; mode: Mode; filingPeriod: FilingPeriod; cashBasis: boolean }

/** One booked line with everything a report needs, already joined. */
export type LineFact = {
  entryId: number
  number: string | null
  status: EntryStatus
  paidOn: string
  invoiceDate: string | null
  fiscalYear: number
  text: string
  counterparty: string
  categoryId: number
  categoryName: string
  kind: CategoryKind
  position: string
  taxCode: TaxCode
  net: number
  tax: number
  gross: number
}
