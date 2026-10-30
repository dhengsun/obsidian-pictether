import { AssetStorage } from '../core/storage';

/** Use the host Electron runtime, without bundling or installing another Electron. */
export async function openSystemAsset(storage: AssetStorage, key: string, openPath?: (path: string) => Promise<string>): Promise<void> {
  // Revalidate on every click: the file may have disappeared or become a symlink.
  const local = await storage.describe(key);
  const open = openPath ?? (require('electron') as { shell: { openPath(path: string): Promise<string> } }).shell.openPath;
  const error = await open(local.path);
  if (error) throw new Error('Could not open attachment with the system default application. Check the file association.');
}
