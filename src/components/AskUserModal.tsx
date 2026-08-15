import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import ApprovalCard from "./bui/ApprovalCard";

export default function AskUserModal() {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    const unlisten = listen<string>("ask-user", (event) => {
      setQuestion(event.payload);
      setOpen(true);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  /* stable identity while the user types; changes on each new question */
  const questions = useMemo(
    () => [{ q: question, type: "text" as const }],
    [question],
  );

  const handleSubmit = useCallback(
    async (answers: string[]) => {
      if (resolving) return;
      setResolving(true);
      try {
        await invoke("answer_user", { answer: answers[0] ?? "" });
        setOpen(false);
      } catch {
        setOpen(false);
      } finally {
        setResolving(false);
      }
    },
    [resolving],
  );

  const handleCancel = useCallback(async () => {
    try {
      await invoke("answer_user", { answer: "" });
    } catch {
      // ignore
    }
    setOpen(false);
  }, []);

  return (
    <ApprovalCard
      open={open}
      onOpenChange={setOpen}
      title="🤖 LLM 需要你的输入"
      questions={questions}
      onSubmit={handleSubmit}
      onCancel={handleCancel}
    />
  );
}
