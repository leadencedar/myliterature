import { useEffect, useRef, useState } from 'react';
import { useRepository } from '@/data/RepositoryProvider';
import { useInvalidate, useRepoQuery } from '@/data/useRepoQuery';
import type { Novel, Rubric, StyleProfile, Tradition, VoiceReference } from '@/domain/schema';
import { LlmError } from '@/llm/errors';
import { useLlm } from '@/llm/useLlm';
import { buildReplaceProposal, newBatchId } from '@/proposal/build';
import { fieldSpecsFor } from '@/proposal/fields';
import { METHODOLOGIES, TRADITIONS, subGenresOf } from '@/prompt/traditions';
import { RUBRIC_DIMENSIONS, VOICE_LIBRARY, findVoice } from '@/prompt/voiceLibrary';
import { Button } from '@/ui/Button';
import { ChipGroup, RadioList, SegmentedControl, Slider } from '@/ui/Controls';
import { TextAreaField } from '@/ui/Field';
import { Section } from '@/ui/Page';
import { Sheet } from '@/ui/Sheet';
import { ProposalInbox } from '../proposals/ProposalInbox';
import {
  STYLE_SAMPLE_SYSTEM,
  StyleSampleSchema,
  buildStyleSampleUserPrompt,
  validateSample,
} from './styleSample';

const MAX_VOICE_REFS = 2;

/** 知识库页里的风格档案入口：摘要 + 调整 */
export function StyleSection({ novel }: { novel: Novel }) {
  const [open, setOpen] = useState(false);
  const { data: style } = useRepoQuery((repo) => repo.getStyleProfile(novel.id), [novel.id]);

  return (
    <Section
      title="风格档案"
      description="决定世界观取向、大纲结构与正文文风，对生成质量影响最大。"
      action={
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          调整
        </Button>
      }
    >
      {style ? <StyleSummary style={style} /> : <p className="text-sm text-ink-300">加载中…</p>}
      {style ? (
        <StyleSheet open={open} novel={novel} style={style} onClose={() => setOpen(false)} />
      ) : null}
    </Section>
  );
}

function StyleSummary({ style }: { style: StyleProfile }) {
  const tradition = TRADITIONS[style.tradition];
  const methodology = METHODOLOGIES[style.methodology];

  return (
    <dl className="flex flex-col gap-2 text-sm">
      <div className="flex gap-2">
        <dt className="w-16 shrink-0 text-ink-500">文体</dt>
        <dd className="text-ink-900">
          {tradition.label}
          {style.subGenre ? ` · ${style.subGenre}` : ''}
        </dd>
      </div>
      <div className="flex gap-2">
        <dt className="w-16 shrink-0 text-ink-500">结构</dt>
        <dd className="text-ink-900">{methodology.label}</dd>
      </div>
      <div className="flex gap-2">
        <dt className="w-16 shrink-0 text-ink-500">文风</dt>
        <dd className="text-ink-900">
          {style.voiceRefs.length === 0 && !style.customRubric ? (
            <span className="text-ink-300">未设定</span>
          ) : (
            [
              ...style.voiceRefs.map((ref) => `${ref.name} ${ref.weight}%`),
              style.customRubric ? '自定义文风' : '',
            ]
              .filter(Boolean)
              .join('、')
          )}
        </dd>
      </div>
    </dl>
  );
}

type SampleState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'review'; batchId: string }
  | { phase: 'error'; message: string };

function StyleSheet({
  open,
  novel,
  style,
  onClose,
}: {
  open: boolean;
  novel: Novel;
  style: StyleProfile;
  onClose: () => void;
}) {
  const repository = useRepository();
  const invalidate = useInvalidate();
  const llm = useLlm();

  const [draft, setDraft] = useState<StyleProfile>(style);
  const [saving, setSaving] = useState(false);
  const [sampleText, setSampleText] = useState('');
  const [sample, setSample] = useState<SampleState>({ phase: 'idle' });

  // style 每次数据刷新都是新对象引用，不能作为重置依赖：
  // 否则文风取样一落库就触发刷新，刚生成的确认面板会被立刻卸载，
  // 用户未保存的编辑也会被冲掉。只在「关闭 → 打开」这一刻重置。
  const styleRef = useRef(style);
  styleRef.current = style;
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open && !wasOpen.current) {
      setDraft(styleRef.current);
      setSample({ phase: 'idle' });
      setSampleText('');
    }
    wasOpen.current = open;
  }, [open]);

  const subGenres = subGenresOf(draft.tradition);

  function patch(next: Partial<StyleProfile>) {
    setDraft((current) => ({ ...current, ...next }));
  }

  function toggleVoice(refId: string) {
    const existing = draft.voiceRefs.find((ref) => ref.refId === refId);
    if (existing) {
      patch({ voiceRefs: draft.voiceRefs.filter((ref) => ref.refId !== refId) });
      return;
    }
    if (draft.voiceRefs.length >= MAX_VOICE_REFS) return;
    const preset = findVoice(refId);
    if (!preset) return;
    const added: VoiceReference = { refId, name: preset.name, weight: 60 };
    patch({ voiceRefs: [...draft.voiceRefs, added] });
  }

  function setVoiceWeight(refId: string, weight: number) {
    patch({
      voiceRefs: draft.voiceRefs.map((ref) => (ref.refId === refId ? { ...ref, weight } : ref)),
    });
  }

  function patchRubric(key: keyof Rubric, value: string) {
    const base: Rubric = draft.customRubric ?? {
      sentenceRhythm: '',
      imagery: '',
      narrativeDistance: '',
      dialogue: '',
      rhetoric: '',
      lexicon: '',
      avoid: '',
    };
    patch({ customRubric: { ...base, [key]: value } });
  }

  async function save() {
    setSaving(true);
    try {
      await repository.upsertStyleProfile(novel.id, {
        tradition: draft.tradition,
        subGenre: draft.subGenre,
        methodology: draft.methodology,
        voiceRefs: draft.voiceRefs,
        customRubric: draft.customRubric,
        extraInstruction: draft.extraInstruction,
      });
      invalidate();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function extractStyle() {
    const problem = validateSample(sampleText);
    if (problem) {
      setSample({ phase: 'error', message: problem });
      return;
    }
    setSample({ phase: 'running' });
    try {
      const result = await llm.runStructured('style-sample', {
        schema: StyleSampleSchema,
        schemaName: 'StyleRubric',
        system: STYLE_SAMPLE_SYSTEM,
        user: buildStyleSampleUserPrompt(sampleText),
      });

      // 提炼结果同样不直接落库，走确认管道
      const batchId = newBatchId();
      const proposal = buildReplaceProposal({
        novelId: novel.id,
        batchId,
        origin: 'refine',
        target: 'styleProfile',
        label: '自定义文风',
        specs: fieldSpecsFor('styleProfile'),
        targetId: novel.id,
        current: { customRubric: draft.customRubric },
        payload: { customRubric: result.data },
        sourceRef: '文风取样',
      });
      await repository.createProposals([proposal]);
      invalidate();
      setSample({ phase: 'review', batchId });
    } catch (cause) {
      setSample({
        phase: 'error',
        message:
          cause instanceof LlmError
            ? cause.message
            : cause instanceof Error
              ? cause.message
              : '提炼失败',
      });
    }
  }

  /** 取样结果确认后，把库里的新 rubric 同步进当前草稿 */
  async function afterSampleSettled() {
    const latest = await repository.getStyleProfile(novel.id);
    if (latest) setDraft((current) => ({ ...current, customRubric: latest.customRubric }));
    setSample({ phase: 'idle' });
    setSampleText('');
  }

  return (
    <Sheet
      open={open}
      title="风格档案"
      description="三个维度共同决定生成风格：写什么路子、按什么结构、用什么笔法。"
      onClose={onClose}
      footer={
        <Button variant="primary" size="lg" block disabled={saving} onClick={save}>
          {saving ? '保存中…' : '保存'}
        </Button>
      }
    >
      <SegmentedControl<Tradition>
        label="文体取向"
        value={draft.tradition}
        options={Object.values(TRADITIONS).map((item) => ({
          value: item.id,
          label: item.label,
          description: item.tagline,
        }))}
        onChange={(tradition) =>
          // 换取向时清空子类：子类列表是随取向变化的，留着会产生无效组合
          patch({ tradition, subGenre: '' })
        }
      />

      {subGenres.length > 0 ? (
        <ChipGroup
          label="子类"
          hint="选一个最接近的，会带上该子类的写作约定。可以不选。"
          options={subGenres.map((item) => ({ value: item.id, label: item.label }))}
          selected={draft.subGenre ? [draft.subGenre] : []}
          onToggle={(value) => patch({ subGenre: draft.subGenre === value ? '' : value })}
        />
      ) : null}

      <RadioList
        label="创作方法论"
        value={draft.methodology}
        options={Object.values(METHODOLOGIES).map((item) => ({
          value: item.id,
          label: item.label,
          description: item.tagline,
        }))}
        onChange={(methodology) => patch({ methodology })}
      />

      <div className="flex flex-col gap-3">
        <ChipGroup
          label="名家风格参考"
          hint={`最多选 ${MAX_VOICE_REFS} 位，选多了文风会互相打架。已选 ${draft.voiceRefs.length} 位。`}
          options={VOICE_LIBRARY.map((voice) => ({
            value: voice.id,
            label: voice.name,
          }))}
          selected={draft.voiceRefs.map((ref) => ref.refId)}
          onToggle={toggleVoice}
        />

        {draft.voiceRefs.map((ref) => {
          const preset = findVoice(ref.refId);
          return (
            <div key={ref.refId} className="rounded-xl bg-paper-sunken p-3">
              <p className="text-xs text-ink-500">{preset?.tagline}</p>
              <div className="mt-1.5">
                <Slider
                  label={`${ref.name} 的强度`}
                  value={ref.weight}
                  valueLabel={`${ref.weight}%`}
                  onChange={(weight) => setVoiceWeight(ref.refId, weight)}
                />
              </div>
            </div>
          );
        })}

        <p className="text-xs leading-relaxed text-ink-300">
          风格库收录的是已故经典作家的写作特征描述，不含作品原文。文学风格本身不受版权保护，
          但作品对外发表时不宜宣称与某位作家的关联。
        </p>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-ink-100 p-3">
        <div>
          <h3 className="text-sm font-medium text-ink-700">文风取样</h3>
          <p className="mt-1 text-xs leading-relaxed text-ink-500">
            粘贴一段你喜欢的文字，AI 会归纳出它的风格特征存为自定义文风，与名家风格叠加使用。
          </p>
        </div>

        <TextAreaField
          label="示例文本"
          rows={5}
          value={sampleText}
          placeholder="粘贴 100–4000 字最有代表性的片段"
          onChange={(event) => setSampleText(event.target.value)}
        />

        <Button
          variant="secondary"
          size="md"
          block
          disabled={!llm.configured || sample.phase === 'running'}
          onClick={extractStyle}
        >
          {sample.phase === 'running' ? '正在归纳…' : '提炼文风'}
        </Button>

        {!llm.configured ? (
          <p className="text-xs text-ink-500">需要先在「设置」里配置模型。</p>
        ) : null}

        {sample.phase === 'error' ? (
          <p role="alert" className="rounded-lg bg-seal-soft px-3 py-2 text-xs text-seal">
            {sample.message}
          </p>
        ) : null}

        {sample.phase === 'review' ? (
          <ProposalInbox
            novelId={novel.id}
            batchId={sample.batchId}
            acceptAllLabel="采用这份文风"
            onSettled={afterSampleSettled}
          />
        ) : null}

        {draft.customRubric ? (
          <details className="rounded-lg bg-paper-sunken p-3">
            <summary className="cursor-pointer text-xs font-medium text-ink-700">
              当前自定义文风（可直接修改）
            </summary>
            <div className="mt-3 flex flex-col gap-3">
              {RUBRIC_DIMENSIONS.map((dimension) => (
                <TextAreaField
                  key={dimension.key}
                  label={dimension.label}
                  rows={2}
                  value={draft.customRubric?.[dimension.key] ?? ''}
                  onChange={(event) => patchRubric(dimension.key, event.target.value)}
                />
              ))}
              <Button size="sm" variant="ghost" onClick={() => patch({ customRubric: null })}>
                清除自定义文风
              </Button>
            </div>
          </details>
        ) : null}
      </div>

      <TextAreaField
        label="额外写作要求"
        rows={3}
        value={draft.extraInstruction}
        placeholder="例如：不要写心理独白；场景描写控制在两句以内；人名统一用三字。"
        hint="这段会原样进入提示词，适合放硬性约束。"
        onChange={(event) => patch({ extraInstruction: event.target.value })}
      />
    </Sheet>
  );
}
