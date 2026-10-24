import type { ComponentType, SVGProps } from 'react';
import { KnowledgeIcon, PlanIcon, SettingsIcon, ShelfIcon, WriteIcon } from '@/ui/icons';

export interface TabDefinition {
  /** 路由路径 */
  path: string;
  /** Tab 显示名 */
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** 是否必须先选定一本小说才有意义 */
  requiresNovel: boolean;
}

/** 底部 Tab 定义，是导航的唯一事实源（UI 与测试共用） */
export const TABS: readonly TabDefinition[] = [
  { path: '/', label: '书架', icon: ShelfIcon, requiresNovel: false },
  { path: '/knowledge', label: '知识库', icon: KnowledgeIcon, requiresNovel: true },
  { path: '/write', label: '写作', icon: WriteIcon, requiresNovel: true },
  { path: '/plan', label: '计划', icon: PlanIcon, requiresNovel: true },
  { path: '/settings', label: '设置', icon: SettingsIcon, requiresNovel: false },
];
