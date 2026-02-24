import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import {
  IconTrash,
  IconMaximize,
  IconMinimize,
  IconChevronDown,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { useWebSocket } from "../hooks/useWebSocket";
import { useAppContext } from "../store";
import type { WsMessage } from "../hooks/useWebSocket";

const LOG_FILES = ["error.log", "access.log"];
const MAX_LINES = 2000;

export function LogPanel() {
  const { state } = useAppContext();
  const [filter, setFilter] = useState("");
  const [currentFile, setCurrentFile] = useState("error.log");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const linesRef = useRef<string[]>([]);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const filterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoScrollRef = useRef(true);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.code !== "KeyA") return;
      const el = containerRef.current;
      if (
        el &&
        (el.contains(document.activeElement) || document.activeElement === el)
      ) {
        e.preventDefault();
        const range = document.createRange();
        range.selectNodeContents(el);
        window.getSelection()?.selectAllChildren(el);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function renderAll(lines: string[]) {
    const el = containerRef.current;
    if (!el) return;
    linesRef.current = lines;
    el.innerHTML = lines.length
      ? lines.join("")
      : '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:13px;color:#6b7280;">Журнал пуст</div>';
  }

  function appendLines(newLines: string[]) {
    if (!newLines.length) return;
    const el = containerRef.current;
    if (!el) return;

    if (!linesRef.current.length) {
      linesRef.current = newLines;
      el.innerHTML = newLines.join("");
      return;
    }

    linesRef.current.push(...newLines);

    if (linesRef.current.length > MAX_LINES) {
      const excess = linesRef.current.length - MAX_LINES;
      linesRef.current.splice(0, excess);
      el.innerHTML = linesRef.current.join("");
    } else {
      el.insertAdjacentHTML("beforeend", newLines.join(""));
    }
  }

  function scrollToBottom() {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

  const handleMessage = useCallback((data: WsMessage) => {
    if (data.error) {
      renderAll([`ERROR: ${data.error}`]);
      if (autoScrollRef.current) requestAnimationFrame(scrollToBottom);
      return;
    }
    if (data.type === "initial") {
      renderAll(data.lines || []);
      if (autoScrollRef.current) requestAnimationFrame(scrollToBottom);
      return;
    }
    if (data.type === "clear") {
      linesRef.current = [];
      if (containerRef.current)
        containerRef.current.innerHTML =
          '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:13px;color:#6b7280;">Логи очищены</div>';
      return;
    }
    if (data.type === "filtered") {
      renderAll(data.lines || []);
      if (autoScrollRef.current) requestAnimationFrame(scrollToBottom);
      return;
    }
    if (data.type === "append" && data.content) {
      const newLines = data.content.split("\n").filter((l) => l.trim());
      appendLines(newLines);
      if (autoScrollRef.current) requestAnimationFrame(scrollToBottom);
    }
  }, []);

  const ws = useWebSocket(handleMessage);

  useEffect(() => {
    ws.reload();
  }, [state.settings.timezone]);

  function switchFile(filename: string) {
    if (filename === currentFile) return;
    setCurrentFile(filename);
    linesRef.current = [];
    if (containerRef.current) containerRef.current.innerHTML = "";
    ws.switchFile(filename);
  }

  function handleFilterChange(value: string) {
    setFilter(value);
    if (filterTimerRef.current) clearTimeout(filterTimerRef.current);
    filterTimerRef.current = setTimeout(() => ws.applyFilter(value), 100);
  }

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 10;
    autoScrollRef.current = atBottom;
    setShowScrollBtn(!atBottom);
  }

  function handleScrollToBottom() {
    autoScrollRef.current = true;
    containerRef.current?.scrollTo({
      top: containerRef.current.scrollHeight,
    });
    setShowScrollBtn(false);
  }

  function handleLogClick(e: React.MouseEvent<HTMLDivElement>) {
    const badge = (e.target as HTMLElement).closest("span");
    if (!badge?.textContent) return;
    const level = badge.textContent;
    if (filterTimerRef.current) clearTimeout(filterTimerRef.current);
    setFilter(level);
    ws.applyFilter(level);
  }

  function openFullscreen() {
    setIsFullscreen(true);
    document.body.style.overflow = "hidden";
  }

  function closeFullscreen() {
    setIsClosing(true);
    document.body.style.overflow = "";
    setTimeout(() => {
      setIsFullscreen(false);
      setIsClosing(false);
    }, 350);
  }

  const timezone = state.settings.timezone;

  return useMemo(() => {
    const header = (
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 pt-4 shrink-0">
        <h2 className="text-lg font-semibold select-none">Журнал</h2>
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="relative flex items-center flex-1 sm:flex-none min-w-30">
            <IconSearch
              size={13}
              className="absolute left-2.5 text-muted-foreground pointer-events-none"
            />
            <Input
              ref={filterInputRef}
              value={filter}
              onChange={(e) => handleFilterChange(e.target.value)}
              placeholder="Фильтр"
              className="h-9 text-base md:text-sm w-full md:w-40 px-7"
            />
            {filter && (
              <button
                onClick={() => {
                  if (filterTimerRef.current)
                    clearTimeout(filterTimerRef.current);
                  setFilter("");
                  ws.applyFilter("");
                }}
                className="absolute right-3 text-muted-foreground hover:text-foreground transition-colors"
              >
                <IconX size={13} />
              </button>
            )}
          </div>
          <Select value={currentFile} onValueChange={switchFile}>
            <SelectTrigger className="h-9 w-30 sm:w-32 shrink-0 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {LOG_FILES.map((f) => (
                <SelectItem key={f} value={f} className="text-sm">
                  {f}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-1.5 ml-auto sm:ml-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9 shrink-0"
                  onClick={() => ws.clearLog()}
                >
                  <IconTrash size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Очистить лог</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9 shrink-0"
                  onClick={isFullscreen ? closeFullscreen : openFullscreen}
                >
                  {isFullscreen ? (
                    <IconMinimize size={14} />
                  ) : (
                    <IconMaximize size={14} />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {isFullscreen ? "Свернуть" : "Развернуть"}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
    );

    return (
      <TooltipProvider delayDuration={300}>
        <div
          className="md:shrink-0"
          style={{ height: isFullscreen || isClosing ? 280 : undefined }}
        >
          {(isFullscreen || isClosing) && (
            <div
              className={cn(
                "fixed inset-0 z-40 bg-black/50 transition-opacity duration-300",
                isClosing ? "opacity-0" : "opacity-100",
              )}
              onClick={closeFullscreen}
            />
          )}
          <div
            className={cn(
              "flex flex-col rounded-xl border border-border bg-card overflow-hidden z-50",
              isFullscreen || isClosing
                ? "fixed left-1/2 -translate-x-1/2 bottom-3 shadow-2xl w-[calc(100%-2rem)] max-w-[1248px]"
                : "relative h-70 w-full",
              isFullscreen && !isClosing && "animate-panel-expand",
              isClosing && "animate-panel-collapse",
            )}
          >
            {header}
            <div className="relative flex-1 min-h-0">
              <div
                ref={containerRef}
                onScroll={handleScroll}
                onClick={handleLogClick}
                className="absolute border inset-4 overflow-y-auto overflow-x-hidden rounded-md bg-input-background"
                tabIndex={0}
                style={{
                  color: "#dbdbdb",
                  fontFamily: "JetBrains Mono, monospace, Noto Color Emoji",
                  fontSize: 13,
                  lineHeight: "1.6",
                  padding: "10px 12px",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                  contain: "content",
                }}
              />
              {showScrollBtn && (
                <Button
                  variant="outline"
                  size="icon"
                  className="absolute bottom-8 right-8 z-10 h-8 w-8 rounded-md shadow-lg bg-background/80 backdrop-blur"
                  onClick={handleScrollToBottom}
                >
                  <IconChevronDown size={14} />
                </Button>
              )}
            </div>
          </div>
        </div>
      </TooltipProvider>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFullscreen, isClosing, filter, currentFile, showScrollBtn, timezone]);
}
