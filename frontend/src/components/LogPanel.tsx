import { useState, useRef, useEffect, useCallback } from "react";
import {
  IconTrash,
  IconMaximize,
  IconMinimize,
  IconChevronDown,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import { motion, AnimatePresence } from "framer-motion";
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
const MAX_LINES = 1000;
const TRANSITION = {
  type: "tween",
  duration: 0.4,
  ease: [0.16, 1, 0.3, 1],
} as const;

export function LogPanel() {
  const { state } = useAppContext();
  const [filter, setFilter] = useState("");
  const [currentFile, setCurrentFile] = useState("error.log");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);
  const [isEmpty, setIsEmpty] = useState(true);

  const logRef = useRef<HTMLDivElement>(null);
  const filterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoScrollRef = useRef(true);

  const linesRef = useRef<string[]>([]);
  const scrollTickingRef = useRef(false);

  useEffect(() => {
    return () => {
      if (filterTimerRef.current) clearTimeout(filterTimerRef.current);
    };
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const renderAll = useCallback((lines: string[]) => {
    const el = logRef.current;
    if (!el) return;

    linesRef.current = lines.slice(-MAX_LINES);
    const hasLines = linesRef.current.length > 0;

    setIsEmpty(!hasLines);
    el.innerHTML = hasLines ? linesRef.current.join("") : "";

    if (hasLines && autoScrollRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  const appendLines = useCallback((newLines: string[]) => {
    if (newLines.length === 0) return;
    const el = logRef.current;
    if (!el) return;

    setIsEmpty(false);
    linesRef.current.push(...newLines);

    if (linesRef.current.length > MAX_LINES) {
      linesRef.current = linesRef.current.slice(-MAX_LINES);
      el.innerHTML = linesRef.current.join("");
    } else {
      el.insertAdjacentHTML("beforeend", newLines.join(""));
    }

    if (autoScrollRef.current) el.scrollTop = el.scrollHeight;
  }, []);

  const handleMessage = useCallback(
    (data: WsMessage) => {
      if (data.error) {
        renderAll([`<div style="color:#ef4444">ERROR: ${data.error}</div>`]);
        return;
      }
      if (data.type === "initial" || data.type === "filtered") {
        renderAll(data.lines || []);
        return;
      }
      if (data.type === "clear") {
        renderAll([]);
        return;
      }
      if (data.type === "append" && data.content) {
        appendLines(data.content.split("\n").filter((l) => l.trim()));
      }
    },
    [renderAll, appendLines],
  );

  const ws = useWebSocket(handleMessage);

  useEffect(() => {
    ws.reload();
  }, [state.settings.timezone]);

  function switchFile(filename: string) {
    if (filename === currentFile) return;
    setCurrentFile(filename);
    renderAll([]);
    ws.switchFile(filename);
  }

  function handleFilterChange(value: string) {
    setFilter(value);
    if (filterTimerRef.current) clearTimeout(filterTimerRef.current);
    filterTimerRef.current = setTimeout(() => ws.applyFilter(value), 100);
  }

  function checkScrollPosition() {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.clientHeight <= el.scrollTop + 40;
    autoScrollRef.current = atBottom;
    setShowScrollBtn(!atBottom);
  }

  function handleScroll() {
    if (isAnimating || scrollTickingRef.current) return;
    scrollTickingRef.current = true;

    requestAnimationFrame(() => {
      checkScrollPosition();
      scrollTickingRef.current = false;
    });
  }

  function handleScrollToBottom() {
    autoScrollRef.current = true;
    setShowScrollBtn(false);
    scrollToBottom();
  }

  function handleLogClick(e: React.MouseEvent<HTMLDivElement>) {
    const badge = (e.target as HTMLElement).closest("span");
    if (!badge?.textContent) return;
    const level = badge.textContent;
    if (filterTimerRef.current) clearTimeout(filterTimerRef.current);
    setFilter(level);
    ws.applyFilter(level);
  }

  function toggleFullscreen() {
    document.body.style.overflow = isFullscreen ? "" : "hidden";
    setIsFullscreen((v) => !v);
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.code !== "KeyA") return;
      const el = logRef.current;
      if (
        el &&
        (el.contains(document.activeElement) || document.activeElement === el)
      ) {
        e.preventDefault();
        window.getSelection()?.selectAllChildren(el);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (!el) return;

    let rTicking = false;
    const ro = new ResizeObserver(() => {
      if (autoScrollRef.current && !rTicking) {
        rTicking = true;
        requestAnimationFrame(() => {
          scrollToBottom();
          rTicking = false;
        });
      }
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollToBottom]);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="md:shrink-0 pb-3 relative h-70 w-full">
        <AnimatePresence>
          {isFullscreen && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-40 bg-black/50"
              onClick={toggleFullscreen}
            />
          )}
        </AnimatePresence>

        <motion.div
          layout
          transition={TRANSITION}
          onLayoutAnimationStart={() => setIsAnimating(true)}
          onLayoutAnimationComplete={() => {
            setIsAnimating(false);
            checkScrollPosition();
          }}
          className={cn(
            "flex flex-col rounded-xl border border-border bg-card overflow-hidden",
            isFullscreen
              ? "fixed inset-x-3 sm:inset-x-4 bottom-3 z-50 shadow-2xl sm:max-w-500 sm:mx-auto"
              : "absolute inset-0 z-10 w-full",
          )}
          style={{ height: isFullscreen ? "calc(100dvh - 1.25rem)" : "100%" }}
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 pt-4 shrink-0">
            <h2 className="text-lg font-semibold select-none">Журнал</h2>
            <div className="flex flex-wrap items-center gap-1.5">
              <div className="relative flex items-center flex-1 sm:flex-none min-w-30">
                <IconSearch
                  size={13}
                  className="absolute left-2.5 text-muted-foreground pointer-events-none"
                />
                <Input
                  value={filter}
                  onChange={(e) => handleFilterChange(e.target.value)}
                  placeholder="Фильтр"
                  className="h-9 text-base md:text-sm w-40 px-7"
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
                      onClick={toggleFullscreen}
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

          <div className="relative flex-1 min-h-0">
            <div className="absolute inset-4 rounded-md bg-input-background overflow-hidden border">
              {isEmpty && (
                <div className="flex items-center justify-center h-full font-mono text-[13px] text-ring pointer-events-none">
                  Журнал пуст
                </div>
              )}
              <div
                ref={logRef}
                tabIndex={0}
                className={cn(
                  "text-[#dbdbdb] font-mono text-[13px] leading-[1.6] h-full overflow-y-auto px-3 py-1.5 whitespace-pre-wrap break-all",
                  isAnimating && "pointer-events-none",
                )}
                onScroll={handleScroll}
                onClick={handleLogClick}
              />
            </div>

            {showScrollBtn && !isAnimating && (
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
        </motion.div>
      </div>
    </TooltipProvider>
  );
}
