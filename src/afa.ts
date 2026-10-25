export type Asset = {
  id: number
  name: string
  acquiredOn: string
  cost: number
  method: 'gwg' | 'linear' | 'digital_one_year'
  usefulLifeMonths: number
  disposedOn: string | null
}

export const METHOD_LABELS: Record<Asset['method'], string> = {
  gwg: 'Geringwertiges Wirtschaftsgut',
  linear: 'Linear über die Nutzungsdauer',
  digital_one_year: 'Computer oder Software, ein Jahr'
}

function monthIndex(date: string): number {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1
}

/**
 * Depreciation of one asset in one year, and its book value at the end of
 * that year. GWG are expensed through their entry already and only listed
 * here, so they add nothing. Linear assets are depreciated by month, starting
 * with the month of acquisition. On disposal the remaining book value is
 * expensed in that year.
 */
export function depreciation(asset: Asset, year: number): { afa: number; bookValueEnd: number } {
  const startYear = Number(asset.acquiredOn.slice(0, 4))
  if (year < startYear) return { afa: 0, bookValueEnd: 0 }
  if (asset.method === 'gwg') return { afa: 0, bookValueEnd: 0 }
  if (asset.method === 'digital_one_year') return { afa: year === startYear ? asset.cost : 0, bookValueEnd: 0 }
  const months = Math.max(1, asset.usefulLifeMonths)
  const start = monthIndex(asset.acquiredOn)
  const spent = (untilMonth: number) => {
    const elapsed = Math.min(months, Math.max(0, untilMonth - start + 1))
    return elapsed >= months ? asset.cost : Math.round(asset.cost * elapsed / months)
  }
  const before = spent(year * 12 - 1)
  let after = spent(year * 12 + 11)
  if (asset.disposedOn && Number(asset.disposedOn.slice(0, 4)) === year) after = asset.cost
  if (asset.disposedOn && Number(asset.disposedOn.slice(0, 4)) < year) return { afa: 0, bookValueEnd: 0 }
  return { afa: after - before, bookValueEnd: asset.cost - after }
}

export async function loadAssets(db: D1Database): Promise<Asset[]> {
  const { results } = await db.prepare('SELECT id, name, acquired_on, cost, method, useful_life_months, disposed_on FROM assets ORDER BY acquired_on, id')
    .all<{ id: number; name: string; acquired_on: string; cost: number; method: Asset['method']; useful_life_months: number; disposed_on: string | null }>()
  return results.map(r => ({ id: r.id, name: r.name, acquiredOn: r.acquired_on, cost: r.cost, method: r.method, usefulLifeMonths: r.useful_life_months, disposedOn: r.disposed_on }))
}

export function totalAfa(assets: Asset[], year: number): number {
  return assets.reduce((sum, asset) => sum + depreciation(asset, year).afa, 0)
}
