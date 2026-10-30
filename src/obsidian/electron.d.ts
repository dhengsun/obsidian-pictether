/** Public Electron API supplied by the desktop host; never bundled. */
declare module 'electron' {
  export const shell: { openPath(path: string): Promise<string> };
}
