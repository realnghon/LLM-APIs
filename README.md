# LLM-APIs

本地运行的轻量级大语言模型 API 代理，提供 OpenAI-compatible 接口、多账号路由、自动故障转移、用量记录和 Web 管理后台。

## 功能

- OpenAI-compatible `/v1/*` 和 `/v3/*` 请求转发
- 多上游账号，按优先级、加权最少连接和最大并发自动负载均衡
- 当前账号遇到网络、超时、鉴权、限流或 5xx 错误时自动尝试下一个同模型账号
- Vercel AI SDK OpenAI-compatible 与 Anthropic provider
- 独立账号次数、余额或积分配置
- 每请求一条使用记录，包含 IP、输入/输出 Tokens、账号、模型、状态、耗时、尝试链与费用
- 按 IP、日期、账号、模型和状态筛选记录，默认保留 100,000 条
- 周/月分组堆叠趋势、账号/模型组合筛选、可点选图例、实际总 Tokens 平滑曲线、累计费用和最近 5 小时分账号统计
- 默认每 5 分钟自动测活，按账号和模型展示状态历史；手动测活可选择模型并并发执行
- 管理后台登录保护
- 本地 JSON/NDJSON 文件持久化，前端图标与 ECharts 均随包提供，不依赖 CDN

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

- API：`http://localhost:8787/v1`
- 管理后台：`http://localhost:8787/admin`
- 登录页：`http://localhost:8787/login`

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
| 请求超时 | 超时后自动尝试下一同模型账号，单位秒 | `120` |
| 模型价格 | 每百万输入/输出 Tokens 的美元单价 | `1.5 / 6` |

每个账号可单独配置次数、余额或积分。账号之间不共享余量。手动测活默认勾选全部模型，也可以取消全选后只检查指定模型；单账号最多同时检测 8 个模型。

## 调用示例

```bash
curl http://localhost:8787/v1/chat/completions \
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
    base_url="http://localhost:8787/v1",
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
2. 按优先级从小到大分组，绝不把请求路由到不支持该模型的账号。
3. 同优先级内使用“当前连接数 / 权重”选择更空闲的账号；负载相同时按权重打散。
4. 达到账号最大并发时跳过该账号，尝试下一个候选账号。
5. 网络错误、请求超时、`401`、`403`、`408`、`409`、`425`、`429` 或 `5xx` 时尝试下一个账号。
6. 不在同一个账号上原地重试。

## 数据文件

账号配置、用量记录和状态历史默认分别保存在：

```text
apis-data/kv.json
apis-data/kv.usage.ndjson
apis-data/kv.status.json
```

旧版 `kv.json` 中的 `usage_logs` 会在首次读取时迁移到独立 NDJSON 日志。日志采用追加写入，避免每次请求重写账号配置文件。调用者 IP 直连时取 socket 地址；经过反向代理时优先取 `X-Forwarded-For` 首项，其次取 `X-Real-IP`。IPv4-mapped IPv6 会显示为普通 IPv4，真实 IPv6 保持原格式。可通过 `DATA_FILE` 指定账号主文件位置，其余文件会放在同一目录：

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
| `PORT` | `8787` | HTTP 监听端口 |
| `DATA_FILE` | `apis-data/kv.json` | 账号主数据文件位置 |
| `USAGE_RETENTION` | `100000` | 使用记录最大保留条数 |

## 状态监测

“运行状态”默认开启，每 5 分钟检测一次所有启用账号的全部模型，可在页面改为 1、5、15、30 或 60 分钟，也可关闭。状态检测写入独立状态快照，不进入使用记录和费用统计。页面可按账号筛选，每个账号下桌面两列、手机一列展示模型；正常为绿色，响应超过 5 秒或请求超时为橙色，其他失败为红色，无数据为灰色。

## 容量与高可用

服务使用 Node.js 异步 I/O、上游连接复用、账号配置内存缓存、独立追加式用量日志和加权最少连接路由，适合几十名调用者共享的单机部署。`/health` 用于存活探测，`/ready` 会读取账号配置并报告可用账号和模型数量。

当前持久化方案是单进程文件存储，不支持多个实例同时写同一个数据目录，也不能单独提供机器级高可用。生产部署应使用 systemd、PM2、Docker restart policy 等进程守护；需要机器级容灾时，应先把账号、用量和状态仓库替换为共享数据库，再由反向代理部署多个实例。不要直接让多个进程共享 `apis-data`。

## 离线资源

管理后台不引用 CDN、外部 CSS 或外部脚本。Lucide 与 ECharts 的压缩运行时及许可证位于 `public/admin/vendor/`，安装包会一并携带；浏览器在无外网环境下仍可显示图标和图表。

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
