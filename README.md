# LLM-APIs

轻量级本地大语言模型 API 代理，支持多账号路由、自动故障转移、登录保护和用量监控。

## 快速开始

**要求**: Node.js 18+

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

### 离线环境部署

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
tar -xzf llm-apis-v1.0.7-offline-20250103.tar.gz

# 2. 进入目录
cd LLM-APIs

# 3. 配置管理员账号
cp config/admin.example.json config/admin.json
# 编辑 config/admin.json 设置用户名和密码

# 4. 启动服务
npm start
```

> [!WARNING]
> API 路由默认不验证客户端身份且允许跨域请求，请仅在可信网络中运行。

## 添加上游账号

登录管理后台，在"账号管理"页面点击"新增账号"，填写上游 API 信息：

- **账号名称**：后台显示名称
- **请求格式**：OpenAI Compatible 或 Anthropic
- **Base URL**：上游 API 地址（如 `https://dashscope.aliyuncs.com/compatible-mode/v1`）
- **API Key**：上游密钥
- **支持模型**：每行一个模型名
- **模型映射**：可选，格式 `客户端模型=上游模型`
- **优先级**：数字越小越优先
- **权重**：同优先级账号的负载分配权重
- **最大并发**：0 表示不限制
- **请求超时**：超时后自动尝试下一账号（秒）
- **模型价格**：每百万输入/输出 Tokens 的美元单价

## 使用 API

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8787/v1",
    api_key="local"
)

response = client.chat.completions.create(
    model="qwen-max",
    messages=[{"role": "user", "content": "你好"}]
)
print(response.choices[0].message.content)
```

## 核心功能

- **多账号路由**：按优先级、权重和负载自动选择账号
- **自动故障转移**：网络错误、超时、限流时自动切换下一账号
- **用量统计**：记录每次请求的 Tokens、费用、耗时和状态
- **按月归档**：历史记录自动按月归档，无记录数量限制
- **健康监测**：定时检测账号和模型可用性
- **离线部署**：所有前端资源内置，无需外网访问

## 配置

**环境变量**：

- `PORT`：HTTP 监听端口（默认 8787）
- `DATA_FILE`：数据文件路径（默认 `apis-data/kv.json`）

**数据文件**：

- `apis-data/kv.json`：账号配置
- `apis-data/kv.usage.ndjson`：当前月用量记录
- `apis-data/kv.usage-YYYY-MM.ndjson`：历史归档
- `apis-data/kv.status.json`：健康检查状态

## License

MIT
