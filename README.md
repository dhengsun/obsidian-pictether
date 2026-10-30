# Pictether

![Language support](https://img.shields.io/badge/Language-English%20%7C%20Chinese-blue)

**English** · [简体中文](README.zh-CN.md)

**Keep your vault clean. Keep your attachments organized.**

Pictether is a simple, local-first external attachment manager for Obsidian Desktop. Paste, drag, and manage images, videos, and PDFs naturally, while keeping them neatly organized outside your vault.

## Why Pictether?

- **Simple by design.** Set an attachment directory and start using it. No complicated setup or workflows.
- **Organized by time.** Attachments follow a predictable `namespace/YYYY-MM-DD/HHmmss-xxxxxx.ext` (six random hexadecimal digits) structure, making files easier to browse, locate, and manage.
- **A cleaner vault.** Keep bulky media files outside your notes without sacrificing the familiar Obsidian editing experience.
- **Backup when you need it.** Optionally back up attachments to S3-compatible storage and recover missing local files.
- **Easy to take elsewhere.** Export notes as standard Markdown with relative attachment links.

*Your notes stay in Obsidian. Your attachments stay organized.*

## Usage

1. **Choose an attachment directory.** Set the attachment root in the plugin settings. The default is `Pictures/markdown-assets` under your home directory. The vault name is read from Obsidian automatically.
2. **Insert attachments.** Paste or drag images, videos, and PDFs into a note, or run **Insert Attachment**. View them in Reading View or Live Preview.
3. **Connect object storage.** Enter your S3 endpoint and bucket. Click the plus icon beside **Access credentials**, enter your Access Key ID and Secret Access Key, test the connection, and save. For Cloudflare R2, use `auto` as the signing region. A Token value is not required.
4. **Enable automatic backup.** Existing and new attachments are backed up automatically. Use an entry's three-dot menu to edit or delete credentials. Gray means not tested, red means the connection test failed, and green means it passed. A small footer shows backup attempts, successes, conflicts, and failures.
5. **Restore missing attachments.** Missing local files can be recovered from cloud storage. You can also use **Restore missing attachments** in settings or run **Restore Missing Attachments**. Conflicting content is never overwritten automatically.
6. **Export a note.** Run **Export Note with Attachments** to create ordinary Markdown with relative attachment links for other tools.

## Compatibility

Pictether currently supports **Obsidian Desktop only**.

The interface follows Obsidian's language setting: Chinese locales use Simplified Chinese; English and other locales use English. No separate plugin language setting is needed. After changing Obsidian's language, follow its reload prompt.

**Supported formats:**
- **Images:** PNG, JPEG, WebP, GIF, BMP, AVIF, and SVG.
- **Videos:** MKV, MOV, MP4, OGV, and WebM. Playback depends on the codec.
- **Documents:** PDF.

New JSON and Markdown imports remain with Obsidian. Audio, HEIC, and TIFF are not supported.

## Important Notes

Attachments use `mdasset://` references and require Pictether for display in the original notes. Use the export feature when sharing with other Markdown tools.

Cloud storage is optional for local use. A successful connection test does not verify upload permissions.

### Reset Warning

**Reset deletes managed local attachments in every namespace under the current attachment root, including attachments used by other vaults sharing that directory. Unbacked files cannot be recovered.**

Review the directory and file counts before confirming. Notes and cloud objects are preserved. Reconfigure object storage afterward to restore backed-up attachments.

---

Author: [dhengsun](https://github.com/dhengsun) · [MIT License](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)