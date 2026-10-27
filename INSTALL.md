# 安装方式

结论先说:**"只粘一个 GitHub 仓库地址"只有 Obsidian 支持(BRAT)**。
VS Code 的 CLI 只接受扩展 ID 或 VSIX 文件路径,**不接受 URL**;
Codex 是 CLI 工具,没有插件市场。

| 平台 | 最简单的方式 | 需要什么 | 能粘仓库地址吗 |
|---|---|---|---|
| **VS Code** | 从 release 下载 VSIX 后安装 | 一行 PowerShell(见下) | ❌ 不能 |
| **Obsidian** | BRAT → 粘仓库地址 | 一个 GitHub 仓库 + 你已装的 BRAT | ✅ **可以** |
| **Codex** | `npm run watch` / 双击 `start-wallpaper.cmd` | 本目录 + Node ≥ 22 | ❌ 不能 |

---

## VS Code

### 现在就能用(1 行)

从 release 下载最新 VSIX 再安装(仓库里**不**放打好的包,`*.vsix` 已被 gitignore):

```powershell
$r = irm https://api.github.com/repos/Maplelia/Wallvia/releases/latest
$u = ($r.assets | Where-Object name -like '*.vsix').browser_download_url
irm $u -OutFile "$env:TEMP\wallvia.vsix"; code --install-extension "$env:TEMP\wallvia.vsix"
```

已实测可用:安装后 `code --list-extensions` 显示 `wallvia.wallvia@<版本>`。
装好后在命令面板搜 **`wallvia`**,应能看到 6 条以 `Wallvia:` 开头的命令。

### 校验你下载的东西

每个 release 现在都带一份 **`SHA256SUMS.txt`**:

```powershell
Get-FileHash "$env:TEMP\wallvia.vsix" -Algorithm SHA256   # 与清单里 vscode/wallvia-x.y.z.vsix 那行对照
```

```bash
shasum -a 256 -c SHA256SUMS.txt        # macOS / Linux
```

拿到仓库里也能跑同一份清单:`node scripts/checksums.mjs --verify`。

> 这些哈希是发布流程**打包完成后**当场算的;同一流程里 `scripts/verify-artifact.mjs`
> 已经先证明过「tag 里的 `main.js` 与 `obsidian/` 源码逐字节一致」,
> 所以清单描述的就是打这个 tag 的源码产物。哈希对不上就别装。

### 重新打包(改了代码后)

```powershell
cd vscode
npx @vscode/vsce package --allow-missing-repository
```

### 卸载前先还原(否则安装目录里会留着补丁)

本扩展要改 VS Code 自己的 `workbench.html`,所以**卸载不等于还原**。
两种收尾方式,任选其一:

1. **命令面板 → `Wallvia: Restore workbench.html`**,重载窗口后再卸载;
2. 直接卸载:**扩展会自己发现它的安装目录已经没了**,并在 `deactivate` 里把
   `workbench.html`、`wallvia-bg.css`、`wallvia-live.js`、`wallvia-stamp.txt`
   一起还原/删除(这条路径改了补丁也必须过测试,见 `tests/vscode-smoke.cjs`)。

另外:每次打补丁都会把 `.wallvia.bak` 刷新成**当前这个 VS Code 版本目录**里
去掉本扩展标记后的原文。旧的实现只在第一次运行写一次备份,VS Code 一升级就换成
新版本目录,`restore` 会拿旧目录的备份去还原新目录的文件(或者退化成只剥标记)。

### 补丁写不进去时会告诉你

装到 `Program Files` 下、又没以管理员身份运行 VS Code 时,改安装目录会失败。
现在这种情况会:弹一条带 **`打开输出` / `重试`** 的警告、状态栏出现 `$(warning) Wallvia`、
输出面板 `Wallvia` 频道留下完整错误,而不是只在扩展宿主日志里写一行
`console.warn`(那行没人看得到)。

### 视频壁纸

选中的视频壁纸会在工作台后面**播放**（`wallvia.videoWallpaper`，默认开）：

- 注入的是 `workbench.html` 里一个真实的 `<video>`，位置在 **`<body>` 开头**——
  不是 `<head>`：`<head>` 里出现 `<div>` 会让解析器提前闭合 head 并凭空造一个 body，
  视频层就跑到文档外面去了。因此它有一套独立的标记对（`wallvia:layer:start/end`），
  样式表那段仍在 head 里；
- 抽帧得到的那张静态图是它的 `poster`，所以首帧到达前**不会黑屏**，自动播放被拒绝时
  也仍然显示这张图；
- 换壁纸 / 关掉开关 / `wallvia.clear` 都会把 `<video>`、它的 css 和 stamp 里的视频地址
  一起撤掉；
- 播放状态由 `wallvia-live.js` 驱动（它本来就在轮询 stamp 文件）。stamp 现在是四行：
  `样式表戳` / `视频地址`（空 = 没有视频）/ `muted|sound` / `pause|keep`。
  后两行是元素状态，只能这样下发——`<video>` 一旦进了文档，Node 侧就改不动它的静音与暂停行为。
  样式表那段只读**第一行**：早先整份 `trim()` 会在有视频时把换行塞进 URL，
  于是"改完即时生效"静默失效；
- 三个开关：`wallvia.videoWallpaper`（关掉退回静态一帧）、`wallvia.videoMuted`（默认静音，
  浏览器不允许有声视频自动播放）、`wallvia.videoPauseUnfocused`（失焦暂停，省电）。
  面板里也能改，并且会告诉你当前壁纸是不是视频、在不在播。

### 总开关：一键停用壁纸（保留选择）

临时要共享屏幕、又不想丢掉正在用的壁纸时用它：

| 平台 | 入口 |
|---|---|
| **VS Code** | 命令面板 → **`Wallvia: Toggle Wallpaper (master switch)`**，或直接点右下角状态栏的 `Wallvia` |
| **Obsidian** | 命令面板 → **`Toggle wallpaper (master switch)`**，或面板 / 设置页里的 **启用壁纸（总开关）** |

关掉时做的是**真正撤除**，不是盖住：

- VS Code：`workbench.html` 里两段标记（样式表块 + 视频层块）全部剥掉，`wallvia-bg.css` / `wallvia-live.js` / `wallvia-stamp.txt` 一并删除，`product.json` 校验和同步修正 —— 工作台回到原厂状态。
- Obsidian：`wallvia-enabled` / `wallvia-glass` / `wallvia-video-on` 三个 class 撤掉，`--wallvia-image`、`--wallvia-dim`、`--wallvia-wash` 等**全部 CSS 变量清空**，视频层与 loopback 服务一并停止。

**选择的壁纸不会被忘记**：图片、视频路径都还在，重新打开立刻恢复，不用再挑一次。想彻底忘掉请用 `Remove Wallpaper` / 面板的「移除」。

> 1.0.1 修了一个相关缺陷：此前 Obsidian 关闭后 `--wallvia-image` 等变量**仍留在页面上**（只是 class 没了所以看不见），任何读取这些变量的主题或片段仍会画出壁纸。现在关闭即清空。

### 可选:将来要上架 Marketplace

**当前状态:未上架**(本项目决定暂不发布到 Marketplace),
所以 `code --install-extension wallvia.wallvia` 暂时不可用 ——
请用上面的「下载 release 里的 VSIX 再安装」一行命令,效果等同安装正式版。

若将来要上架,先准备 Azure DevOps 的 Personal Access Token:

```powershell
npx @vscode/vsce login wallvia     # 粘贴 PAT
npx @vscode/vsce publish           # 上架后即可 code --install-extension wallvia.wallvia
```

> 前置:在 https://marketplace.visualstudio.com/manage/createpublisher 建 publisher
> (Publisher ID 用 `wallvia`,需要一个 Azure DevOps 组织)。
> 该页面依赖 Google reCAPTCHA:本机需开启系统代理,否则脚本加载失败、按钮点了没反应。

> ⚠️ 本扩展通过修改 VS Code **安装目录**的 `workbench.html` 实现背景图,
> 所以只能在**本机桌面版**工作。vscode.dev / 网页版 / Remote-SSH / Dev Containers
> 里装上也不会生效 —— 上架时请在描述里写明。

### 从 GitHub 分发(不上架时最省事)

1. 仓库里放 `vscode/`(`package.json`、`src/`、`README.md`、`images/`、`LICENSE`);
2. 打好的 `.vsix` 作为 **Release 附件**上传;
3. 用户下载 → 双击。这是不上架时最接近"一键"的做法。

---

## Obsidian

### 现在就能用

把仓库**根目录**的 `manifest.json`、`main.js`、`styles.css` 放进
`<vault>\.obsidian\plugins\wallvia\`,重启后在**第三方插件**里启用。

> 想核对这三个文件没被篡改:用 release 里的 `SHA256SUMS.txt`,见上面「校验你下载的东西」。

### 粘仓库地址（BRAT，已可用）

仓库已发布 [最新 release](https://github.com/Maplelia/Wallvia/releases/latest)
（三个资产都带 SLSA 构建溯源），BRAT 直接装：

1. Obsidian → 设置 → **BRAT** → **Add Beta plugin**
2. 粘贴仓库地址 `https://github.com/Maplelia/Wallvia`
3. BRAT 自动下载并安装，之后还会**自动更新**

### 或者走官方社区目录（已上架）

设置 → **第三方插件** → **浏览** → 搜索 `Wallvia` → 安装,之后跟着社区目录自动更新。

> ⚠️ 老的"给 `obsidianmd/obsidian-releases` 提 PR"通道**已停用**（该仓库的 PR 已关闭），
> 现在走 **https://community.obsidian.md** 门户提交（需要 GitHub 账号 + Obsidian 账号）。
> 本插件已通过该门户上架 —— 在官方目录的 `community-plugins.json` 里能查到 `"id": "wallvia"`。

### 从 Wallpaper Engine 选来的画面存在哪

默认存在**插件自己的缓存目录** `<vault>/.obsidian/plugins/wallvia/cache/`：
Obsidian 只能显示 vault 里的文件，所以字节必须落在 vault 内，但没必要落在你的笔记树里。
这个目录是点文件夹，文件浏览器不列，`Wallpapers/` 那种"选一张壁纸就在根目录多一个文件夹"
的情况没有了。

- 想让它回到可见的 vault 目录：设置 → **缓存目录**填一个路径（如 `Wallpapers`），
  非空值按原样用，这是你明确要求"给我一个看得见的文件夹"。
- 1.0.x 的旧数据会自动迁移：`data.json` 里仍是旧默认值 `Wallpapers` 的，
  启动时改成私有用缓存，并删掉旧目录里本插件写过的 `wallvia-we-*` 文件（只删这个前缀，
  你自己的图片不动）。
- 清理失败/读图失败不再静默：设置页会多一行 **"上次失败"**，写清位置、错误和按钮"忽略"。

### 视频壁纸会真的播放（默认开）

选中的 Wallpaper Engine 视频壁纸现在会在工作区后面**播放**，而不是只画一帧：

- Obsidian 只能显示 vault 里的文件，而视频在 Wallpaper Engine 的库里（vault 外）。
  插件因此**只为这一个文件**在 `127.0.0.1` 上起一个随机端口的本地服务，
  带 Range 支持（`<video>` 才能拖动/边下边播）、带一次性 token（别的本机进程访问一律 403）、
  只服务这一个文件（没有路径参数，不存在目录穿越）、只接受 `GET`/`HEAD`。
  关掉插件或换壁纸时，socket 立刻关闭。
- **封面**仍是抽帧得到的那张静态图（设置 → 可选行为 → 视频抽帧）：首帧到达前、暂停时都显示它，
  所以不会出现"黑一下再出画面"。
- 三个开关在 设置 → 可选行为 / VS Code 设置里：**视频壁纸播放**（关掉退回静态一帧）、
  **视频静音**（浏览器不允许有声视频自动播放，所以默认静音）、
  **失焦时暂停**（切到别的窗口就暂停，省电）。
- 视频文件被移动/删除时会记进"上次失败"，静态图继续留在屏幕上，不会变成空白。

---

## Codex

### 现在就能用

```powershell
cd codex
npm run watch            # 或双击 start-wallpaper.cmd
```

### 一行安装（推荐：npm 已上架）

```powershell
npm i -g wallvia
wallvia watch
```

> 不想全局安装就用 `npx wallvia watch`。
> npm 页面：https://www.npmjs.com/package/wallvia

### 或者一条 PowerShell 命令（不经过 npm）

```powershell
irm https://cdn.jsdelivr.net/gh/Maplelia/Wallvia@main/codex/install.ps1 | iex
```

会装到 `%LOCALAPPDATA%\Wallvia\codex`,并把 `wallvia` 命令加进用户 PATH(不需要管理员)。
装完新开一个终端,直接 `wallvia watch`。

> 说明:脚本走 **jsDelivr** 而不是 `raw.githubusercontent.com`,因为后者在部分网络下不通;
> 脚本内部用 `codeload.github.com` 下载仓库 ZIP,同样不受该限制。

### 或者手动 clone

```powershell
git clone https://github.com/Maplelia/Wallvia "$env:LOCALAPPDATA\Wallvia\codex"
cd "$env:LOCALAPPDATA\Wallvia\codex"; npm run watch
```

> npm 全局安装与上面的脚本**都提供 `wallvia` 命令**（前者装进 npm 的全局 bin，
> 后者装进 `%LOCALAPPDATA%\Wallvia\bin`）。两条路都能用，但**只选一个**，
> 否则 PATH 里会有两份同名命令。

---

## 一个仓库，三个平台

三个平台现在都从同一个仓库发布：[**Maplelia/Wallvia**](https://github.com/Maplelia/Wallvia)

| 位置 | 平台 | 安装方式 |
|---|---|---|
| 仓库**根目录** | **Obsidian** | 社区插件市场搜 `Wallvia`；或 **BRAT 粘仓库地址** → 自动装 + 自动更新 |
| [`vscode/`](vscode/) | **VS Code** | Release 里的 `.vsix`（一行下载安装，见上） |
| [`codex/`](codex/) | **Codex 桌面版** | **`npm i -g wallvia`**（已上架 npm）或上面的安装脚本 |

> Obsidian 规定插件文件必须位于**仓库根目录**（`manifest.json`、`main.js`、`styles.css`），
> 且 release 的 tag 必须**等于** `manifest.json` 里的版本号 —— 所以根目录留给插件，
> 另外两个平台各占一个子目录。打一个 tag 会同时发布插件、VSIX 与 npm 包。

### 仓库结构

```
.
├── manifest.json / main.js / styles.css / versions.json   # Obsidian 插件（必须在根目录）
├── obsidian/                                              # 插件源码、文档与截图（TypeScript）
├── vscode/                                                # VS Code 扩展
├── codex/                                                 # npm 包 wallvia（CLI）
├── scripts/bump-version.mjs                               # 三个版本号一起升
└── .github/workflows/                                     # release.yml / npm-publish.yml
```

发版：`node scripts/bump-version.mjs <x.y.z>` → commit → 打 tag 推送。工作流会构建插件、
打包 VSIX、带 SLSA 溯源发 release，并把 npm 包一起发布（`release.yml` 里有一道守卫，
tag 与 `manifest.json` 版本不一致会直接失败）。
