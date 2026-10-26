import type { EditorLanguage } from './types'

/** Форматирует json/yaml через prettier (ленивая загрузка плагинов), сохраняя позицию курсора. Возвращает null для остальных языков. */
export async function formatWithPrettier(content: string, language: EditorLanguage, cursorOffset: number) {
  if (language === 'json') {
    const [prettier, prettierBabel, prettierEstree] = await Promise.all([
      import('prettier'),
      import('prettier/plugins/babel'),
      import('prettier/plugins/estree'),
    ])
    const result = await prettier.formatWithCursor(content, {
      cursorOffset,
      parser: 'json',
      plugins: [prettierBabel, prettierEstree],
      printWidth: 120,
      endOfLine: 'lf',
    })
    return {
      text: result.formatted.replace(/\n{3,}/g, '\n\n').replace(/\s+$/gm, '').replace(/\n$/, ''),
      cursor: result.cursorOffset,
    }
  }
  if (language === 'yaml') {
    const [prettier, prettierYaml] = await Promise.all([import('prettier'), import('prettier/plugins/yaml')])
    const result = await prettier.formatWithCursor(content, {
      cursorOffset,
      parser: 'yaml',
      plugins: [prettierYaml],
      printWidth: 200,
      tabWidth: 2,
      singleQuote: true,
      endOfLine: 'lf',
    })
    return { text: result.formatted, cursor: result.cursorOffset }
  }
  return null
}
