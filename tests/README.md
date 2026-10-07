# 测试

全部为**零依赖**测试(不需要 npm install),用 Node 直接跑。

```powershell
cd Wallvia
node tests/run-all.cjs        # 全部（在仓库根目录 Wallvia/ 下运行）
```

单项:

```powershell
node tests/shared-core.mjs    # 平台无关核心:状态/几何/通透度
node tests/codex-modules.mjs  # Codex:WE 配置解析、源缓存、注入 CSS
node tests/obsidian-smoke.cjs # Obsidian 插件端到端(mock API)
node tests/obsidian-we-picker.cjs # WE → vault 预览图复制路径
node tests/obsidian-scene-pkg.cjs # scene.pkg 原始画面提取(PKGV0022 + IEND 精确切图)
node tests/mp4-size.cjs       # 纯 JS 解析 MP4 容器取视频真实分辨率
node tests/we-folder-still.cjs # 解包项目的散图扫描(内置壁纸的横向缩略图)
node tests/we-video-frame.cjs # 视频帧缓存:源识别 + size/mtime 缓存键
node tests/we-level-cap.cjs   # 最大图源宽度:按宽度选 mipmap 级(不缩放)+ 缓存键带 cap
node tests/obsidian-styles.cjs # Obsidian 样式表不变量(每面板一层填充 / 预览显示整图)
node tests/vscode-smoke.cjs   # VS Code 扩展补丁逻辑(假安装目录)
node tests/vscode-video-frame.cjs # VS Code 侧视频帧缓存(与 Obsidian 共享临时目录与键)
node tests/vscode-video-decode.cjs # 真 Chromium + 真 WE 视频:验证抽帧函数本身
node tests/vscode-css-weight.cjs # 用真实 VS Code 样式表校验改写权重的选择器
node tests/cdp-live.mjs       # 真实 Chromium 端到端注入(无浏览器则 SKIP)
```

## 覆盖内容

| 测试 | 验证点 |
|---|---|
| `validate-json.cjs` | 所有交付的 JSON(manifest/package/tsconfig/launch)可解析 |
| `shared-core.mjs` | 状态默认/边界钳制(含 NaN)、`data:` URL 校验、表面通透度公式与**方向**、fit 几何 |
| `codex-modules.mjs` | WE `config.json` 解析、`scene.pkg` → `preview.jpg`、mtime-size token、**源缓存(未变不重编码)**、注入 CSS(dim 钳制、`data:` 内联、主题分支、不使用本版本缺失的变量)、IIFE 幂等版本守卫 |
| `obsidian-smoke.cjs` | 载入 esbuild 产物(`.default` 解包)、`onload` 注册 3 个事件、无图不启用、设图后加类并写 CSS 变量、`css-change` 可重入、`onunload` 清空 |
| `obsidian-styles.cjs` | `styles.css` 的不变量:编辑区 / 空标签页 / 左右侧栏四条真实嵌套链**各恰好一层**玻璃填充(链取自 Obsidian 自带 `app.css`)、所有填充用**同一个** `color-mix` 值、面板不按 split 分别填充、侧栏特有表面(ribbon `::before` / vault 切换条 / 标签栏 / 状态栏)同值、两个预览框用 `contain` 显示整图;另断言 ribbon 本体**不带** `backdrop-filter`(否则侧栏开关被重锚)、FAB 静息态半透明而悬停/展开态实心、`.view-content > *` 结构性清底、Bases 与 opencode 的显式清底。**嵌入网页面板**这一组断言锁死三个前提:面板玻璃画在 `.workspace-leaf-content::before`(带 `position/inset/z-index:-1/pointer-events:none`)而**不**在 `.workspace-leaf-content` 本体上、`.view-content iframe` 在暗色/亮色主题下分别是 `lighten`/`darken`、以及嵌了网页的 leaf 用 `:has(.view-content iframe)` 解除 `contain: layout`/`paint` 与 `isolation`(仍保留 `size`/`style`),外加 `--wallvia-embed-opacity` 手动档与**笔记内 iframe 的还原**(`opacity:1` + `mix-blend-mode:normal`)。可用 `node tests/obsidian-styles.cjs <旧 styles.css>` 对历史修订跑同一组断言 |
| `obsidian-scene-pkg.cjs` | 自造**结构真实**的 `scene.pkg`(PKGV0022 表 + 含真 PNG 与 mipmap 的 `.tex`):取最大那张、按 `IEND` 精确切分(**不夹带 mipmap 字节**)、写入字节与原图**完全一致**、提示带分辨率;四条回退(图太小 / 魔数错 / 条目截断 / 非 scene)。本机真装了 WE 时再遍历真实 workshop 目录做一次真机验证 |
| `codex-wallpaper-list.mjs` / `codex-cli-follow.mjs` | Codex 侧的壁纸列表与 `follow` 模式(node:test 跑在子进程里) |
| `vscode-smoke.cjs` | 注入标记/`<link>`+live 脚本、编码后的 `vscode-file://` URI、dim、**checksum 为无填充 base64(43 字符、非 hex)**、**保持源扩展名**、重复应用不重复注入、备份、`glass↔fade` 切换、`clear`、`restore`(还原+删 css/live/stamp+修 checksum)、`status`、`fit` 四档(cover/contain/fill/center)、**scene.pkg 原图逐字节**、**16:9 mipmap 缩略图 + 缓存复用 + 宽度上限**、**图源解析**(`project.json` 写 `scene.json` 时仍能解析到 `scene.pkg`)、**live apply**(脚本 + stamp 内容与 mtime 一致)、**主题明暗洗色**、面板开关(`hires`/`videoFrames`/`liveApply`/`themeAware`/`maxImageWidth`)、选择器重开刷新、**已销毁面板会被替换而不是抛错**、**视频帧往返**(选择器发 `needFrame` → webview 回帧 → 落进共享临时缓存 → 卡片显示该帧且角标用容器自带的 1920×1080 → 应用时按视频自身宽度再解一帧并写成背景)、**卡片图片以字节下发**(消息带 `base64` + `mime`，HTML 里不出现缓存文件路径)——`asWebviewUri` 曾对缓存帧一律返回 null，导致 5 张视频卡片永远停在 `…` |
| `vscode-video-frame.cjs` | VS Code 侧的帧缓存(移植自 `we-video-frame.cjs`):卡片宽 960(**可被 `maxImageWidth` 提高**) / 背景按视频自身宽度且上限 2560 的两套宽度策略、**宽度进缓存键**(两种宽度互不覆盖)、键含 size+mtime、空载荷与非图片载荷不入库、**只有文件头的 23 字节残废 JPEG 被拒**(它在解析上"合法",因此必须按体积拦)、**磁盘上被截断的缓存帧会被删除而不是端出去**、`tkhd` 尺寸读取、以及**测试帧绝不落进真实缓存目录**(`WALLVIA_STILLS_DIR` 覆盖) |
| `vscode-video-decode.cjs` | **真 Chromium + 本机真实 WE 视频**:从 `extension.js` 里按括号配平抽出**实际发布的** `decodeFrame`,连**选择器页面自己的 CSP** 一起搬进探针页,对一个真实 4K 视频跑一遍,断言拿到的是 **960 宽的 16:9 JPEG(实测 64 KB)**;再跑一遍**去掉 `media-src`** 的同款页面,断言返回 `null`——那正是"5 张视频卡片全部停在 `…`"的真凶(CSP 缺 `media-src` 时 `<video>` 根本加载不了),所以这条回归被钉死。没浏览器或没 WE 视频时 `SKIPPED` |
| `vscode-css-weight.cjs` | 解析**真实 VS Code 安装目录**里的 `workbench.desktop.main.css`:逐条找出「给 sidebar/panel/auxiliarybar/editor/titlebar/statusbar/activitybar 等结构表面上色」的规则,要求每条都被 Wallvia 的两套机制之一盖住——同权重更强的 `!important` 清底,或把该规则使用的主题变量置为 `transparent`;并手工钉死 1.140 浮动卡片规则 `.monaco-workbench.floating-panels .part.sidebar`(0,4,0) 必须被 (0,4,2) 的覆盖链压过。没装 VS Code 时打印 `SKIPPED` 并以 0 退出 |
| `png-pkg-fixture.cjs` | 共享夹具(不是测试):用真 CRC/IDAT 造出合法 PNG,以及 PKGV0022 容器 + 含 mipmap 的 `.tex` 条目,供 Obsidian 与 VS Code 两侧的场景包测试复用 |
| `mp4-size.cjs` | 纯字节解析 MP4/MOV:`tkhd` v0/v1(16.16 定点)、跳过 0 尺寸音轨、`moov` 在头或在尾、**`mdat` 里伪 `tkhd` 不得胜出**(真机曾把 3840×2160 读成 30307×13873)、超限尺寸拒绝、截断与无 `moov` 返回 `null`;本机装了 WE 时再对真实视频逐个交叉验证 |
| `we-folder-still.cjs` | 解包项目(无 `scene.pkg`)的缩略图选取:16:9 素材胜过方形素材、`preview.jpg` 永不入选、过宽 logo 不得压过真正的壁纸、扫描只深入一层、包里没有可用 PNG 时回退到项目散图 |
| `we-video-frame.cjs` | 视频帧缓存:只有 `project.json` 的 `file` 是视频扩展名时才算视频(`scene.json` 不算)、帧字节原样读回、缓存键含 **size+mtime**(工坊项更新后自动失效)、空载荷不入库 |
| `we-level-cap.cjs` | 「最大图源宽度」按宽度**选 mipmap 级**(3840 链上 cap=1920 → 取 1920、cap=500 → 取 960、cap=7680 → 回退最大级)、选中字节**逐字节原样**、`cap=0` 与 `cap=1920` 走不同缓存条目、视频帧缓存键也带 cap |
| `cdp-live.mjs` | 对**真实无头 Chromium**:`/json` 发现、WebSocket CDP、`Runtime.evaluate`、真实注入、`verifySkin`、color-mix 通透度真的生效、幂等、变更检测、请求超时 |

`cdp-live.mjs` 需要一个 Chromium 系浏览器(Edge/Chrome)。找不到时打印
`SKIPPED` 并以 0 退出,所以套件在无浏览器的机器上仍然全绿。它使用独立的
`--user-data-dir` 与无头模式,不影响你正在用的浏览器。

## mock 说明

`tests/mocks/` 是仅供测试的假 `obsidian` / `vscode` 模块,
由 `tests/mock-loader.cjs` 通过 `Module._load` 钩子按需注入,
**不会**写进插件目录的 `node_modules`,也不会随插件交付。
其中的 `vscode.Uri` 会像真实实现一样做百分号编码,以便测试覆盖
"路径含空格/中文" 这类真实故障。
