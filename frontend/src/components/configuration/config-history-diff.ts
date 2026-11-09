export interface ConfigDiffRow {
  left?: string
  right?: string
  leftLine?: number
  rightLine?: number
  kind: 'same' | 'removed' | 'added'
}

export function diffConfigLines(leftContent: string, rightContent: string): ConfigDiffRow[] {
  const left = leftContent.split(/\r?\n/)
  const right = rightContent.split(/\r?\n/)
  let prefix = 0
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++

  let suffix = 0
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) suffix++

  const rows: ConfigDiffRow[] = []
  for (let index = 0; index < prefix; index++) rows.push({ left: left[index], right: right[index], kind: 'same' })

  const leftMiddle = left.slice(prefix, left.length - suffix)
  const rightMiddle = right.slice(prefix, right.length - suffix)
  const width = rightMiddle.length + 1
  const cells = (leftMiddle.length + 1) * width

  if (cells <= 16_000_000) {
    const lcs = new Uint16Array(cells)
    for (let i = leftMiddle.length - 1; i >= 0; i--) {
      const row = i * width
      const nextRow = (i + 1) * width
      for (let j = rightMiddle.length - 1; j >= 0; j--) {
        lcs[row + j] =
          leftMiddle[i] === rightMiddle[j]
            ? lcs[nextRow + j + 1] + 1
            : Math.max(lcs[nextRow + j], lcs[row + j + 1])
      }
    }

    let i = 0
    let j = 0
    while (i < leftMiddle.length && j < rightMiddle.length) {
      if (leftMiddle[i] === rightMiddle[j]) {
        rows.push({ left: leftMiddle[i++], right: rightMiddle[j++], kind: 'same' })
      } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
        rows.push({ left: leftMiddle[i++], kind: 'removed' })
      } else {
        rows.push({ right: rightMiddle[j++], kind: 'added' })
      }
    }
    while (i < leftMiddle.length) rows.push({ left: leftMiddle[i++], kind: 'removed' })
    while (j < rightMiddle.length) rows.push({ right: rightMiddle[j++], kind: 'added' })
  } else {
    for (const line of leftMiddle) rows.push({ left: line, kind: 'removed' })
    for (const line of rightMiddle) rows.push({ right: line, kind: 'added' })
  }

  for (let index = suffix; index > 0; index--) {
    const leftLine = left[left.length - index]
    const rightLine = right[right.length - index]
    rows.push({ left: leftLine, right: rightLine, kind: 'same' })
  }
  let leftLine = 0
  let rightLine = 0
  for (const row of rows) {
    if (row.left !== undefined) row.leftLine = ++leftLine
    if (row.right !== undefined) row.rightLine = ++rightLine
  }
  return rows
}

export interface ConfigChangeLine {
  kind: 'removed' | 'added'
  line: number
  text: string
}

export function getConfigChangeLines(before: string, after: string): ConfigChangeLine[] {
  return diffConfigLines(before, after).flatMap<ConfigChangeLine>((row) => {
    if (row.kind === 'removed' && row.left !== undefined) {
      if (row.left.trim() === '') return []
      return [{ kind: 'removed' as const, line: row.leftLine ?? 0, text: row.left }]
    }
    if (row.kind === 'added' && row.right !== undefined) {
      if (row.right.trim() === '') return []
      return [{ kind: 'added' as const, line: row.rightLine ?? 0, text: row.right }]
    }
    return []
  })
}

interface ChangeHunk {
  start: number
  end: number
  before: string[]
  after: string[]
}

function makeChangeHunks(before: string, after: string): ChangeHunk[] {
  const rows = diffConfigLines(before, after)
  const changedRanges: Array<{ start: number; end: number }> = []
  for (let index = 0; index < rows.length;) {
    if (rows[index].kind === 'same') {
      index++
      continue
    }
    const start = index
    while (index < rows.length && rows[index].kind !== 'same') index++
    changedRanges.push({ start, end: index })
  }

  const context = 2
  const merged: Array<{ start: number; end: number }> = []
  for (const range of changedRanges) {
    const next = { start: Math.max(0, range.start - context), end: Math.min(rows.length, range.end + context) }
    const previous = merged.at(-1)
    if (previous && next.start <= previous.end) previous.end = Math.max(previous.end, next.end)
    else merged.push(next)
  }

  return merged.map(({ start, end }) => {
    const hunkRows = rows.slice(start, end)
    return {
      start,
      end,
      before: hunkRows.flatMap((row) => (row.left === undefined ? [] : [row.left])),
      after: hunkRows.flatMap((row) => (row.right === undefined ? [] : [row.right])),
    }
  })
}

function findUniqueSequence(lines: string[], sequence: string[]): number {
  if (sequence.length === 0) return lines.length === 0 ? 0 : -1
  let found = -1
  for (let start = 0; start <= lines.length - sequence.length; start++) {
    if (!sequence.every((line, offset) => lines[start + offset] === line)) continue
    if (found !== -1) return -1
    found = start
  }
  return found
}

export function revertConfigChange(current: string, before: string, after: string): string {
  const ending = current.includes('\r\n') ? '\r\n' : '\n'
  const lines = current.split(/\r?\n/)
  const hunks = makeChangeHunks(before, after)

  if (hunks.length === 0) throw new Error('В выбранной версии нет изменений для отмены')

  for (const hunk of hunks.reverse()) {
    const index = findUniqueSequence(lines, hunk.after)
    if (index < 0) {
      throw new Error('Не удалось безопасно отменить изменение: затронутые строки изменились позже или совпадают в нескольких местах')
    }
    lines.splice(index, hunk.after.length, ...hunk.before)
  }

  return lines.join(ending)
}
