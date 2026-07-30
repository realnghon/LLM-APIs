# LLM-APIs

轻量级本地大语言模型 API 网关，支持多账号路由、自动故障转移、API Key、SQLite 持久化和用量监控。

## 版本说明

- 最低运行版本升级为 Node.js 22.13。
- 默认端口为 `8787`，运行参数集中在 `config/service.json`。
- 首次启动自动将旧 JSON、NDJSON 和状态文件导入 SQLite，之后仅使用 SQLite，原文件会保留。
- 启动前必须创建 `config/admin.json`，或设置 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD`。
- 客户端 Key 默认由管理员创建后手动开启强制鉴权，便于现有部署平滑升级。

## 快速开始

**要求**: Node.js 22.13+

### 联网环境

```bash
git clone https://github.com/realnghon/LLM-APIs.git
cd LLM-APIs
npm install
cp config/admin.example.json config/admin.json  # Windows: Copy-Item config/admin.example.json config/admin.json
# 编辑 config/admin.json 设置管理员账号密码
npm start
```

启动后访问 `http://localhost:8787/admin` 登录管理后台，API 地址为 `http://localhost:8787/v1`。

停止服务：`npm run stop`

## 无损升级

运行数据保存在 `apis-data/kv.sqlite`，管理员凭据保存在 `config/admin.json`。升级程序时保留这两个位置即可保留账号、API Key、价格、用量和健康检查记录。若使用了 `DATABASE_FILE` 或环境变量管理员凭据，请改为备份对应的自定义数据库和环境配置。

### 联网部署升级

在现有项目目录执行：

```bash
# 1. 停止服务，确保 SQLite 数据已完整落盘
npm run stop

# 2. 备份数据和本地配置（目录名可按实际日期调整）
mkdir -p ../llm-apis-backup
cp -a apis-data ../llm-apis-backup/
cp config/admin.json ../llm-apis-backup/admin.json
cp config/service.json ../llm-apis-backup/service.json

# 3. 获取新版本并按锁文件安装依赖
git pull --ff-only
npm ci --omit=dev

# 4. 启动并登录后台确认账号、Key 和使用记录
npm start
```

PowerShell 中可使用 `New-Item -ItemType Directory ../llm-apis-backup -Force` 和 `Copy-Item apis-data,config/admin.json,config/service.json ../llm-apis-backup -Recurse -Force` 完成备份。

### 离线部署升级

1. 在联网机器构建并传输新离线包，不要把旧部署目录中的 `apis-data` 打进安装包。
2. 在离线机器执行 `npm run stop`，备份整个 `apis-data` 目录、`config/admin.json` 和自定义过的 `config/service.json`。
3. 将新离线包解压到新目录，把备份的 `apis-data` 和本地配置复制到新目录的相同位置。
4. 在新目录执行 `npm start`。程序会自动执行所需的 SQLite 数据结构升级。
5. 登录管理后台确认账号、API Key 和使用记录后，再删除旧目录与备份。

升级失败时，先停止新版本，恢复旧程序目录及整份 `apis-data` 备份，再启动旧版本。不要在服务运行时只复制 `kv.sqlite`；SQLite 可能同时使用 `kv.sqlite-wal` 和 `kv.sqlite-shm`，停服后备份整个目录最安全。

### 离线部署

**在联网机器上构建离线包**：

```bash
git clone https://github.com/realnghon/LLM-APIs.git
cd LLM-APIs
npm install --production
npm run build:offline
```

执行后会生成 `llm-apis-v{版本号}-offline-{日期}.tar.gz` 文件。

**在离线机器上部署**：

```bash
# 1. 解压离线包
tar -xzf llm-apis-v2.2.0-offline-20260730.tar.gz

# 2. 进入目录
cd LLM-APIs

# 3. 配置管理员账号
cp config/admin.example.json config/admin.json
# 编辑 config/admin.json 设置用户名和密码

# 4. 启动服务
npm start
```

> [!WARNING]
> 新安装完成后请先创建客户端 Key，并在“API Keys”页面开启强制鉴权。未开启时 API 路由允许匿名访问，请仅在可信网络中运行。

## 配置上游账号

登录管理后台，在“账号管理”页面点击“新增账号”，填写上游 API 信息：

- **账号名称**：后台显示名称
- **请求格式**：OpenAI Compatible 或 Anthropic
- **Base URL**：上游 API 地址（如 `https://dashscope.aliyuncs.com/compatible-mode/v1`）
- **API Key**：上游密钥
- **支持模型**：每行一个模型名
- **模型映射**：可选，格式 `客户端模型=上游模型`
- **最大并发**：0 表示不限制
- **模型价格**：在“模型价格”页面统一维护；账号仅在渠道价格不同时设置覆盖值

## 使用 API

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8787/v1",
    api_key="llm_创建后显示的完整Key"
)

response = client.chat.completions.create(
    model="qwen-max",
    messages=[{"role": "user", "content": "你好"}]
)
print(response.choices[0].message.content)
```

## 核心功能

- **自动负载均衡**：优先选择当前负载较低的可用账号，无需配置优先级或权重
- **自动故障转移**：网络错误、超时、限流时自动切换下一账号
- **多模态输入**：OpenAI Compatible 透明转发图片输入，Anthropic 自动转换 `image_url`
- **用量统计**：记录每次请求的 Tokens、费用、耗时和状态
- **API Key**：创建下游 Key、限制可用模型，并按 Key 追踪用量
- **SQLite 持久化**：首次启动自动创建数据库，并自动导入旧 JSON/NDJSON 数据
- **健康监测**：定时检测账号和模型可用性
- **离线部署**：所有前端资源内置，无需外网访问

## 配置

**服务配置**：

默认配置位于 `config/service.json`：

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "max_request_body_bytes": 10485760,
  "headers_timeout_ms": 15000,
  "request_timeout_ms": 300000,
  "keep_alive_timeout_ms": 5000
}
```

环境变量可以覆盖配置文件中的对应项目：

- `PORT`：HTTP 监听端口（默认 8787）
- `HOST`：监听地址（默认 `127.0.0.1`；局域网访问可设为 `0.0.0.0`）
- `DATA_FILE`：旧数据导入源，同时用于推导默认 SQLite 文件名（默认 `apis-data/kv.json`）
- `DATABASE_FILE`：SQLite 文件路径（默认与 `DATA_FILE` 同目录、同名 `.sqlite`）
- `MAX_REQUEST_BODY_BYTES`：最大请求体字节数（默认 10 MiB）
- `LOG_LEVEL`：日志等级（`debug`、`info`、`warn`、`error`，默认 `info`）
- `ADMIN_USERNAME` / `ADMIN_PASSWORD`：可替代 `config/admin.json` 提供管理员凭据

**旧数据迁移文件**：

- `apis-data/kv.json`：账号配置
- `apis-data/kv.usage.ndjson`：当前月用量记录
- `apis-data/kv.usage-YYYY-MM.ndjson`：历史归档
- `apis-data/kv.status.json`：健康检查状态

运行时唯一存储为 `apis-data/kv.sqlite`。第一次启动会自动导入以上旧文件，旧文件不会自动删除，也不会继续写入。

## API Key

后台“API Keys”页面可以创建、复制、停用和撤销客户端 Key。新版本创建的完整 Key 可随时在列表中复制；旧版本只保存了不可逆哈希，因此旧 Key 第一次复制时需要确认重新生成，原 Key 会立即失效。

`apis-data/kv.sqlite` 会保存可供管理员再次复制的完整客户端 Key，也包含上游账号 API Key。请限制数据库及其备份文件的访问权限，不要上传到代码仓库或公开存储。

创建至少一个 Key 后，可在该页面开启“强制 API Key 鉴权”。开启后 `/v1/*`、`/v3/*` 及模型列表都必须携带：

```http
Authorization: Bearer llm_xxx
```

## License

MIT
