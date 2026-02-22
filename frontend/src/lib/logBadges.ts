const badge = (cls: string, text: string) => `<span class="log-badge log-badge-${cls}">${text}</span>`

const RULES: [RegExp, string][] = [
  [/\bINFO\b/g, badge("info", "INFO")],
  [/\bWARN(?:ING)?\b/g, badge("warn", "WARN")],
  [/\bERROR\b/g, badge("error", "ERROR")],
  [/\bDEBUG\b/g, badge("debug", "DEBUG")],
  [/\bFATAL\b/g, badge("fatal", "FATAL")],
]

export function processLogLine(line: string): string {
  return line.replace(/(<[^>]*>)|([^<]+)/g, (_match, tag, text) => {
    if (tag) return tag
    return RULES.reduce((t, [re, b]) => t.replace(re, b), text)
  })
}
