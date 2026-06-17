/**
 * @param {unknown} data
 * @returns {data is { id: string, message: unknown }}
 */
export function isRelevantEventData(data) {
  if (!data || typeof data !== 'object') return false
  if (!('id' in data && 'message' in data)) return false
  if (typeof data.id !== 'string') return false

  return true
}
