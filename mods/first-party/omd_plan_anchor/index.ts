import type { Json, ModAPI } from '@oh-my-diff/mod-api';

type Plan = { steps: { step: string; status: string }[]; since: number };
const THREADS = 32;
const STEPS = 8;
const MARK: Record<string, string> = { completed: 'x', in_progress: '>', pending: ' ' };

export default function activate(api: ModAPI) {
  const every = () => Math.min(50, Math.max(2, Math.round(Number(api.settings.every) || 8)));
  const save = (plans: Record<string, Plan>, thread: string, plan: Plan) =>
    api.state.set({ ...Object.fromEntries(Object.entries(plans).filter(([id]) => id !== thread).slice(1 - THREADS)), [thread]: plan } as unknown as Json);

  api.intercept('tool', { before: ['omd_output_budget'] }, async (e, next) => {
    const thread = e.thread_id;
    if (!thread) return next(e);
    const plans = (api.state.get() ?? {}) as unknown as Record<string, Plan>;
    if (e.tool === 'update_plan') {
      const given = (e.arguments as { plan?: { step?: unknown; status?: unknown }[] } | null)?.plan;
      if (Array.isArray(given)) save(plans, thread, { steps: given.map(item => ({ step: String(item?.step ?? '').slice(0, 120), status: String(item?.status ?? 'pending') })), since: 0 });
      return next(e);
    }
    const result = await next(e);
    const plan = plans[thread];
    const open = plan?.steps.filter((item: Plan['steps'][number]) => item.status !== 'completed') ?? [];
    if (!plan || !open.length || next.origin?.caller !== 'model') return result;
    if (plan.since + 1 < every() || result.truncated || result.output.length > 200_000) {
      save(plans, thread, { ...plan, since: plan.since + 1 });
      return result;
    }
    save(plans, thread, { ...plan, since: 0 });
    const lines = open.slice(0, STEPS).map(item => `- [${MARK[item.status] ?? ' '}] ${item.step}`);
    const more = open.length > STEPS ? `\n- … ${open.length - STEPS} more open` : '';
    return { output: `${result.output}\n\n[omd_plan_anchor: current plan, ${plan.steps.length - open.length}/${plan.steps.length} done; call update_plan when it changes]\n${lines.join('\n')}${more}`, success: result.success };
  });
}
