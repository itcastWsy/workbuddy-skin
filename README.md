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
- **自动主题色**：换壁纸时自动提取封面主色，给玻璃描边/高光上色，让界面和背景更搭（灰阶/近单色图保持主题默认色）。
- **明暗自适应**：跟随 WorkBuddy 的浅色 / 暗色主题自动切换配色。
- **首页出氛围，任务页更安静**：对话页自动加一层可读性遮罩并轻微压暗背景。
- **多主题一键切换**：内置 5 套预设，可实时切换（不用重启 WorkBuddy）。
- **可选零重启**：`enable-cdp` 持久化环境变量（或 `autostart` 改快捷方式），之后换肤永远热注入、不再重启。
- **可还原**：一条命令移除皮肤、干净重启 WorkBuddy。
- **相对安全**：调试端口只绑 `127.0.0.1`，不改任何官方文件。

界面里的侧栏、卡片、输入框都是 WorkBuddy 的**原生控件**，不是贴图。

---

## 快速上手（3 步）

| 步骤 | 操作 |
|---|---|
| **1. 下载** | 到 [Releases](https://github.com/itcastWsy/workbuddy-skin/releases) 页面下载 `workbuddy-skin-windows-x64.exe`（或对应平台的文件） |
| **2. 双击运行** | 选择 `1) 应用皮肤` —— 会自动启动 WorkBuddy 并注入默认「极光玻璃」主题 |
| **3. 持久化（可选）** | 选择 `7) 持久化调试端口`，之后每次开机换肤不再需要重启 WorkBuddy |

> 不需要安装 Node.js、不写注册表、不改官方文件。删除 exe 即卸载。

---

## 下载安装（详细）

**不需要装 Node，也不用敲命令。** 只要你装了 WorkBuddy 就能用。

1. 打开本仓库的 **[Releases](https://github.com/itcastWsy/workbuddy-skin/releases)** 页面，下载对应你系统的文件：

   | 系统 | 下载文件 |
   |---|---|
   | Windows（64 位） | `workbuddy-skin-windows-x64.exe` |
   | macOS（Apple 芯片 M1/M2/M3） | `workbuddy-skin-macos-arm64` |
   | macOS（Intel 芯片） | `workbuddy-skin-macos-x64` |
   | Linux（64 位） | `workbuddy-skin-linux-x64` |

2. **双击运行**（macOS / Linux 首次可能需要在终端 `chmod +x ./workbuddy-skin-*` 授予执行权限，或右键→打开绕过 Gatekeeper）。
3. 程序会弹出一个**中文菜单**，按数字选择即可：

   ```
   ============================================
      WorkBuddy 换肤工具
   ============================================
     1) 应用皮肤（自动启动 WorkBuddy 并换肤）
     2) 选择主题
     3) 设置壁纸（输入本地图片路径）
     4) 清除壁纸（恢复主题渐变）
     5) 还原为官方外观
     6) 开机自启换肤（给快捷方式加调试端口）   # 仅 Windows
     7) 持久化调试端口 (enable-cdp)
     0) 退出
   ```

   - **第一次用**：先选 `1` 应用皮肤——它会按需启动 WorkBuddy 并换上默认的「极光玻璃」主题。
   - **换壁纸**：选 `3`，把图片文件**拖进窗口**（或粘贴完整路径）再回车。
   - **换风格**：选 `2` 从 5 套内置主题里挑。
   - **不想要了**：选 `5` 一键还原成官方原样。

> 单个 exe 已内置全部主题与样式资源，**离线可用、绿色免安装**，不写注册表、不改 WorkBuddy 的任何官方文件。删除文件即卸载（本地设置存在下方“目录结构”所列的用户目录，`5) 还原` 后可手动删除）。

想用命令行？双击版同样支持所有命令，例如 Windows 上：`workbuddy-skin-windows-x64.exe apply --bg D:\pic.jpg`。参数见下方[用法](#用法)。

---

## 快速开始（开发者 / 从源码运行）

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

自己打包一个双击 exe（用本机 Node，无需联网下载基座）：

```bash
npm install          # 装 esbuild / postject（仅打包时需要）
npm run build        # 产物在 dist/workbuddy-skin(.exe)
```

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
| `portrait set <image>` | 给带立绘位的主题（如 portrait-fan）放一张人物立绘（自动持久化） |
| `portrait clear` | 移除立绘 |
| `autostart [undo]` | 改写 WorkBuddy 快捷方式使其自带调试端口，之后换肤永不重启（`undo` 还原） |
| `enable-cdp [undo]` | 持久化环境变量 `WORKBUDDY_REMOTE_DEBUGGING_PORT`，每次 WorkBuddy 启动自动开启调试端口（推荐，优于 autostart；`undo` 移除） |
| `dom [--selector <css>]` | 内置 DevTools 替代——实时勘察 WorkBuddy DOM 结构、节点属性（新版无开发者工具时排障用） |
| `status` | 查看当前状态与皮肤是否生效 |

`apply` 选项：`--theme <id|path>`、`--bg <image>`、`--port <n>`、`--exe <path>`、`--restart`、`--watch`、`--no-launch`。

```bash
# 换壁纸（内联为 data URI 注入，绕过渲染进程 CSP 对 file: 的拦截；之后自动沿用）
workbuddy-skin bg set ~/Pictures/beach.jpg

# 切主题（内置：aurora-glass / midnight / sakura / mono / portrait-fan）
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
- **自动主题色**：`bg set` 会从壁纸提取主色，把玻璃描边/高光染成相近色调，零操作；`status` 可看当前 `Accent`，`bg clear` 恢复主题默认色。灰阶/近单色图不改色。
- 想连玻璃风格一起换，才用 `theme use <id>`；只换图片，永远用 `bg`。

### 让换肤永不重启 WorkBuddy（enable-cdp / autostart）

换肤靠 CDP 注入，需要 WorkBuddy 带一个只绑 `127.0.0.1` 的调试端口。而 Chromium 的
`--remote-debugging-port` **只能在启动那一刻传**，没法给一个已经裸启动的进程事后补上——
所以如果 WorkBuddy 正开着且没端口，第一次上皮肤就得重启它一次。

**推荐方案：`enable-cdp`**（v1.3.0 新增）—— 持久化一个用户级环境变量，WorkBuddy 启动时
自动读取，无需修改快捷方式，跨版本升级也不会丢失：

```bash
workbuddy-skin enable-cdp         # 持久化调试端口环境变量
workbuddy-skin enable-cdp undo    # 移除环境变量
```

**备选方案：`autostart`** —— 改写快捷方式（桌面 / 开始菜单 / 任务栏）加上调试端口参数：

```bash
workbuddy-skin autostart          # 给快捷方式加上调试端口标记
workbuddy-skin autostart undo     # 还原快捷方式（去掉标记）
```

- 两者任选其一即可，`enable-cdp` 更简单、兼容 WorkBuddy 自动更新。
- 幂等：重复运行只会跳过已处理的项目。
- 执行后**彻底关掉再重开一次 WorkBuddy**，新设置才会生效。
- 目前 Windows 全自动；macOS / Linux 会打印出需要手动附加的启动参数。

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
│  ├─ cli.mjs             # 命令分发 + 双击交互菜单：install/apply/restore/theme/bg/portrait/autostart/status
│  ├─ platform.mjs        # 跨平台：exe 发现 / 进程 / 端口 / 状态 / 启动 / 内置主题（SEA 感知）
│  ├─ injector.mjs        # CDP 客户端：apply/watch/remove/verify/shot/diag（可进程内调用，供单文件 exe）
│  ├─ image.mjs           # 壁纸/立绘自动压缩 + 自动取色（jimp）
│  ├─ build-exe.mjs       # 打包成单文件可执行程序（Node SEA：esbuild → blob → postject）
│  ├─ selftest.mjs        # 离线自测（不需运行中的 App）
│  └─ *.ps1               # Windows 薄壳，转调 Node CLI（可选）
├─ assets/
│  ├─ theme.json          # 默认主题契约
│  ├─ themes/             # 预设主题：aurora-glass / midnight / sakura / mono / portrait-fan
│  ├─ skin.css            # 视觉层（针对 WorkBuddy 选择器的玻璃化规则）
│  ├─ samples/            # 原创示例壁纸（aurora-sample.jpg，可直接 bg set 试用）
│  └─ renderer-inject.js  # 渲染进程内的幂等 DOM 集成 + 清理
├─ .github/workflows/
│  └─ release.yml         # 打 tag 自动多平台构建并发布到 Releases
├─ dist/                  # 构建产物（git 忽略；exe 通过 Release 分发，不入库）
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

## 发布新版本（维护者）

发布完全自动化：**打一个版本 tag 并推送**，GitHub Actions 就会在 Windows / macOS(Intel & Apple Silicon) / Linux 四个运行器上各自用它们自带的 Node 构建单文件可执行程序（Node SEA，无需交叉编译、无需下载基座），并把四份产物自动上传到该版本的 [Releases](https://github.com/itcastWsy/workbuddy-skin/releases)。

```bash
# 版本号建议同步改一下 package.json 的 "version"
git tag v1.3.0
git push origin v1.3.0
```

- 工作流定义见 [`.github/workflows/release.yml`](.github/workflows/release.yml)，触发条件为推送 `v*` 形式的 tag。
- 也可在 Actions 页面手动 `workflow_dispatch` 触发，仅构建产物、不创建 Release（用于验证构建）。
- Release 说明由 `generate_release_notes` 自动根据提交记录生成，可事后编辑补充。
- 产物命名：`workbuddy-skin-windows-x64.exe` / `-macos-arm64` / `-macos-x64` / `-linux-x64`。

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

## 联系与反馈

使用中遇到问题、想反馈 bug 或提建议，欢迎联系作者：

- 邮箱：yeah126139163@163.com
- 微信：w846903522

也可以直接在仓库提 [Issue](https://github.com/itcastWsy/workbuddy-skin/issues) 或 PR。

---

## License

MIT
