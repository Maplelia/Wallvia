<div align="center">

# Wallvia for Codex Desktop

**Bring your Wallpaper Engine everywhere.**

让你 Wallpaper Engine 当前的壁纸透进 **OpenAI Codex 桌面应用** —— 通过 CDP 运行时注入,
不改应用文件、不需要管理员、换壁纸自动跟随。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522-3c873a)
![Admin](https://img.shields.io/badge/admin-not%20required-3c873a)
![Files patched](https://img.shields.io/badge/app%20files-untouched-3c873a)

</div>

![效果](images/codex-glass-verified.png)

<sub>实测:壁纸在 Codex 界面背后清晰透出,文字依然可读。</sub>

---

## 目录

- [特性](#特性)
- [为什么用 CDP 注入](#为什么用-cdp-注入)
- [系统要求](#系统要求)
- [快速开始](#快速开始)
- [命令与参数](#命令与参数)
- [实测数据](#实测数据)
- [工作原理](#工作原理)
- [安全提示](#安全提示)
- [排障](#排障)
- [已知限制](#已知限制)
- [致谢](#致谢)

## 特性

| | |
|---|---|
| **跟随系统壁纸** | 自动读取 Wallpaper Engine 当前壁纸,换壁纸约 1.5 秒内跟随 |
| **列出并选择** | `wallvia list` 列出本机**已下载**的全部壁纸(创意工坊 / 自制 / 内置),`wallvia use <编号>` 直接换;`wallvia follow` 随时回到跟随模式 |
| **也支持固定图片** | 一条命令指定任意图片,优先于 WE |
| **免管理员** | MSIX 安装也照用,不碰 `app.asar`、不改签名 |
| **不改应用文件** | 样式只存在于渲染进程内存,`stop` 后重启即完全恢复 |
| **双击即用** | `start-wallpaper.cmd` / `stop-wallpaper.cmd` |
| **自动重注入** | 窗口重载、换壁纸、改参数都会重建样式表 |
| **轻量** | 仅 stat + 缓存命中,不重复编码图片、不 spawn 子进程 |

## 为什么用 CDP 注入

实测结论:Codex 桌面版以 **MSIX 包**分发(`C:\Program Files\WindowsApps\OpenAI.Codex_*`),
`app.asar` 受系统 ACL 保护**无法修改**;即使强行提权,MSIX 运行时也禁止对目录条目
做 create/rename,而且每次应用更新都会被覆盖。此外它是**单实例应用** ——
已运行的实例会吞掉带调试端口的新启动。

所以这里不做文件补丁,而是:

```
启动器:关掉已运行的实例
        → 以 --remote-debugging-port=9333 重新启动
              │
              ▼
后台 keeper(每 1.5 秒):
  • 读 Wallpaper Engine config.json → 当前壁纸 → preview.jpg → base64 data:URL
  • 对每个主窗口 WebSocket 连 CDP → Runtime.evaluate 注入 <style>
  • 换壁纸或窗口重载时自动重注入
              │
              ▼
Codex 渲染层:body::before 画背景 + body::after 压暗 +
  面板用半透明洗色(毛玻璃)
```

## 系统要求

- **Node.js ≥ 22**(依赖全局 `WebSocket`)
- **Windows**(MSIX 检测与激活走 PowerShell)
- Wallpaper Engine(跟随模式)或任意图片文件(固定图模式)

## 快速开始

### 一行安装(推荐)

```powershell
npm i -g wallvia
wallvia watch
```

不想全局安装就用 `npx wallvia watch`。
npm 页面:<https://www.npmjs.com/package/wallvia>

### 一行安装(不经过 npm)

```powershell
irm https://cdn.jsdelivr.net/gh/Maplelia/Wallvia@main/codex/install.ps1 | iex
```

会装到 `%LOCALAPPDATA%\Wallvia\codex`,并把 `wallvia` 命令加进你的用户 PATH
(不需要管理员)。装完新开一个终端,直接 `wallvia watch`。

> 两条路都提供 `wallvia` 命令,**只选一个**,否则 PATH 里会有两份同名命令。
>
> 若你的网络访问不了 `raw.githubusercontent.com`(常见),上面的 jsDelivr 地址可直接用;
> 安装脚本内部使用 `codeload.github.com` 下载仓库 ZIP,同样不受该限制。

### 双击启动(最省事)

| 文件 | 作用 |
|---|---|
| `start-wallpaper.cmd` | 拉起可调试的 Codex + 启动 keeper,可带参数 |
| `stop-wallpaper.cmd` | 停止 keeper |

启动器会先清理上一次的 keeper,所以**重复双击不会堆积孤儿进程**。

### 命令行

```powershell
npm run watch                  # 跟随 WE 壁纸(推荐)
npm run watch -- --glass 100   # 最通透
npm run list                   # 列出本机已下载的 WE 壁纸(编号表格)
npm run use -- 3               # 把 3 号壁纸的预览图应用到 Codex
npm run follow                 # 回到跟随模式(清除固定图片)
npm run image -- "C:\a.jpg"    # 固定一张图(优先于 WE)
npm run status                 # 查看 WE 解析 / 端口 / Codex 状态
npm run apply                  # 只注入一次并校验
npm run stop                   # 停止 keeper
```

### 列出并选择壁纸

```powershell
wallvia list                   # 编号 + 标题 + [类型] + (来源) + id,* = 当前那张
wallvia list --json            # 机器可读格式
wallvia use 8                  # 按编号
wallvia use 3536645955         # 或直接给 id
wallvia follow                 # 回到跟随模式(清除固定图片)
```

真机输出示例(本机 39 张;为便于阅读,下面把标题列宽压缩过,实际按最长标题对齐):

```text
[list] Wallpaper Engine: D:\Steam\steamapps\common\wallpaper_engine — 共 39 张已下载壁纸
   #  title                                              [type]     (source)    id
   1  [若叶睦]清夏 - It's MyGO!!!!!/AveMujica              [scene]    (workshop)  3558034522
   ...
*  8  Bang Dream 仓田真白 Mashiro 2137card                 [Scene]    (workshop)  3536645955

* = Wallpaper Engine 当前正在使用的那张
用 `wallvia use <编号|id>` 应用其中一张(取静态预览图)。
```

按顺序枚举三处,`project.json` 里没有可用预览图的目录会被跳过,id 重复时以
创意工坊那份为准,排序为 **创意工坊 → 自制 → 内置**,组内按标题(不区分大小写):

| 来源 | 目录 |
|---|---|
| `workshop` | `<Steam>\steamapps\workshop\content\431960\<id>` |
| `mine` | `<WE>\projects\myprojects\<id>` |
| `builtin` | `<WE>\projects\defaultprojects\<id>` |

> `use` 用的是壁纸的**静态预览图**(`project.json.preview` → `preview.jpg/png/jpeg/gif`
> → `thumbnail.jpg` → 壁纸本身就是图片时用它)。scene / video 类型的动态内容无法注入,
> 这一点和 keeper 跟随模式完全一致。
>
> `use` / `image` 会把这张图**固定**下来(优先于 WE 实时壁纸),`dim`/`glass`/`fit`
> 不受影响;要回到跟随模式随时执行 `wallvia follow`(清除固定图片,CDP 在就立刻重新应用
> 当前 WE 壁纸)。
>
> WE 装在非常规位置时,`list` 列不出来就设 `WE_CONFIG` 指到它的 `config.json`:
> `set WE_CONFIG=D:\Steam\steamapps\common\wallpaper_engine\config.json`。

### 恢复原状

```powershell
npm run stop
```

然后关闭 Codex 并正常启动(不带调试端口)即可。注入的 `<style>` 从不落盘。

## 命令与参数

| 命令 | 说明 |
|---|---|
| `status` | 显示 WE 配置路径、当前壁纸、CDP 端口状态、Codex 是否运行 |
| `list [--json]` | 列出本机已下载的 WE 壁纸(编号表格);`*` 标记当前正在使用的那张,`--json` 输出机器可读格式 |
| `use <编号\|id>` | 把该壁纸的预览图应用到 Codex(复用 `image` 的链路:读文件 → `data:` URL → 注入);找不到时非 0 退出 |
| `follow` | **回到跟随模式**:清除 `use` / `image` 记住的固定图片(其余设置不动),CDP 在就立刻重新应用当前 WE 壁纸 |
| `apply` | 注入一次并**校验**(成功退出码 0) |
| `watch` | 拉起可调试实例 + 启动 keeper |
| `stop` | 停止 keeper(含清理历史孤儿进程) |
| `image <path>` | 记住一张固定图片 |

| 参数 | 默认 | 说明 |
|---|---|---|
| `--port N` | `9333` | CDP 端口 |
| `--dim 0-80` | `22` | 压暗层强度 |
| `--glass 0-100` | `75` | 面板通透度(0 = 完全不透明,100 = 最透) |
| `--fit cover\|fill\|center` | `cover` | 图片对齐方式:**覆盖(cover)** / **填充(fill)** / **居中(center)**。旧值 `contain` / `tile` 仍可读取(不会崩,行为不变) |
| `--json` | 关 | 仅 `list`:输出 JSON |
| `--no-kill` | 关 | 若 Codex 正在运行则**拒绝替它关闭**,直接报错退出 |

对齐方式的 CSS 语义(`src/state.mjs`):

| 值 | 中文 | `background-size` |
|---|---|---|
| `cover` | 覆盖 | `cover`(铺满,可能裁切) |
| `fill` | 填充 | `100% 100%`(拉伸,可能变形) |
| `center` | 居中 | `auto`(原图尺寸,居中,超出即裁切) |

## 实测数据

在 Codex 桌面版(MSIX `26.930.3930.0`)上注入后实测:

| 指标 | 应用原值 | 默认 `--glass 75` | 最大通透 `--glass 100` |
|---|---|---|---|
| 全窗口面板不透明度 | `0.93` | **`0.71`** | `0.62` |
| 聊天主体 / 输入区 | `0.93` | `0.65` | `0.52` |
| 背景图 | — | 你的 WE 壁纸(`preview.jpg` → 561 KB data:URL) | 同左 |
| 压暗层 | — | `rgba(8, 10, 18, 0.22)` | 同左 |

## 工作原理

- **图片必须是 `data:` URL**:该渲染器会拒绝 `file://` 图片资源。
- **版本 token = 壁纸标识 + CSS 内容哈希**:换壁纸、改 `--dim/--glass`,
  或升级本工具后,keeper 都会重写样式表(否则窗口会一直留着旧 CSS)。
- **解析与编码分离**:只在壁纸文件的 mtime/size 变化时才重新读取并 base64 编码。
- **配置路径只解析一次**:定位 WE 配置需要 spawn `powershell.exe` / `reg.exe`,
  所以结果会缓存(路径仍存在就复用)。否则 keeper 会每 1.5 秒弹一个控制台窗口
  —— 这是实际踩过的坑,修复后实测 keeper 在 12 秒内的子进程数为 **0**。
- **面板选择器用子串匹配**:该版本使用 `bg-surface-secondary` 这类 Tailwind 记号,
  需 `[class*="bg-surface"]` 才能匹配。
- **不依赖应用内部变量**:该版本**不存在** `--color-surface`,用不存在的变量做
  `color-mix()` 会变成"计算期无效"(表面反而全透明);因此面板颜色改为按
  `data-theme` 分支的 rgba。
- **MSIX 激活**:回退激活使用
  `shell:AppsFolder\<PackageFamilyName>!<ApplicationId>`,两部分都在运行时读取,
  应用更新换了版本号也不会失效。

## 安全提示

CDP 端口只绑定 `127.0.0.1`,但**没有同用户认证** —— 注入期间,本机任何程序都能控制该窗口。

- 注入期间不要运行来路不明的本机程序;
- 不用时 `npm run stop` 并重启 Codex 关闭调试端口。

## 排障

| 现象 | 处理 |
|---|---|
| `CDP :9333 -> down` | 还没带调试端口启动。用 `watch` 或 `start-wallpaper.cmd` |
| `could not bring up the CDP endpoint` | 加 `--port 9334` 换端口;或确认 `Get-AppxPackage OpenAI.Codex` 有结果 |
| `no wallpaper resolved` | Wallpaper Engine 没装 / 没有活动壁纸;用 `image <path>` 指定固定图 |
| `未检测到已下载的 Wallpaper Engine 壁纸` | WE 装在非常规位置:`set WE_CONFIG=<WE>\config.json` 后再 `list` |
| `[use] 找不到壁纸 "x"` | 编号超出范围或 id 打错;`wallvia list` 看编号与 id(给数字时优先按 id 匹配,再按编号) |
| `use` 后一直是同一张图 | `use` / `image` 会**固定**这张图、优先于 WE 实时壁纸;要回到跟随模式执行 `wallvia follow`(清除固定图片,`dim`/`glass`/`fit` 不受影响) |
| 注入了但看不到图 | 首次 MSIX 启动较慢(keeper 有宽限);若窗口还在加载 / 登录页,登录后即生效 |
| 面板不透 | Codex 更新可能改了类名:检查 DOM 后调整 `src/inject.mjs` 的选择器 |
| 壁纸很淡 | 提高 `--glass`(100 时面板降到 62%),或调低 `--dim` |
| 动态壁纸 | 只取 `preview.jpg` **静态快照**,WE 的动态内容无法实时反映 |

## 已知限制

- 视频 / 场景壁纸只能取静态预览图。
- 选择器依赖 Codex 当前 DOM;大版本更新后可能需要同步 `src/inject.mjs`。
- 需要一个常驻 Node 进程(keeper);应用关闭后它会自行退出。
- 仅 Windows 实测。

## 目录结构

```
.
├── start-wallpaper.cmd      # 双击启动(拉起 Codex + keeper)
├── stop-wallpaper.cmd       # 双击停止
├── bin/wallvia              # 可执行入口(npm link 后全局可用)
├── src/
│   ├── cli.mjs              # status / list / use / apply / watch / stop / image
│   ├── wallpaper-engine.mjs # WE config.json → 当前壁纸 + 已下载壁纸列表
│   ├── settings.mjs         # 配置持久化 + 壁纸源解析(带缓存)
│   ├── state.mjs            # 平台无关的 fit(覆盖/填充/居中)/ dim / glass 语义(共享核心)
│   ├── inject.mjs           # 生成注入 CSS + 版本 token
│   ├── cdp.mjs              # CDP /json、WebSocket 会话、注入与校验
│   ├── keeper.mjs           # 后台轮询重注入(独立进程)
│   └── launcher.mjs         # MSIX 定位、带调试端口启动
├── images/
├── LICENSE
└── README.md
```

## 致谢

CDP 注入与 Wallpaper Engine 读取思路参考
[Senxss19/codex-wallpaper-theme](https://github.com/Senxss19/codex-wallpaper-theme)
与 [xnydl/codex-dream-skin](https://github.com/xnydl/codex-dream-skin)。
玻璃壁纸机制移植自 **DeepSeek Harness(DSH)** 生态的壁纸插件:

- **[`@deepseek-ai/dsh-plugin-wallpaper`](https://www.npmjs.com/package/@deepseek-ai/dsh-plugin-wallpaper)**(MIT)—
  本移植的**代码来源**:状态模型(`enabled` / `image` / `fit` / `dim` / `strength`)、
  对宿主 `--dsw-*` 表面 token 的透明化手法、各表面可读性下限与 `surfaceShare` 公式、
  图片缩放上限(长边 2000px / ≤4.2MB)与 `dsh.wallpaper.v1` 存储键均来自它。
  该包只声明 `"license": "MIT"`,未提供作者字段。
- **[`@linxin666/dsh-web-all`](https://github.com/zhu1090093659/dsh-web)**(Apache-2.0)—
  DSH Web UI 的聚合插件;UI 里**实际挂载**壁纸功能的是它打包的 skin-center
  (`@linxin666/dsh-client-ui-skin-center`,profile 中的 `skin-wallpaper` 配置即由它读取)。
  本仓库**未**复制其代码,仅为说明功能出处而署名。

本仓库只沿用其思路与参数,代码为对应平台重写。

Wallpaper Engine 是 Kristjan Skutta 的产品;本项目只读取其本地 `config.json`,
与其无隶属关系。

[MIT](LICENSE) © 2026 Wallvia contributors
