import SelectionActions from "../bui/SelectionActions";
import { useMessageSend } from "./registry";
import type { ChatMessage } from "../../types";

/* SelectionActions reports the picked preset by English key (independent of
   the Chinese button label); map the key to a verb for the follow-up
   instruction sent to the model. */
const ACTION_LABELS: Record<string, string> = {
  Explain: "解释",
  Improve: "润色",
  Shorten: "精简",
  "Change tone": "调整语气",
  "Fix grammar": "修正语法",
};

interface UserMessageProps {
  message: ChatMessage;
}

export default function UserMessage({ message }: UserMessageProps) {
  const send = useMessageSend();
  const content = message.content ?? "";

  /* With the app send hook wired in, the message renders through
     SelectionActions in bubble mode — a solid accent bubble with the
     action bar (revealed on hover, or tap on touch) letting the user
     explain/improve/shorten it via a follow-up turn. The returned promise
     keeps the bar busy until the turn completes. Messages without text
     keep the plain bubble. */
  if (send && content.trim()) {
    return (
      <div className="flex justify-end">
        <SelectionActions
          text={content}
          auto={false}
          bubble
          onAction={(action, selected, prompt) =>
            send(
              prompt
                ? `请修改这段内容：\n"${selected}"\n要求：${prompt}`
                : `请${ACTION_LABELS[action ?? ""] ?? action}这段内容：\n"${selected}"`,
            )
          }
        />
      </div>
    );
  }

  return (
    <div className="flex justify-end">
      <div className="max-w-[70%] rounded-[10px] bg-accent-strong px-3 py-2 text-[13px] leading-relaxed text-white whitespace-pre-wrap">
        {content}
      </div>
    </div>
  );
}
