/**
 * A workflow drawn from its declarations (graphOf in src/workflows/model.ts, the mockup's layout):
 * one card per step, coloured by kind, the AI's steps marked, edges labelled with their outcome,
 * back edges routed below. A run's path is drawn hot when `path` is given.
 * A graph wider than its frame scrolls inside it, the hidden side faded so it never reads as cut off.
 */
import { outcomeWord } from './words.js';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { graphOf, END, textIn, type GraphNode, type WorkflowDecl } from '../../../workflows/model.js';
import { language, t } from '../../i18n/index.js';

const W = 156, H = 62, CG = 64, RG = 30, PAD = 22;

export function Graph({ workflow, selected, path, at, onSelect }: {
  workflow: WorkflowDecl;
  selected?: string;
  path?: string[];
  at?: string;
  onSelect?: (step: string) => void;
}) {
  const g = graphOf(workflow);
  const hasBack = g.edges.some((e) => e.back);
  /** Edges between the same two steps are drawn once, their outcomes in one label, in words («In Ordnung · Limite erreicht, später»); an outcome the app has no word for is not named, never shown as its raw id (#341). */
  const lines = [...g.edges.map((e) => ({ ...e, outcome: outcomeWord(e.outcome) })).reduce((m, e) => {
    const k = `${e.from}>${e.to}`;
    const seen = m.get(k);
    m.set(k, seen ? { ...seen, outcome: [seen.outcome, e.outcome].filter(Boolean).join(' · ') } : { ...e });
    return m;
  }, new Map<string, (typeof g.edges)[number]>()).values()];
  /** A label sits before its target, unless several edges enter that target: then beside its source. */
  const layerOf = new Map(g.nodes.map((n) => [n.id, n.layer]));
  /** A forward edge that skips a column arcs above the row instead of running behind the cards between. */
  const skips = (e: (typeof lines)[number]) => !e.back && layerOf.get(e.to)! - layerOf.get(e.from)! > 1;
  const into = (id: string) => lines.filter((e) => e.to === id && !e.back && !skips(e)).length;
  const atSource = (e: (typeof lines)[number]) => !e.back && !skips(e) && into(e.to) > 1;
  const top = lines.some(skips) ? 26 : 0;
  const gap = Array.from({ length: g.layers }, (_, l) => Math.max(CG, ...lines.filter((e) => !e.back && layerOf.get(e.from) === l).map((e) => e.outcome.length * 6 + 24)));
  const xOf = (layer: number) => PAD + layer * W + gap.slice(0, layer).reduce((a, b) => a + b, 0);
  const width = xOf(g.layers - 1) + W + PAD;
  const height = top + PAD * 2 + g.rows * H + (g.rows - 1) * RG + (hasBack ? 40 : 0);
  const pos = new Map(g.nodes.map((n) => [n.id, { x: xOf(n.layer), y: top + PAD + n.row * (H + RG) }]));
  const sourceSide = new Map(g.nodes.map((n) => [n.id, lines.filter((e) => e.from === n.id && atSource(e))]));
  const walked = new Set((path ?? []).flatMap((s, i) => (path![i + 1] ? [`${s}>${path![i + 1]}`] : [])));
  const lang = language();
  const label = (n: GraphNode) => (n.id === END ? t('automation.end') : textIn(workflow.steps.find((s) => s.id === n.id)!.label, lang));
  return (
    <ScrollFrame>
      <div className="wfgraph" style={{ width, height }}>
        <svg width={width} height={height} aria-hidden="true">
          <defs>
            <marker id="wf-ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" /></marker>
          </defs>
          {lines.map((e) => {
            const a = pos.get(e.from)!, b = pos.get(e.to)!;
            const hot = walked.has(`${e.from}>${e.to}`);
            const arc = Math.min(a.y, b.y) - 26;
            const d = e.back
              ? `M${a.x + W / 2} ${a.y + H} C${a.x + W / 2} ${height - PAD - 6} ${b.x + W / 2} ${height - PAD - 6} ${b.x + W / 2} ${b.y + H + 2}`
              : skips(e)
                ? `M${a.x + W / 2} ${a.y} C${a.x + W / 2} ${arc} ${b.x + W / 2} ${arc} ${b.x + W / 2} ${b.y - 2}`
                : `M${a.x + W} ${a.y + H / 2} C${(a.x + W + b.x) / 2} ${a.y + H / 2} ${(a.x + W + b.x) / 2} ${b.y + H / 2} ${b.x - 2} ${b.y + H / 2}`;
            const k = sourceSide.get(e.from)!.indexOf(e);
            const lx = e.back || skips(e) ? (a.x + b.x + W) / 2 : atSource(e) ? a.x + W + 6 : b.x - 6;
            const ly = e.back ? height - PAD - 10 : skips(e) ? arc + 16 : atSource(e) ? a.y + H / 2 + 14 + k * 13 : b.y + H / 2 - 7;
            return (
              <g key={`${e.from}>${e.to}`} className={`wfedge${hot ? ' hot' : ''}${e.back ? ' back' : ''}`}>
                <path d={d} markerEnd="url(#wf-ah)" />
                <text x={lx} y={ly} textAnchor={e.back || skips(e) ? 'middle' : atSource(e) ? 'start' : 'end'}>{e.outcome}</text>
              </g>
            );
          })}
        </svg>
        {g.nodes.map((n) => {
          const p = pos.get(n.id)!;
          const step = workflow.steps.find((s) => s.id === n.id);
          const notBuilt = step?.body.kind === 'action' && !workflow.runnable.ok && workflow.runnable.missing.some((m) => m.step === n.id);
          const cls = ['wfnode', `k-${n.kind}`, n.id === END ? 'end' : '', selected === n.id ? 'sel' : '', path?.includes(n.id) ? 'walked' : '', at === n.id ? 'at' : '', notBuilt ? 'notbuilt' : ''].filter(Boolean).join(' ');
          return n.id === END ? (
            <div key={n.id} className={cls} style={{ left: p.x, top: p.y + H / 2 - 14 }}>{label(n)}</div>
          ) : (
            <button key={n.id} type="button" className={cls} style={{ left: p.x, top: p.y, width: W, height: H }} onClick={() => onSelect?.(n.id)} data-tip={notBuilt ? t('automation.step.notBuilt') : undefined}>
              <span className="kind">{n.kind === 'agent' ? <BotIcon /> : null}{t(`automation.kind.${n.kind}` as 'automation.kind.step')}</span>
              <span className="lbl">{label(n)}</span>
            </button>
          );
        })}
      </div>
    </ScrollFrame>
  );
}

/** Which sides of a horizontal scroller hide content: the frame fades those. */
function ScrollFrame({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState('');
  useLayoutEffect(() => {
    const el = ref.current!;
    const update = () => setMore([el.scrollLeft > 1 ? 'l' : '', el.scrollLeft + el.clientWidth < el.scrollWidth - 1 ? 'r' : ''].join(''));
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    ro.observe(el.firstElementChild!);
    return () => { el.removeEventListener('scroll', update); ro.disconnect(); };
  }, []);
  return <div className="wfscroll" data-more={more || undefined}><div ref={ref} className="wfpan">{children}</div></div>;
}

/** The mark of an AI (views.md "AI is always marked"): Lucide's bot. */
export function BotIcon() {
  return (
    <svg className="i bot" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 8V4H8" /><rect x="4" y="8" width="16" height="12" rx="2" /><path d="M2 14h2M20 14h2M15 13v2M9 13v2" />
    </svg>
  );
}
