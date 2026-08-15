import { useEffect, useState } from "react";
import { App as AntdApp, Button, Input, Modal, Typography } from "antd";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

const { Text } = Typography;

interface CwdModalProps {
  open: boolean;
  /** 当前会话工作目录（绝对路径） */
  cwd: string;
  onClose: () => void;
  /** 保存（后端校验目录存在性；失败时抛出，由本组件提示） */
  onSave: (cwd: string) => Promise<void>;
}

/** 会话工作目录选择弹窗：手动输入（支持 ~/...）或原生目录选择器浏览。 */
export default function CwdModal({ open, cwd, onClose, onSave }: CwdModalProps) {
  const { message } = AntdApp.useApp();
  const [value, setValue] = useState(cwd);
  const [saving, setSaving] = useState(false);

  // 每次打开时同步当前值
  useEffect(() => {
    if (open) {
      setValue(cwd);
      setSaving(false);
    }
  }, [open, cwd]);

  const handleBrowse = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "选择工作目录",
        defaultPath: value || cwd || undefined,
      });
      if (selected && typeof selected === "string") {
        setValue(selected);
      }
    } catch (e) {
      message.error(String(e));
    }
  };

  const handleSave = async () => {
    const next = value.trim();
    if (!next) {
      message.warning("请输入工作目录路径");
      return;
    }
    if (next === cwd) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      await onSave(next);
      message.success("工作目录已更新");
      onClose();
    } catch (e) {
      message.error(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title="设置工作目录"
      width={440}
      onCancel={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={saving} onClick={handleSave}>
            确定
          </Button>
        </>
      }
    >
      <Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>
        会话内运行 Shell 命令与解析相对路径的工作目录
      </Text>
      <div style={{ display: "flex", gap: 8 }}>
        <Input
          id="cwd-input"
          aria-label="工作目录路径"
          placeholder="输入路径（支持 ~/...），或点击浏览选择目录"
          value={value}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onPressEnter={handleSave}
          variant="filled"
        />
        <Button onClick={handleBrowse}>浏览…</Button>
      </div>
    </Modal>
  );
}
