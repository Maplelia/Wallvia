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

### 重新打包(改了代码后)

```powershell
cd vscode
npx @vscode/vsce package --allow-missing-repository
```

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
