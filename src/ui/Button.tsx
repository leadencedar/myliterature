import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** 撑满父容器宽度，移动端主操作常用 */
  block?: boolean;
  children?: ReactNode;
}

/**
 * hover 用 `enabled:hover:` 而不是裸 `hover:`。
 *
 * `:hover` 与 `:disabled` 的选择器特异性相同，谁生效取决于生成样式表里的先后顺序 ——
 * 那是不该依赖的实现细节。显式排除 disabled 状态，禁用按钮就不会在鼠标掠过时变色。
 * （`hover` 变体本身由 Tailwind 包在 `@media (hover: hover)` 里，触屏设备不会粘住。）
 */
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-ink-900 text-paper enabled:hover:bg-ink-700 active:bg-ink-700 disabled:bg-ink-300',
  secondary:
    'bg-paper-sunken text-ink-900 enabled:hover:bg-ink-100 active:bg-ink-100 disabled:text-ink-300',
  ghost:
    'bg-transparent text-ink-700 enabled:hover:bg-paper-sunken active:bg-paper-sunken disabled:text-ink-300',
  danger:
    'bg-seal-soft text-seal enabled:hover:bg-seal enabled:hover:text-paper active:bg-seal active:text-paper disabled:text-ink-300',
};

const SIZES: Record<Size, string> = {
  // 即便是 sm，触控高度也不低于 36px；主操作用 md/lg 满足 44px
  sm: 'h-9 px-3 text-sm rounded-lg',
  md: 'h-11 px-4 text-[0.9375rem] rounded-xl',
  lg: 'h-12 px-5 text-base rounded-xl',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  block = false,
  className = '',
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={[
        'inline-flex items-center justify-center gap-1.5 font-medium transition-colors',
        // 浏览器给 <button> 的默认光标是 default，桌面端必须显式改成手型
        'cursor-pointer disabled:cursor-not-allowed',
        VARIANTS[variant],
        SIZES[size],
        block ? 'w-full' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    />
  );
}

/** 图标按钮，保证 44px 触控目标 */
export function IconButton({
  label,
  className = '',
  type = 'button',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type={type}
      aria-label={label}
      className={[
        'tap-target inline-flex items-center justify-center rounded-xl text-ink-500',
        'cursor-pointer transition-colors disabled:cursor-not-allowed disabled:text-ink-300',
        'enabled:hover:bg-paper-sunken enabled:hover:text-ink-900 active:bg-paper-sunken',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {children}
    </button>
  );
}
