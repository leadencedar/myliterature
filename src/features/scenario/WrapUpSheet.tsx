import { useEffect, useRef, useState } from 'react';
import type { Scenario } from '@/domain/schema';
import { SCENARIO_LIMITS } from '@/domain/scenario';
import { Button } from '@/ui/Button';
import { RadioList } from '@/ui/Controls';
import { TextAreaField } from '@/ui/Field';
import { Sheet } from '@/ui/Sheet';
import { GOAL_KIND_LABELS } from './scenarioPrompt';

/**
 * 收尾（设计 D4.3）：可选一个目标结局（可不选）与一句说明。
 * 选的目标只作为提示词输入：结局从当前状态自然得出，写出来的和想要的不一致时界面如实显示，不报错
 */
export function WrapUpSheet({
  open,
  scenario,
  onSubmit,
  onClose,
}: {
  open: boolean;
  scenario: Scenario;
  onSubmit: (goalId: string | null, note: string) => void;
  onClose: () => void;
}) {
  const [goalId, setGoalId] = useState('');
  const [note, setNote] = useState('');
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setGoalId('');
      setNote('');
    }
    wasOpen.current = open;
  }, [open]);

  const tooLong = note.trim().length > SCENARIO_LIMITS.wrapUpNote;
  return (
    <Sheet
      open={open}
      title="收尾"
      description="在这一步写出结局。从当前状态自然得出，做不到圆满就会是开放或中性结局。"
      onClose={onClose}
      footer={
        <Button
          variant="primary"
          size="lg"
          block
          disabled={tooLong}
          onClick={() => onSubmit(goalId || null, note.trim())}
        >
          写出结局
        </Button>
      }
    >
      <RadioList
        label="想要的结局"
        value={goalId}
        options={[
          { value: '', label: '不指定', description: '让这条线自己走到结局' },
          ...scenario.setup.goals.map((goal, index) => ({
            value: goal.id,
            label: `G${index + 1} · ${GOAL_KIND_LABELS[goal.kind]}`,
            description: goal.description,
          })),
        ]}
        onChange={setGoalId}
      />
      <TextAreaField
        label="收尾说明（选填）"
        rows={3}
        value={note}
        hint={
          <span className={tooLong ? 'text-seal' : undefined}>
            {note.trim().length} / {SCENARIO_LIMITS.wrapUpNote}
          </span>
        }
        onChange={(event) => setNote(event.target.value)}
      />
    </Sheet>
  );
}
