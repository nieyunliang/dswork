import { createContext, useContext, type ComponentType } from "react";
import type { ChatMessage } from "./types";

type MessageComponent = ComponentType<{ message: ChatMessage }>;

const registry: Record<string, MessageComponent> = {};

export function register(role: string, component: MessageComponent) {
  registry[role] = component;
}

export function getComponent(role: string): MessageComponent | undefined {
  return registry[role];
}

/* Optional send access for message renderers (e.g. SelectionActions on the
   user bubble). Provided by the app shell around the message list. When a
   promise is returned, it settles once the turn completes — callers can
   hold their busy state until then. */
export const MessageSendContext = createContext<
  ((text: string) => void | Promise<unknown>) | null
>(null);

export function useMessageSend(): ((
  text: string,
) => void | Promise<unknown>) | null {
  return useContext(MessageSendContext);
}
