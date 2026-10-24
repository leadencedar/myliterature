import { z } from 'zod';
import { ENTRY_STATUSES, OC_ASPECTS, OPTION_TENDENCIES, OptionRiskSchema } from '@/domain/schema';

/**
 * 互动推演里模型产出的形状（设计 D3.1）。
 *
 * 引用用名称、目标与里程碑用序号（G1、M2…）：模型抄名字和序号比抄 id 稳，解析成 id 由代码在落库前做一次
 * （worldline.ts 的 resolveStepChanges / resolveStepProgress / resolveStepEnding）。
 * 各数组都设上限：newEntries ≤ 2 同时是防发散手段，一步最多引入两个新实体。
 * 枚举常量从 schema.ts 引，避免循环引用。
 */

/** 一个选项：只写主角要做什么；倾向与风险是固定枚举，结构上就剧透不了结果 */
export const OptionOutSchema = z.object({
  text: z.string().trim().min(2).max(60),
  tendency: z.enum(OPTION_TENDENCIES),
  // 按主角此刻看得见的危险标
  risk: OptionRiskSchema,
});
export type OptionOut = z.infer<typeof OptionOutSchema>;

export const StepTailSchema = z
  .object({
    challenge: z.string().trim().max(300),
    options: z.array(OptionOutSchema).max(4),
    changes: z.object({
      fieldChanges: z
        .array(
          z.object({
            entry: z.string().trim().min(1).max(120),
            field: z.string().trim().min(1).max(40),
            value: z.string().trim().min(1).max(500),
          }),
        )
        .max(8),
      newEntries: z
        .array(
          z.object({
            category: z.string().trim().min(1),
            title: z.string().trim().min(1).max(120),
            summary: z.string().trim().max(60),
            fields: z
              .array(
                z.object({
                  field: z.string().trim().min(1),
                  value: z.string().trim().min(1).max(1000),
                }),
              )
              .max(12),
          }),
        )
        .max(2),
      statusChanges: z
        .array(
          z.object({
            entry: z.string().trim().min(1).max(120),
            status: z.enum(ENTRY_STATUSES),
            note: z.string().trim().max(80),
          }),
        )
        .max(4),
      ocChanges: z
        .array(
          z.object({
            aspect: z.enum(OC_ASPECTS),
            op: z.enum(['add', 'remove']),
            text: z.string().trim().min(1).max(80),
          }),
        )
        .max(6),
      events: z.array(z.string().trim().min(1).max(80)).max(3),
      flags: z
        .array(
          z.object({
            key: z.string().trim().min(1).max(30),
            value: z.string().trim().min(1).max(60),
          }),
        )
        .max(4),
    }),
    progress: z.object({
      // 提示词里 M1、M2… 的序号
      reachedMilestones: z.array(z.number().int().min(1)).max(2),
      note: z.string().trim().max(120),
    }),
    ending: z
      .object({
        kind: z.enum(['good', 'bad', 'neutral']),
        // G1、G2… 的序号；开放结局为 null
        goal: z.number().int().min(1).nullable(),
        title: z.string().trim().min(1).max(30),
        // 是哪个选择 / 哪种状态导致了它：界面上显示「起因：…」，作者一眼能看出是不是硬转
        cause: z.string().trim().min(1).max(120),
      })
      .nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.ending === null) {
      if (v.options.length < 2) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: '没有结局时必须给 2–4 个选项' });
      }
      if (!v.challenge) {
        ctx.addIssue({ code: 'custom', path: ['challenge'], message: '没有结局时必须给出挑战' });
      }
    } else if (v.options.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: '触发结局时不再给选项' });
    }
  });
export type StepTail = z.infer<typeof StepTailSchema>;

/**
 * 收尾：ending 必填。refine 不进 JSON Schema，所以收尾请求的【输出格式】与普通一步逐字节相同，
 * 系统提示整体也就相同（共享前缀缓存）
 */
export const WrapUpTailSchema = StepTailSchema.refine((v) => v.ending !== null, {
  path: ['ending'],
  message: '作者要求收尾：必须写出结局',
});

/** 「再给几个选项」 */
export const OptionsBatchSchema = z.object({ options: z.array(OptionOutSchema).min(2).max(4) });
export type OptionsBatch = z.infer<typeof OptionsBatchSchema>;

/** 检查点前情摘要 */
export const SummaryOutSchema = z.object({
  summary: z.string().trim().min(1).max(600),
  openThreads: z.array(z.string().trim().min(1).max(120)).max(8),
});
export type SummaryOut = z.infer<typeof SummaryOutSchema>;
