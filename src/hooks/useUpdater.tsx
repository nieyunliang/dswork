import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdaterStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "error"
  | "upToDate";

export interface UpdateInfo {
  version: string;
  date?: string;
  body?: string;
}

export interface DownloadProgress {
  downloaded: number;
  total: number;
  /** 服务端未给出总大小时为 null，UI 显示不确定进度 */
  percent: number | null;
}

interface UpdaterContextType {
  status: UpdaterStatus;
  updateInfo: UpdateInfo | null;
  error: string | null;
  progress: DownloadProgress | null;
  /** silent=true 时失败/无更新不产生打扰性状态（自动检查用） */
  checkForUpdates: (silent?: boolean) => Promise<void>;
  installUpdate: () => Promise<void>;
  dismiss: () => void;
}

const FIRST_CHECK_DELAY_MS = 5000;
const AUTO_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 小时

const UpdaterContext = createContext<UpdaterContextType | null>(null);

export function UpdaterProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<UpdaterStatus>("idle");
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);

  // Update 是资源句柄，跨回调保存；progress 用 ref 避免闭包读到旧值
  const pendingUpdateRef = useRef<Update | null>(null);
  const progressRef = useRef<DownloadProgress | null>(null);

  const applyProgress = useCallback((p: DownloadProgress) => {
    progressRef.current = p;
    setProgress(p);
  }, []);

  const checkForUpdates = useCallback(async (silent = false) => {
    setError(null);
    setStatus("checking");
    try {
      const update = await check({ timeout: 15000 });
      if (update) {
        pendingUpdateRef.current = update;
        setUpdateInfo({
          version: update.version,
          date: update.date,
          body: update.body,
        });
        setStatus("available");
      } else {
        pendingUpdateRef.current = null;
        setStatus(silent ? "idle" : "upToDate");
      }
    } catch (e) {
      pendingUpdateRef.current = null;
      setError(e instanceof Error ? e.message : String(e));
      setStatus(silent ? "idle" : "error");
    }
  }, []);

  const installUpdate = useCallback(async () => {
    const update = pendingUpdateRef.current;
    if (!update) return;
    setError(null);
    progressRef.current = null;
    setProgress(null);
    setStatus("downloading");
    applyProgress({ downloaded: 0, total: 0, percent: null });
    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started": {
            const total = event.data.contentLength ?? 0;
            applyProgress({
              downloaded: 0,
              total,
              percent: total > 0 ? 0 : null,
            });
            break;
          }
          case "Progress": {
            const prev = progressRef.current;
            const downloaded = (prev?.downloaded ?? 0) + event.data.chunkLength;
            const total = prev?.total ?? 0;
            applyProgress({
              downloaded,
              total,
              percent:
                total > 0
                  ? Math.min(100, Math.round((downloaded / total) * 100))
                  : null,
            });
            break;
          }
          case "Finished":
            break;
        }
      });
      setStatus("downloaded");
      // 重启以完成安装；Windows 上 NSIS 安装器可能已关闭应用进程，relaunch 失败属预期
      try {
        await relaunch();
      } catch {
        // 应用进程仍在（如安装器未接管），用户可手动重启
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, [applyProgress]);

  // 启动后延迟静默检查一次，之后每 4 小时自动检查
  useEffect(() => {
    let disposed = false;
    const first = setTimeout(() => {
      if (!disposed) void checkForUpdates(true);
    }, FIRST_CHECK_DELAY_MS);
    const interval = setInterval(() => {
      if (!disposed) void checkForUpdates(true);
    }, AUTO_CHECK_INTERVAL_MS);
    return () => {
      disposed = true;
      clearTimeout(first);
      clearInterval(interval);
    };
  }, [checkForUpdates]);

  const dismiss = useCallback(() => {
    setStatus("idle");
    setError(null);
  }, []);

  return (
    <UpdaterContext.Provider
      value={{
        status,
        updateInfo,
        error,
        progress,
        checkForUpdates,
        installUpdate,
        dismiss,
      }}
    >
      {children}
    </UpdaterContext.Provider>
  );
}

export function useUpdater(): UpdaterContextType {
  const ctx = useContext(UpdaterContext);
  if (!ctx) throw new Error("useUpdater must be used within an UpdaterProvider");
  return ctx;
}
