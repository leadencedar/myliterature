import type { NovelRepository } from '@/data/NovelRepository';
import type { WritingNorm, WritingNormScope } from '@/domain/schema';

/**
 * 端到端注入测试的写作规范夹具。
 *
 * 正文全是通用规则、不含任何原作事实：测试只关心「规范有没有进对地方」，
 * 带上某部作品的专名反而会让人误以为测试依赖它。
 * 唯一标记用来在请求体里精确断言「含 / 不含」，不会和任何提示词固定文案撞上。
 */
export const NORM_FIXTURE_MARKER = '【夹具标记 N-7F3】';

export const NORM_FIXTURE = {
  title: '使用提示',
  content: [
    '## 写作规则',
    '- 以已导入资料为原作基线，以本作当前时期为准。',
    '- 同一人物在不同时期的身份不能混用。',
    '- 阶段性称号不新增为人物条目。',
    '- 组织、地点与技术不因名字相近而自动合并。',
    '- 保留「原作未明确」「角色推测」这类限定。',
    '- 缺失信息只能作为建议，未经作者采用不成为事实。',
    '- 新增能力须写明来源、条件、消耗、失效条件与社会后果。',
    '- 分叉之后按新因果续写，并更新受影响的后续事件。',
    NORM_FIXTURE_MARKER,
  ].join('\n'),
} as const;

/** 在仓储里建一份夹具规范；默认启用、五个作用范围全开（与仓储缺省一致） */
export function createFixtureNorm(
  repository: NovelRepository,
  novelId: string,
  options: { scopes?: WritingNormScope[]; enabled?: boolean } = {},
): Promise<WritingNorm> {
  return repository.createWritingNorm(novelId, {
    title: NORM_FIXTURE.title,
    content: NORM_FIXTURE.content,
    ...(options.scopes ? { scopes: options.scopes } : {}),
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
  });
}
