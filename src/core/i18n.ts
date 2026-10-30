/** UI language follows Obsidian. Core modules never import the host API. */
let languageProvider: () => string = () => 'en';
export function setLanguageProvider(provider: () => string): void {
  languageProvider = provider;
}
export const english: Readonly<Record<string, string>> = {
  'Access Key ID 和 Secret Access Key 指向同一个凭据条目。请在设置中重新填写两项并点击“保存凭据”，然后重新加载插件。':
    'Access Key ID and Secret Access Key reference the same entry. Re-enter both credentials in settings and reload the plugin.',
  'OSS Endpoint 必须是有效的 HTTPS S3 API 地址。': 'The endpoint must be a valid HTTPS S3 API URL.',
  'OSS Endpoint 必须是 HTTPS 地址，不能包含凭据、路径或查询参数。':
    'The endpoint must use HTTPS without credentials, a path, or query parameters.',
  'OSS Bucket 名称无效，请填写 Bucket 名称而非 URL。':
    'Invalid bucket name. Enter the bucket name, not a URL.',
  '云端未找到该附件，笔记引用已保留。':
    'The attachment was not found in cloud storage. Its note reference has been preserved.',
  '附件内容或校验信息不一致，已停止处理并保留原文件。':
    'Attachment content or checksums differ. Processing stopped and the original file was preserved.',
  '云端操作失败，请检查本地权限、网络和 OSS 配置后重试。':
    'Cloud operation failed. Check local permissions, your network, and object storage settings.',
  'OSS Bucket 不存在，请检查 Endpoint 和 Bucket 名称。':
    'The bucket does not exist. Check the endpoint and bucket name.',
  'OSS 拒绝了请求参数，请检查两项 S3 凭据是否分别对应 Access Key ID 和 Secret Access Key，以及 Endpoint 是否为目标账户的 S3 API 地址。':
    'Object storage rejected the request parameters. Check both S3 credential fields and the account S3 API endpoint.',
  'OSS 请求时间校验失败，请检查系统时间后重试。':
    'Request time validation failed. Check your system clock and retry.',
  'OSS 凭据未能被 SDK 正确读取，请重新选择两项凭据并重新加载插件。':
    'The SDK could not read the credentials. Re-enter both fields and reload the plugin.',
  'OSS 凭据无效或权限不足，请检查 AK、Secret Key 和目标 Bucket 的读写权限。':
    'Invalid credentials or insufficient permissions. Check the access key, secret key, and bucket read/write permissions.',
  'OSS 返回了非预期响应，请核对 S3 API Endpoint 和代理配置。':
    'Unexpected object storage response. Check the S3 API endpoint and proxy settings.',
  '无法连接 OSS，请检查网络、Endpoint 或代理设置后重试。':
    'Cannot connect to object storage. Check your network, endpoint, and proxy settings.',
  'OSS TLS 证书验证失败，请检查 Endpoint、系统时间或代理证书。':
    'TLS certificate validation failed. Check the endpoint, system clock, and proxy certificates.',
  'OSS 服务暂时不可用，请稍后重试。': 'Object storage is temporarily unavailable. Try again later.',
  'OSS 连接检查失败：': 'Connection check failed: ',
  '重置已停止：附件根目录必须是绝对路径。':
    'Reset stopped: the attachment root must be an absolute path.',
  '重置已停止：不能清理系统根目录或用户主目录。':
    'Reset stopped: the filesystem root and home directory cannot be cleared.',
  '重置已停止：附件目录不能包含笔记库，也不能位于笔记库或插件目录内。':
    'Reset stopped: the attachment directory must not contain or be inside the vault or plugin directory.',
  '重置已停止：附件根目录是符号链接。': 'Reset stopped: the attachment root is a symbolic link.',
  '重置已停止：受管理路径中存在符号链接或异常文件类型。':
    'Reset stopped: a managed path contains a symbolic link or an unexpected file type.',
  '重置已停止：附件目录中存在符号链接，请先人工检查。':
    'Reset stopped: the attachment directory contains symbolic links. Inspect it manually first.',
  '本地附件范围已变化，请重新打开重置确认框。':
    'Local attachments have changed. Reopen the reset confirmation dialog.',
  '重置已停止：附件目录身份发生变化。':
    'Reset stopped: the attachment directory changed during cleanup.',
  '重置已停止：待删除文件发生变化，请重新确认。':
    'Reset stopped: a file selected for deletion has changed. Confirm the scope again.',
  '重置期间本地附件范围发生变化，请重新确认剩余文件。':
    'Local attachments changed during reset. Confirm the remaining files again.',
  默认凭据: 'Default credentials',
  'Pictether: OSS 凭据不可用，请编辑 RK 重新填写。':
    'Pictether: Storage credentials are unavailable. Edit the credential entry and re-enter both fields.',
  'Pictether: OSS 初始化失败：{0}': 'Pictether: Object storage initialization failed: {0}',
  '插件已停用。': 'The plugin has been disabled.',
  '请先完成重置。': 'Complete the pending reset first.',
  '配置正在切换或重置，请稍后重试。': 'Settings are being applied or reset. Try again shortly.',
  '无法读取本地附件清理范围，请检查目录权限后重试。':
    'Cannot inspect local attachments for reset. Check directory permissions and retry.',
  '数据库不可用，重置未开始。': 'The database is unavailable. Reset has not started.',
  '重置未完成，部分本地附件可能已删除。笔记和云端已保留，请检查本地权限与 SecretStorage 后点击“继续重置”。':
    'Reset is incomplete. Some local attachments may already be deleted. Notes and cloud objects are preserved. Check local permissions and SecretStorage, then choose Resume reset.',
  'Pictether 已重置，本地受管理附件已删除，笔记和云端已保留。{0}':
    'Pictether has been reset. Managed local attachments were deleted; notes and cloud objects were preserved. {0}',
  '目录中另有未识别项目，已保留，请人工检查。':
    'Unrecognized items were preserved. Inspect them manually.',
  'Pictether: 配置正在切换或重置，请稍后导入。':
    'Pictether: Settings are being applied or reset. Import again shortly.',
  'Pictether: 附件已保留在本地，但备份记录无法保存。修复存储后自动备份会重新发现。':
    'Pictether: The attachment is saved locally, but its backup record could not be saved. Automatic backup will rediscover it after storage is repaired.',
  '插件已停用，请重新加载后操作。': 'The plugin is disabled. Reload it before continuing.',
  '设置已修改，请重新加载 Pictether 后再执行云端操作。':
    'Settings have changed. Reload Pictether before using cloud operations.',
  'SQLite 备份记录不可用，请先修复数据库问题；本地附件仍可使用。':
    'SQLite backup records are unavailable. Fix the database first; local attachments remain usable.',
  '请配置 OSS 地址、存储桶并启用一组 RK。':
    'Configure an endpoint and bucket, then activate a credential entry.',
  'Pictether: {0} 个附件可用，{1} 个恢复失败。重新打开笔记可刷新预览。':
    'Pictether: {0} attachments available; {1} could not be restored. Reopen the note to refresh previews.',
  新凭据: 'New credentials',
  '编辑 RK': 'Edit credentials',
  '新增 RK': 'Add credentials',
  '直接填写访问凭据，测试后保存。': 'Enter your access credentials, test the connection, and save.',
  名称: 'Name',
  '••••••••（已保存，留空保留）': '•••••••• (saved; leave blank to keep)',
  '填写 {0}': 'Enter {0}',
  未测试: 'Not tested',
  '连接正常 · 留空沿用已保存凭据': 'Connected · Leave blank to keep saved credentials',
  '上次测试失败，可重新测试或填写两项替换。':
    'The last test failed. Retry or replace both credential fields.',
  '留空可测试已保存凭据；替换时同时填写两项。':
    'Leave both fields blank to test saved credentials, or fill in both to replace them.',
  测试连接: 'Test connection',
  '测试中…': 'Testing…',
  取消: 'Cancel',
  保存: 'Save',
  '配置正在切换或重置尚未完成，请稍后重试。':
    'Settings are being applied or reset is incomplete. Try again shortly.',
  '该凭据已不存在，请重新打开设置。': 'This credential entry no longer exists. Reopen settings.',
  '已保存的凭据不可用，请重新填写 ID 和 Key。':
    'Saved credentials are unavailable. Re-enter the ID and key.',
  '请同时填写 Access Key ID 和 Secret Access Key。':
    'Enter both Access Key ID and Secret Access Key.',
  连接正常: 'Connected',
  '请填写不超过 80 字的凭据名称。': 'Enter a credential name of no more than 80 characters.',
  'SecretStorage 不可用，凭据未保存。': 'SecretStorage is unavailable. Credentials were not saved.',
  '凭据保存失败，原配置已保留。':
    'Could not save credentials. The previous configuration was preserved.',
  '该凭据已不存在，修改未保存。': 'This credential entry no longer exists. Changes were not saved.',
  '重置正在进行，修改未保存。': 'Reset is in progress. Changes were not saved.',
  'SecretStorage 不可用，凭据清理待重试。':
    'SecretStorage is unavailable. Credential cleanup needs to be retried.',
  '凭据清理未完成，请重试删除或重置。':
    'Credential cleanup is incomplete. Retry deletion or reset.',
  'SecretStorage 不可用，重置未完成。': 'SecretStorage is unavailable. Reset is incomplete.',
  '密钥清理失败，重置待重试。': 'Could not clear credentials. Retry reset.',
  'Access Key ID 和 Secret Access Key 不能相同，请填写 Cloudflare 提供的对应两项值。':
    'Access Key ID and Secret Access Key must differ. Enter the two corresponding values provided by Cloudflare.',
  'Obsidian SecretStorage 不可用，凭据未保存。':
    'Obsidian SecretStorage is unavailable. Credentials were not saved.',
  '凭据保存失败，原配置已保留。请检查 SecretStorage 和插件存储后重试。':
    'Could not save credentials. The previous configuration was preserved. Check SecretStorage and plugin storage before retrying.',
  确认: 'Confirm',
  '重置 Pictether': 'Reset Pictether',
  '删除当前附件根目录下所有命名空间的受管理附件，并清空配置、记录、统计与插件密钥。笔记和云端保留。':
    'Delete managed attachments in every namespace under the current attachment root, and clear settings, records, statistics, and plugin credentials. Notes and cloud objects are preserved.',
  '正在检查本地附件…': 'Inspecting local attachments…',
  '我确认共用此目录的其他库也受影响，未备份的本地附件将永久丢失。':
    'I understand that other vaults sharing this directory are affected and unbacked local attachments will be permanently lost.',
  删除本地附件并重置: 'Delete local attachments and reset',
  '请关闭此窗口，重新检查范围后继续重置。':
    'Close this dialog and review the scope again before resuming reset.',
  '本地目录：{0}\n{1} 个命名空间，{2} 个附件。{3}':
    'Local directory: {0}\n{1} namespaces, {2} attachments. {3}',
  '另有 {0} 个未识别项目会保留。': '{0} unrecognized items will be preserved.',
  '无法确认删除范围，重置未开始。': 'Cannot determine the deletion scope. Reset has not started.',
  通用设置: 'General',
  附件根目录: 'Attachment root',
  编辑附件根目录: 'Edit attachment root',
  保存附件根目录: 'Save attachment root',
  '附件统一保存在此目录。': 'Store attachments in this directory.',
  仓库名: 'Vault name',
  保存通用设置: 'Save general settings',
  '附件根目录必须为绝对路径。': 'The attachment root must be an absolute path.',
  'OSS 配置': 'Object storage',
  'S3 兼容对象存储': 'S3-compatible object storage',
  服务地址: 'Endpoint',
  存储桶: 'Bucket',
  高级设置: 'Advanced',
  签名区域: 'Signing region',
  'R2 使用 auto，其他服务按其 S3 配置填写。':
    'Use auto for R2, or the S3 signing region required by your provider.',
  '保存 OSS 配置': 'Save storage settings',
  '签名区域格式无效。': 'Invalid signing region format.',
  'RK 访问凭据': 'Access credentials',
  '请先保存 OSS 地址和存储桶。': 'Save the endpoint and bucket first.',
  尚未添加凭据: 'No credentials added',
  连接失败: 'Connection failed',
  当前: 'Active',
  启用: 'Activate',
  '{0} 的更多操作': 'More actions for {0}',
  更多操作: 'More actions',
  编辑: 'Edit',
  删除: 'Delete',
  '删除 RK': 'Delete credentials',
  '删除“{0}”及其专属密钥，笔记、本地附件和云端保持不变。':
    'Delete “{0}” and its dedicated keys. Notes, local attachments, and cloud objects will be preserved.',
  备份与恢复: 'Backup and recovery',
  '启用一组 RK 后，自动备份已有及新增附件。':
    'Activate a credential entry to back up existing and new attachments automatically.',
  '填写服务地址和存储桶后开始备份。': 'Enter an endpoint and bucket to start backing up.',
  '开启后自动备份已有及新增附件。':
    'Automatically back up existing and new attachments when enabled.',
  自动备份: 'Automatic backup',
  恢复缺失附件: 'Restore missing attachments',
  '从 OSS 补齐笔记引用的缺失文件。':
    'Restore missing files referenced by notes from object storage.',
  恢复: 'Restore',
  重置未完成: 'Reset incomplete',
  重置插件: 'Reset plugin',
  '删除当前根目录内全部受管理附件，清空配置、记录、统计和插件密钥。保留笔记与云端。':
    'Delete all managed attachments under the current root and clear settings, records, statistics, and plugin credentials. Preserve notes and cloud objects.',
  继续重置: 'Resume reset',
  重置: 'Reset',
  今日概览: 'Today',
  备份统计: 'Backup statistics',
  '备份{0}，成功{1}，冲突{2}，失败{3}': 'Backups {0}, successful {1}, conflicts {2}, failed {3}',
  统计暂不可用: 'Statistics unavailable',
  备份次数: 'Backup attempts',
  成功: 'Succeeded',
  冲突: 'Conflicts',
  失败: 'Failed',
  '按本地自然日统计附件备份尝试。': 'Attachment backup attempts for the current local day.',
  本地数据库暂不可用: 'Local database unavailable',
  今日统计暂不可用: 'Daily statistics unavailable',
};
export const chinese: Readonly<Record<string, string>> = {
  'Insert Attachment': '插入附件',
  'Restore Missing Attachments': '恢复缺失附件',
  'Export Note with Attachments': '导出笔记与附件',
  Attachment: '附件',
  'Open attachment': '打开附件',
  'Open with default application': '使用默认应用打开',
  'Click to preview': '点击预览',
  'Invalid Pictether reference: {0}': '无效的 Pictether 引用：{0}',
  'Loading attachment…': '正在加载附件…',
  'Loading image…': '正在加载图片…',
  'Previous page': '上一页',
  'Next page': '下一页',
  'Loading PDF…': '正在加载 PDF…',
  'PDF unavailable': 'PDF 无法显示',
  'Cannot render this PDF. Use the attachment link to open it.':
    '无法渲染此 PDF，请通过附件链接打开。',
  'Could not load PDF. Use the attachment link to open it.': '无法加载 PDF，请通过附件链接打开。',
  'Could not open attachment. Check Assets Root, the file and its default application.':
    '无法打开附件，请检查附件根目录、文件及其默认应用。',
  'Video cannot play with the installed codecs. Use Open attachment.':
    '当前编码无法播放此视频，请点击“打开附件”。',
  'Cannot decode image: {0}': '无法解码图片：{0}',
  '{0} (.{1}) — Open attachment': '{0}（.{1}）— 打开附件',
  'Attachment unavailable: {0}. Check Assets Root or run Restore Missing Attachments.':
    '附件无法显示：{0}。请检查附件根目录或执行“恢复缺失附件”。',
  'Image unavailable: {0}. Check Assets Root or run Restore Missing Attachments.':
    '图片无法显示：{0}。请检查附件根目录或执行“恢复缺失附件”。',
  'Export parent directory': '导出父目录',
  'Existing absolute directory. A new unique subdirectory will be created.':
    '选择已存在的绝对路径，将在其中创建新的独立子目录。',
  Export: '导出',
  'Pictether: Exported to {0}': 'Pictether：已导出至 {0}',
  'Pictether: Open a Markdown editor to insert attachments.':
    'Pictether：请先打开 Markdown 编辑器再插入附件。',
  'Pictether: Attachment import failed. {0}': 'Pictether：附件导入失败。{0}',
  'Check attachment content and directory permissions.': '请检查附件内容与目录权限。',
  'Pictether: Attachments saved, but the target editor changed. References:\n{0}':
    'Pictether：附件已保存，但目标编辑器已变化。引用：\n{0}',
  'Import failed.': '导入失败。',
  'Export failed.': '导出失败。',
  'Pictether: SQLite records are safe, but settings could not be saved. Original JSON was preserved; retry after fixing disk permissions.':
    'Pictether：SQLite 记录安全，但设置保存失败。原 JSON 已保留，请修复磁盘权限后重试。',
  'Pictether: {0} Node {1}; Electron {2}. Local attachments and original records are preserved.':
    'Pictether：{0} Node {1}；Electron {2}。本地附件与原始记录已保留。',
  'Pictether requires a desktop filesystem vault.': 'Pictether 需要桌面端本地文件系统笔记库。',
  'SQLite backup records unavailable.': 'SQLite 备份记录不可用。',
  'System opening is unavailable. Reload Pictether.': '系统打开功能不可用，请重新加载 Pictether。',
};
/** A callback replacement keeps user text such as "$&" literal. */
export function t(key: string, ...values: (string | number)[]): string {
  const translated = languageProvider().toLowerCase().startsWith('zh')
    ? (chinese[key] ?? key)
    : (english[key] ?? key);
  return translated.replace(/\{(\d+)\}/g, (placeholder, index: string) =>
    values[Number(index)] === undefined ? placeholder : String(values[Number(index)]),
  );
}
