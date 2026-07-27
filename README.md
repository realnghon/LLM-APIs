# LLM-APIs

极度轻量化的本地大语言模型 API 代理。

## 为什么需要这个？

自建 API 代理通常需要部署在服务器上，但：

- 免费服务器卡顿、有各种限制
- 付费服务器有额外成本
- 需要运维、监控、维护

**解决方案**：直接在本地运行，每次开机在终端执行一行命令即可，无需服务器。

## 核心功能

### 🚀 轻量级本地运行
- 单文件架构，一个文件搞定全部功能
- 零配置，无需 Docker、无需数据库
- 即开即用，开机运行，关机停止

### 🔄 多账号池化
- 支持配置多个上游 API 账号（阿里云、DeepSeek、Moonshot 等）
- 自动轮询 + 权重路由
- 账号故障自动切换
- 支持多平台混合使用

### ⚖️ 智能负载均衡
- 基于优先级 + 权重的路由分配
- 同一优先级内按权重比例分发
- 故障自动转移

### 📊 用量监控
- 实时查看每个 API 账号的使用情况
- 按时/天/周统计 Token 消耗和成本
- Web 管理后台，随时关注自己的用量

### ⚡ 高性能
- TCP/TLS 长连接复用
- 流式响应（SSE）支持
- 内存占用极小

## 快速开始

### 方式一：直接运行（推荐）

```bash
# 需要 Node.js >= 18
node APIs.js
```

### 方式二：npm 安装

```bash
npm install llm-apis
npx llm-apis
```

### 方式三：克隆源码

```bash
git clone https://github.com/lijinzhao8/LLM-APIs.git
cd LLM-APIs
npm start
```

启动后：
- API 地址：`http://localhost:3000`
- 管理后台：`http://localhost:3000/admin`

## 使用方法

### 1. 配置账号

打开管理后台 `http://localhost:3000/admin`，添加上游 API 账号：

| 字段 | 说明 | 示例 |
|------|------|------|
| 名称 | 账号备注 | 阿里云百炼 |
| 接口地址 | 上游 API Base URL | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| API Key | 你的 API 密钥 | `sk-xxx` |
| 支持的模型 | 每行一个模型名 | `qwen-max` |
| 优先级 | 数字越小越优先 | `1` |
| 权重 | 1-10，越大分配越多 | `5` |

### 2. 调用 API

把客户端的 API 地址改为 `http://localhost:3000/v1`，其他保持不变：

```bash
# 使用 curl
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen-max",
    "messages": [{"role": "user", "content": "你好"}]
  }'

# 使用 Python openai SDK
import openai
client = openai.OpenAI(base_url="http://localhost:3000/v1", api_key="any")
response = client.chat.completions.create(
    model="qwen-max",
    messages=[{"role": "user", "content": "你好"}]
)
```

### 3. 查看用量

管理后台提供完整的统计页面，随时关注自己的 API 使用情况：

| 页面 | 说明 |
|------|------|
| 账号管理 | 查看/编辑/删除账号，实时负载状态 |
| 使用记录 | 按时间查看每次 API 调用详情 |
| 累计统计 | 按天/周/总计查看 Token 消耗和成本 |

## 工作原理

```
客户端请求
    ↓
LLM-APIs 代理（localhost:3000）
    ↓ 路由选择（优先级 + 权重）
    ↓
上游账号 A / B / C ...
    ↓
返回响应给客户端
```

### 路由策略

1. **优先级**：数字越小越优先（1 > 2 > 3）
2. **权重**：同一优先级内，按权重比例分配
3. **故障转移**：账号失败自动切换下一个
4. **并发控制**：可设置单账号最大并发数

## 配置说明

账号和统计信息存储在 `apis-data/kv.json`，可通过管理后台编辑，也可直接修改文件：

```json
{
  "accounts": [
    {
      "id": "acc_123",
      "name": "阿里云百炼",
      "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "api_key": "sk-xxx",
      "models": ["qwen-max", "qwen-plus"],
      "enabled": true,
      "priority": 1,
      "weight": 5,
      "model_map": {}
    }
  ]
}
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 服务监听端口 |

## 项目结构

```
LLM-APIs/
├── APIs.js          # 主程序（单文件，无第三方依赖）
├── package.json     # npm 配置
├── README.md        # 说明文档
├── .gitignore       # 忽略规则
└── apis-data/       # 运行时数据（已 gitignore）
    └── kv.json      # 账号和统计数据
```

## 常见问题

### Q: 需要安装什么吗？
A: 只需要 Node.js >= 18，这是一个纯 Node.js 应用，无其他依赖。

### Q: 支持哪些上游 API？
A: 支持所有兼容 OpenAI API 格式的服务，包括：
- OpenAI / Azure OpenAI
- 阿里云百炼
- DeepSeek
- MiniMax
- Moonshot
- 其他兼容 OpenAI 格式的 API

### Q: 可以同时配置多个不同平台的账号吗？
A: 可以。通过池模式（Pool Mode）将不同平台的账号组合成一个逻辑账号，自动查询和故障转移。

### Q: 如何让它开机自动运行？
A: 建议配合 PM2 使用，只需一次配置即可：

```bash
npm install -g pm2
pm2 start APIs.js --name llm-apis
pm2 save
pm2 startup
```

## License

MIT License
