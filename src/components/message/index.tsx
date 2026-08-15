import { memo } from "react";
import { Divider } from "antd";
import type { ChatMessage } from "../../types";
import { register, getComponent } from "./registry";
import UserMessage from "./UserMessage";
import AssistantMessage from "./AssistantMessage";
import ToolMessage from "./ToolMessage";
import SystemMessage from "./SystemMessage";

register("user", UserMessage);
register("assistant", AssistantMessage);
register("tool", ToolMessage);
register("system", SystemMessage);

interface MessageProps {
  message: ChatMessage;
}

function UnknownMessage({ message }: { message: ChatMessage }) {
  return <Divider>{message.role}</Divider>;
}

export default memo(function Message({ message }: MessageProps) {
  const Component = getComponent(message.role) ?? UnknownMessage;
  return <Component message={message} />;
});
