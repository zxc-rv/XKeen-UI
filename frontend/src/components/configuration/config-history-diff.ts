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

interface ChangeBlock {
  afterStart: number
  before: string[]
  after: string[]
}

function makeChangeBlocks(before: string, after: string): ChangeBlock[] {
  const rows = diffConfigLines(before, after)
  const blocks: ChangeBlock[] = []
  let rightLineCount = 0
  for (let index = 0; index < rows.length;) {
    if (rows[index].kind === 'same') {
      if (rows[index].right !== undefined) rightLineCount++
      index++
      continue
    }
    const changedRows: ConfigDiffRow[] = []
    while (index < rows.length && rows[index].kind !== 'same') changedRows.push(rows[index++])
    const firstRightLine = changedRows.find((row) => row.rightLine !== undefined)?.rightLine
    blocks.push({
      afterStart: firstRightLine === undefined ? rightLineCount : firstRightLine - 1,
      before: changedRows.flatMap((row) => (row.left === undefined ? [] : [row.left])),
      after: changedRows.flatMap((row) => (row.right === undefined ? [] : [row.right])),
    })
    rightLineCount += changedRows.filter((row) => row.right !== undefined).length
  }
  return blocks
}

function mapSnapshotLinesToCurrent(snapshot: string[], current: string[]): Map<number, number> {
  const mapping = new Map<number, number>()
  for (const row of diffConfigLines(snapshot.join('\n'), current.join('\n'))) {
    if (row.kind === 'same' && row.leftLine !== undefined && row.rightLine !== undefined) {
      mapping.set(row.leftLine - 1, row.rightLine - 1)
    }
  }
  return mapping
}

function findInsertionPoint(afterStart: number, mapping: Map<number, number>, currentLength: number): number {
  let previous: number | undefined
  let next: number | undefined
  for (let index = afterStart - 1; index >= 0; index--) {
    const mapped = mapping.get(index)
    if (mapped !== undefined) {
      previous = mapped
      break
    }
  }
  for (let index = afterStart; index >= 0; index++) {
    const mapped = mapping.get(index)
    if (mapped !== undefined) {
      next = mapped
      break
    }
  }
  if (previous !== undefined && next !== undefined) {
    if (previous >= next) return -1
    return next
  }
  if (next !== undefined) return next
  if (previous !== undefined) return previous + 1
  return currentLength === 0 ? 0 : -1
}

/** Reverse one saved change while preserving unrelated edits made afterwards. */
export function revertConfigChange(current: string, before: string, after: string): string {
  const ending = current.includes('\r\n') ? '\r\n' : '\n'
  const lines = current.split(/\r?\n/)
  const blocks = makeChangeBlocks(before, after)

  if (blocks.length === 0) throw new Error('В выбранной версии нет изменений для отмены')

  const afterLines = after.split(/\r?\n/)
  const mapping = mapSnapshotLinesToCurrent(afterLines, lines)
  for (const block of blocks.reverse()) {
    let index: number
    if (block.after.length === 0) {
      index = findInsertionPoint(block.afterStart, mapping, lines.length)
    } else {
      const mapped = block.after.map((_, offset) => mapping.get(block.afterStart + offset))
      if (mapped.some((line) => line === undefined)) {
        throw new Error('Не удалось безопасно отменить изменение: изменённая строка была удалена или изменена позже')
      }
      index = mapped[0]!
      if (mapped.some((line, offset) => line !== index + offset)) index = -1
    }
    if (index < 0 || index > lines.length) {
      throw new Error('Не удалось безопасно отменить изменение: затронутые строки изменились позже или совпадают в нескольких местах')
    }
    lines.splice(index, block.after.length, ...block.before)
  }

  return lines.join(ending)
}
