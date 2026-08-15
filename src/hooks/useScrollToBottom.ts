import { useRef, useState, useEffect, useCallback } from "react";
import { useUpdateEffect } from "ahooks";
import type { ChatMessage } from "../types";

export function useScrollToBottom(
  messages: ChatMessage[],
  streamingContent: string | null,
  streamingReasoning: string | null,
  currentSessionId: string | null,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const [hasUnreadMessages, setHasUnreadMessages] = useState(false);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    isNearBottomRef.current = true;
    setHasUnreadMessages(false);
    bottomRef.current?.scrollIntoView({ behavior, block: "end" });
  }, []);

  const handleMessageScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const isNearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < 80;
    isNearBottomRef.current = isNearBottom;
    if (isNearBottom) setHasUnreadMessages(false);
  }, []);

  // Auto-scroll when messages or streaming content changes
  useUpdateEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (isNearBottomRef.current) {
        scrollToBottom("auto");
      } else {
        setHasUnreadMessages(true);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, streamingContent, streamingReasoning, scrollToBottom]);

  // Scroll to bottom on session switch
  useEffect(() => {
    const frame = requestAnimationFrame(() => scrollToBottom("auto"));
    return () => cancelAnimationFrame(frame);
  }, [currentSessionId, scrollToBottom]);

  return {
    containerRef,
    bottomRef,
    hasUnreadMessages,
    scrollToBottom,
    handleMessageScroll,
    isNearBottomRef,
  };
}
