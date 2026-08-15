
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowUp,
  ChatBubbleQuestion,
  Check,
  EmojiSatisfied,
  NavArrowRight,
  Refresh,
  Scissor,
  Spark,
  TextBox,
  Xmark,
} from "iconoir-react";
import { Shimmer } from "../atoms/Shimmer";
import { StreamText } from "../atoms/StreamText";

/* ─────────────────────────────────────────────────────────
 * SELECTION ACTIONS
 * A contextual AI bar attached beneath selected text.
 * The global theme owns its surface; this component only
 * composes existing surface, ink, accent, radius and motion
 * tokens.
 *
 * auto (demo self-play) shows the bar after a delay and
 * choreographs thinking → streaming → result. Controlled
 * mode reveals the bar on hover/focus (tap toggles it on
 * touch) and stays busy until the onAction promise settles.
 * ───────────────────────────────────────────────────────── */

const LEAD = "周末开心果口味一直稳居榜首。";
const PICKED =
  "周六一早先做开心果，让这一批在下午高峰前有时间凝固成型。";
const REWRITE =
  "周六一早先做开心果口味，让这一批在下午高峰前充分凝固成型。";

type Mode = "idle" | "thinking" | "streaming" | "result";

const iconProps = {
  width: 14,
  height: 14,
  strokeWidth: 1.8,
  "aria-hidden": true,
} as const;

const icons = {
  explain: <ChatBubbleQuestion {...iconProps} />,
  improve: <Spark {...iconProps} />,
  shorten: <Scissor {...iconProps} />,
  tone: <EmojiSatisfied {...iconProps} />,
  grammar: <TextBox {...iconProps} />,
  send: (
    <ArrowUp
      width="16"
      height="16"
      strokeWidth="2.4"
      aria-hidden="true"
    />
  ),
  chevron: <NavArrowRight {...iconProps} />,
  check: <Check {...iconProps} />,
  close: <Xmark {...iconProps} />,
  retry: <Refresh {...iconProps} />,
};

const control =
  "inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[12px] font-normal text-ink transition-[background-color,color,transform] duration-150 hover:bg-hover active:scale-[0.96]";

const primary =
  "inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-ink px-2.5 text-[12.5px] font-normal text-canvas shadow-hairline transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.96]";

/* Nearest ancestor that scrolls/clips the host. The action bar is absolutely
   positioned inside its host, so this container's overflow — and the paint
   containment of a wrapping group — is what would cut a bar that extends past
   the container's edge. */
function findScrollContainer(el: HTMLElement | null): HTMLElement | null {
  let current = el?.parentElement ?? null;
  while (current) {
    const overflowY = getComputedStyle(current).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return current;
    current = current.parentElement;
  }
  return null;
}

export default function SelectionActions({
  text,
  onAction,
  auto = true,
  bubble = false,
}: {
  /** Selected-text content the bar attaches to (demo copy by default) */
  text?: string;
  /** In non-auto mode, fires when a preset action is picked (action =
   *  its label) or a prompt is sent (action = null, prompt = instruction).
   *  Returning a promise keeps the busy state until it settles. */
  onAction?: (
    action: string | null,
    selectedText: string,
    prompt?: string,
  ) => void | Promise<unknown>;
  /** Demo self-play (delayed show + thinking/streaming choreography) */
  auto?: boolean;
  /** Render the text as a solid accent chat bubble instead of a
   *  highlighted text fragment; sizes to content up to 70% width and
   *  anchors the bar below the bubble's padding. */
  bubble?: boolean;
}) {
  const content = text ?? PICKED;
  /* Only fall back to the demo lead when no text prop was given at all —
     an explicit empty string must not leak the demo sentence. */
  const lead = text == null ? LEAD : "";
  const [shown, setShown] = useState(false);
  const [mode, setMode] = useState<Mode>("idle");
  const [action, setAction] = useState("Improve");
  const [prompt, setPrompt] = useState("");
  const [typingWidth, setTypingWidth] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [anchor, setAnchor] = useState({ x: 0, y: 0 });
  const [positioned, setPositioned] = useState(false);
  /* The first reveal plays pop-in once; later reveals only fade/slide. */
  const [popped, setPopped] = useState(false);
  /* Touch devices have no hover — the bubble toggles the bar on tap. */
  const [hoverCapable] = useState(
    () => window.matchMedia("(hover: hover)").matches,
  );

  const hostRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  /* Tracks whether the pointer is over the host so reset() can decide if
     the bar should stay revealed once the busy state ends. */
  const hoveredRef = useRef(false);
  const previousModeRef = useRef<Mode>("idle");
  const lastWidthRef = useRef(0);
  const widthAnimationRef = useRef<Animation | null>(null);

  useEffect(() => {
    if (!auto) return;
    const timer = window.setTimeout(() => setShown(true), 280);
    return () => window.clearTimeout(timer);
  }, [auto]);

  useEffect(() => {
    /* Controlled mode holds "thinking" until onAction settles — the
       streaming rewrite choreography is demo self-play only. */
    if (mode !== "thinking" || !auto) return;
    const timer = window.setTimeout(() => setMode("streaming"), 700);
    return () => window.clearTimeout(timer);
  }, [mode, auto]);

  /* Attach beneath the final selected line, while centering the bar
   * against the complete selection bounds. requestAnimationFrame batches
   * streaming reflow measurements and avoids visible intermediate positions.
   * In bubble mode the bar clears the bubble's bottom padding (py-2).
   *
   * The centered x is then clamped so the bar stays inside the scroll
   * container's content box: a narrow bubble pinned to the right edge would
   * otherwise push the bar past the container, where the message list's
   * overflow (and a wrapping group's paint containment) clips it. */
  const place = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      const host = hostRef.current;
      const selection = selectionRef.current;
      const bar = barRef.current;
      if (!host || !selection || !bar) return;

      const bounds = selection.getBoundingClientRect();
      const lines = Array.from(selection.getClientRects());
      const lastLine = lines.at(-1);
      if (!lastLine) return;

      const hostBounds = host.getBoundingClientRect();

      let x = bounds.left - hostBounds.left + bounds.width / 2;
      const scroller = findScrollContainer(host);
      if (scroller) {
        const scrollerRect = scroller.getBoundingClientRect();
        const style = getComputedStyle(scroller);
        const contentLeft =
          scrollerRect.left +
          (parseFloat(style.borderLeftWidth) || 0) +
          (parseFloat(style.paddingLeft) || 0);
        const contentRight =
          scrollerRect.right -
          (parseFloat(style.borderRightWidth) || 0) -
          (parseFloat(style.paddingRight) || 0);

        const barWidth = bar.getBoundingClientRect().width;
        const minLeft = contentLeft + 4;
        const maxRight = contentRight - 4;
        if (barWidth <= maxRight - minLeft) {
          const half = barWidth / 2;
          const left = hostBounds.left + x - half;
          const right = hostBounds.left + x + half;
          if (left < minLeft) x += minLeft - left;
          if (right > maxRight) x -= right - maxRight;
        }
      }

      const next = {
        x: Math.round(x),
        y: Math.round(lastLine.bottom - hostBounds.top + (bubble ? 16 : 8)),
      };

      setAnchor((current) =>
        current.x === next.x && current.y === next.y ? current : next,
      );
      setPositioned(true);
    });
  }, [bubble]);

  useLayoutEffect(() => {
    place();
  }, [mode, place]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(place);
    observer.observe(host);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [place]);

  /* Intrinsic width handles the preset expansion. When the entire content
   * changes between idle, loading and confirmation, animate from the last
   * rendered width to the new intrinsic width before the browser paints. */
  useLayoutEffect(() => {
    const bar = barRef.current;
    const content = contentRef.current;
    if (!bar || !content) return;

    const nextWidth = Math.ceil(content.getBoundingClientRect().width) + 8;
    const previousWidth =
      lastWidthRef.current || Math.ceil(bar.getBoundingClientRect().width);

    if (
      previousModeRef.current !== mode &&
      Math.abs(nextWidth - previousWidth) > 1
    ) {
      widthAnimationRef.current?.cancel();
      const animation = bar.animate(
        [
          { width: `${previousWidth}px` },
          { width: `${nextWidth}px` },
        ],
        {
          duration: 320,
          easing: "cubic-bezier(0.23,1,0.32,1)",
        },
      );
      widthAnimationRef.current = animation;
      animation.onfinish = () => {
        lastWidthRef.current = nextWidth;
        widthAnimationRef.current = null;
      };
    } else {
      lastWidthRef.current = nextWidth;
    }

    previousModeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const observer = new ResizeObserver(() => {
      if (widthAnimationRef.current?.playState === "running") return;
      lastWidthRef.current =
        Math.ceil(content.getBoundingClientRect().width) + 8;
      /* Width changes (expand, typing, busy states) alter where the bar needs
         to be clamped — re-place so it stays fully within the container. */
      place();
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      widthAnimationRef.current?.cancel();
    };
  }, [place]);

  const run = (nextAction: string | null) => {
    setAction(nextAction ?? "");
    setExpanded(false);
    if (auto) {
      setMode("thinking");
      return;
    }
    /* Controlled mode: hold the busy state until the consumer settles so
       the bar cannot be double-fired while a turn is in flight. */
    setMode("thinking");
    try {
      const result = onAction?.(
        nextAction,
        content,
        prompt.trim() || undefined,
      ) as void | Promise<unknown>;
      if (result && typeof (result as Promise<unknown>).then === "function") {
        (result as Promise<unknown>).then(reset, reset);
      } else {
        reset();
      }
    } catch {
      reset();
    }
  };

  const reset = () => {
    setExpanded(false);
    setPrompt("");
    setTypingWidth(null);
    setAction("Improve");
    setMode("idle");
    if (!auto && !hoveredRef.current) setShown(false);
  };

  const busy = mode === "thinking" || mode === "streaming";
  /* The busy bar stays revealed even if the pointer drifts away; reset()
     re-hides it once the turn settles. */
  const visible = (shown || busy) && positioned;

  useEffect(() => {
    if (visible && !popped) setPopped(true);
  }, [visible, popped]);

  const hasPrompt = prompt.trim().length > 0;
  const busyLabel =
    action === "Improve"
      ? "正在润色"
      : action === "Shorten"
        ? "正在精简"
        : action === "Change tone"
          ? "正在调整语气"
          : "正在编辑";

  return (
    <div className={bubble ? "max-w-[70%]" : "w-full max-w-[460px]"}>
      <div
        ref={hostRef}
        className="relative pb-12"
        onMouseEnter={
          !auto && hoverCapable
            ? () => {
                hoveredRef.current = true;
                setShown(true);
              }
            : undefined
        }
        onMouseLeave={
          !auto && hoverCapable
            ? (event) => {
                hoveredRef.current = false;
                if (event.currentTarget.contains(document.activeElement))
                  return;
                setShown(false);
              }
            : undefined
        }
        onFocus={!auto ? () => setShown(true) : undefined}
        onBlur={
          !auto
            ? (event) => {
                /* Only hide when focus provably left the host — Safari
                   reports a null relatedTarget for mouse-initiated blur
                   (e.g. clicking a bar button), which must not dismiss
                   the bar before the click lands. */
                if (busy) return;
                const next = event.relatedTarget;
                if (next && !event.currentTarget.contains(next as Node)) {
                  setShown(false);
                }
              }
            : undefined
        }
        onClick={
          !auto && !hoverCapable
            ? (event) => {
                if ((event.target as HTMLElement).closest("[data-bar]")) return;
                setShown((value) => !value);
              }
            : undefined
        }
      >
        <p
          className={
            bubble
              ? "rounded-[10px] bg-accent-strong px-3 py-2 text-[13px] leading-relaxed text-white whitespace-pre-wrap"
              : "text-[13px] leading-relaxed text-ink"
          }
        >
          {lead}
          <span
            ref={selectionRef}
            className={
              bubble
                ? undefined
                : "box-decoration-clone rounded-[3px] bg-[color-mix(in_srgb,var(--accent)_14%,var(--surface))] text-ink dark:bg-accent-tint"
            }
          >
            {mode === "idle" || mode === "thinking" ? (
              content
            ) : mode === "streaming" ? (
              <StreamText
                text={REWRITE}
                onProgress={place}
                onDone={() => setMode("result")}
              />
            ) : (
              REWRITE
            )}
          </span>
        </p>

        <div
          data-bar
          className="absolute top-0 left-0 z-10"
          style={{
            transform: `translate3d(${anchor.x}px, ${anchor.y}px, 0) translateX(-50%)`,
            transition:
              "transform 320ms cubic-bezier(0.77,0,0.175,1), opacity 180ms ease-out",
            opacity: visible ? 1 : 0,
            pointerEvents: visible ? "auto" : "none",
            willChange: "transform",
          }}
        >
          {/* A 36px pill wraps 28px controls at a 4px inset. The controls
              resolve to a 14px radius, preserving the concentric curve. */}
          <div
            ref={barRef}
            className="flex h-9 w-fit max-w-[calc(100vw-48px)] select-none items-center justify-center gap-0.5 overflow-hidden rounded-full bg-surface p-1 font-sans font-normal text-ink antialiased shadow-overlay"
            style={{
              width:
                mode === "idle" && hasPrompt && typingWidth
                  ? typingWidth
                  : undefined,
              ...(visible && !popped
                ? {
                    animation:
                      "pop-in 220ms cubic-bezier(0.23,1,0.32,1) both",
                  }
                : {}),
            }}
          >
            <div
              ref={contentRef}
              className="flex w-fit shrink-0 items-center justify-center gap-0.5"
              style={{
                width:
                  mode === "idle" && hasPrompt && typingWidth
                    ? typingWidth - 8
                    : undefined,
              }}
            >
            {busy && (
              <span className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap px-2.5 text-[12.5px] font-normal text-ink-2">
                <span
                  className="size-3 shrink-0 rounded-full border-[1.5px] border-line-strong border-t-ink-2"
                  style={{ animation: "spin 700ms linear infinite" }}
                />
                {mode === "thinking" ? (
                  <Shimmer className="text-[12.5px] font-normal">
                    {busyLabel}…
                  </Shimmer>
                ) : (
                  <span>{busyLabel}…</span>
                )}
              </span>
            )}

            {mode === "result" && (
              <>
                <button
                  type="button"
                  onClick={reset}
                  className={primary}
                >
                  {icons.check}
                  保留
                </button>
                <button type="button" onClick={reset} className={control}>
                  {icons.close}
                  放弃
                </button>
                <span className="mx-0.5 h-4 w-px shrink-0 bg-line" />
                <button
                  type="button"
                  aria-label="重试"
                  onClick={() => run(action)}
                  className="flex size-7 shrink-0 items-center justify-center rounded-full text-ink-3 transition-[background-color,color,transform] duration-150 hover:bg-hover-2 hover:text-ink-2 active:scale-[0.96]"
                >
                  {icons.retry}
                </button>
              </>
            )}

            {mode === "idle" && (
              <>
                <div
                  className="flex min-w-0 items-center overflow-hidden transition-[max-width,opacity,transform] duration-400"
                  style={{
                    maxWidth: expanded
                      ? 0
                      : hasPrompt && typingWidth
                        ? typingWidth - 40
                        : 145,
                    opacity: expanded ? 0 : 1,
                    transform: expanded ? "translateX(-8px)" : "translateX(0)",
                    transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)",
                  }}
                >
                  <form
                    className="flex h-7 shrink-0 items-center transition-[width] duration-400"
                    style={{
                      width:
                        hasPrompt && typingWidth ? typingWidth - 40 : 145,
                      transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)",
                    }}
                    onSubmit={(event) => {
                      event.preventDefault();
                      run(prompt.trim() ? null : "Improve");
                    }}
                  >
                    <input
                      value={prompt}
                      onChange={(event) => {
                        const next = event.target.value;
                        if (!prompt.trim() && next.trim()) {
                          setTypingWidth(
                            Math.ceil(
                              barRef.current?.getBoundingClientRect().width ??
                                0,
                            ),
                          );
                        } else if (!next.trim()) {
                          setTypingWidth(null);
                        }
                        setPrompt(next);
                      }}
                      aria-label="描述修改要求"
                      placeholder="描述修改要求"
                      className="h-7 w-full bg-transparent pr-2.5 pl-3 text-[12.5px] text-ink placeholder:text-ink-3"
                    />
                  </form>
                </div>

                <div
                  className="flex min-w-0 items-center gap-0.5 overflow-hidden transition-[max-width,opacity,transform] duration-400"
                  style={{
                    maxWidth: hasPrompt ? 0 : expanded ? 462 : 224,
                    opacity: hasPrompt ? 0 : 1,
                    transform: hasPrompt ? "translateX(-8px)" : "translateX(0)",
                    transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)",
                  }}
                >
                  {!expanded && (
                    <span className="mx-1 h-4 w-px shrink-0 bg-line-strong" />
                  )}
                  <button
                    type="button"
                    onClick={() => run("Explain")}
                    className={control}
                  >
                    {icons.explain}
                    解释
                  </button>
                  <button
                    type="button"
                    onClick={() => run("Improve")}
                    className={control}
                  >
                    {icons.improve}
                    润色
                  </button>

                  <div
                    className="flex min-w-0 items-center gap-0.5 overflow-hidden transition-[max-width,opacity,margin] duration-400"
                    style={{
                      maxWidth: expanded ? 262 : 0,
                      opacity: expanded ? 1 : 0,
                      marginLeft: expanded ? 2 : 0,
                      transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)",
                    }}
                  >
                  <button
                    type="button"
                    onClick={() => run("Shorten")}
                    className={control}
                  >
                    {icons.shorten}
                    精简
                  </button>
                  <button
                    type="button"
                    onClick={() => run("Change tone")}
                    className={control}
                  >
                    {icons.tone}
                    语气
                  </button>
                  <button
                    type="button"
                    onClick={() => run("Fix grammar")}
                    className={control}
                  >
                    {icons.grammar}
                    语法
                  </button>
                  </div>

                  <span className="mx-0.5 h-4 w-px shrink-0 bg-line" />
                  <button
                    type="button"
                    aria-label={expanded ? "显示更少操作" : "显示更多操作"}
                    aria-expanded={expanded}
                    onClick={() => setExpanded((value) => !value)}
                    className="flex size-7 shrink-0 items-center justify-center rounded-full text-ink transition-[background-color,transform] duration-200 hover:bg-hover active:scale-[0.96]"
                  >
                    <span
                      className="flex transition-transform duration-400"
                      style={{
                        transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
                        transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)",
                      }}
                    >
                      {icons.chevron}
                    </span>
                  </button>
                </div>

                <div
                  className="flex min-w-0 items-center overflow-hidden transition-[max-width,opacity,transform] duration-400"
                  style={{
                    maxWidth: hasPrompt ? 30 : 0,
                    opacity: hasPrompt ? 1 : 0,
                    transform: hasPrompt ? "scale(1)" : "scale(0.88)",
                    transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)",
                  }}
                >
                  <button
                    type="button"
                    aria-label="发送修改指令"
                    onClick={() => run(null)}
                    className="flex size-7 shrink-0 items-center justify-center rounded-full bg-ink text-surface transition-[opacity,transform] duration-200 active:scale-[0.94]"
                  >
                    {icons.send}
                  </button>
                </div>
              </>
            )}
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
