# 市场监控 · Market Monitor

纯前端的加密货币行情监控面板：Binance REST 拉历史 K 线 + WebSocket 推实时行情，本地计算技术指标、信号评分、可行性分析与回测，并支持价格提醒。

**零依赖、免安装** —— 没有 `package.json`，没有 `npm install`，只需要一个 Node.js 运行时。

## 运行指令

```bash
node serve.js
```

启动后访问 **http://localhost:5173**。终端会打印：

```
市场监控已启动  →  http://localhost:5173
```

停止服务：在终端按 `Ctrl+C`。

### 换端口

通过 `PORT` 环境变量指定（默认 `5173`）：

```bash
# macOS / Linux / Git Bash
PORT=8080 node serve.js

# Windows PowerShell
$env:PORT = 8080; node serve.js

# Windows CMD
set PORT=8080 && node serve.js
```

### 为什么必须起服务器

`web/app.js` 是 ES 模块（`<script type="module">`），浏览器在 `file://` 协议下会因 CORS 拒绝加载。**直接双击 `web/index.html` 打不开**，必须走 `http://`。

`serve.js` 就是为此写的零依赖静态服务器：只用 Node 内置的 `http` / `fs` / `path`，把 `web/` 目录挂到根路径，带 MIME 映射、目录穿越防护和 `Cache-Control: no-cache`。

## 环境要求

| 项 | 要求 |
| --- | --- |
| Node.js | 任意近期版本即可（本机验证于 v24.16.0）；只用到内置模块 |
| 浏览器 | 支持 ES Modules、WebSocket、Notification API 的现代浏览器 |
| 网络 | 需要能直连 `api.binance.com`（REST）与 `stream.binance.com:9443`（WebSocket） |

行情数据由浏览器**直接**请求 Binance，`serve.js` 只负责发静态文件、不代理任何 API。所以网络受限时页面会加载但拿不到数据。

## 首次使用

1. `node serve.js`
2. 打开 http://localhost:5173
3. 顶部选择交易对（BTC / ETH / SOL / BNB USDT）与周期（5m / 15m / 1h / 4h / 1d），默认 `BTCUSDT` + `1h`
4. 想用价格提醒的话，在提醒面板点授权，浏览器会弹 Notification 权限请求；未授权时只有声音提示

提醒规则存在浏览器 `localStorage` 里，按域名+端口隔离，**换端口等于换一套提醒数据**。

## 目录结构

```
serve.js                       零依赖静态服务器（唯一的运行入口）
web/
  index.html                   页面骨架 + 全部样式
  app.js                       主控：状态、渲染、事件绑定
  binance.js                   行情接入：fetchKlines / fetch24h / subscribeKlines（断线指数退避重连）
  indicators.js                指标：SMA / EMA / 布林 / RSI / MACD / ATR / 分位 / 摆动点 / 聚类
  signal.js                    信号评分、可行性分析、入场位、最终建议
  backtest.js                  基于信号序列的回测
  alerts.js                    价格提醒：localStorage 持久化 + Notification + 蜂鸣
  vendor/
    lightweight-charts.js      图表库（已本地化，无 CDN 依赖）
```

## 常见问题

**端口被占用**（`EADDRINUSE`）→ 换个端口：`PORT=5174 node serve.js`。

**页面空白 / 控制台报模块加载错误** → 检查是不是直接用 `file://` 打开了 HTML，必须通过 `http://localhost:5173`。

**图表出来了但没数据** → 打开浏览器控制台看 Binance 请求是否被拦截；国内网络通常需要代理。

**改了 `web/` 下的文件不生效** → 服务器已设 `no-cache`，刷新即可；`serve.js` 本身改动需要重启进程。
