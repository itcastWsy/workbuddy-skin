# WorkBuddy Skin

给 WorkBuddy 桌面端换一张会呼吸的脸 —— 一层背景壁纸 + 半透明玻璃界面。
参考 [Codex-Dream-Skin](https://github.com/Fei-Away/Codex-Dream-Skin) 的思路：
**本机回环 CDP 注入，不修改官方安装包（`app.asar` / 安装目录），一键还原。**

> 非官方产品；不改动 WorkBuddy 的可执行文件、签名、账号与数据。
> 跨平台：Windows / macOS / Linux，纯 Node.js；仅一个纯 JS 依赖 `jimp`（用于自动压缩壁纸/立绘），注入器本身零依赖。

---

## 它做了什么

- **真背景层**：在整窗铺一张连续壁纸（内置渐变主题，也可换成自己的照片）。
- **玻璃界面**：侧边栏、顶栏、菜单栏、卡片、输入框变成半透明毛玻璃，透出背景。
- **明暗自适应**：跟随 WorkBuddy 的浅色 / 暗色主题自动切换配色。
- **首页出氛围，任务页更安静**：对话页自动加一层可读性遮罩并轻微压暗背景。
- **多主题一键切换**：内置 4 套预设，可实时切换（不用重启 WorkBuddy）。
- **可还原**：一条命令移除皮肤、干净重启 WorkBuddy。
- **相对安全**：调试端口只绑 `127.0.0.1`，不改任何官方文件。

界面里的侧栏、卡片、输入框都是 WorkBuddy 的**原生控件**，不是贴图。

---

## 快速开始

**前置**：Node.js 18+（推荐 20 / 22）。

```bash
# 1. 安装（一次性：校验环境、定位 WorkBuddy、写入预设主题）
node bin/workbuddy-skin.mjs install

# 2. 应用皮肤（会按需重启 WorkBuddy 以开启调试端口）
node bin/workbuddy-skin.mjs apply --restart

# 3. 还原官方外观
node bin/workbuddy-skin.mjs restore
```

装成全局命令后可直接用 `workbuddy-skin apply`（`npm link` 或发布到 npm 后 `npx workbuddy-skin apply`）。

> **Windows 用户**：仓库保留了 `scripts\*.ps1` 薄壳，习惯 PowerShell 的可继续用
> `powershell -ExecutionPolicy Bypass -File .\scripts\start-skin.ps1 -RestartExisting`，
> 它只是转调上面的 Node CLI。

---

## 用法

```bash
workbuddy-skin <command> [options]
```

| 命令 | 作用 |
|---|---|
| `install` | 校验 Node/WorkBuddy，把预设主题写入本地库 |
| `apply` | 按需启动 + 注入皮肤 |
| `restore [--keep-open] [--uninstall]` | 移除皮肤并干净重启；`--uninstall` 连本地库一起删 |
| `theme list` | 列出可用主题（`*` 为当前） |
| `theme use <id>` | 切换主题（会话在线则实时重注入） |
| `bg set <image>` | 用本地图片当壁纸（自动持久化） |
| `bg clear` | 回到主题自带的渐变背景 |
| `status` | 查看当前状态与皮肤是否生效 |

`apply` 选项：`--theme <id|path>`、`--bg <image>`、`--port <n>`、`--exe <path>`、`--restart`、`--watch`、`--no-launch`。

```bash
# 换壁纸（内联为 data URI 注入，绕过渲染进程 CSP 对 file: 的拦截；之后自动沿用）
workbuddy-skin bg set ~/Pictures/beach.jpg

# 切主题（内置：aurora-glass / midnight / sakura / mono）
workbuddy-skin theme use midnight

# 常驻守护，刷新/切换页面后自动重注入
workbuddy-skin apply --watch

# 指定端口 / 指定 WorkBuddy 路径
workbuddy-skin apply --port 9345 --exe "/path/to/WorkBuddy"
```

### 只想换背景图（不动主题）

如果你对当前主题的玻璃质感满意，只想换一张壁纸，用 `bg` 就够了——它**只替换背景层，不改主题**：

```bash
# 换成自己的照片（自动持久化，下次 apply 继续沿用）
workbuddy-skin bg set "D:\Pictures\beach.jpg"     # Windows
workbuddy-skin bg set ~/Pictures/beach.jpg        # macOS / Linux

# 想先试试效果？仓库自带一张原创抽象壁纸
workbuddy-skin bg set assets/samples/aurora-sample.jpg

# 回到当前主题自带的渐变背景
workbuddy-skin bg clear
```

- 支持 `jpg / png / webp / gif`；图片会被复制进本地库并在注入时内联为 data URI（绕过 CSP）。
- **大图自动压缩**：超过安全体积的图片会在入库时自动缩放/重编码（壁纸转 JPEG、立绘转 PNG 并保留透明），避免 data URI 过大导致背景不生效——你直接丢原图即可，无需手动处理。
- 想连玻璃风格一起换，才用 `theme use <id>`；只换图片，永远用 `bg`。

---

## 原理

WorkBuddy 是一个 Electron 应用（Vite/React 渲染层，沿用 VS Code 主题变量）。

1. CLI 用 `--remote-debugging-port` 启动 WorkBuddy，开启本机回环 CDP。
2. `injector.mjs`（零依赖，用 Node 内置 `fetch` + `WebSocket`）连接渲染进程，注入：
   - 一层 `#wb-skin-bg` 固定背景 div（`pointer-events:none`，永远在 `#root` 之下）；
   - `assets/skin.css` 视觉层 + 由主题生成的 CSS 变量层；
   - 在 `<body>` 打上 `data-wb-skin="on"` 标记 —— 所有样式都以它为前缀，去掉标记即整层失效。
3. 注入既作用于当前页面，也注册为 `addScriptToEvaluateOnNewDocument`，刷新/导航后自动重放。
4. 本地图片壁纸在注入时**内联为 data URI**，绕过渲染进程对 `file:` 的 CSP 拦截。
5. `restore` 实时清理后干净重启 WorkBuddy，彻底复原。

CSS 只针对 `body[data-application-name="workbuddy"]` 生效，装饰层一律 `pointer-events:none`，真实按钮 / 导航 / 输入框始终在最上层可点击。

---

## 目录结构

```
workbuddy-skin/
├─ bin/
│  └─ workbuddy-skin.mjs  # CLI 入口（npx/bin）
├─ scripts/
│  ├─ cli.mjs             # 命令分发：install/apply/restore/theme/bg/status
│  ├─ platform.mjs        # 跨平台：exe 发现 / 进程 / 端口 / 状态 / 启动
│  ├─ injector.mjs        # CDP 客户端：apply/watch/remove/verify/shot/diag
│  ├─ selftest.mjs        # 离线自测（不需运行中的 App）
│  └─ *.ps1               # Windows 薄壳，转调 Node CLI（可选）
├─ assets/
│  ├─ theme.json          # 默认主题契约
│  ├─ themes/             # 预设主题：aurora-glass / midnight / sakura / mono
│  ├─ skin.css            # 视觉层（针对 WorkBuddy 选择器的玻璃化规则）
│  ├─ samples/            # 原创示例壁纸（aurora-sample.jpg，可直接 bg set 试用）
│  └─ renderer-inject.js  # 渲染进程内的幂等 DOM 集成 + 清理
├─ package.json
├─ LICENSE
└─ README.md
```

本地状态与主题库位于：Windows `%LOCALAPPDATA%\WorkBuddySkin`，macOS `~/Library/Application Support/WorkBuddySkin`，Linux `${XDG_CONFIG_HOME:-~/.config}/WorkBuddySkin`。

---

## 自定义主题

在 `assets/themes/` 放一个新的 `<id>.json`（或复制到本地主题库），再 `theme use <id>`：

- `background.dark` / `background.light`：任意合法的 CSS `background-image` 值（渐变叠加、`url(...)` 均可，逗号分层）。
- `glass.blur`：毛玻璃模糊像素；`glass.saturate`：饱和度。
- `glass.panelOpacity* / cardOpacity* / chatScrim*`：面板 / 卡片 / 对话遮罩的不透明度（0–1，越大越实、越易读）。

---

## 校验与自测

```bash
# 离线自测（注入契约、幂等、清理）
node scripts/selftest.mjs

# 语法检查
node --check scripts/injector.mjs
node --check scripts/cli.mjs

# 皮肤是否生效（需运行中的调试会话）
node scripts/injector.mjs verify --port 9345

# 截图当前渲染进程（肉眼确认皮肤/壁纸效果）
node scripts/injector.mjs shot --port 9345 --out wb-shot.png

# 诊断背景层与遮挡容器（排查壁纸为何不显示）
node scripts/injector.mjs diag --port 9345
```

---

## 故障排查

- **找不到渲染进程 / 端口连不上**：确认 WorkBuddy 由本工具启动（普通启动没有调试端口）。用 `apply --restart` 重启。
- **找不到 WorkBuddy**：用 `apply --exe <可执行文件完整路径>` 显式指定。
- **皮肤没出现**：先 `restore` 再 `apply`；或加 `--watch` 处理刷新后失效。
- **WorkBuddy 升级后失效**：重跑 `apply`，会重新定位当前安装。
- **想彻底复原**：`restore` 会干净重启；`restore --uninstall` 连本地库一起清除。

> 若某个 WorkBuddy 生产版本禁用了 `--remote-debugging-port`，CDP 注入将无法连接。此时需改用其它注入方式（本项目只做 CDP 方案）。

---

## 平台说明

- **Windows**：完整支持，含 PowerShell 薄壳。
- **macOS / Linux**：CLI 已按各平台约定实现（`/Applications/WorkBuddy.app/...`、`/opt`、`~/.local` 等路径发现，`pgrep`/`pkill` 进程管理）。若你的安装路径特殊，用 `--exe` 指定即可。欢迎按实际安装位置提 PR 补充发现路径。

---

## 安全边界

- 调试端口只绑 `127.0.0.1`；皮肤运行期间勿运行来路不明的本机程序。
- 不修改官方安装目录、代码签名、`app.asar`。
- 不改动任何 API / 账号 / 数据配置。

## License

MIT
