import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { useLocalStorageState, useMemoizedFn } from "ahooks";

export type ThemeMode = "system" | "light" | "dark";

interface ThemeContextType {
  isDark: boolean;
  mode: ThemeMode;
  cycleMode: () => void;
}

const THEME_MODES: ThemeMode[] = ["system", "light", "dark"];

const ThemeContext = createContext<ThemeContextType | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode = "system", setMode] = useLocalStorageState<ThemeMode>("dswork-theme", {
    defaultValue: "system",
  });
  const [systemIsDark, setSystemIsDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setSystemIsDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const isDark = mode === "system" ? systemIsDark : mode === "dark";

  // Drive the bui token layer: tokens.css defines the dark palette in `.dark`
  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
    document.documentElement.style.colorScheme = isDark ? "dark" : "light";
    // keep the theme-color meta in sync with the page background
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", isDark ? "#17181a" : "#fafafb");
  }, [isDark]);

  const cycleMode = useMemoizedFn(() => {
    const idx = THEME_MODES.indexOf(mode);
    setMode(THEME_MODES[(idx + 1) % THEME_MODES.length]);
  });

  return (
    <ThemeContext.Provider value={{ isDark, mode, cycleMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextType {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
