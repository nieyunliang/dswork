import { useEffect, useMemo, useRef, useState } from "react";

/* One-shot word streaming — reveals `text` word by word with the
 * stream-in keyframe from bui/tokens.css, fires onProgress per word
 * and onDone once complete. */

export function StreamText({
  text,
  wordMs = 28,
  onProgress,
  onDone,
  className = "",
}: {
  text: string;
  wordMs?: number;
  onProgress?: () => void;
  onDone?: () => void;
  className?: string;
}) {
  const words = useMemo(() => text.split(" "), [text]);
  const [count, setCount] = useState(0);
  const done = count >= words.length;

  // Latest callbacks via ref so timer cadence never depends on parent renders
  const cbRef = useRef({ onProgress, onDone });
  cbRef.current = { onProgress, onDone };

  useEffect(() => {
    setCount(0);
  }, [text]);

  useEffect(() => {
    if (done) {
      cbRef.current.onDone?.();
      return;
    }
    const t = setTimeout(() => {
      setCount((c) => c + 1);
      cbRef.current.onProgress?.();
    }, wordMs);
    return () => clearTimeout(t);
  }, [done, wordMs]);

  return (
    <span className={className}>
      {words.slice(0, count).map((word, i) => (
        <span
          key={`${i}-${word}`}
          className="inline [will-change:filter,opacity]"
          style={{
            animation: "stream-in 420ms cubic-bezier(0.22,0.61,0.25,1) both",
          }}
        >
          {word}{" "}
        </span>
      ))}
      {!done && (
        <span
          className="ml-0.5 inline-block h-3 w-0.5 translate-y-0.5 rounded-full bg-ink"
          style={{ animation: "fade-in 150ms ease-out both" }}
        />
      )}
    </span>
  );
}
