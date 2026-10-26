# AI 模型与设置

## 服务商与模型

模型与密钥在设置里配置（主屏左下角的账号行打开）：

![设置窗口](img/settings-general.png)

- **Claude（订阅）**（默认）：使用本机 `claude` CLI 的登录——执行一次 `claude login` 即可；模型为 sonnet、opus、haiku；仅支持文本，不含图片。也支持 **Codex CLI**，Ollama、LM Studio 等本地服务可作为兼容 OpenAI 的自定义端点。
- **网络搜索与媒体**：网络搜索无需密钥即可使用（免费链路；需密钥的提供商为可选）。图像生成与媒体分析在配置 AI Media 提供商之前保持关闭。
- **自定义端点（BYOK）**：设置 ▸ AI 里为每家协议填 base URL 与 API key——OpenAI 兼容、Anthropic、Gemini、DeepSeek、DashScope(qwen) 等。key 存在本机的应用设置文件里，发送时只进请求头。 Atlas Cloud 也在内置协议之列。
- 每类能力可选不同模型：对话/生成、图像生成、图像理解（看图）。
- **连接测试**：保存前可测试端点连通与模型可见性。
- base URL 支持带路径与查询串（如网关地址），App 会正确拼接端点路径。

## CLI 集成（Codex 类）

- 设置里可指定本机 CLI 程序路径（支持非 ASCII 用户目录与 ~ 前缀，会自动展开）；「检测模型」会探测该 CLI 可用模型。
- 路径校验只查存在性，不限制字符集。

## 何时生效

- 模型与端点改动即时生效；正在进行的对话继续用旧配置直到下一轮。
