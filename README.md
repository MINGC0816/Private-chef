# 私厨 · Private Chief

上传食材照片或文字清单，由 AI 私人厨师识别食材、联网检索菜谱，并按**营养价值**与**制作难度**排序，给出结构化推荐方案。

---

## 功能概览

| 能力 | 说明 |
| --- | --- |
| 多模态对话 | 支持文字描述 + 食材图片，流式输出菜谱建议 |
| 联网搜菜 | Agent 优先调用 Tavily 搜索真实菜谱，再整理打分 |
| 会话记忆 | 基于 LangGraph SqliteSaver，按 `thread_id` 保留多轮上下文 |
| 图片上传 | 阿里云 OSS 预签名直传，前端预览后一并送给模型 |
| 参考图代理 | `/api/v1/proxy/image` 缓解外链防盗链导致的图片无法显示 |
| Web 界面 | 内置静态前端：历史会话、新对话、停止生成、清空当前会话 |

---

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 大模型 | 通义千问（DashScope OpenAI 兼容接口），默认 `qwen3.5-plus` |
| Agent | LangChain `create_agent` + TavilySearch |
| 会话持久化 | LangGraph `SqliteSaver`（`app/db/personal_chief.db`） |
| 后端 | Python ≥ 3.13、FastAPI、Uvicorn |
| 对象存储 | 阿里云 OSS（预签名上传） |
| 前端 | 原生 HTML / CSS / JS（`app/static`） |

---

## 工作流程

```
用户上传食材图 / 输入清单
        ↓
识别食材与新鲜度 → 整理「可用食材清单」
        ↓
调用 web_search（Tavily）检索菜谱
        ↓
按营养价值、制作难度打分排序
        ↓
流式返回结构化推荐报告（可含参考图）
```

---

## 目录结构

```
app/
├── main.py                 # FastAPI 入口，挂载路由与静态资源
├── agents/
│   └── personal_chief.py   # 私厨 Agent、流式生成、会话读写
├── api/v1/
│   ├── chat.py             # 对话流式 / 历史 / 清空
│   ├── oss.py              # OSS 预签名上传
│   └── proxy.py            # 外链图片代理
├── models/
│   └── schemas.py          # 请求体模型
├── common/
│   └── logger.py           # 日志
├── db/
│   └── personal_chief.db   # 会话检查点（运行后自动生成）
└── static/                 # Web 前端
    ├── index.html
    └── assets/
```

> 本包以 `app` 形式被导入（如 `app.main:app`）。请在**包含本目录的仓库根目录**（即存在 `pyproject.toml` / `.env` 的那一层）安装依赖并启动。

---

## 环境要求

- **Python** ≥ 3.13
- 推荐使用 **[uv](https://github.com/astral-sh/uv)** 管理依赖
- 可用的 **DashScope（通义）** API Key
- 可用的 **Tavily** API Key（联网搜菜）
- 若需图片上传：阿里云 **OSS** 存储桶与 AccessKey

---

## 配置环境

### 1. 安装依赖

在仓库根目录执行：

```bash
# 若尚未创建虚拟环境
uv sync

# 或使用已有 .venv
uv pip install -e .
```

也可直接：

```bash
uv run python -c "import fastapi; print('ok')"
```

### 2. 配置环境变量

在仓库根目录创建 `.env`（不要提交到 Git）：

```env
# 通义千问（DashScope OpenAI 兼容）
DASHSCOPE_API_KEY=sk-xxxxxxxx
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1

# Tavily 联网搜索（langchain-tavily 读取该变量）
TAVILY_API_KEY=tvly-xxxxxxxx

# 阿里云 OSS（图片上传；不用上传可暂不配）
OSS_ACCESS_KEY_ID=your_access_key_id
OSS_ACCESS_KEY_SECRET=your_access_key_secret
OSS_BUCKET=your-bucket-name
# 可选，默认 oss-cn-beijing.aliyuncs.com
OSS_ENDPOINT=oss-cn-beijing.aliyuncs.com
```

说明：

| 变量 | 必填 | 用途 |
| --- | --- | --- |
| `DASHSCOPE_API_KEY` | 是 | 调用 qwen 模型 |
| `DASHSCOPE_BASE_URL` | 是 | DashScope 兼容接口地址 |
| `TAVILY_API_KEY` | 是 | Agent 工具联网搜菜 |
| `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET` | 上传图片时 | OSS SDK 凭证 |
| `OSS_BUCKET` | 上传图片时 | 存储桶名 |
| `OSS_ENDPOINT` | 否 | 默认北京地域 Endpoint |

> OSS 地域在代码中默认为 `cn-beijing`，若你的桶在其他地域，需同步修改 `app/api/v1/oss.py` 中的 `cfg.region`。

---

## 启动命令

在仓库根目录执行（任选其一）：

```bash
# 方式一：直接跑入口（默认 127.0.0.1:8001）
uv run python -m app.main

# 方式二：uvicorn
uv run uvicorn app.main:app --host 127.0.0.1 --port 8001

# 需要热重载时（Windows 下偶发僵死进程，按需使用）
uv run uvicorn app.main:app --host 127.0.0.1 --port 8001 --reload
```

启动后访问：

- 前端页面：http://127.0.0.1:8001/
- API 文档：http://127.0.0.1:8001/docs

---

## 主要 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/v1/chat/stream` | SSE 流式对话；body：`message`、`thread_id`、可选 `image_url` |
| `GET` | `/api/v1/chat/messages?thread_id=` | 拉取某会话历史 |
| `DELETE` | `/api/v1/chat/messages?thread_id=` | 清空某会话 |
| `GET` | `/api/v1/oss/presign?filename=` | 申请 OSS 预签名上传 URL |
| `GET` | `/api/v1/proxy/image?url=` | 代理拉取外链图片 |

流式对话请求示例：

```bash
curl -N -X POST "http://127.0.0.1:8001/api/v1/chat/stream" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"冰箱里有鸡蛋、番茄和青椒，晚饭做什么？\",\"thread_id\":\"demo-1\"}"
```

---

## 使用提示

1. 打开前端后，可直接文字描述食材，或点击图片按钮上传后提问。
2. 侧边栏支持多会话切换；「新对话」会新建 `thread_id`。
3. 生成过程中可点停止；清空仅清除当前会话的服务端记忆。
4. 本地数据库文件在 `app/db/`，一般无需手动创建。

---

## 注意事项

- **切勿**将 `.env`、真实 API Key、OSS 密钥提交到公开仓库。
- `app/db/*.db` 为本地运行数据，建议加入 `.gitignore`。
- 生产环境请收紧 CORS（当前为开发便利允许 `*`），并按需限制图片代理的目标域名。


