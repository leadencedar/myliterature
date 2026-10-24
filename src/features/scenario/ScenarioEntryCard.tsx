import { useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRepoQuery } from '@/data/useRepoQuery';
import type { Novel } from '@/domain/schema';
import { Button } from '@/ui/Button';
import { ScenarioListSheet } from './ScenarioListSheet';
import { ScenarioSetupSheet } from './ScenarioSetupSheet';
import { scenarioOverview, scenarioPath } from './scenarioView';

/**
 * 写作页顶部的「互动推演」入口（设计 §8.1 / D10）。
 *
 * 放在「全书进度」之上、一行高：互动本身是目的，藏在大纲与几十章章节之后会找不到；
 * 沉淀出的大纲与外传就在同一页，玩 → 沉淀 → 写这一章不跨 Tab。不加第六个主导航：
 * 那会让所有页面、所有用户的每个 Tab 变窄，而推演只对一部分作品有用。
 */
export function ScenarioEntryCard({ novel }: { novel: Novel }) {
  const navigate = useNavigate();
  const headingId = useId();
  const [listOpen, setListOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);

  const { data } = useRepoQuery(
    async (repo) => {
      const scenarios = await repo.listScenarios(novel.id);
      const nodes = await Promise.all(
        scenarios.map((scenario) => repo.listScenarioNodes(scenario.id)),
      );
      // 主角可能是限定条目，也可能已在回收站：列表里照样要显示名字
      const entries =
        scenarios.length > 0
          ? await repo.listEntries(novel.id, { scope: 'all', includeDeleted: true })
          : [];
      return {
        items: scenarios.map((scenario, index) => ({ scenario, nodes: nodes[index] ?? [] })),
        entries,
      };
    },
    [novel.id],
  );

  // 首次加载前不占位：卡片只有一行高，闪一下空框比晚出现一瞬更扎眼
  if (!data) return null;
  const items = data.items;
  // listScenarios 已按最近推进倒序
  const latest = items[0];
  const latestOverview = latest ? scenarioOverview(latest.scenario, latest.nodes) : null;

  return (
    <section
      aria-labelledby={headingId}
      className="mb-5 flex flex-wrap items-center gap-3 rounded-2xl border border-ink-100 bg-paper-raised p-4 lg:mb-6 lg:p-5"
    >
      <div className="min-w-0 flex-1">
        <h2 id={headingId} className="text-sm font-semibold text-ink-900 lg:text-base">
          互动推演{items.length > 0 ? ` · ${items.length} 个` : ''}
        </h2>
        {items.length === 0 ? (
          <p className="mt-1 text-xs leading-relaxed text-ink-500 lg:text-sm">
            互动推演：把主角放进这个世界，一步步选择走向结局，再沉淀成大纲
          </p>
        ) : null}
      </div>
      {latest && latestOverview ? (
        <>
          <Button variant="primary" onClick={() => navigate(scenarioPath(latest.scenario.id))}>
            {latestOverview.landingStep === null
              ? `《${latest.scenario.title}》· 还没有开局`
              : `继续《${latest.scenario.title}》第 ${latestOverview.landingStep} 步`}
          </Button>
          <Button onClick={() => setListOpen(true)}>全部推演</Button>
        </>
      ) : (
        <Button variant="primary" onClick={() => setSetupOpen(true)}>
          开始一局
        </Button>
      )}

      <ScenarioListSheet
        open={listOpen}
        items={items}
        entries={data.entries}
        onOpenScenario={(id) => {
          setListOpen(false);
          navigate(scenarioPath(id));
        }}
        onCreate={() => {
          setListOpen(false);
          setSetupOpen(true);
        }}
        onClose={() => setListOpen(false)}
      />
      <ScenarioSetupSheet
        open={setupOpen}
        novel={novel}
        onClose={() => setSetupOpen(false)}
        onSaved={(scenario) => {
          setSetupOpen(false);
          // autoStart：推演页据此直接发开局请求，作者不用再点一次「开始」
          navigate(scenarioPath(scenario.id), { state: { autoStart: true } });
        }}
      />
    </section>
  );
}
