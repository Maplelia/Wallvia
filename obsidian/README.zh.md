<div align="center">

# Wallvia for Obsidian

**Bring your Wallpaper Engine everywhere.**

把 vault 里的图片，或 Wallpaper Engine 已下载的壁纸设为 Obsidian 工作区背景 ——
编辑区、侧栏与嵌入网页一起变成毛玻璃，暗色亮色都适用。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)
![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Obsidian](https://img.shields.io/badge/Obsidian-%E2%89%A51.4.0-7c3aed)
![Install](https://img.shields.io/badge/install-BRAT%20%7C%20manual-3c873a)
![Wallpaper Engine](https://img.shields.io/badge/Wallpaper%20Engine-local%20library-3c873a)

中文 · [English](README.md)

</div>

<img src="obsidian-workspace.jpg" alt="Obsidian 工作区：壁纸在编辑区背后透出" width="100%">

<sub>壁纸在编辑区背后透出，左右侧栏与标签区是毛玻璃，正文文字依然清晰。</sub>

| 项目 | 说明 |
|:--|:--|
| 插件 ID | `wallvia` |
| 当前版本 | `1.0.0` |
| 最低版本 | Obsidian `1.4.0` |
| Wallpaper Engine | Windows 桌面端 |
| 源码位置 | 仓库根目录下的 `obsidian/` |

---

## 目录

- [功能](#功能)
- [安装](#安装)
- [使用](#使用)
- [Wallpaper Engine 壁纸列表](#wallpaper-engine-壁纸列表)
- [视频壁纸](#视频壁纸)
- [效果](#效果)
- [设置](#设置)
- [常见问题](#常见问题)
- [卸载与还原](#卸载与还原)
- [已知限制](#已知限制)
- [开发与测试](#开发与测试)
- [许可](#许可)

---

## 功能

| | 功能 |
|:--|:--|
| 🖼️ | 选择 vault 图片，或从已下载的 Wallpaper Engine 壁纸里挑一张 |
| 🧩 | 壁纸列表按窗口宽度自适应分列，支持搜索、方向键选择、原图分辨率徽标 |
| 🪟 | 编辑区、左右侧栏、以及插件嵌入的网页面板支持玻璃效果 |
| 🌗 | 暗色 / 亮色主题自动适配 |
| 🎛️ | 可调 Fit、Dim、Glass、Blur、图片不透明度、嵌入透明度和压暗颜色 |

---

## 安装

### BRAT

1. 安装 [BRAT](https://github.com/TfTHacker/obsidian42-brat)；
2. **设置 → BRAT → Add Beta plugin**，填入：

   ```text
   https://github.com/Maplelia/Wallvia
   ```

3. 在 **设置 → 第三方插件** 中启用 Wallvia。

### 手动安装

把下面三个文件复制到 `<你的 vault>/.obsidian/plugins/wallvia/`：

```text
manifest.json
main.js
styles.css
```

重启 Obsidian，关闭受限模式并启用插件。`main.js` 已经构建完成，普通安装不需要 Node.js。

### 源码构建

```powershell
npm install
npm run build     # 类型检查 + esbuild 打包，产物落在仓库根目录的 main.js
npm run dev       # 监听改动
```

---

## 使用

| 命令 | 作用 |
|:--|:--|
| `Open wallpaper panel` | 打开浮动面板（等同 ribbon 图标） |
| `Pick wallpaper image` | 选择 vault 里的图片 |
| `Choose from Wallpaper Engine` | 打开 Wallpaper Engine 壁纸列表 |
| `Toggle wallpaper` | 快速启用 / 关闭背景 |

浮动面板可以调 **Fit、Dim、Glass、嵌入透明度、Blur、图片不透明度**；压暗颜色放在设置页（面板放不下）。

<img src="obsidian-panel.png" alt="Wallvia 浮动面板" width="420">

<sub>浮动面板：Fit、Dim、Glass、嵌入透明度、Blur、图片不透明度一处调完。</sub>

---

## Wallpaper Engine 壁纸列表

<img src="obsidian-picker.png" alt="Wallpaper Engine 壁纸列表" width="100%">

<sub>壁纸列表：16:9 预览框、左下角原图分辨率徽标、类型与来源、当前使用中的角标。</sub>

每张卡片包含：16:9 预览框（图片完整显示，不裁剪）、左下角的**原图分辨率**徽标、标题、`Scene · 创意工坊` 这样的类型与来源、以及应用按钮；当前正在用的那张右上角有「当前」角标。

| 操作 | 效果 |
|:--|:--|
| 搜索框 | 按标题 / 类型 / 来源即时过滤 |
| 方向键 | 移动选中项（上 / 下按整行移动） |
| `Enter` | 应用选中的壁纸 |
| `Esc` | 关闭列表 |
| 点击卡片 | 选中；再点「应用」或按 `Enter` 才生效 |

### 缩略图从哪来

Wallpaper Engine 自带的那张 `preview.jpg` 是**方形**的（本机实测 801×801、192×192），塞进 16:9 框必然两侧留底色。所以缩略图按下面的顺序取，规则与 VS Code 版一致：

| 优先级 | 来源 | 说明 |
|:--:|:--|:--|
| 1 | `scene.pkg` 的 mipmap 链 | `.tex` 自带整条 mipmap，取一个约 480px 宽的层，**不缩放** |
| 2 | 项目文件夹里的散图 | 内置壁纸是解包项目，扫 `materials/`、`images/`、`img/`、`textures/`、`pictures/`；按最接近 16:9 打分，比 1.2:1 更方的直接淘汰 |
| 3 | 视频帧 | 视频壁纸没有静帧，用宿主 Chromium 取一帧（见下） |
| 4 | `preview.jpg` | 兜底，方形，两侧露框底色 `#0b0d12` |

> **应用时用的始终是完整原图**，16:9 框只影响卡片缩略图。

### 原图分辨率徽标

徽标给的是**应用后会铺到工作区的那张图**的尺寸，不是缩略图的尺寸：

| 类型 | 徽标 |
|:--|:--|
| 场景壁纸 | `scene.pkg` 里最大内嵌 PNG 的尺寸（本机实测 3840×2160、7680×4320） |
| 视频壁纸 | MP4 容器里的真实帧尺寸（本机实测 3830×2160、3840×2160） |
| 没有更大资源的壁纸 | 不显示 |

长边小于 1280 时徽标转红，提示铺满窗口会偏糊。

### 读盘与缓存

- 卡片图片通过 Node 读取后以 `blob:` URL 交给渲染进程（`file://` 会被 Obsidian 拒绝），关闭窗口时逐个释放；
- 打开列表时先读第一屏，其余跟着滚动位置读，几百张的库不会在打开瞬间全部读盘；
- 读盘串行执行，一次只解析一个包；
- 结果按项目目录缓存在内存里，同一张壁纸只解析一次。

---

## 视频壁纸

背景层是 CSS `background-image`，放不了视频，所以视频壁纸也是**一帧静图** —— 但这一帧是**视频里真实的一帧**，不是那张 192×192 的方形预览。

解码由宿主自带的 Chromium 完成：用一个挂在文档里的隐藏 `<video>` 加载 `app://` 资源 URL，跳到第 2 秒，再画到 canvas 上导出 JPEG。

> **不需要 ffmpeg**，也不需要任何额外依赖或外部程序。

解出来的帧按 `路径 + 文件大小 + 修改时间 + 宽度上限` 缓存在系统临时目录 `wallvia-stills/`（每张 70–120 KB），第二次打开是瞬时的；工坊项更新后缓存键自动失效。

---

## 效果

### 压暗层颜色（Wash）

盖在壁纸上的可读性遮罩默认跟随主题：

| 主题 | 颜色 |
|:--|:--|
| 暗色 | `rgb(8 10 18)` |
| 亮色 | `rgb(246 247 250)` |

不是纯黑 / 纯白，避免压死或过曝。设置项 `Wash` 可以改成 **深色 / 浅色 / 自定义颜色**；颜色选择器一动就自动切到自定义模式。

### Fit

| 模式 | 说明 |
|:--|:--|
| `cover` | 保持比例铺满，可能裁掉边缘 |
| `fill` | 强制填满，可能变形 |
| `center` | 保持原始比例居中，不裁剪，可能留白 |

壁纸列表的预览框始终完整显示，不受这里的 Fit 影响。

### 透明 iframe

Obsidian 无法直接修改跨源 iframe 内部的 CSS，Wallvia 用的是元素合成：

- 玻璃层画在 `.workspace-leaf-content::before`；
- 含 iframe 的 pane 放宽 Obsidian 的 containment；
- 暗色主题用 `lighten`，亮色主题用 `darken`；
- 笔记正文里的 iframe 保持正常显示。

所以 OpenCode 这类工作区网页可以透出壁纸，文字和控件继续保留。

---

## 设置

| 设置 | 范围 | 默认值 |
|:--|:--|--:|
| Enabled | 开 / 关 | 开 |
| Fit | `cover` / `fill` / `center` | `cover` |
| Dim | `0`–`1` | `0.35` |
| Glass | `0`–`100` | `55` |
| Blur | `0`–`40` px | `10` |
| Embed opacity | `0`–`100` | `0` |
| Image opacity | `0`–`1` | `0.6` |
| Wash | `auto` / `dark` / `light` / 自定义 | `auto` |
| 场景包取原图 | 开 / 关 | 开 |
| 视频抽帧 | 开 / 关 | 开 |
| 最大图源宽度 | `0`–`7680`，步进 `160` | `0` |
| Cache directory | vault 路径 | `Wallpapers` |

「恢复默认效果」会把 Fit、Dim、Glass、Blur、图片不透明度、嵌入透明度和 Wash 恢复成默认值，但保留当前壁纸、缓存目录和下面三个**可选行为**开关 —— 它们不是效果项，悄悄把 4K 原图重新打开会很意外。

### 可选行为

#### 场景包取原图 · 默认开

从 `scene.pkg` 的 mipmap 链取内嵌 PNG，字节原样复制；没有包的内置项目则扫项目文件夹。关掉后卡片和背景都退回方形 `preview.*` —— 会变糊，但**不会变成空白**。

#### 视频抽帧 · 默认开

取视频里真实的一帧当缩略图。关掉后改用方形预览图，已经缓存的帧不会被删除。

> **跨平台一致**
> 三个平台同一条路：用宿主自带的 Chromium 离屏解码取一帧，
> **不需要 `ffmpeg`，也不需要任何外部程序或依赖**。

#### 最大图源宽度 · 默认 `0`

取原图时的宽度上限，用来压住 4K 图的显存占用（3840×2160 解码后约 33MB）。

| 值 | 行为 |
|--:|:--|
| `0` | 用最清晰的一级 |
| `1920` | 取 mipmap 链里**不小于 1920 的最小一级**；没有这么大的就取最大的一级 |

它**只挑级别，绝不缩放**：复制进 vault 的字节始终是 Wallpaper Engine 原样的那一级。这个值同时约束卡片缩略图、背景原图和视频抽帧宽度，也是缓存键的一部分（`0` 与 `1920` 各存一份，互不串）。

实测同一张 7680×4320 的壁纸：

| 设置 | 落盘尺寸 |
|--:|:--|
| `1920` | 1920×1080 |
| `0` | 7680×4320 |

### 刻意没有的开关

| 开关 | 为什么没有 |
|:--|:--|
| 改完即时生效 | Obsidian 侧不存在这个问题。插件把值直接写进 CSS 变量，改完就是即时生效，做成开关只会是个永远为 true 的假开关 |
| 跟随主题明暗 | 已经由 `Wash` 覆盖，而且比 VS Code 版多两档：能钉死深 / 浅色，也能自定义颜色 |

---

## 常见问题

**卡片两侧是深色的**

这一张取到的是兜底的方形 `preview.jpg`：要么是视频壁纸且关掉了「视频抽帧」，要么包里的纹理是 DXT 压缩、整包没有 PNG 且文件夹里也没有横向素材。两侧露的是预览框底色，图片本身没有被裁剪或拉伸。

**打开列表时只有一部分卡片有图**

这是懒加载，滚到哪读到哪。往下滚即可，还没读的卡片不会显示错误。

**徽标不显示或转红**

- 不显示：这张壁纸没有比缩略图更大的资源，没有「原图」可标。
- 转红：原图长边不到 1280，铺满窗口会偏糊。

**徽标要等一下才出现**

解析和缩略图共用同一个触发点，滚到可视区域才开始。场景壁纸要读整个 `scene.pkg`（本机 7–10 MB 一个），视频壁纸只读文件头；读盘串行，滚一圈就会全部填上。

**背景仍然模糊**

先看徽标：如果它转红，说明能取到的最大图本身就小。视频壁纸只能用一帧静图，低分辨率源无法靠 CSS 恢复细节；场景壁纸可以试试把「最大图源宽度」调回 `0`。

**找不到 Wallpaper Engine**

选择器支持 Windows + Steam 安装。确认 Steam 或 Wallpaper Engine 已启动，并且项目目录里有 `project.json` 和可用的预览文件。

## 卸载与还原

**卸载**：设置 → 第三方插件，关掉 Wallvia（或直接删除），再删掉 `<你的 vault>/.obsidian/plugins/wallvia/` 即可；用 BRAT 装的就在 BRAT 里移除这个 beta 插件。

关掉插件的那一瞬间就还原了：注入的样式类与 CSS 变量都在 `onunload()` 里清干净，不需要重启 Obsidian，笔记、主题和 CSS 片段都没有被改过。

**它会留下什么**：

| 位置 | 内容 | 怎么处理 |
|:--|:--|:--|
| `<vault>/.obsidian/plugins/wallvia/data.json` | 你的各项设置 | 想恢复出厂设置就删掉它 |
| `<vault>/<缓存目录>/` | 从 Wallpaper Engine 复制过来的预览图，默认放在 `Wallpapers/` | 不再需要就删掉整个目录 |

缓存目录里的文件都带插件自己的前缀，而且**同时只保留一份** —— 换壁纸时会顺手删掉上一条由它复制的预览。所以即便卸载后不清理，最多也只剩一张图；插件**从不**碰你自己的文件。

## 已知限制

- **Wallpaper Engine 选择器仅限桌面端**：那段代码被 `Platform.isDesktop` 守着，移动包里完全惰性、不会加载任何 Node 模块。插件本身在移动端照常可用，只是只能挑 vault 里的图片。
- **动态内容不会动**：Obsidian 只能画静态背景 —— 场景壁纸取包内原始画面，视频壁纸取一帧静图，都不会播放。
- **内置 / web 项目没有 `scene.pkg`**：只能扫项目文件夹里的散图，取不到就退回方形 `preview.*`；DXT 压缩的纹理无法解码，同样退回方形预览，图片两侧会露出预览框底色。
- **首屏读盘**：场景壁纸要读整个 `scene.pkg`（本机 7–10 MB 一个），卡片进入可视区域才开始解析，读盘串行；滚过一圈之后就全走缓存。
- **嵌入网页的透明要靠「透明 iframe」**：玻璃层画在 `.workspace-leaf-content::before`，而 webview 自己的底色由它内部决定，插件只能尽量配合。
- **设置页的渲染方式取决于 Obsidian 版本**：1.13 及以上走官方声明式设置，可以被设置搜索命中；1.4–1.12 走传统的 `display()` 渲染，功能一致但搜不到。
- **最低要求 Obsidian 1.4.0**，Wallpaper Engine 壁纸库需要 Windows 桌面端；只把 vault 里的图片当壁纸的话，哪一端都能用。

---

## 开发与测试

插件的一切都在 `obsidian/` 里：源码、文档、截图、`tsconfig.json` 和 `eslint.config.mjs`。构建产物按 Obsidian 的要求落在**仓库根目录**的 `main.js`。

工具链装在仓库根目录（VS Code 扩展、CLI 和测试套件共用那一份 `node_modules`），所以在根目录执行：

```powershell
npm install                                    # 只需一次
npm run build                                  # 类型检查 + 打包
npm run dev                                    # 监听改动
npm test                                       # 全部测试
npm run lint                                   # ESLint + Stylelint
```

当前回归结果：

```text
ALL TESTS PASSED
```

---

## 许可

Wallvia 使用 MIT License，详见 [LICENSE](../LICENSE)。Wallpaper Engine 是 Kristjan Skutta 的产品，Wallvia 与其没有隶属关系。
