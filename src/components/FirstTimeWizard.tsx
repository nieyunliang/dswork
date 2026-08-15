import { useState, useEffect } from "react";
import { CheckCircle, Key } from "iconoir-react";
import {
  Alert,
  Button,
  Flex,
  Input,
  Modal,
  Select,
  Steps,
  Typography,
} from "antd";
import { useDeepSeekConfig } from "../hooks/useDeepSeekConfig";
import {
  DEFAULT_DEEPSEEK_MODEL,
  DEEPSEEK_MODEL_OPTIONS,
} from "../modelOptions";

const { Text } = Typography;

interface FirstTimeWizardProps {
  open: boolean;
  onClose: () => void;
  onFinish: () => void;
}

export default function FirstTimeWizard({
  open,
  onClose,
  onFinish,
}: FirstTimeWizardProps) {
  const { saveConfig, testConnection } = useDeepSeekConfig();

  const [step, setStep] = useState(0);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.deepseek.com");
  const [model, setModel] = useState(DEFAULT_DEEPSEEK_MODEL);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setStep(0);
      setApiKey("");
      setBaseUrl("https://api.deepseek.com");
      setModel(DEFAULT_DEEPSEEK_MODEL);
      setTestResult(null);
    }
  }, [open]);

  const canNext = step === 0 ? apiKey.trim().length > 0 : true;

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testConnection({ baseUrl, model, apiKey });
      setTestResult(result);
    } catch (e) {
      setTestResult({ success: false, message: `测试连接失败: ${e}` });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
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
      onFinish();
      onClose();
    } catch {
      // save error handled by context
    } finally {
      setSaving(false);
    }
  }

  const stepContent = [
    <div key="step-1" className="py-6 text-center">
      <Key
        width={40}
        height={40}
        strokeWidth={1.5}
        aria-hidden="true"
        className="mx-auto"
        style={{ color: "var(--accent)" }}
      />
      <Text className="block mt-3">
        请输入你的 DeepSeek API Key
      </Text>
      <div className="mx-auto mt-4 max-w-100">
        <Input.Password
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-…"
          aria-label="API Key"
          name="apiKey"
          autoComplete="off"
          spellCheck={false}
          variant="filled"
        />
      </div>
      <Text type="secondary" style={{ fontSize: 12 }} className="block mt-3">
        可在 DeepSeek 官网 https://platform.deepseek.com 获取
      </Text>
    </div>,

    <div key="step-2" className="py-6">
      <Flex vertical gap={20}>
        <div>
          <Text strong>模型选择</Text>
          <div className="mt-2">
            <Select
              value={model}
              onChange={setModel}
              options={DEEPSEEK_MODEL_OPTIONS}
              aria-label="模型"
              placeholder="请选择"
              variant="filled"
            />
          </div>
        </div>
        <div>
          <Text strong>Base URL</Text>
          <div className="mt-2">
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.deepseek.com"
              aria-label="Base URL"
              name="baseUrl"
              autoComplete="off"
              variant="filled"
            />
          </div>
        </div>
      </Flex>
    </div>,

    <div key="step-3" className="py-6">
      <Flex vertical gap={8} className="mb-5">
        <Flex gap={4}>
          <Text strong>Base URL:</Text>
          <Text>{baseUrl}</Text>
        </Flex>
        <Flex gap={4}>
          <Text strong>模型:</Text>
          <Text>{model}</Text>
        </Flex>
        <Flex gap={4}>
          <Text strong>API Key:</Text>
          <Text>
            {apiKey
              ? `${apiKey.slice(0, 8)}…${apiKey.slice(-4)}`
              : "未填写"}
          </Text>
        </Flex>
      </Flex>

      <Flex vertical gap={12}>
        <Button
          icon={<CheckCircle width={13} height={13} strokeWidth={1.8} aria-hidden="true" />}
          onClick={handleTest}
          loading={testing}
          disabled={!apiKey.trim()}
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
      </Flex>
    </div>,
  ];

  const footer = (
    <div className="flex items-center justify-between">
      <Button onClick={onClose}>取消</Button>
      <Flex gap={8}>
        {step > 0 && (
          <Button onClick={() => setStep(step - 1)}>上一步</Button>
        )}
        {step < 2 ? (
          <Button type="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
            下一步
          </Button>
        ) : (
          <Button
            type="primary"
            onClick={handleSave}
            loading={saving}
            disabled={!testResult?.success}
          >
            保存
          </Button>
        )}
      </Flex>
    </div>
  );

  return (
    <Modal
      title="DeepSeek API 配置向导"
      open={open}
      onCancel={onClose}
      width={520}
      footer={footer}
    >
      <div className="mb-4">
        <Steps
          current={step}
          items={[
            { title: "填写 API Key" },
            { title: "选择模型" },
            { title: "测试并保存" },
          ]}
        />
      </div>
      {stepContent[step]}
    </Modal>
  );
}
