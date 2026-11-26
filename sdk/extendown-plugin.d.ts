/** Document text and revision at the moment a command starts. */
export interface PluginDocument {
  readonly source: string;
  readonly revision: number;
}

export interface PluginInput {
  readonly command: string;
  /** Present when the command is granted document.read and a document is available. */
  readonly document?: PluginDocument;
}

/** A plain-text notice, a candidate Markdown replacement, or both. */
export type PluginResult =
  | { readonly message: string; readonly source?: string }
  | { readonly message?: string; readonly source: string };

/** Declare a synchronous global function named run with this signature. */
export type PluginRun = (input: PluginInput) => PluginResult;
