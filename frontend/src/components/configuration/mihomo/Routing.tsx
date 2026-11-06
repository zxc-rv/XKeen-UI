import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type TouchEvent as ReactTouchEvent,
  type RefObject,
} from 'react'
import { IconPlus, IconListDetails } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import {
  deleteMihomoRoutingRule,
  getMihomoRoutingRules,
  getMihomoRuleInsertionIndex,
  getMihomoRoutingTargets,
  inspectMihomoRuleConfig,
  reorderMihomoRoutingRules,
  updateMihomoRoutingRule,
  updateMihomoRoutingRuleTargets,
  insertMihomoRoutingRuleAt,
  completeMihomoRoutingDraft,
  describeMihomoRoutingRule,
  parseMihomoCondition,
  serializeMihomoCondition,
  getMihomoRuleOptions,
  type MihomoConditionNode,
} from '@/lib/mihomo-rules'
import type { CodeMirrorRef } from '../CodeMirror'
import { MihomoRoutingRuleRow } from './RoutingRuleRow'
import { ConditionEditor, emptyCondition } from './ConditionEditor'

interface RoutingProps {
  content: string
  file: string
  editorRef: RefObject<CodeMirrorRef | null>
  onAddRule: () => void
  showToast: (msg: string, type?: 'success' | 'error') => void
}
export function MihomoRouting({ content, file, editorRef, onAddRule, showToast }: RoutingProps) {
  const [dragRuleOrder, setDragRuleOrder] = useState<number[] | null>(null)
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null)
  const ruleRowsRef = useRef<(HTMLDivElement | null)[]>([])
  const cleanupDragRef = useRef<(() => void) | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pendingRef = useRef<HTMLDivElement>(null)
  const [newRule, setNewRule] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ index: number; raw: string; logical?: MihomoConditionNode } | null>(null)
  const [draftValue, setDraftValue] = useState('')
  useEffect(() => {
    if (newRule !== null) pendingRef.current?.scrollIntoView({ block: 'nearest' })
  }, [newRule])
  const parsed = useMemo(() => {
    try {
      return { rules: getMihomoRoutingRules(content), error: '' }
    } catch (error) {
      return { rules: [] as string[], error: error instanceof Error ? error.message : String(error) }
    }
  }, [content])
  const { rules, error } = parsed
  const targets = useMemo(() => getMihomoRoutingTargets(content), [content])
  const options = useMemo(() => inspectMihomoRuleConfig(content), [content])
  const providers = options.providers.map((p) => p.name)
  const insertionIndex = getMihomoRuleInsertionIndex(rules)
  const getContent = useCallback(() => editorRef.current?.getValue() ?? content, [content, editorRef])
  const write = (next: string) => {
    if (!editorRef.current) throw new Error('Редактор ещё не готов')
    editorRef.current.replaceAll(next)
    if (file) editorRef.current.validate(file)
  }
  const attempt = (action: () => string, message: string) => {
    try {
      write(action())
      showToast(`${message}. Нажмите «Применить»`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Не удалось изменить правило', 'error')
    }
  }
  useEffect(() => () => cleanupDragRef.current?.(), [])
  const openEdit = (index: number, raw: string, type?: string) => {
    const rule = describeMihomoRoutingRule(raw)
    try {
      const logical = type
        ? emptyCondition(type)
        : ['AND', 'OR', 'NOT'].includes(rule.type)
          ? parseMihomoCondition(`${rule.type},${rule.matcher}`)
          : undefined
      setDraft({ index, raw, logical })
      setDraftValue(raw)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Не удалось разобрать условие', 'error')
    }
  }
  let draftError = ''
  let nextRaw = draftValue.trim()
  if (draft?.logical) {
    try {
      const rule = describeMihomoRoutingRule(draft.raw)
      nextRaw = [serializeMihomoCondition(draft.logical), rule.target, ...getMihomoRuleOptions(draft.raw)].join(',')
    } catch (error) {
      draftError = error instanceof Error ? error.message : 'Заполните условия'
    }
  } else if (!nextRaw || /[\r\n]/.test(nextRaw)) draftError = 'Введите одно правило в одну строку'
  const saveDraft = () => {
    if (!draft || draftError) return
    if (draft.index < 0) updateNewRule(nextRaw)
    else attempt(() => updateMihomoRoutingRule(getContent(), draft.index, nextRaw), 'Правило обновлено')
    setDraft(null)
  }
  const updateNewRule = (raw: string) => {
    const rule = describeMihomoRoutingRule(raw)
    if (rule.matcher && rule.target) {
      try {
        const validated = completeMihomoRoutingDraft(raw)
        const currentRules = getMihomoRoutingRules(getContent())
        const target = describeMihomoRoutingRule(validated).target
        write(insertMihomoRoutingRuleAt(getContent(), getMihomoRuleInsertionIndex(currentRules, target), validated))
        setNewRule(null)
      } catch (error) {
        showToast(error instanceof Error ? error.message : 'Проверьте правило', 'error')
      }
    } else setNewRule(raw)
  }
  const startDrag = (event: ReactMouseEvent | ReactTouchEvent, fromIndex: number) => {
    if (event.cancelable) event.preventDefault()
    cleanupDragRef.current?.()
    const initialContent = getContent()
    let order = rules.map((_, index) => index)
    const setOrder = setDragRuleOrder
    const refs = ruleRowsRef
    let position = fromIndex
    setOrder(order)
    setDraggingIndex(fromIndex)
    const onMove = (moveEvent: MouseEvent | TouchEvent) => {
      if (moveEvent.cancelable) moveEvent.preventDefault()
      const y = 'touches' in moveEvent ? moveEvent.touches[0]?.clientY : moveEvent.clientY
      if (y == null) return
      for (let i = 0; i < order.length; i++) {
        if (i === position) continue
        const rect = refs.current[i]?.getBoundingClientRect()
        if (!rect || y < rect.top || y > rect.bottom) continue
        const next = [...order]
        const [moved] = next.splice(position, 1)
        next.splice(i, 0, moved)
        order = next
        position = i
        setOrder(next)
        setDraggingIndex(i)
        break
      }
      const scroll = scrollRef.current
      if (scroll) {
        const rect = scroll.getBoundingClientRect()
        if (y < rect.top + 40) scroll.scrollTop -= 12
        if (y > rect.bottom - 40) scroll.scrollTop += 12
      }
    }
    const cleanup = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onEnd)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onEnd)
      document.removeEventListener('touchcancel', onCancel)
      setDragRuleOrder(null)
      setDraggingIndex(null)
      cleanupDragRef.current = null
    }
    const onCancel = () => cleanup()
    const onEnd = () => {
      cleanup()
      if (order.every((value, index) => value === index)) return
      if (getContent() !== initialContent) {
        showToast('Конфигурация изменилась во время перемещения. Повторите действие', 'error')
        return
      }
      const nextOrder = order
      attempt(() => reorderMihomoRoutingRules(initialContent, nextOrder), 'Порядок правил обновлён')
    }
    cleanupDragRef.current = cleanup
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onEnd)
    document.addEventListener('touchmove', onMove, { passive: false })
    document.addEventListener('touchend', onEnd)
    document.addEventListener('touchcancel', onCancel)
  }

  const pending =
    newRule !== null ? (
      <div ref={pendingRef} className="border-chart-2 space-y-2 rounded-lg border border-dashed p-2">
        <p className="text-muted-foreground px-1 text-xs">
          Новое правило · заполните значение и маршрут. До заполнения в YAML не добавляется.
        </p>
        <MihomoRoutingRuleRow
          raw={newRule}
          index={rules.length}
          targets={targets}
          providers={providers}
          icons={options.groupIcons}
          dragging={false}
          draft
          onDragStart={() => {}}
          onChange={updateNewRule}
          onTargetChange={(target) => {
            const r = describeMihomoRoutingRule(newRule)
            updateNewRule([r.type, r.matcher, target].join(','))
          }}
          onEdit={() => openEdit(-1, newRule)}
          onConstruct={(type) => openEdit(-1, newRule, type)}
          onDelete={() => setNewRule(null)}
          onError={(message) => showToast(message, 'error')}
        />
      </div>
    ) : null
  return (
    <div className="absolute inset-0 flex min-h-0 flex-col gap-3 font-sans text-sm">
      <div ref={scrollRef} className="flex min-h-0 flex-1 scrollbar-thin flex-col gap-2 overflow-y-auto pb-1">
        {error ? (
          <div className="text-destructive rounded-lg border p-3">{error}</div>
        ) : (
          <>
            {(dragRuleOrder ?? rules.map((_, index) => index)).map((index, position) => (
              <div key={index}>
                {index === insertionIndex && pending}
                <div
                  ref={(element) => {
                    ruleRowsRef.current[position] = element
                  }}
                >
                  <MihomoRoutingRuleRow
                    raw={rules[index]}
                    index={index}
                    targets={targets}
                    providers={providers}
                    icons={options.groupIcons}
                    dragging={draggingIndex === position}
                    onDragStart={(event) => startDrag(event, position)}
                    onChange={(raw) => attempt(() => updateMihomoRoutingRule(getContent(), index, raw), 'Правило обновлено')}
                    onTargetChange={(target) =>
                      attempt(() => updateMihomoRoutingRuleTargets(getContent(), [index], target), 'Маршрут обновлён')
                    }
                    onEdit={() => openEdit(index, rules[index])}
                    onConstruct={(type) => openEdit(index, rules[index], type)}
                    onDelete={() => attempt(() => deleteMihomoRoutingRule(getContent(), index), 'Правило удалено')}
                    onError={(message) => showToast(message, 'error')}
                  />
                </div>
              </div>
            ))}
            {insertionIndex === rules.length && pending}
            {rules.length === 0 && !pending && (
              <p className="text-muted-foreground rounded-lg border p-5 text-center">Правил маршрутизации пока нет</p>
            )}
          </>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2 pt-1">
        <Button variant="outline" disabled={!!error || newRule !== null} onClick={() => setNewRule('DOMAIN-SUFFIX,,')}>
          <IconPlus size={17} />
          Добавить правило
        </Button>
        <Button variant="outline" disabled={!!error} onClick={onAddRule}>
          <IconListDetails size={17} />
          Конструктор правил
        </Button>
      </div>
      <Dialog
        open={draft !== null}
        onOpenChange={(open) => {
          if (!open) setDraft(null)
        }}
      >
        <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {draft?.logical ? 'Конструктор условий' : 'Изменить правило'}
              {draft && draft.index >= 0 ? ` #${draft.index + 1}` : ''}
            </DialogTitle>
          </DialogHeader>
          {draft?.logical ? (
            <ConditionEditor node={draft.logical} providers={providers} onChange={(logical) => setDraft({ ...draft, logical })} />
          ) : (
            <Textarea
              aria-label="Правило Mihomo"
              value={draftValue}
              onChange={(event) => setDraftValue(event.target.value)}
              className="min-h-28 font-mono text-sm"
            />
          )}
          {draftError ? (
            <p className="text-destructive text-sm">{draftError}</p>
          ) : (
            <pre className="bg-muted/40 overflow-x-auto rounded-lg border p-3 text-xs whitespace-pre-wrap">{nextRaw}</pre>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>
              Отмена
            </Button>
            <Button disabled={!!draftError} onClick={saveDraft}>
              Сохранить правило
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
