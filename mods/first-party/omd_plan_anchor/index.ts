import type { Json, ModAPI } from '../../api.d.ts';

type Plan = { steps: { step: string; status: string }[]; since: number };
const STEPS = 8;
const MARK: Record<string, string> = { completed: 'x', in_progress: '>', pending: ' ' };

export default function activate(api: ModAPI) {
  const every = () => Math.min(50, Math.max(2, Math.round(Number(api.settings.every) || 8)));
  const save = (plan: Plan) => api.state.set(plan as unknown as Json);

  api.intercept('tool', { before: ['omd_output_budget'] }, async (e, next) => {
    if (!e.thread_id) return next(e);
    const result = await next(e);
    if (e.tool === 'update_plan') {
      const given = (e.arguments as { plan?: { step?: unknown; status?: unknown }[] } | null)?.plan;
      if (result.success && Array.isArray(given)) save({ steps: given.map(item => ({ step: String(item?.step ?? '').slice(0, 120), status: String(item?.status ?? 'pending') })), since: 0 });
      return result;
    }
    const plan = api.state.get() as unknown as Plan | null;
    const open = plan?.steps.filter(item => item.status !== 'completed') ?? [];
    if (!plan || !open.length || next.origin?.caller !== 'model') return result;
    if (plan.since + 1 < every() || result.truncated || result.output.length > 200_000) {
      save({ ...plan, since: plan.since + 1 });
      return result;
    }
    save({ ...plan, since: 0 });
    const lines = open.slice(0, STEPS).map(item => `- [${MARK[item.status] ?? ' '}] ${item.step}`);
    const more = open.length > STEPS ? `\n- … ${open.length - STEPS} more open` : '';
    return { output: `${result.output}\n\n[omd_plan_anchor: current plan, ${plan.steps.length - open.length}/${plan.steps.length} done; call update_plan when it changes]\n${lines.join('\n')}${more}`, success: result.success };
  });
}
