import type { Root } from 'hast';
import type { MarkdownExtensionContribution } from '../plugins/contracts.ts';

export type ExportFormat = 'html' | 'pdf' | 'png' | 'jpg';

/** The immutable content boundary shared by every exporter. */
export interface DocumentSnapshot {
  readonly source: string;
  readonly name: string;
  readonly revision: number;
  readonly dialect: 'commonmark-gfm-frontmatter';
  readonly extensions?: readonly MarkdownExtensionContribution[];
  readonly resolveImage?: (reference: string) => Promise<string | null>;
}

export interface ExportOptions {
  readonly title?: string;
  readonly background?: string;
  readonly scale?: number;
  readonly paper?: 'a4' | 'letter';
  readonly orientation?: 'portrait' | 'landscape';
  readonly marginMm?: number;
  readonly splitImages?: boolean;
}

export interface ExportArtifact {
  readonly format: ExportFormat;
  readonly mimeType: string;
  readonly suggestedName: string;
  readonly bytes: Uint8Array;
  readonly revision: number;
}

export interface Exporter {
  readonly format: ExportFormat;
  readonly kind: 'web' | 'native';
  readonly available: boolean;
  export(snapshot: Readonly<DocumentSnapshot>, options?: Readonly<ExportOptions>): Promise<ExportArtifact>;
}

export type ExportErrorCode =
  | 'unsupported-format'
  | 'native-host-required'
  | 'invalid-options'
  | 'document-too-large'
  | 'render-failed';

export class ExportError extends Error {
  readonly code: ExportErrorCode;

  constructor(code: ExportErrorCode, message: string) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
  }
}

export interface PreparedExportDocument {
  readonly root: Root;
  readonly headingIds: ReadonlyMap<number, string>;
  readonly title: string;
  readonly revision: number;
}
