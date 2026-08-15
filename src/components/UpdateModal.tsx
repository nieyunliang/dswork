import { Alert, Button, Flex, Modal, Progress, Spin, Typography } from "antd";
import { relaunch } from "@tauri-apps/plugin-process";
import { useUpdater } from "../hooks/useUpdater";

const { Text } = Typography;

interface UpdateModalProps {
  open: boolean;
  onClose: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 MB";
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function UpdateModal({ open, onClose }: UpdateModalProps) {
  const { status, updateInfo, error, progress, checkForUpdates, installUpdate } =
    useUpdater();

  let title = "检查更新";
  let content: React.ReactNode = null;
  let footer: React.ReactNode = null;

  switch (status) {
    case "checking":
      content = (
        <Flex gap={12} align="center">
          <Spin size="small" />
          <Text type="secondary">正在检查更新…</Text>
        </Flex>
      );
      break;

    case "available":
      title = `发现新版本 v${updateInfo?.version ?? ""}`;
      content = (
        <Flex vertical gap={12}>
          {updateInfo?.date && (
            <Text type="secondary">
              发布日期：{new Date(updateInfo.date).toLocaleDateString()}
            </Text>
          )}
          <div
            style={{
              maxHeight: 240,
              overflowY: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontSize: 13,
              lineHeight: 1.6,
              background: "var(--surface, #fafafa)",
              borderRadius: 8,
              padding: "8px 12px",
            }}
          >
            {updateInfo?.body?.trim() || "本次更新没有提供说明。"}
          </div>
        </Flex>
      );
      footer = (
        <Flex justify="flex-end" gap={8}>
          <Button onClick={onClose}>稍后</Button>
          <Button type="primary" onClick={() => void installUpdate()}>
            立即更新
          </Button>
        </Flex>
      );
      break;

    case "downloading":
      title = "正在下载更新";
      content = (
        <Flex vertical gap={12}>
          {progress?.percent != null ? (
            <Progress
              percent={progress.percent}
              status="active"
              format={(p) => `${p}%`}
            />
          ) : (
            <Flex gap={12} align="center">
              <Spin size="small" />
              <Text type="secondary">正在连接下载…</Text>
            </Flex>
          )}
          <Text type="secondary">
            {progress
              ? `已下载 ${formatBytes(progress.downloaded)}${
                  progress.total > 0 ? ` / ${formatBytes(progress.total)}` : ""
                }`
              : ""}
          </Text>
          <Text type="secondary">下载完成后将自动重启应用完成安装。</Text>
        </Flex>
      );
      footer = (
        <Flex justify="flex-end">
          <Button onClick={onClose}>后台下载</Button>
        </Flex>
      );
      break;

    case "downloaded":
      title = "更新已安装";
      content = (
        <Flex vertical gap={12}>
          <Flex gap={12} align="center">
            <Spin size="small" />
            <Text>更新已安装，正在重启应用…</Text>
          </Flex>
          <Text type="secondary">
            若应用未自动重启，请点击下方按钮手动重启。
          </Text>
        </Flex>
      );
      footer = (
        <Flex justify="flex-end" gap={8}>
          <Button onClick={onClose}>稍后重启</Button>
          <Button
            type="primary"
            onClick={() => void relaunch().catch(() => {})}
          >
            立即重启
          </Button>
        </Flex>
      );
      break;

    case "upToDate":
      title = "检查更新";
      content = (
        <Alert type="success" title="已是最新版本" showIcon />
      );
      footer = (
        <Flex justify="flex-end">
          <Button type="primary" onClick={onClose}>
            知道了
          </Button>
        </Flex>
      );
      break;

    case "error":
      title = "更新失败";
      content = (
        <Alert
          type="error"
          title={error ? `更新失败：${error}` : "更新失败，请稍后重试"}
          showIcon
        />
      );
      footer = (
        <Flex justify="flex-end" gap={8}>
          <Button onClick={onClose}>关闭</Button>
          <Button type="primary" onClick={() => void checkForUpdates()}>
            重试
          </Button>
        </Flex>
      );
      break;

    case "idle":
    default:
      content = null;
      footer = (
        <Flex justify="flex-end">
          <Button onClick={onClose}>关闭</Button>
        </Flex>
      );
      break;
  }

  return (
    <Modal
      title={title}
      open={open}
      onCancel={onClose}
      footer={footer}
      width={440}
    >
      {content}
    </Modal>
  );
}
