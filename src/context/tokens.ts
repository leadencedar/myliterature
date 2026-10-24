/**
 * token 估算。
 *
 * 这是**估算**而非精确计算：真正的分词规则由服务端的 tokenizer 决定，
 * 在前端引入 tokenizer 会带来几百 KB 的体积，对一个只需要「给用户一个量级感」
 * 的场景不值得。请求发出后 `TokenUsage` 会回传真实用量，那才是准数。
 *
 * 系数依据：中文在主流 BPE 分词器下大致一个字对应 0.6–1 个 token，
 * 这里取 0.8 偏保守（宁可高估，避免用户以为很便宜却超支）；
 * 拉丁字母与数字约 4 个字符一个 token，取 0.25。
 */

const CJK_PATTERN =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/u;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK_PATTERN.test(char)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 0.8 + other * 0.25);
}

/** 展示用：1200 → 「约 1.2k tokens」 */
export function formatTokens(count: number): string {
  if (count < 1000) return `约 ${count} tokens`;
  return `约 ${(count / 1000).toFixed(1)}k tokens`;
}
