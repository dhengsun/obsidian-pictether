# Pictether

Obsidian Desktop 的本地优先外部附件插件。附件保存在 Vault 外，通过 `mdasset://` 引用；S3 兼容对象存储用于可选备份和缺失恢复。

## 功能

- 粘贴、拖入或选择图片、视频和 PDF。
- 阅读视图与实时预览、图片预览、视频播放、PDF 翻页及系统打开。
- OSS 自动备份、校验、重试和缺失附件恢复。
- 凭据管理、连接测试、每日备份汇总。
- 笔记与附件导出为普通 Markdown 和相对链接。

图片支持 PNG、JPEG、WebP、GIF、BMP、AVIF、SVG；视频支持 MKV、MOV、MP4、OGV、WebM，实际播放取决于编码。JSON、Markdown 的新导入交给 Obsidian；不支持音频、HEIC、TIFF。旧受管 Markdown 保留兼容读取，JSON 引用不再渲染或恢复。

## 构建与安装

开发需要 Node.js 24+ 和 npm，生成 ZIP 另外需要 Python 3。

```sh
npm ci
npm run typecheck
npm run build
```

将 `main.js`、`manifest.json`、`styles.css` 放到 Vault 的 `.obsidian/plugins/pictether/`，同时保留 `LICENSE`、`THIRD_PARTY_NOTICES.md`，然后在 Obsidian 中启用插件。

需要本地安装 ZIP 时可运行 `npm run package`；构建文件和安装包均不提交源码仓库。测试、工程约定和开发文档只留本地，不随公开源码分发；`npm run test:local` 仅供具有本地测试文件的维护者使用。

仅支持桌面，声明的最低 Obsidian API 版本为 1.11.4；备份数据库还要求实际宿主内置 `node:sqlite`。不同平台、视频编码和 S3 服务需分别验证，当前为开发预览版本。

## 使用

1. 设置附件根目录，默认是当前用户的 `Pictures/markdown-assets`。仓库名自动读取 Obsidian，已有附件路径保持稳定。
2. 在 Markdown 笔记中粘贴、拖入附件，或执行 `Insert Attachment`。
3. 需要云端备份时，填写 S3 Endpoint、Bucket，在加号入口添加 Access Key ID 和 Secret Access Key，测试并保存，再开启自动备份。R2 的签名区域为 `auto`，无需填写 Token value。
4. 缺失附件可自动恢复，也可执行 `Restore Missing Attachments`；导出使用 `Export Note with Attachments`。

RK 列表的三个点菜单提供编辑和删除；凭据不回显，设置只保存 SecretStorage 引用。绿点表示相应配置曾通过连接测试，不代表已验证写入权限。多设备可使用同一命名空间，本地和云端内容冲突不会自动覆盖。

附件布局：

```text
{root}/{namespace}/{YYYY-MM-DD}/{HHmmss-xxxxxx}.{ext}
```

正常操作不删除附件或向云端传播删除。**重置会删除当前附件根目录下所有命名空间的受管理本地附件，包含共用目录的其他库；未备份文件无法恢复。** 操作前必须核对范围并勾选确认。笔记、云端和无法识别的本地文件保留，部分失败可继续重置。重置后重新配置 OSS 可恢复已备份附件。

自定义 `mdasset://` 引用依赖本插件。需要给其他 Markdown 工具使用时，请导出笔记与附件。SQLite 数据库不支持跨设备实时双向同步；备份数据库前应停用插件并等待连接关闭。

## 许可

[MIT License](LICENSE)，Copyright © 2026 Erix。第三方组件保留其各自许可，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；使用 `npm run licenses` 更新声明。
