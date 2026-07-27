# LLM-APIs

本地运行的轻量级大语言模型 API 代理，提供 OpenAI-compatible 接口、多账号路由、自动故障转移、用量记录和 Web 管理后台。

## 功能

- OpenAI-compatible `/v1/*` 和 `/v3/*` 请求转发
- 多上游账号，按优先级和权重选择
- 当前账号遇到网络、鉴权、限流或 5xx 错误时自动尝试下一个账号
- Vercel AI SDK OpenAI-compatible 与 Anthropic provider
- 独立账号次数、余额或积分配置
- 使用记录与累计统计
- 管理后台登录保护
- JSON 文件持久化，无需数据库

池模式、同账号原地重试和多账号共享余额已经移除。

## 要求

- Node.js 18 或更高版本
- npm

## 安装与启动

```bash
git clone https://github.com/realnghon/LLM-APIs.git
cd LLM-APIs
npm install
```

首次启动前，从示例创建本地管理员配置：

```bash
cp config/admin.example.json config/admin.json
```

Windows PowerShell：

```powershell
Copy-Item config/admin.example.json config/admin.json
```

修改 `config/admin.json` 中的用户名和密码后启动服务：

```bash
npm start
```

停止服务（Windows、Linux 和 macOS 使用同一条命令）：

```bash
npm run stop
```

服务启动时会记录当前 PID。若再次启动并遇到端口占用，终端会显示正在运行的服务 PID，并提示执行 `npm run stop`，不会再输出 `EADDRINUSE` 异常堆栈。

启动后：

- API：`http://localhost:3000/v1`
- 管理后台：`http://localhost:3000/admin`
- 登录页：`http://localhost:3000/login`

## 管理员登录

管理员凭据位于本地文件 `config/admin.json`：

```json
{
  "username": "admin",
  "password": "your-strong-password"
}
```

该文件已被 Git 忽略，不会提交到仓库。可提交的配置模板为 [`config/admin.example.json`](config/admin.example.json)。修改配置后需要重启进程。

> [!WARNING]
> 公共 API 路由默认不验证客户端身份，且服务允许跨域请求。请仅在可信网络中运行，不要直接暴露到公网。

## 添加上游账号

登录管理后台后打开“账号管理”，选择“新增账号”。

| 字段 | 说明 | 示例 |
| --- | --- | --- |
| 账号名称 | 后台显示名称 | 阿里云百炼 |
| 请求格式 | OpenAI Compatible 或 Anthropic | OpenAI Compatible |
| Base URL | 上游 API 根地址 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| API Key | 上游密钥 | `sk-xxx` |
| 支持模型 | 每行一个模型 | `qwen-max` |
| 模型映射 | `客户端模型=上游模型`，每行一个 | `gpt-4=qwen-max` |
| 优先级 | 数字越小越先尝试 | `1` |
| 权重 | 同优先级账号的选择权重 | `5` |
| 最大并发 | `0` 表示不限制 | `5` |

每个账号可单独配置次数、余额或积分。账号之间不共享余量。

## 调用示例

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen-max",
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

Python OpenAI SDK：

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="local",
)

response = client.chat.completions.create(
    model="qwen-max",
    messages=[{"role": "user", "content": "你好"}],
)
print(response.choices[0].message.content)
```

## 路由策略

1. 筛选已启用且支持请求模型的账号。
2. 按优先级从小到大分组。
3. 同优先级内按权重生成尝试顺序。
4. 网络错误、`401`、`403`、`408`、`409`、`425`、`429` 或 `5xx` 时尝试下一个账号。
5. 不在同一个账号上原地重试。

## 数据文件

账号和用量数据默认保存在：

```text
apis-data/kv.json
```

可通过 `DATA_FILE` 指定其他位置：

```bash
DATA_FILE=/path/to/kv.json npm start
```

Windows PowerShell：

```powershell
$env:DATA_FILE = "D:\llm-apis\kv.json"
npm start
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口 |
| `DATA_FILE` | `apis-data/kv.json` | 数据文件位置 |

## 开发与测试

```bash
npm test
npm run test:browser
npm run dev
```

测试使用 Node.js 内置测试运行器和 Playwright。HTTP 测试覆盖登录、账号数据迁移、持久化、AI SDK 连通性、Anthropic 适配、跨账号故障转移和用量记录；浏览器测试覆盖登录、新增账号和用量页面。

## 项目结构

```text
LLM-APIs/
├── APIs.js                         # 进程启动入口
├── config/admin.example.json       # 管理员凭据模板
├── public/admin/                   # 管理后台 HTML、CSS、JS
├── src/app.js                      # HTTP 路由与适配
├── src/auth.js                     # 登录会话
├── src/accounts.js                 # 账号管理
├── src/proxy.js                    # 多账号路由与故障转移
├── src/usage.js                    # 用量记录与统计接口
├── src/storage/                    # JSON 文件仓库
├── src/upstream/                   # AI SDK provider 适配
└── test/                           # HTTP 与浏览器测试
```

## License

MIT
