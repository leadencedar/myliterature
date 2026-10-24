export type LlmErrorKind =
  /** 没填 Key / baseUrl 等本地配置问题 */
  | 'config'
  /** 网络不可达、CORS、被 CSP 拦截 */
  | 'network'
  /** Key 无效 */
  | 'auth'
  /** 余额不足 */
  | 'insufficient-balance'
  /** 触发限流 */
  | 'rate-limit'
  /** 服务端错误 */
  | 'server'
  /** 请求参数被服务端拒绝 */
  | 'bad-request'
  /** 返回内容无法解析或不符合 schema */
  | 'parse'
  /**
   * 输出撞上上限被截断（finish_reason === 'length'）。
   * 与 parse 分开：截断不是提示词问题，修复重试救不回残缺内容，UI 要给「压短输入」这类建议
   */
  | 'truncated'
  /** 用户主动取消 */
  | 'aborted';

/**
 * 统一的 LLM 错误类型。
 * 分类的意义在于 UI 能给出可操作的提示：余额不足要引导充值，
 * 限流要提示稍后重试，解析失败则是提示词问题而非用户问题。
 */
export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly status?: number;
  readonly detail?: string;

  constructor(kind: LlmErrorKind, message: string, options?: { status?: number; detail?: string }) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
    if (options?.status !== undefined) this.status = options.status;
    if (options?.detail !== undefined) this.detail = options.detail;
  }
}

/** 把 HTTP 状态码映射成用户能看懂的错误 */
export function errorFromStatus(status: number, detail: string): LlmError {
  switch (status) {
    case 400:
      return new LlmError('bad-request', '请求被服务端拒绝，可能是模型名或参数不被支持', {
        status,
        detail,
      });
    case 401:
      return new LlmError('auth', 'API Key 无效，请检查设置页填写的密钥', { status, detail });
    case 402:
      return new LlmError('insufficient-balance', '账户余额不足，请先充值', { status, detail });
    case 422:
      return new LlmError('bad-request', '请求参数不合法', { status, detail });
    case 429:
      return new LlmError('rate-limit', '请求过于频繁或已达限额，请稍后再试', { status, detail });
    default:
      if (status >= 500) {
        return new LlmError('server', '模型服务暂时不可用，请稍后重试', { status, detail });
      }
      return new LlmError('server', `请求失败（HTTP ${status}）`, { status, detail });
  }
}

/** fetch 抛出的异常归一化 */
export function errorFromThrown(cause: unknown): LlmError {
  if (cause instanceof LlmError) return cause;
  if (cause instanceof DOMException && cause.name === 'AbortError') {
    return new LlmError('aborted', '已取消');
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return new LlmError(
    'network',
    '无法连接模型服务。请检查网络，以及该接口地址是否在应用的连接白名单内',
    { detail: message },
  );
}
