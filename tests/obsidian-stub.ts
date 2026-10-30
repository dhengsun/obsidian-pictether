import { StateField } from '@codemirror/state';
import type { MarkdownFileInfo } from 'obsidian';
// Public API boundary only; tests use real CodeMirror state and transactions.
export const editorInfoField = StateField.define<MarkdownFileInfo | undefined>({ create: () => undefined, update: value => value });
export const editorLivePreviewField = StateField.define<boolean>({ create: () => true, update: value => value });
export class MarkdownRenderChild {
  constructor(readonly containerEl: HTMLElement) {}
}
let pdfTestLibrary:unknown;
export function setPdfTestLibrary(library:unknown):void{pdfTestLibrary=library;}
export async function loadPdfJs():Promise<unknown>{if(!pdfTestLibrary)throw new Error('No PDF library configured for this test.');return pdfTestLibrary;}
