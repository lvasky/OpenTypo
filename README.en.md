<p align="center">
  <img src="./src-tauri/icons/128x128.png" alt="OpenTypo icon" width="60">
</p>

<h1 align="center">OpenTypo</h1>

<p align="center">
  <a href="https://github.com/lvasky/OpenTypo/releases">
    <img src="https://img.shields.io/badge/releases-GitHub-blue" alt="GitHub Release">
  </a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey" alt="Available for macOS and Windows">
  <a href="./LICENSE">
    <img src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue" alt="AGPL-3.0-or-later">
  </a>
</p>

<p align="center">
  <a href="./README.md">简体中文</a>
  ·
  <a href="./README.en.md"><strong>English</strong></a>
</p>

<p align="center">
  <strong>An open-source Markdown editor for live editing and faithful source formatting.</strong>
</p>

OpenTypo builds on Nomo and aims to make live Markdown editing as smooth and intuitive as Typora. [Upstream Nomo repository](https://github.com/nomo-md/nomo)

We want one open-source editor where live rendering feels responsive and editing tables feels straightforward. OpenTypo favors standard Markdown when you edit or paste, with extensions available when you choose them. It aims to preserve the formatting, alignment, and line breaks of untouched content so a small edit produces a small Git diff.

<p align="center">
  <img src="./assets/nomo-editor-en.gif" alt="Live Markdown editing demo in English" width="800">
</p>

## Download and Install

Windows 10 / 11 (x64) builds are available as an `.exe` installer or a portable `.zip`. On macOS, follow the development instructions below to build from source. [GitHub Releases](https://github.com/lvasky/OpenTypo/releases)

## Features

- **Markdown editing**: Live preview, source and split modes, with `/` for quick insertion.
- **Strict Markdown**: Enabled by default for GFM compatibility with GitHub, GitLab and VS Code previews. Pasting favors Markdown conversion and preserves existing and handwritten HTML. Table cell breaks use `<br>`. Untouched tables keep their source formatting, and cell edits produce minimal Git diffs. You can insert extensions from the toolbar and toggle strict mode in editor settings.
- **Clipboard**: Ordinary copy defaults to visible text with HTML, preserving explicit preferences. Use `Ctrl+Shift+C` to copy as Markdown and `Ctrl+Shift+V` to paste literal text. Ordinary paste prefers HTML conversion. Escaping depends on context, code remains literal, and unchanged top-level blocks retain their source syntax and line endings.
- **Rich content**: Tables, syntax highlighting, math formulas and Mermaid diagrams.
- **File management**: Type to locate files in the explorer, work in multiple tabs and edit large TXT / JSON files in segments.
- **Save and restore**: Optional autosave and local Markdown snapshots, plus workspace and reading position restoration.
- **Comfortable writing**: Light and dark themes, [custom color themes and fonts](docs/custom-themes.md) (guide in Chinese), optional fine typography and an always-on-top Markdown mini window.
- **Export and preview**: Export HTML / PDF / Word (.docx), with editable Word text and tables, formulas and diagrams as images, and Quick Look previews on macOS.

Version changes are documented with each release. [Release notes](https://github.com/lvasky/OpenTypo/releases)

## Development

Built with Tauri 2 + Svelte 5. Requires Node.js 22, pnpm 11.5.1 and Rust / Cargo.

- Windows: Visual Studio 2022 Build Tools or the full Visual Studio.
- macOS: Xcode Command Line Tools; building the Quick Look extension requires the full Xcode.

```bash
pnpm install
pnpm tauri dev
```

## Get Involved

We welcome bug reports, suggestions, and code contributions. When reporting a bug, include your OS version, steps to reproduce, and a sample. [Open an issue](https://github.com/lvasky/OpenTypo/issues) · [Open a pull request](https://github.com/lvasky/OpenTypo/pulls)

If you find OpenTypo useful, give it a star and follow Nomo’s creator and community. [Project repository](https://github.com/lvasky/OpenTypo) · [LIXianSenQwQ](https://github.com/LIXianSenQwQ) · [linux.do](https://linux.do/)

Licensed under [AGPL-3.0-or-later](./LICENSE); contact the maintainers for separate commercial licensing. Third-party components retain their own licenses.

Thanks to Tauri, Svelte, ProseMirror, CodeMirror, markdown-it, Shiki, KaTeX, Mermaid and other open-source projects.
