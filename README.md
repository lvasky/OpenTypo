<p align="center">
  <img src="./src-tauri/icons/128x128.png" alt="OpenTypo 图标" width="60">
</p>

<h1 align="center">OpenTypo</h1>

<p align="center">
  <a href="https://github.com/lvasky/OpenTypo/releases">
    <img src="https://img.shields.io/badge/releases-GitHub-blue" alt="GitHub Release">
  </a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey" alt="支持 macOS 与 Windows">
  <a href="./LICENSE">
    <img src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue" alt="AGPL-3.0-or-later">
  </a>
</p>

<p align="center">
  <a href="./README.md"><strong>简体中文</strong></a>
  ·
  <a href="./README.en.md">English</a>
</p>

<p align="center">
  <strong>一款注重实时编辑体验和源码保真的开源 Markdown 编辑器。</strong>
</p>

OpenTypo 基于 Nomo 开发，目标是让 Markdown 实时编辑像 Typora 一样顺手。[Nomo 上游仓库](https://github.com/nomo-md/nomo)

我们希望在一个开源编辑器里兼顾流畅的实时渲染和方便的表格编辑。编辑和粘贴时优先使用标准 Markdown，扩展语法由用户主动选择。保存时尽量保留未改动内容的写法、对齐和换行，让一次小修改在 Git diff 里只留下必要的变更。

<p align="center">
  <img src="./assets/nomo-editor-zh.gif" alt="中文实时编辑演示" width="800">
</p>

## 下载与安装

Windows 10 / 11（x64）可下载 `.exe` 安装版或 `.zip` 免安装版。macOS 用户可参照下文的开发说明从源码构建。[GitHub Releases](https://github.com/lvasky/OpenTypo/releases)

## 核心特点

- **Markdown 编辑**：即时预览、源码与双栏模式，输入 `/` 快速插入内容。
- **严格 Markdown**：默认开启，使用 GFM 语法兼容 GitHub、GitLab 和 VS Code 的预览。粘贴优先转换为 Markdown，保留已有和手写的 HTML，表格单元格换行使用 `<br>`。未改动的表格保持原始写法，修改单元格尽量只产生必要的 Git 差异。扩展语法可从工具栏手动插入，严格模式可在编辑器设置中切换。
- **复制粘贴**：普通复制默认提供显示文字和 HTML（保留已有显式偏好），`Ctrl+Shift+C` 复制为 Markdown，`Ctrl+Shift+V` 粘贴纯文本。普通粘贴优先转换 HTML；技术表达式采用上下文最小转义，代码保持字面值，未修改的顶层块尽量保留原始语法和换行。
- **丰富内容**：支持表格、代码高亮、数学公式与 Mermaid 图表。
- **文件管理**：文件树键入定位、多标签，以及 TXT / JSON 大文件分段编辑。
- **保存与恢复**：可启用自动保存和 Markdown 本地快照，恢复工作区与阅读位置。
- **舒适写作**：浅深色主题、[自定义配色主题与字体](docs/custom-themes.md)、可手动开启的精细排版，以及可置顶的 Markdown 小窗。
- **导出与预览**：导出 HTML / PDF / Word（.docx），Word 正文和表格可编辑，公式与图表转为图片；macOS 支持 Quick Look 快速预览。

版本变化见项目发布记录。[更新记录](https://github.com/lvasky/OpenTypo/releases)

## 开发

使用 Tauri 2 + Svelte 5 构建，需要 Node.js 22、pnpm 11.5.1 和 Rust / Cargo。

- Windows：Visual Studio 2022 Build Tools 或完整 Visual Studio。
- macOS：Xcode Command Line Tools；构建 Quick Look 扩展需要完整 Xcode。

```bash
pnpm install
pnpm tauri dev
```

## 参与项目

欢迎反馈问题、提出建议或贡献代码。反馈问题时请附系统版本、复现步骤与样例。[提交 Issue](https://github.com/lvasky/OpenTypo/issues) · [提交 Pull Request](https://github.com/lvasky/OpenTypo/pulls)

欢迎为 OpenTypo 点 Star，也欢迎关注 Nomo 原作者和社区。[项目仓库](https://github.com/lvasky/OpenTypo) · [LIXianSenQwQ](https://github.com/LIXianSenQwQ) · [linux.do](https://linux.do/)

采用 [AGPL-3.0-or-later](./LICENSE) 许可证；商业授权请联系维护者，第三方组件遵循各自许可证。

感谢 Tauri、Svelte、ProseMirror、CodeMirror、markdown-it、Shiki、KaTeX、Mermaid 等开源项目。
