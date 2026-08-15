import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { useMount } from "ahooks";
import { invoke } from "@tauri-apps/api/core";
import type { Skill, SkillSummary } from "../types";

interface SkillsContextType {
  skills: SkillSummary[];
  loading: boolean;
  refreshSkills: () => Promise<void>;
  getSkill: (name: string) => Promise<Skill>;
}

const SkillsContext = createContext<SkillsContextType | null>(null);

export function SkillsProvider({ children }: { children: ReactNode }) {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const refreshSkills = useCallback(async () => {
    const list = await invoke<SkillSummary[]>("list_skills");
    setSkills(list);
  }, []);

  const getSkill = useCallback(async (name: string): Promise<Skill> => {
    return await invoke<Skill>("get_skill", { name });
  }, []);

  useMount(() => {
    refreshSkills().finally(() => setLoading(false));
  });

  return (
    <SkillsContext.Provider value={{ skills, loading, refreshSkills, getSkill }}>
      {children}
    </SkillsContext.Provider>
  );
}

export function useSkills(): SkillsContextType {
  const ctx = useContext(SkillsContext);
  if (!ctx) {
    throw new Error("useSkills must be used within a SkillsProvider");
  }
  return ctx;
}
