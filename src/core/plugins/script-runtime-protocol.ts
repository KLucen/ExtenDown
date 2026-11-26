export const SCRIPT_PROTOCOL = 1;
export const MAX_SCRIPT_DOCUMENT_BYTES = 2 * 1024 * 1024;
export const MAX_SCRIPT_RESULT_BYTES = 8 * 1024 * 1024;

export interface ScriptInput {
  readonly command: string;
  readonly document?: {
    readonly source: string;
    readonly revision: number;
  };
}

export type PluginExecutionErrorCode =
  | 'invalid-input'
  | 'invalid-result'
  | 'script-failed'
  | 'timeout'
  | 'aborted'
  | 'runtime-unavailable';

const DESCRIPTIONS: Record<PluginExecutionErrorCode, string> = {
  'invalid-input': '插件命令或输入超出支持范围。',
  'invalid-result': '插件必须同步返回大小合规的 JSON 对象。',
  'script-failed': '插件脚本执行失败。请检查入口函数和运行限制。',
  timeout: '插件执行超时。',
  aborted: '已取消插件执行。',
  'runtime-unavailable': '无法启动插件运行环境。',
};

export class PluginExecutionError extends Error {
  readonly code: PluginExecutionErrorCode;

  constructor(code: PluginExecutionErrorCode) {
    super(DESCRIPTIONS[code]);
    this.name = 'PluginExecutionError';
    this.code = code;
  }
}

export interface ScriptRequest {
  readonly protocol: typeof SCRIPT_PROTOCOL;
  readonly script: string;
  readonly input: ScriptInput;
}

export type ScriptReply = {
  readonly protocol: typeof SCRIPT_PROTOCOL;
} & (
  | { readonly ok: true; readonly output: string }
  | { readonly ok: false; readonly code: PluginExecutionErrorCode }
);

export function exceedsUtf8Limit(value: string, limit: number): boolean {
  return value.length > limit || new TextEncoder().encode(value).byteLength > limit;
}
