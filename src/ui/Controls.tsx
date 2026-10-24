import { useId, type ReactNode } from 'react';

/** 分段控件：少量互斥选项的首选，比下拉更适合移动端 */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; description?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium text-ink-700">{label}</legend>
      <div className="flex gap-1 rounded-xl bg-paper-sunken p-1">
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(option.value)}
              className={[
                'flex-1 rounded-lg px-2 py-2 text-sm font-medium transition-colors',
                active ? 'bg-paper-raised text-ink-900 shadow-sm' : 'text-ink-500',
              ].join(' ')}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {options.find((option) => option.value === value)?.description ? (
        <p className="text-xs leading-relaxed text-ink-500">
          {options.find((option) => option.value === value)?.description}
        </p>
      ) : null}
    </fieldset>
  );
}

/** 标签组：可多选或单选的紧凑选项，适合子类、分类这类数量不定的取值 */
export function ChipGroup({
  label,
  hint,
  options,
  selected,
  onToggle,
}: {
  label: string;
  hint?: ReactNode;
  options: { value: string; label: string }[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium text-ink-700">{label}</legend>
      {hint ? <p className="text-xs leading-relaxed text-ink-500">{hint}</p> : null}
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const active = selected.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => onToggle(option.value)}
              className={[
                'rounded-full border px-3 py-1.5 text-sm transition-colors',
                active
                  ? 'border-ink-900 bg-ink-900 text-paper'
                  : 'border-ink-100 bg-paper-raised text-ink-700',
              ].join(' ')}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

/** 单选列表：选项带较长说明时比分段控件更合适 */
export function RadioList<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; description?: string }[];
  onChange: (value: T) => void;
}) {
  const name = useId();
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium text-ink-700">{label}</legend>
      <div className="flex flex-col gap-1.5">
        {options.map((option) => {
          const active = option.value === value;
          return (
            <label
              key={option.value}
              className={[
                'flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 transition-colors',
                active ? 'border-ink-900 bg-paper-sunken' : 'border-ink-100 bg-paper-raised',
              ].join(' ')}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={active}
                onChange={() => onChange(option.value)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-ink-900"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink-900">{option.label}</span>
                {option.description ? (
                  <span className="mt-0.5 block text-xs leading-relaxed text-ink-500">
                    {option.description}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** 滑杆：用于强度这类连续取值 */
export function Slider({
  label,
  value,
  min = 0,
  max = 100,
  step = 5,
  valueLabel,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  valueLabel?: string;
  onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium text-ink-700">
          {label}
        </label>
        <span className="text-xs text-ink-500">{valueLabel ?? value}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-6 w-full accent-ink-900"
      />
    </div>
  );
}

/** 开关：布尔选项 */
export function Toggle({
  label,
  description,
  checked,
  onChange,
  ariaLabel,
  tapTarget = false,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /**
   * 无障碍名。不传时沿用 <label htmlFor>（可见文字），与现在一致。
   * 列表里每行可见文字都是「启用」时，靠它让读屏区分是哪一行的开关。
   */
  ariaLabel?: string;
  /** 为 true 时文字与开关所在区域至少 44×44px；默认 false，现有用处的视觉不变 */
  tapTarget?: boolean;
}) {
  const id = useId();
  const input = (
    <input
      id={id}
      type="checkbox"
      checked={checked}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.checked)}
      className="mt-0.5 h-5 w-5 shrink-0 accent-ink-900"
    />
  );
  return (
    // 不传 tapTarget 时类名与结构和改动前逐字节相同，现有界面与测试不受影响
    <div className={`flex ${tapTarget ? 'items-center' : 'items-start'} justify-between gap-3`}>
      <span className="min-w-0">
        <label
          htmlFor={id}
          className={
            tapTarget
              ? 'tap-target inline-flex items-center text-sm font-medium text-ink-700'
              : 'text-sm font-medium text-ink-700'
          }
        >
          {label}
        </label>
        {description ? (
          <span className="mt-0.5 block text-xs leading-relaxed text-ink-500">{description}</span>
        ) : null}
      </span>
      {tapTarget ? (
        // 用 label 而不是 span 包：点 span 里 input 之外的空白不会切换，
        // 一个 input 关联多个 label 是合法 HTML，整块 44×44 都可点；
        // 有 ariaLabel 时它决定无障碍名，多个 label 不会让名字变成「启用 启用」
        <label htmlFor={id} className="tap-target inline-flex items-center justify-center">
          {input}
        </label>
      ) : (
        input
      )}
    </div>
  );
}
