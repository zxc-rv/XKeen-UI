import { apiCall } from './api'

type ApiResult = { success: boolean; error?: string }

export function supportsConfigHistory(file: string): boolean {
  return /\.(?:ya?ml|json)$/i.test(file)
}

export async function deleteConfigHistory(file: string, id?: string): Promise<string | null> {
  try {
    const params = new URLSearchParams({ file })
    if (id) params.set('id', id)
    const result = await apiCall<ApiResult>('DELETE', `configs/changes?${params.toString()}`)
    return result.success ? null : result.error || 'Не удалось удалить историю'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export async function saveConfigRevision(
  file: string,
  content: string,
  baseUrl?: string | null,
  previousContent?: string
): Promise<string | null> {
  if (!supportsConfigHistory(file)) return null

  try {
    const result = await apiCall<ApiResult>(
      'PUT',
      'configs/changes',
      { file, content, previous_content: previousContent, date: new Date().toISOString() },
      { baseUrl }
    )
    return result.success ? null : result.error || 'Не удалось записать историю'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
