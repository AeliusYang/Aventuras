# Aventuras 中文写作

基于 [AventurasTeam/Aventuras](https://github.com/AventurasTeam/Aventuras) 的中文写作改造版，当前源码版本为 **0.7.16**。

中文写作使用 Director → Writer → 事实维护流程。用户可自然输入动作、对白、剧情要求或“继续”；长期规划和短期剧情建议通过现有按需入口使用。普通冒险模式保留原有流程。

内置默认提示词包名为 **中文写作**，普通创建与角色卡导入均可直接使用。当前与兼容旧版模板均不包含成人场景专节。提示词仍能通过 Prompt Inspector 查看并在 Prompt Pack 编辑器中修改。

本副本仅含源码、通用资源与测试，不附带 API 连接、故事数据库、角色卡、私人预设原文件、评测记录、备份或 Git 历史。

## 开发与构建

需要 Node.js 22.13+（建议 Node.js 24 LTS）、npm；桌面构建另需 Rust 和相应平台的 [Tauri 构建依赖](https://v2.tauri.app/start/prerequisites/)。

```sh
npm ci
npm run check
npm test
npm run build
npm run tauri build
```

`npm run dev` 启动前端开发服务，`npm run tauri dev` 启动完整桌面开发环境。API 由使用者在应用内配置。

本副本沿用上游应用标识 `com.karelian.aventura`。如果在已有安装的电脑上启动桌面程序，它会访问同一应用数据目录；源码脱敏不代表运行环境隔离。核验全新默认体验时请使用独立操作系统账户或隔离环境。

上游自动更新保持禁用。此副本不含指向上游仓库的自动发布流程，也未配置 Git 远程。

## 文档与许可

- [公开副本说明与验证结果](docs/public-release.md)
- [默认中文写作提示词全文](docs/default-prompts.md)
- [架构概览](docs/architecture/overview.md)
- [提示词机制](docs/architecture/prompts.md)
- [开发脚本](scripts/README.md)
- [GitHub 发布方式](docs/github-release.md)

保留上游 [AGPL-3.0 许可证](LICENSE.md) 与 `third-party-licenses/` 中的第三方许可。本项目是基于 Aventuras 的修改版本，不代表上游官方发行。
