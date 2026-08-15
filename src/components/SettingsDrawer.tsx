import { useState, useEffect } from "react";
import { Download, Refresh, Trash } from "iconoir-react";
import {
  Alert,
  App as AntdApp,
  Button,
  Divider,
  Drawer,
  Flex,
  Input,
  Select,
  Tag,
  Typography,
} from "antd";
import { getVersion } from "@tauri-apps/api/app";
import { useDeepSeekConfig } from "../hooks/useDeepSeekConfig";
import { useUpdater } from "../hooks/useUpdater";
import type { TestConnectionResult } from "../types";
import {
  DEFAULT_DEEPSEEK_MODEL,
  DEEPSEEK_MODEL_OPTIONS,
} from "../modelOptions";

const { Text } = Typography;

interface SettingsDrawerProps {
  open: boolean;
  onClose: () => void;
  /** 打开更新弹窗并触发检查 */
  onCheckUpdates: () => void;
}

const statusLabel: Record<
  string,
  { tone: "default" | "success" | "error"; label: string }
> = {
  missing: { tone: "error", label: "未配置" },
  saved: { tone: "default", label: "已保存" },
  valid: { tone: "success", label: "连接成功" },
  invalid: { tone: "error", label: "连接失败" },
};

export default function SettingsDrawer({
  open,
  onClose,
  onCheckUpdates,
}: SettingsDrawerProps) {
  const { modal } = AntdApp.useApp();
  const { config, saveConfig, testConnection, clearApiKey } =
    useDeepSeekConfig();
  const { status: updaterStatus, updateInfo } = useUpdater();

  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.deepseek.com");
  const [model, setModel] = useState(DEFAULT_DEEPSEEK_MODEL);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [changed, setChanged] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (open && config) {
      setBaseUrl(config.baseUrl);
      setModel(config.model);
      setApiKey("");
      setTestResult(null);
      setChanged(false);
    }
  }, [open, config]);

  function handleFieldChange() {
    setChanged(true);
    setTestResult(null);
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      let result: TestConnectionResult;
      if (apiKey.trim()) {
        result = await testConnection({ baseUrl, model, apiKey });
      } else if (config?.hasApiKey) {
        result = await testConnection();
      } else {
        result = { success: false, message: "请输入 API Key" };
      }
      setTestResult(result);
    } catch (e) {
      setTestResult({ success: false, message: `测试连接失败: ${e}` });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    if (!apiKey.trim() && config?.hasApiKey) {
      setSaving(true);
      try {
        await saveConfig({
          baseUrl,
          model,
          status: "saved",
        });
        setChanged(false);
      } catch {
        // save error handled by context
      } finally {
        setSaving(false);
      }
      return;
    }

    if (!apiKey.trim()) return;
    setSaving(true);
    try {
      await saveConfig({
        baseUrl,
        model,
        apiKey,
        status: testResult?.success ? "valid" : "saved",
        lastTestedAt: testResult?.success
          ? new Date().toISOString()
          : undefined,
      });
      setChanged(false);
      setApiKey("");
    } catch {
      // save error handled by context
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    setClearing(true);
    try {
      await clearApiKey();
      setApiKey("");
      setBaseUrl("https://api.deepseek.com");
      setModel(DEFAULT_DEEPSEEK_MODEL);
      setTestResult(null);
      setChanged(false);
    } catch {
      // clear error handled by context
    } finally {
      setClearing(false);
    }
  }

  const currentStatus = config
    ? statusLabel[config.status] ?? { tone: "default" as const, label: config.status }
    : null;

  return (
    <Drawer
      title="DeepSeek API 配置"
      open={open}
      onClose={onClose}
      size={400}
      footer={
        <Flex gap={8}>
          <Button onClick={onClose}>取消</Button>
          <Button onClick={handleTest} loading={testing}>
            测试连接
          </Button>
          <Button
            type="primary"
            onClick={handleSave}
            loading={saving}
            disabled={!changed && !apiKey.trim()}
          >
            保存
          </Button>
        </Flex>
      }
    >
      <Flex vertical gap={16}>
        {currentStatus && (
          <Flex gap={8} align="center">
            <Text strong>状态:</Text>
            <Tag color={currentStatus.tone === "default" ? undefined : currentStatus.tone}>
              {currentStatus.label}
            </Tag>
          </Flex>
        )}

        <div>
          <Text strong>API Key</Text>
          <div className="mt-1">
            <Input.Password
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                handleFieldChange();
              }}
              placeholder={
                config?.hasApiKey ? "已保存密钥，输入以替换" : "输入 DeepSeek API Key"
              }
              aria-label="API Key"
              name="apiKey"
              autoComplete="off"
              spellCheck={false}
              variant="filled"
            />
          </div>
          {config?.hasApiKey && (
            <Button
              type="link"
              danger
              size="small"
              icon={<Trash width={12} height={12} strokeWidth={1.8} aria-hidden="true" />}
              onClick={() => {
                modal.confirm({
                  title: "清除已保存的密钥",
                  content: "清除后需要重新输入 API Key 才能使用。确定清除吗？",
                  okText: "清除",
                  okButtonProps: { danger: true },
                  onOk: handleClear,
                });
              }}
              loading={clearing}
              style={{ marginTop: 4 }}
            >
              清除已保存的密钥
            </Button>
          )}
        </div>

        <div>
          <Text strong>Base URL</Text>
          <div className="mt-1">
            <Input
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                handleFieldChange();
              }}
              placeholder="https://api.deepseek.com"
              aria-label="Base URL"
              name="baseUrl"
              autoComplete="off"
              variant="filled"
            />
          </div>
        </div>

        <div>
          <Text strong>模型</Text>
          <div className="mt-1">
            <Select
              value={model}
              onChange={(v) => {
                setModel(v);
                handleFieldChange();
              }}
              options={DEEPSEEK_MODEL_OPTIONS}
              aria-label="模型"
              placeholder="请选择"
              variant="filled"
            />
          </div>
        </div>

        <Divider />

        <Button
          onClick={handleTest}
          icon={<Refresh width={13} height={13} strokeWidth={1.8} aria-hidden="true" />}
          loading={testing}
          block
        >
          测试连接
        </Button>

        {testResult && (
          <Alert
            type={testResult.success ? "success" : "error"}
            title={testResult.message}
          />
        )}

        <Divider />

        <Flex vertical gap={8}>
          <Text strong>关于与更新</Text>
          <Text type="secondary">当前版本 v{version || "-"}</Text>
          <Flex gap={8} align="center">
            <Button
              icon={<Download width={13} height={13} strokeWidth={1.8} aria-hidden="true" />}
              loading={updaterStatus === "checking"}
              onClick={onCheckUpdates}
            >
              检查更新
            </Button>
            {updaterStatus === "available" && updateInfo && (
              <Tag color="success">有新版本 v{updateInfo.version}</Tag>
            )}
          </Flex>
        </Flex>
      </Flex>
    </Drawer>
  );
}
