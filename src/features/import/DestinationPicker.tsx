import type { SideStory } from '@/domain/schema';
import { normalizeSideStoryTitle, sideStoryLabel, sideStoryTitleKey } from '@/domain/sideStory';
import { RadioList } from '@/ui/Controls';
import { SelectField, TextField } from '@/ui/Field';

/**
 * 这一批稿件导入到哪里（界面上的选择）。
 *
 * 比仓储的 ImportDestination 多一个 newSide：新建外传要到 commitImportChapters 的事务里
 * 才真正建出来，在那之前只有一个名字。
 */
export type DestinationChoice =
  | { kind: 'main' }
  | { kind: 'side'; sideStoryId: string }
  | { kind: 'newSide'; title: string }
  | { kind: 'worldview' };

/** 一条线的章数与下一章编号（本线最大 index + 1，空线为 1） */
export interface LineCount {
  count: number;
  next: number;
}

export interface LineCounts {
  main: LineCount;
  perSide: Map<string, LineCount>;
}

/** 外传名称上限，与 SideStorySchema 一致 */
const TITLE_MAX = 40;

/** 下拉框里「新建外传」那一项的值；外传 id 是 uuid，不会和它撞上 */
const NEW_SIDE = '__new__';

/**
 * 目的地是否可以提交。picker 与 ImportScreen 共用，两边判得一样。
 *
 * fieldError 只在需要在「外传名称」字段下报错时给出；名称为空只禁用按钮、不报错。
 * 这里只做即时反馈，重名与外传是否存在最终以仓储事务里的检查为准。
 */
export function validateDestination(
  value: DestinationChoice,
  sideStories: readonly Pick<SideStory, 'id' | 'title'>[],
  llmConfigured: boolean,
): { ok: boolean; fieldError?: string } {
  switch (value.kind) {
    case 'main':
      return { ok: true };
    case 'side':
      return { ok: sideStories.some((story) => story.id === value.sideStoryId) };
    case 'newSide': {
      const title = normalizeSideStoryTitle(value.title);
      if (!title) return { ok: false };
      if (title.length > TITLE_MAX) {
        return { ok: false, fieldError: `外传名称不能超过 ${TITLE_MAX} 字` };
      }
      const key = sideStoryTitleKey(title);
      if (sideStories.some((story) => sideStoryTitleKey(story.title) === key)) {
        return { ok: false, fieldError: '已有同名外传，直接从上面选它' };
      }
      return { ok: true };
    }
    case 'worldview':
      return { ok: llmConfigured };
  }
}

/** 文风勾选框的默认值：主线勾上，外传不勾（番外常刻意换语气，样本也少） */
export function defaultWithStyle(value: DestinationChoice): boolean {
  return value.kind === 'main';
}

/** 选「外传」时的默认：有外传就选第一部，没有就新建 */
function defaultSideChoice(sideStories: readonly Pick<SideStory, 'id'>[]): DestinationChoice {
  const first = sideStories[0];
  return first ? { kind: 'side', sideStoryId: first.id } : { kind: 'newSide', title: '' };
}

const KIND_OPTIONS: { value: 'main' | 'side' | 'worldview'; label: string; description: string }[] =
  [
    {
      value: 'main',
      label: '主线章节',
      description: '接在主线之后编号，生成章节摘要与全书进展。',
    },
    {
      value: 'side',
      label: '外传',
      description: '独立于主线的番外篇章，有自己的编号与摘要链，不计入主线进度。',
    },
    {
      value: 'worldview',
      label: '仅作为世界观设定',
      description: '只提取人物与设定条目，不写成章节、不占编号、不出摘要与文风。',
    },
  ];

interface DestinationPickerProps {
  value: DestinationChoice;
  onChange: (value: DestinationChoice) => void;
  sideStories: readonly SideStory[];
  lineCounts: LineCounts;
  withStyle: boolean;
  /** 用户是否手动改过文风勾选框；改过之后切换目的地不再覆盖他的选择 */
  withStyleTouched: boolean;
  /** touched 为 true 表示这次改动来自用户点击 */
  onWithStyleChange: (checked: boolean, touched: boolean) => void;
  llmConfigured: boolean;
}

/**
 * 导入目的地选择：主线章节 / 外传 / 仅作为世界观设定。
 *
 * 受控组件，只负责展示和本地校验，不读写仓储：外传列表与按线计数由 ImportScreen 传入。
 * 「从第 M 章接着编号」只是预告，真正的编号由 commitImportChapters 在事务内重新计算。
 */
export function DestinationPicker({
  value,
  onChange,
  sideStories,
  lineCounts,
  withStyle,
  withStyleTouched,
  onWithStyleChange,
  llmConfigured,
}: DestinationPickerProps) {
  const kind = value.kind === 'newSide' ? 'side' : value.kind;
  const validity = validateDestination(value, sideStories, llmConfigured);

  function change(next: DestinationChoice) {
    onChange(next);
    if (!withStyleTouched) onWithStyleChange(defaultWithStyle(next), false);
  }

  function changeKind(next: 'main' | 'side' | 'worldview') {
    if (next === kind) return;
    if (next === 'side') change(defaultSideChoice(sideStories));
    else change({ kind: next });
  }

  const selectedStory =
    value.kind === 'side' ? sideStories.find((story) => story.id === value.sideStoryId) : undefined;

  let numbering = '';
  if (value.kind === 'main') {
    const { count, next } = lineCounts.main;
    // 作者需要确认新素材是追加而不是覆盖，尤其在刚看着上一批写进去之后
    if (count > 0)
      numbering = `主线已有 ${count} 章，这一批从第 ${next} 章接着编号，不会覆盖已有内容。`;
  } else if (value.kind === 'side') {
    if (selectedStory) {
      const line = lineCounts.perSide.get(selectedStory.id) ?? { count: 0, next: 1 };
      numbering = `${sideStoryLabel(selectedStory)} 已有 ${line.count} 章，从第 ${line.next} 章接着编号。`;
    }
  } else if (value.kind === 'newSide') {
    numbering = '从第 1 章开始编号。';
  } else {
    numbering = '不会写成任何章节，只提取成知识库条目。';
  }

  return (
    <div className="flex flex-col gap-3">
      <RadioList label="导入到" value={kind} options={KIND_OPTIONS} onChange={changeKind} />

      {kind === 'side' ? (
        <SelectField
          label="哪一部外传"
          value={value.kind === 'side' ? value.sideStoryId : NEW_SIDE}
          options={[
            ...sideStories.map((story) => ({ value: story.id, label: story.title })),
            { value: NEW_SIDE, label: '＋ 新建外传…' },
          ]}
          onChange={(event) => {
            const selected = (event.target as HTMLSelectElement).value;
            change(
              selected === NEW_SIDE
                ? { kind: 'newSide', title: '' }
                : { kind: 'side', sideStoryId: selected },
            );
          }}
        />
      ) : null}

      {value.kind === 'newSide' ? (
        <TextField
          label="外传名称"
          required
          value={value.title}
          placeholder="例如：青冥旧事"
          {...(validity.fieldError ? { error: validity.fieldError } : {})}
          onChange={(event) => onChange({ kind: 'newSide', title: event.target.value })}
        />
      ) : null}

      {numbering ? (
        <p aria-live="polite" className="text-xs leading-relaxed text-ink-500">
          {numbering}
        </p>
      ) : null}

      {value.kind === 'worldview' && !llmConfigured ? (
        <p className="text-xs leading-relaxed text-ink-500">需要先在『设置』里配置模型才能提取</p>
      ) : null}

      {kind !== 'worldview' ? (
        // 钱花出去之前最后一个能改的地方；默认值取决于目的地，所以放在这里
        <label className="flex items-start gap-2 rounded-xl bg-paper-sunken px-3 py-2.5">
          <input
            type="checkbox"
            checked={withStyle}
            onChange={(event) => onWithStyleChange(event.target.checked, true)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-ink-900"
          />
          <span className="min-w-0">
            <span className="text-sm text-ink-900">顺便归纳这部作品的文风</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-ink-500">
              从你自己的稿子里读出句式节奏、叙述距离、对话风格等特征，
              连同文体取向一起作为待确认项交给你。多一次调用，续写时就不必从零挑风格。
            </span>
          </span>
        </label>
      ) : null}
    </div>
  );
}
