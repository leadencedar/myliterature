/**
 * 内联图标集。刻意不引入图标库：阶段一要求零第三方脚本，
 * 且 Tab 栏只需要五个图标，内联的体积与可控性都更好。
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function Base({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

/** 书架 */
export function ShelfIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4 4.5h5.2a2 2 0 0 1 2 2V20a2 2 0 0 0-2-2H4z" />
      <path d="M20 4.5h-5.2a2 2 0 0 0-2 2V20a2 2 0 0 1 2-2H20z" />
    </Base>
  );
}

/** 知识库 */
export function KnowledgeIcon(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="12" cy="6" r="2.4" />
      <circle cx="5.6" cy="17" r="2.4" />
      <circle cx="18.4" cy="17" r="2.4" />
      <path d="M10.2 7.8 7.2 14.9M13.8 7.8l3 7.1M8 17h8" />
    </Base>
  );
}

/** 写作 */
export function WriteIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M16.6 3.9a2 2 0 0 1 2.8 2.8L8.5 17.6l-4 1.2 1.2-4z" />
      <path d="M14.4 6.1l3.5 3.5" />
    </Base>
  );
}

/** 计划 */
export function PlanIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="3.5" y="5" width="17" height="15" rx="2.2" />
      <path d="M3.5 9.6h17M8.4 3.4v3.2M15.6 3.4v3.2" />
      <path d="M8 13.4l1.6 1.6 3-3.2" />
    </Base>
  );
}

/** 设置 */
export function SettingsIcon(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="2.8" />
      <path d="M12 3.2v2.4M12 18.4v2.4M4.8 12H2.4M21.6 12h-2.4M6.9 6.9 5.2 5.2M18.8 18.8l-1.7-1.7M6.9 17.1l-1.7 1.7M18.8 5.2l-1.7 1.7" />
    </Base>
  );
}

/** 返回 */
export function BackIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M15 5l-7 7 7 7" />
    </Base>
  );
}

/** 新增 */
export function PlusIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 5v14M5 12h14" />
    </Base>
  );
}

/** 更多操作 */
export function MoreIcon(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="12" cy="5.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="18.5" r="1.4" fill="currentColor" stroke="none" />
    </Base>
  );
}

/** 已选中 */
export function CheckIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4.5 12.5l5 5 10-10.5" />
    </Base>
  );
}

/** 关闭 */
export function CloseIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Base>
  );
}

/** 展开 / 折叠指示 */
export function ChevronIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M8 10l4 4 4-4" />
    </Base>
  );
}

/** 重新生成 */
export function RefreshIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M20 11a8 8 0 1 0-2.6 5.9" />
      <path d="M20 5.5V11h-5.2" />
    </Base>
  );
}

/** 撤销 / 还原 */
export function UndoIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4 9h10a5 5 0 0 1 0 10H8" />
      <path d="M7.5 5.5 4 9l3.5 3.5" />
    </Base>
  );
}

/** 搜索 */
export function SearchIcon(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l4.5 4.5" />
    </Base>
  );
}

/** 删除 / 回收站 */
export function TrashIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.9 12.2A1.5 1.5 0 0 0 8.9 20.5h6.2a1.5 1.5 0 0 0 1.5-1.3L17.5 7" />
      <path d="M10.5 11v6M13.5 11v6" />
    </Base>
  );
}

/** 置顶 / 核心标记 */
export function PinIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M9 3.5h6l-.8 6 3.3 3.3H6.5L9.8 9.5z" />
      <path d="M12 12.8V20.5" />
    </Base>
  );
}

/** 分类 */
export function FolderIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l1.8 2H19a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />
    </Base>
  );
}

/** 恢复 */
export function RestoreIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4 12a8 8 0 1 0 2.6-5.9" />
      <path d="M4 5.5V11h5.2" />
    </Base>
  );
}

/** 译名表：两种文字之间的对照 */
export function GlossaryIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4 7h6M7 7v10" />
      <path d="M13.5 17l3.5-9 3.5 9" />
      <path d="M14.8 14h4.4" />
    </Base>
  );
}

/** 导入旧稿：文稿 + 向内的箭头 */
export function ImportIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 3v9" />
      <path d="M8.5 8.5 12 12l3.5-3.5" />
      <path d="M4.5 15v3A1.5 1.5 0 0 0 6 19.5h12a1.5 1.5 0 0 0 1.5-1.5v-3" />
    </Base>
  );
}

/** 排序把手 */
export function ReorderIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M8 6h8M8 12h8M8 18h8" />
    </Base>
  );
}

/** 上移 */
export function ArrowUpIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </Base>
  );
}

/** 下移 */
export function ArrowDownIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 5v14M6 13l6 6 6-6" />
    </Base>
  );
}

/** 降级（缩进） */
export function IndentIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M5 6h14M9 12h10M9 18h10" />
      <path d="M5 10.5l2.5 1.5L5 13.5z" fill="currentColor" stroke="none" />
    </Base>
  );
}

/** 升级（取消缩进） */
export function OutdentIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M5 6h14M9 12h10M9 18h10" />
      <path d="M7.5 10.5L5 12l2.5 1.5z" fill="currentColor" stroke="none" />
    </Base>
  );
}
