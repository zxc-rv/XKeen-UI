import {
  useState,
  useRef,
  useEffect,
  useCallback,
  forwardRef,
  startTransition,
} from "react";
import {
  IconPlus,
  IconX,
  IconGripVertical,
  IconPencil,
  IconCheck,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "../lib/utils";
import { useAppContext } from "../store";
import { apiCall } from "../lib/api";
import type { MonacoEditorRef } from "./MonacoEditor";
import type { Config } from "../types";

const RULE_FIELDS = {
  domain: {
    type: "array" as const,
    placeholder: "youtube.com, geosite:youtube",
  },
  ip: { type: "array" as const, placeholder: "1.1.1.1/32, geoip:cloudflare" },
  port: { type: "string" as const, placeholder: "80, 443, 1000-2000" },
  sourceIP: { type: "array" as const, placeholder: "192.168.1.2" },
  sourcePort: { type: "string" as const, placeholder: "80, 443" },
  network: {
    type: "buttons" as const,
    options: ["tcp", "udp"],
    isString: true,
  },
  inboundTag: { type: "buttons" as const },
  protocol: {
    type: "buttons" as const,
    options: ["http", "tls", "quic", "bittorrent"],
  },
};

type FieldName = keyof typeof RULE_FIELDS;
type Rule = Record<string, any>;

function stripComments(s: string) {
  return s.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "");
}

function parseRules(content: string): Rule[] {
  try {
    const json = JSON.parse(stripComments(content));
    if (json?.routing?.rules && Array.isArray(json.routing.rules))
      return JSON.parse(JSON.stringify(json.routing.rules));
  } catch {}
  return [];
}

function getBadges(value: any): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.trim())
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  if (typeof value === "number") return [String(value)];
  return [];
}

function validatePort(v: string): boolean {
  if (/^\d+$/.test(v)) {
    const n = parseInt(v);
    return n >= 1 && n <= 65535;
  }
  if (/^\d+-\d+$/.test(v)) {
    const [a, b] = v.split("-").map(Number);
    return a >= 1 && b <= 65535 && a < b;
  }
  return false;
}

interface AvailableTags {
  outbounds: string[];
  inbounds: string[];
  balancers: string[];
}

interface Props {
  editorRef: React.RefObject<MonacoEditorRef | null>;
  configs: Config[];
  activeConfigIndex: number;
}

export function RoutingPanel({ editorRef, configs, activeConfigIndex }: Props) {
  const { showToast, state, dispatch } = useAppContext();
  const [rules, setRules] = useState<Rule[]>([]);
  const [available, setAvailable] = useState<AvailableTags>({
    outbounds: [],
    inbounds: [],
    balancers: [],
  });
  const rulesRef = useRef<Rule[]>([]);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);

  useEffect(() => {
    const content =
      configs[activeConfigIndex]?.content ??
      editorRef.current?.getValue() ??
      "";
    const parsed = parseRules(content);
    rulesRef.current = parsed;
    setRules(parsed);
    loadAvailable();
  }, [activeConfigIndex]);

  function loadAvailable() {
    let outbounds: string[] = [],
      inbounds: string[] = [],
      balancers: string[] = [];
    try {
      const c = configs.find((x) =>
        x.filename.toLowerCase().includes("outbound"),
      );
      if (c) {
        const j = JSON.parse(stripComments(c.content));
        outbounds =
          j.outbounds?.filter((o: any) => o.tag).map((o: any) => o.tag) ?? [];
      }
    } catch {}
    try {
      const c = configs.find((x) =>
        x.filename.toLowerCase().includes("inbound"),
      );
      if (c) {
        const j = JSON.parse(stripComments(c.content));
        inbounds =
          j.inbounds?.filter((i: any) => i.tag).map((i: any) => i.tag) ?? [];
      }
    } catch {}
    try {
      const content =
        configs[activeConfigIndex]?.content ??
        editorRef.current?.getValue() ??
        "";
      const j = JSON.parse(stripComments(content));
      balancers =
        j.routing?.balancers
          ?.filter((b: any) => b.tag)
          .map((b: any) => b.tag) ?? [];
    } catch {}
    setAvailable({
      outbounds: [...new Set(outbounds)],
      inbounds: [...new Set(inbounds)],
      balancers: [...new Set(balancers)],
    });
  }

  const syncToEditor = useCallback(
    async (newRules: Rule[], triggerSoftRestart = false) => {
      const wrapper = editorRef.current;
      if (!wrapper) return;
      const monacoEditor = wrapper.getEditor();
      if (!monacoEditor) return;
      const model = monacoEditor.getModel();
      if (!model) return;
      try {
        const json = JSON.parse(stripComments(wrapper.getValue()));
        json.routing.rules = newRules;
        const text = JSON.stringify(json, null, 2);
        monacoEditor.executeEdits("gui-routing", [
          { range: model.getFullModelRange(), text },
        ]);

        if (
          triggerSoftRestart &&
          state.settings.autoApply &&
          state.serviceStatus === "running"
        ) {
          const activeConfig = configs[activeConfigIndex];
          if (activeConfig) {
            const content = monacoEditor.getValue();
            await apiCall<any>("PUT", "configs", {
              action: "save",
              filename: activeConfig.filename,
              content,
            });
            dispatch({
              type: "SAVE_CONFIG",
              index: activeConfigIndex,
              content,
            });
            dispatch({
              type: "SET_SERVICE_STATUS",
              status: "pending",
              pendingText: "Перезапуск...",
            });
            const r = await apiCall<any>("POST", "control", {
              action: "softRestart",
              core: state.currentCore,
            });
            showToast(
              r?.success ? "Изменения применены" : `Ошибка: ${r?.error}`,
              r?.success ? "success" : "error",
            );
            dispatch({ type: "SET_SERVICE_STATUS", status: "running" });
          }
        }
      } catch (e: any) {
        showToast(`Ошибка синхронизации: ${e.message}`, "error");
      }
    },
    [
      editorRef,
      showToast,
      state.settings.autoApply,
      state.serviceStatus,
      state.currentCore,
      configs,
      activeConfigIndex,
      dispatch,
    ],
  );

  function applyRules(newRules: Rule[], triggerSoftRestart = false) {
    rulesRef.current = newRules;
    startTransition(() => setRules([...newRules]));
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(
      () => syncToEditor(newRules, triggerSoftRestart),
      100,
    );
  }

  function startDrag(
    e: React.MouseEvent | React.TouchEvent,
    fromIndex: number,
  ) {
    if (e.cancelable) e.preventDefault();
    let current = fromIndex;
    setDraggingIndex(fromIndex);

    const onMove = (ev: MouseEvent | TouchEvent) => {
      const clientY = "touches" in ev ? ev.touches[0].clientY : ev.clientY;
      for (let i = 0; i < cardRefs.current.length; i++) {
        if (i === current) continue;
        const rect = cardRefs.current[i]?.getBoundingClientRect();
        if (!rect || clientY < rect.top || clientY > rect.bottom) continue;
        const newRules = [...rulesRef.current];
        const [moved] = newRules.splice(current, 1);
        newRules.splice(i, 0, moved);
        current = i;
        rulesRef.current = newRules;
        setRules([...newRules]);
        setDraggingIndex(i);
        break;
      }
    };
    const onUp = () => {
      syncToEditor(rulesRef.current);
      setDraggingIndex(null);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("touchmove", onMove, { passive: true });
    document.addEventListener("touchend", onUp, { passive: true });
  }

  return (
    <div
      ref={scrollRef}
      className="absolute inset-4 overflow-y-auto flex flex-col gap-2"
    >
      <div className="flex flex-col gap-2">
        {rules.map((rule, index) => (
          <RuleCard
            key={index}
            ref={(el) => {
              cardRefs.current[index] = el;
            }}
            rule={rule}
            index={index}
            isDragging={draggingIndex === index}
            available={available}
            onUpdate={(updated, triggerSoftRestart) => {
              const r = [...rulesRef.current];
              r[index] = updated;
              applyRules(r, triggerSoftRestart);
            }}
            onDelete={() =>
              applyRules(rulesRef.current.filter((_, i) => i !== index))
            }
            onDragStart={(e) => startDrag(e, index)}
            showToast={showToast}
          />
        ))}
      </div>
      <button
        onClick={() => {
          applyRules([
            ...rulesRef.current,
            { domain: [], outboundTag: available.outbounds[0] ?? "direct" },
          ]);
          setTimeout(
            () =>
              scrollRef.current?.scrollTo({
                top: scrollRef.current.scrollHeight,
                behavior: "smooth",
              }),
            50,
          );
        }}
        className="flex items-center cursor-pointer justify-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-[#60a5fa] transition-colors border-2 border-dashed border-ring/60 hover:border-chart-2 hover:border-solid rounded-xl px-3 py-2.5 w-full mt-1"
      >
        <IconPlus size={17} /> Добавить правило
      </button>
    </div>
  );
}

interface RuleCardProps {
  rule: Rule;
  index: number;
  isDragging: boolean;
  available: AvailableTags;
  onUpdate: (r: Rule, triggerSoftRestart?: boolean) => void;
  onDelete: () => void;
  onDragStart: (e: React.MouseEvent | React.TouchEvent) => void;
  showToast: (msg: string, type?: "success" | "error") => void;
}

const RuleCard = forwardRef<HTMLDivElement, RuleCardProps>(function RuleCard(
  {
    rule,
    index,
    isDragging,
    available,
    onUpdate,
    onDelete,
    onDragStart,
    showToast,
  },
  ref,
) {
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(rule.ruleTag ?? "");

  const isBalancer = "balancerTag" in rule;
  const outboundType = isBalancer ? "balancerTag" : "outboundTag";
  const outboundValue = rule[outboundType] ?? "";
  const conditionFields = Object.keys(rule).filter(
    (k) => !["outboundTag", "balancerTag", "ruleTag"].includes(k),
  );
  const availableToAdd = (Object.keys(RULE_FIELDS) as FieldName[]).filter(
    (f) => !(f in rule),
  );

  function saveName() {
    const trimmed = nameValue.trim();
    const updated = { ...rule };
    if (trimmed) updated.ruleTag = trimmed;
    else delete updated.ruleTag;
    setEditingName(false);
    onUpdate(updated);
  }

  function addField(f: FieldName) {
    const cfg = RULE_FIELDS[f];
    onUpdate({
      ...rule,
      [f]: cfg.type === "array" || cfg.type === "buttons" ? [] : "",
    });
  }

  function removeField(f: string) {
    const u = { ...rule };
    delete u[f];
    onUpdate(u);
  }

  function changeField(old: string, next: FieldName) {
    const u = { ...rule };
    delete u[old];
    const cfg = RULE_FIELDS[next];
    u[next] = cfg.type === "array" || cfg.type === "buttons" ? [] : "";
    onUpdate(u);
  }

  function updateField(f: string, v: any) {
    onUpdate({ ...rule, [f]: v });
  }

  function addBadge(f: string, v: string) {
    if (["port", "sourcePort"].includes(f) && !validatePort(v)) {
      showToast(
        "Некорректный порт. Допустимы числа или диапазоны 1-65535",
        "error",
      );
      return;
    }
    const cur = getBadges(rule[f]);
    if (cur.includes(v)) return;
    const next = [...cur, v];
    const cfg = RULE_FIELDS[f as FieldName];
    updateField(f, cfg?.type === "array" ? next : next.join(","));
  }

  function editBadge(f: string, oldV: string, newV: string) {
    if (!newV) return removeBadge(f, oldV);
    if (oldV === newV) return;
    if (["port", "sourcePort"].includes(f) && !validatePort(newV)) {
      showToast(
        "Некорректный порт. Допустимы числа или диапазоны 1-65535",
        "error",
      );
      return;
    }
    const cur = getBadges(rule[f]);
    const next = cur.map((x) => (x === oldV ? newV : x));
    const cfg = RULE_FIELDS[f as FieldName];
    updateField(f, cfg?.type === "array" ? next : next.join(","));
  }

  function removeBadge(f: string, v: string) {
    const next = getBadges(rule[f]).filter((x) => x !== v);
    const cfg = RULE_FIELDS[f as FieldName];
    updateField(f, cfg?.type === "array" ? next : next.join(","));
  }

  function toggleBtn(f: string, v: string) {
    const cfg = RULE_FIELDS[f as FieldName];
    const cur = getBadges(rule[f]);
    let next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
    const optionsOrder = (cfg as any)?.options as string[] | undefined;
    if (optionsOrder) next = optionsOrder.filter((o) => next.includes(o));
    updateField(f, (cfg as any)?.isString ? next.join(",") : next);
  }

  function switchOutbound(newType: "outboundTag" | "balancerTag") {
    const u = { ...rule };
    delete u.outboundTag;
    delete u.balancerTag;
    u[newType] =
      newType === "outboundTag"
        ? (available.outbounds[0] ?? "")
        : (available.balancers[0] ?? "");
    onUpdate(u);
  }

  function changeOutboundValue(value: string) {
    onUpdate({ ...rule, [outboundType]: value }, true);
  }

  return (
    <div
      ref={ref}
      style={{ background: "var(--color-input-background)" }}
      className={cn(
        "rounded-xl border p-3 flex flex-col gap-2 transition-all duration-150 select-none",
        isDragging
          ? "border-primary/60 shadow-lg shadow-black/30 scale-[0.99] opacity-80"
          : "border-border",
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        <div
          className={cn(
            "p-1 rounded transition-colors text-muted-foreground hover:text-foreground hover:bg-muted/50 touch-none",
            isDragging ? "cursor-grabbing" : "cursor-grab",
          )}
          onMouseDown={onDragStart}
          onTouchStart={onDragStart}
        >
          <IconGripVertical size={19} />
        </div>
        <Badge
          variant="outline"
          className="rounded-md w-6 h-6 p-3.5 px-4 bg-blue-500/10 text-blue-400 border-blue-500/20"
        >
          #{index + 1}
        </Badge>
        {editingName ? (
          <div className="flex items-center gap-1 flex-1 min-w-0">
            <input
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveName();
                if (e.key === "Escape") {
                  setEditingName(false);
                  setNameValue(rule.ruleTag ?? "");
                }
              }}
              autoFocus
              className="h-6 text-xs bg-transparent border-b border-border outline-none flex-1 min-w-0"
              placeholder="Название правила"
            />
            <button
              onClick={saveName}
              className="text-muted-foreground hover:text-foreground shrink-0"
            >
              <IconCheck size={14} />
            </button>
          </div>
        ) : (
          <div className="flex items-center pl-1 gap-2 flex-1 min-w-0">
            {rule.ruleTag && (
              <span className="text-sm truncate">{rule.ruleTag}</span>
            )}
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => {
                      setEditingName(true);
                      setNameValue(rule.ruleTag ?? "");
                    }}
                    className="text-muted-foreground/40 hover:text-muted-foreground transition-colors shrink-0"
                  >
                    <IconPencil size={16} />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Редактировать название</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        )}
        <button
          onClick={onDelete}
          className="ml-auto text-ring hover:text-destructive hover:bg-destructive/20 rounded-md transition-colors p-1 shrink-0"
        >
          <IconX size={23} className="cursor-pointer" />
        </button>
      </div>

      {/* Condition fields */}
      {conditionFields.map((fieldName) => {
        const cfg = RULE_FIELDS[fieldName as FieldName];
        const otherFields = (Object.keys(RULE_FIELDS) as FieldName[]).filter(
          (f) => f !== fieldName && !(f in rule),
        );

        return (
          <div key={fieldName} className="flex items-start gap-2">
            <Select
              value={fieldName}
              onValueChange={(v) => {
                if (v && v !== fieldName)
                  changeField(fieldName, v as FieldName);
              }}
            >
              <SelectTrigger className="w-fit shrink-0 flex items-center justify-between gap-2 h-9 px-3 rounded-md border border-border bg-input-background hover:bg-muted text-[13px] font-medium transition-colors focus:ring-0 [&>svg]:opacity-50">
                <span className="truncate">{fieldName}</span>
                <SelectValue placeholder={fieldName} className="hidden" />
              </SelectTrigger>
              <SelectContent position="popper">
                {otherFields.map((f) => (
                  <SelectItem
                    key={f}
                    value={f}
                    className="text-[13px] cursor-pointer"
                  >
                    {f}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="flex-1 min-w-0">
              {cfg?.type === "buttons" || fieldName === "inboundTag" ? (
                <div className="cursor-pointer flex flex-wrap gap-1 items-center min-h-9 px-1 py-1 pr-1 rounded-md border border-border bg-input-background">
                  {(
                    (fieldName === "inboundTag"
                      ? available.inbounds
                      : (cfg as any).options) ?? []
                  ).map((opt: string) => {
                    const active = getBadges(rule[fieldName]).includes(opt);
                    const colors: Record<string, { a: string; i: string }> = {
                      inboundTag: {
                        a: "bg-green-500/10 text-green-400 border-green-500/40",
                        i: "bg-green-500/5 text-green-500/40 border-green-500/20 hover:bg-green-500/15",
                      },
                      protocol: {
                        a: "bg-purple-500/10 text-purple-400 border-purple-500/40",
                        i: "bg-purple-500/5 text-purple-500/40 border-purple-500/20 hover:bg-purple-500/15",
                      },
                      network: {
                        a: "bg-blue-500/10 text-blue-400 border-blue-500/40",
                        i: "bg-blue-500/5 text-blue-500/40 border-blue-500/20 hover:bg-blue-500/15",
                      },
                    };
                    const c = colors[fieldName] || {
                      a: "bg-primary/10 text-primary border-primary/40",
                      i: "bg-primary/5 text-primary/40 border-primary/20 hover:bg-primary/15",
                    };

                    return (
                      <button
                        key={opt}
                        onClick={() => toggleBtn(fieldName, opt)}
                        className={cn(
                          "cursor-pointer px-3 py-0.75 rounded text-xs border transition-colors",
                          active ? c.a : c.i,
                        )}
                      >
                        {fieldName === "network" || fieldName === "protocol"
                          ? opt.toUpperCase()
                          : opt}
                      </button>
                    );
                  })}
                  {fieldName === "inboundTag" &&
                    available.inbounds.length === 0 && (
                      <span className="text-xs text-muted-foreground">
                        Inbound теги не найдены
                      </span>
                    )}
                  <button
                    onMouseDown={(e) => {
                      e.preventDefault();
                      removeField(fieldName);
                    }}
                    className="ml-auto shrink-0 text-muted-foreground/40 hover:text-destructive transition-colors p-1"
                  >
                    <IconX size={14} />
                  </button>
                </div>
              ) : (
                <BadgeInput
                  badges={getBadges(rule[fieldName])}
                  placeholder={cfg?.placeholder ?? ""}
                  fieldType={fieldName}
                  onAdd={(v) => addBadge(fieldName, v)}
                  onRemove={(v) => removeBadge(fieldName, v)}
                  onRemoveField={() => removeField(fieldName)}
                  onEdit={(oldV, newV) => editBadge(fieldName, oldV, newV)}
                />
              )}
            </div>
          </div>
        );
      })}

      {/* Add condition */}
      {availableToAdd.length > 0 && (
        <Select
          key={availableToAdd.join(",")}
          onValueChange={(v) => {
            if (v) addField(v as FieldName);
          }}
        >
          <SelectTrigger className="flex items-center justify-center gap-1.5 text-xs tracking-wide text-muted-foreground hover:text-foreground transition-colors border border-dashed border-border rounded-lg px-3 py-2 w-full h-auto min-h-9 bg-transparent focus:ring-0 [&>svg]:hidden">
            <IconPlus size={13} />
            <span>Добавить условие</span>
            <SelectValue className="hidden" />
          </SelectTrigger>
          <SelectContent position="popper">
            {availableToAdd.map((f) => (
              <SelectItem key={f} value={f} className="text-sm cursor-pointer">
                {f}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* Outbound row */}
      <div className="flex items-center gap-2">
        <Select
          value={outboundType}
          onValueChange={(v) =>
            switchOutbound(v as "outboundTag" | "balancerTag")
          }
        >
          <SelectTrigger className="w-fit min-w-32.5 shrink-0 h-9 px-2.5 border-blue-500/40 bg-input-background hover:bg-blue-500/10 text-blue-400 text-[13px] font-bold transition-colors [&>svg]:text-blue-400/60">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="outboundTag" className="text-[13px] font-bold">
              outboundTag
            </SelectItem>
            <SelectItem value="balancerTag" className="text-[13px] font-bold">
              balancerTag
            </SelectItem>
          </SelectContent>
        </Select>

        <Select value={outboundValue} onValueChange={changeOutboundValue}>
          <SelectTrigger className="h-9 flex-1 text-[13px] border-blue-500/40 bg-input-background hover:bg-blue-500/10 [&>svg]:text-blue-400/60">
            <SelectValue placeholder="Выберите..." />
          </SelectTrigger>
          <SelectContent>
            {(isBalancer ? available.balancers : available.outbounds).map(
              (tag) => (
                <SelectItem key={tag} value={tag} className="text-[13px]">
                  {tag}
                </SelectItem>
              ),
            )}
            {(isBalancer ? available.balancers : available.outbounds).length ===
              0 && (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                {isBalancer ? "Балансиры не найдены" : "Аутбаунды не найдены"}
              </div>
            )}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
});

interface BadgeInputProps {
  badges: string[];
  placeholder: string;
  fieldType: string;
  onAdd: (v: string) => void;
  onRemove: (v: string) => void;
  onRemoveField: () => void;
  onEdit: (oldV: string, newV: string) => void;
}

function BadgeInput({
  badges,
  placeholder,
  fieldType,
  onAdd,
  onRemove,
  onRemoveField,
  onEdit,
}: BadgeInputProps) {
  const [input, setInput] = useState("");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function commitNew(v: string) {
    const t = v.trim();
    if (!t) return;
    onAdd(t);
    setInput("");
  }

  function startEdit(i: number) {
    setEditingIndex(i);
    setEditingValue(badges[i]);
  }

  function commitEdit() {
    if (editingIndex === null) return;
    const old = badges[editingIndex];
    const trimmed = editingValue.trim();
    setEditingIndex(null);
    setEditingValue("");
    onEdit(old, trimmed);
  }

  function cancelEdit() {
    setEditingIndex(null);
    setEditingValue("");
  }

  const color =
    fieldType === "domain"
      ? "bg-red-500/10 text-red-400 border-red-500/30"
      : fieldType === "ip"
        ? "bg-blue-500/10 text-blue-400 border-blue-500/30"
        : fieldType === "sourceIP"
          ? "bg-purple-500/10 text-purple-400 border-purple-500/30"
          : "bg-yellow-500/10 text-yellow-400 border-yellow-500/30";

  return (
    <div
      className="flex flex-wrap gap-1 items-center min-h-9 px-1 py-1 pr-1 rounded-md border border-border bg-input-background cursor-text"
      onClick={() => {
        if (editingIndex === null) inputRef.current?.focus();
      }}
    >
      {badges.map((badge, i) =>
        editingIndex === i ? (
          <input
            key={i}
            value={editingValue}
            onChange={(e) => setEditingValue(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                commitEdit();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                cancelEdit();
              }
              e.stopPropagation();
            }}
            onClick={(e) => e.stopPropagation()}
            autoFocus
            style={{ width: Math.max(editingValue.length * 8, 60) + "px" }}
            className={cn(
              "px-1.5 py-0.5 rounded text-xs border outline-none",
              color,
            )}
          />
        ) : (
          <span
            key={i}
            onClick={(e) => {
              e.stopPropagation();
              startEdit(i);
            }}
            className={cn(
              "inline-flex items-center gap-0.5 pl-3 pr-2.25 py-0.75 rounded text-xs tracking-wide border cursor-pointer hover:opacity-75 transition-opacity select-none",
              color,
            )}
          >
            {badge}
            <button
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onRemove(badge);
              }}
              className="opacity-50 text-sm hover:opacity-100 ml-1 transition-opacity leading-none"
            >
              <IconX size={12} />
            </button>
          </span>
        ),
      )}
      {editingIndex === null && (
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commitNew(input);
            }
            if (e.key === " ") {
              e.preventDefault();
              commitNew(input);
            }
            if (e.key === "Backspace" && !input && badges.length > 0)
              onRemove(badges[badges.length - 1]);
          }}
          onBlur={() => commitNew(input)}
          placeholder={badges.length === 0 ? placeholder : ""}
          className="pl-1 flex-1 min-w-20 bg-transparent outline-none text-xs placeholder:text-muted-foreground/50"
        />
      )}
      <button
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onRemoveField();
        }}
        className="shrink-0 ml-auto text-muted-foreground/40 hover:text-destructive transition-colors p-1"
      >
        <IconX size={14} />
      </button>
    </div>
  );
}
