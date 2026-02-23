import { useState, useRef, useEffect, useCallback } from "react";
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
import { processLogLine } from "../lib/logBadges";
import type { WsMessage } from "../hooks/useWebSocket";

const LOG_FILES = ["error.log", "access.log"];
const MAX_LINES = 5000;

function LogContent({
  logLines,
  containerRef,
  onScroll,
  onClick,
  showScrollBtn,
  onScrollToBottom,
}: {
  logLines: string[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  onClick: (e: React.MouseEvent<HTMLDivElement>) => void;
  showScrollBtn: boolean;
  onScrollToBottom: () => void;
}) {
  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={containerRef}
        onScroll={onScroll}
        onClick={onClick}
        className="absolute border p-3 inset-4 overflow-y-auto overflow-x-hidden leading-relaxed rounded-md bg-input-background"
        tabIndex={0}
        style={{
          color: "#dbdbdb",
          fontFamily: "JetBrains Mono, monospace, Noto Color Emoji",
          fontSize: 13,
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
        }}
      >
        {logLines.length === 0 ? (
          <div className="flex items-center justify-center h-full text-[13px] text-ring">
            Журнал пуст
          </div>
        ) : (
          logLines.map((line, i) => (
            <div key={i} dangerouslySetInnerHTML={{ __html: line }} />
          ))
        )}
      </div>
      {showScrollBtn && (
        <Button
          variant="outline"
          size="icon"
          className="absolute bottom-8 right-8 z-10 h-8 w-8 rounded-md shadow-lg bg-background/80 backdrop-blur"
          onClick={onScrollToBottom}
        >
          <IconChevronDown size={14} />
        </Button>
      )}
    </div>
  );
}

export function LogPanel() {
  const { state } = useAppContext();
  const [logLines, setLogLines] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [currentFile, setCurrentFile] = useState("error.log");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [userScrolled, setUserScrolled] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.code === "KeyA") {
        const el = containerRef.current;
        if (
          el &&
          (el.contains(document.activeElement) || document.activeElement === el)
        ) {
          e.preventDefault();
          const range = document.createRange();
          range.selectNodeContents(el);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  const filterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const handleMessage = useCallback((data: WsMessage) => {
    if (data.error) {
      setLogLines([processLogLine(`ERROR: ${data.error}`)]);
      return;
    }
    if (data.type === "initial") {
      setLogLines((data.lines || []).map(processLogLine));
      return;
    }
    if (data.type === "clear") {
      setLogLines([]);
      return;
    }
    if (data.type === "filtered") {
      setLogLines((data.lines || []).map(processLogLine));
      return;
    }
    if (data.type === "append" && data.content) {
      const newLines = data.content
        .split("\n")
        .filter((l) => l.trim())
        .map(processLogLine);
      setLogLines((prev) => {
        const next = [...prev, ...newLines];
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
      });
    }
  }, []);

  const ws = useWebSocket(handleMessage);

  useEffect(() => {
    ws.reload();
  }, [state.settings.timezone]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const updateScroll = () => {
      if (!userScrolled) {
        el.scrollTop = el.scrollHeight;
        setShowScrollBtn(false);
      } else {
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 5;
        setShowScrollBtn(!atBottom);
        if (atBottom) setUserScrolled(false);
      }
    };
    updateScroll();
    const observer = new ResizeObserver(updateScroll);
    observer.observe(el);
    return () => observer.disconnect();
  }, [logLines, isFullscreen, userScrolled]);

  function switchFile(filename: string) {
    if (filename === currentFile) return;
    setCurrentFile(filename);
    setLogLines([]);
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
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 5;
    setUserScrolled(!atBottom);
    setShowScrollBtn(!atBottom);
  }

  function scrollToBottom() {
    containerRef.current?.scrollTo({
      top: containerRef.current.scrollHeight,
      behavior: "smooth",
    });
    setUserScrolled(false);
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

  const header = (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 pt-4 shrink-0">
      <h2 className="text-lg font-semibold">Журнал</h2>
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
        {/* Задник для фулскрина */}
        {(isFullscreen || isClosing) && (
          <div
            className={cn(
              "fixed inset-0 z-40 bg-black/50 transition-opacity duration-300",
              isClosing ? "opacity-0" : "opacity-100",
            )}
            onClick={closeFullscreen}
          />
        )}

        {/* Сама панель */}
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
          <LogContent
            logLines={logLines}
            containerRef={containerRef}
            onScroll={handleScroll}
            onClick={handleLogClick}
            showScrollBtn={showScrollBtn}
            onScrollToBottom={scrollToBottom}
          />
        </div>
      </div>
    </TooltipProvider>
  );
}
