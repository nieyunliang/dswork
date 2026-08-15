import { useEffect, useState } from "react";
import { EditPencil, Trash } from "iconoir-react";
import { App as AntdApp, Button, Input, Modal } from "antd";
import SidebarNav, {
  type MenuItem,
  type NavItem,
  type NavSection,
} from "./bui/SidebarNav";
import type { SessionSummary } from "../types";

interface SessionListProps {
  collapsed: boolean;
  onCollapse: (collapsed: boolean) => void;
  sessions: SessionSummary[];
  currentSessionId: string | null;
  onNewSession: () => void;
  onSwitchSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, name: string) => void;
}

function formatRelativeTime(unixSecs: number): string {
  const now = Date.now() / 1000;
  const diff = now - unixSecs;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)} 天前`;
  return new Date(unixSecs * 1000).toLocaleDateString("zh-CN");
}

/* Sessions are laid out flat, grouped by how recent they are. */
const DATE_GROUPS = ["今天", "昨天", "7 天内", "30 天内", "更早"] as const;

function dateGroupLabel(unixSecs: number): string {
  const diff = Date.now() / 1000 - unixSecs;
  if (diff < 86400) return "今天";
  if (diff < 86400 * 2) return "昨天";
  if (diff < 86400 * 7) return "7 天内";
  if (diff < 86400 * 30) return "30 天内";
  return "更早";
}

const iconProps = {
  width: 12,
  height: 12,
  strokeWidth: 1.8,
  "aria-hidden": true,
} as const;

export default function SessionList({
  collapsed,
  onCollapse,
  sessions,
  currentSessionId,
  onNewSession,
  onSwitchSession,
  onDeleteSession,
  onRenameSession,
}: SessionListProps) {
  const { message, modal } = AntdApp.useApp();
  const [modalState, setModalState] = useState<
    | { type: "rename-session"; session: SessionSummary }
    | null
  >(null);
  const [modalName, setModalName] = useState("");
  const [confirmLoading, setConfirmLoading] = useState(false);

  // Re-render every minute so relative timestamps ("X 分钟前") stay fresh even
  // while the sidebar is otherwise idle.
  const [, setNow] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const handleModalOk = async () => {
    const name = modalName.trim();
    if (!name) {
      message.warning("请输入会话名称");
      return;
    }
    if (modalState?.type === "rename-session" && modalState.session.title === name) {
      setModalState(null);
      return;
    }
    setConfirmLoading(true);
    try {
      if (modalState?.type === "rename-session") {
        await onRenameSession(modalState.session.id, name);
      }
      setModalState(null);
    } catch (e) {
      message.error(String(e));
    } finally {
      setConfirmLoading(false);
    }
  };

  const items: NavItem[] = sessions.map((s) => ({
    key: s.id,
    label: s.title,
    meta: formatRelativeTime(s.updatedAt),
    icon: "chat",
    sectionKey: dateGroupLabel(s.updatedAt),
  }));

  // Only groups that actually have sessions render, in recency order.
  const navSections: NavSection[] = DATE_GROUPS.filter((label) =>
    items.some((i) => i.sectionKey === label),
  ).map((label) => ({ key: label, label }));

  const confirmDelete = (key: string) => {
    const session = sessions.find((s) => s.id === key);
    modal.confirm({
      title: `删除会话「${session?.title ?? ""}」`,
      content: "删除后无法恢复。确定删除吗？",
      okText: "删除",
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await onDeleteSession(key);
        } catch (e) {
          message.error(String(e));
          throw e;
        }
      },
    });
  };

  const itemMenu = (key: string): MenuItem[] => {
    const session = sessions.find((s) => s.id === key);
    return [
      {
        key: "rename",
        label: "重命名",
        icon: <EditPencil {...iconProps} />,
        onClick: () => {
          if (session) {
            setModalName(session.title === "新对话" ? "" : session.title);
            setModalState({ type: "rename-session", session });
          }
        },
      },
      { key: "divider-delete", type: "divider" },
      {
        key: "delete",
        label: "删除会话",
        danger: true,
        icon: <Trash {...iconProps} />,
        onClick: () => confirmDelete(key),
      },
    ];
  };

  return (
    <>
      <SidebarNav
        demo={false}
        collapsed={collapsed}
        onToggleCollapse={() => onCollapse(!collapsed)}
        workspaceTitle="dswork"
        workspaceSub="DeepSeek 工作区"
        accentLabel="新对话"
        onAccent={onNewSession}
        items={items}
        activeKey={currentSessionId ?? ""}
        onSelectItem={onSwitchSession}
        sections={navSections}
        itemMenu={itemMenu}
      />

      <Modal
        open={modalState !== null}
        title="重命名会话"
        width={360}
        onCancel={() => setModalState(null)}
        footer={
          <>
            <Button onClick={() => setModalState(null)}>取消</Button>
            <Button type="primary" loading={confirmLoading} onClick={handleModalOk}>
              确定
            </Button>
          </>
        }
      >
        <Input
          id="session-name-input"
          aria-label="会话名称"
          placeholder="输入会话名称"
          value={modalName}
          maxLength={30}
          autoFocus
          onChange={(e) => setModalName(e.target.value)}
          onPressEnter={handleModalOk}
          variant="filled"
        />
      </Modal>
    </>
  );
}
