# 今日头条 · 新闻资讯项目

基于 **FastAPI + Vue 3** 的新闻资讯全栈学习项目，实现新闻浏览、用户体系、收藏/历史、以及 AI 智能问答等功能。

> **说明**：本仓库（或本目录）中，仅以下两个文件夹属于「今日头条」项目代码：
>
> - `toutiao_backend/` — 后端 API 服务
> - `xwzx-news/` — 前端 Web 应用
>
> 其他目录（如课程练习、参考项目等）与本项目无关，上传 GitHub 时建议只保留上述两个目录及本 README。

---

## 功能特性

| 模块 | 说明 |
|------|------|
| 新闻浏览 | 分类列表、新闻列表分页、详情、相关推荐 |
| 用户系统 | 注册、登录、Token 鉴权、个人信息修改、改密 |
| 收藏 | 添加 / 取消收藏、收藏列表、收藏状态检查 |
| 浏览历史 | 记录浏览、历史列表、清空历史 |
| AI 问答 | 对接阿里云 DashScope（通义千问），支持流式输出 |
| 缓存 | Redis 缓存新闻分类与列表，减轻数据库压力 |
| 前端体验 | 主题切换、国际化（i18n）、响应式布局 |

---

## 技术栈

**后端 (`toutiao_backend`)**

- Python 3.10+
- FastAPI + Uvicorn
- SQLAlchemy（异步）+ aiomysql
- MySQL 8.x
- Redis（异步客户端）
- Passlib（bcrypt 密码加密）
- httpx（调用大模型 API）

**前端 (`xwzx-news`)**

- Vue 3 + Vite
- Vue Router + Pinia
- Vant 4（UI 组件）
- Axios、vue-i18n、marked、DOMPurify

---

## 项目结构

```text
.
├── README.md
├── toutiao_backend/          # 后端
│   ├── main.py               # FastAPI 入口
│   ├── config/               # 数据库 / Redis / AI 配置
│   ├── models/               # ORM 模型
│   ├── schemas/              # Pydantic 请求/响应模型
│   ├── crud/                 # 数据访问层
│   ├── routers/              # 路由（news / user / favorite / history / ai）
│   ├── cache/                # 缓存封装
│   ├── utils/                # 鉴权、响应、异常处理等
│   └── requirements.txt      # Python 依赖
└── xwzx-news/                # 前端
    ├── src/
    │   ├── views/            # 页面
    │   ├── components/       # 组件
    │   ├── router/           # 路由
    │   ├── store/            # Pinia 状态
    │   ├── config/api.js     # 后端 API 地址
    │   └── ...
    ├── package.json
    └── vite.config.js
```

---

## 环境准备

### 1. 基础软件

- [Python](https://www.python.org/) 3.10 及以上
- [Node.js](https://nodejs.org/) 18 及以上（建议 LTS）
- [MySQL](https://dev.mysql.com/) 8.x
- [Redis](https://redis.io/) 6.x 及以上

### 2. 创建数据库

在 MySQL 中创建库（字符集建议 `utf8mb4`）：

```sql
CREATE DATABASE news_app DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

按 ORM 模型建表（或自行导入已有 SQL 脚本），主要表如下：

| 表名 | 说明 |
|------|------|
| `news_category` | 新闻分类 |
| `news` | 新闻内容 |
| `user` | 用户 |
| `user_token` | 登录令牌 |
| `favorite` | 收藏 |
| `history` | 浏览历史 |

并提前写入若干分类与新闻数据，否则前端列表为空。

### 3. 启动 Redis

默认连接：`localhost:6379`，数据库编号 `0`。

确保本机 Redis 已启动；若端口或主机不同，请修改 `toutiao_backend/config/cache_conf.py`。

---

## 后端配置与启动

### 1. 进入目录并创建虚拟环境

```bash
cd toutiao_backend
python -m venv .venv

# Windows PowerShell
.\.venv\Scripts\Activate.ps1

# macOS / Linux
# source .venv/bin/activate
```

### 2. 安装依赖

```bash
pip install -r requirements.txt
```

### 3. 修改数据库连接（重要）

编辑 `toutiao_backend/config/db_conf.py`，将连接串改为你的 MySQL 账号密码：

```python
ASYNC_DATABASE_URL = "mysql+aiomysql://用户名:密码@localhost:3306/news_app?charset=utf8mb4"
```

默认示例为：`root:123456@localhost:3306/news_app`。

### 4.（可选）配置 AI 问答

编辑 `toutiao_backend/config/ai_conf.py`，或通过环境变量配置（推荐，避免密钥进仓库）：

```bash
# Windows PowerShell 示例
$env:DASHSCOPE_API_KEY = "你的阿里云 DashScope API Key"
$env:DASHSCOPE_MODEL = "qwen3.5-plus"
```

| 环境变量 | 说明 |
|----------|------|
| `DASHSCOPE_API_KEY` | 阿里云 DashScope API Key |
| `DASHSCOPE_MODEL` | 模型名，默认 `qwen3.5-plus` |
| `DASHSCOPE_BASE_URL` | 兼容模式 Base URL（一般无需改） |

未配置有效 Key 时，新闻等接口仍可使用，仅 AI 问答不可用。

### 5. 启动服务

在 `toutiao_backend` 目录下执行：

```bash
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

启动成功后：

- 接口根路径：http://127.0.0.1:8000/
- Swagger 文档：http://127.0.0.1:8000/docs
- ReDoc 文档：http://127.0.0.1:8000/redoc

### 主要 API 前缀

| 前缀 | 模块 |
|------|------|
| `/api/news` | 分类、列表、详情、相关新闻 |
| `/api/user` | 注册、登录、用户信息 |
| `/api/favorite` | 收藏相关（需登录） |
| `/api/history` | 浏览历史（需登录） |
| `/api/ai` | AI 智能问答 |

需要登录的接口请在请求头携带：`Authorization: Bearer <token>`。

---

## 前端配置与启动

### 1. 安装依赖

```bash
cd xwzx-news
npm install
```

### 2. 确认后端地址

默认后端地址在 `xwzx-news/src/config/api.js`：

```js
export const apiConfig = {
  baseURL: 'http://127.0.0.1:8000',
}
```

若后端端口或主机有变，请同步修改此处。

### 3. 启动开发服务器

```bash
npm run dev
```

终端会输出本地访问地址（一般为 http://127.0.0.1:5173/）。

### 4. 构建生产包（可选）

```bash
npm run build
npm run preview
```

---

## 本地联调顺序建议

1. 启动 MySQL，确认库 `news_app` 与表数据就绪  
2. 启动 Redis  
3. 启动后端：`uvicorn main:app --reload --port 8000`  
4. 启动前端：`npm run dev`  
5. 浏览器打开前端地址，访问首页 / 登录 / AI 问答等页面验证  

---

## 上传 GitHub 建议

建议仓库根目录仅包含：

```text
README.md
.gitignore
toutiao_backend/
xwzx-news/
```

推荐 `.gitignore` 至少忽略：

```gitignore
# Python
__pycache__/
*.pyc
.venv/
venv/
.env

# Node
node_modules/
xwzx-news/dist/

# IDE / OS
.idea/
.vscode/
.DS_Store
Thumbs.db
```

**安全提示**：请勿将真实数据库密码、DashScope API Key 等敏感信息提交到公开仓库。上传前检查 `config/db_conf.py`、`config/ai_conf.py`，优先改用环境变量或本地未跟踪的配置文件。


