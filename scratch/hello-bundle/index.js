/**
 * Host half of the `predictor-hello` P0 load-proof bundle.
 *
 * Two jobs:
 *  1. Prove the Host process composed this bundle row and ran `apply()`: print
 *     one stable marker line to the server stdout (redirected by the launch
 *     script into scratch/logs/web-3090.out.log).
 *  2. Probe whether a locally linked bundle can resolve the bare specifiers
 *     that a Config-schema-carrying plugin wants (`@deepseek-ai/schemastery`,
 *     `zod`) without declaring/installing its own dependencies.
 */
export const HOST_MARKER = '[predictor-hello] HOST_APPLY_OK';
export const IMPORT_PROBE_MARKER = '[predictor-hello] IMPORT_PROBE';

async function probeImport(spec) {
  const started = Date.now();
  let resolved = null;
  try {
    resolved = import.meta.resolve(spec);
  } catch (err) {
    resolved = `resolve-error:${err?.code ?? err?.name ?? 'unknown'}`;
  }
  try {
    const mod = await import(spec);
    const keys = Object.keys(mod).slice(0, 12);
    console.log(
      `${IMPORT_PROBE_MARKER} OK spec=${spec} resolved=${resolved} ` +
        `keys=${keys.join(',') || '(none)'} ms=${Date.now() - started}`,
    );
    return { spec, ok: true, resolved, keys };
  } catch (err) {
    console.log(
      `${IMPORT_PROBE_MARKER} FAIL spec=${spec} resolved=${resolved} ` +
        `code=${err?.code ?? err?.name ?? 'unknown'} message=${String(err?.message ?? err).slice(0, 300)}`,
    );
    return { spec, ok: false, resolved, error: String(err?.message ?? err) };
  }
}

export function apply(ctx) {
  const profile = process.env.DSH_PROFILE ?? '(unset)';
  const entry = ctx.fiber?.entry;
  const row = entry?.id ?? 'predictor-hello';
  console.log(
    `${HOST_MARKER} profile=${profile} row=${row} pid=${process.pid} ` +
      `time=${new Date().toISOString()}`,
  );
  ctx.effect(() => () => {
    console.log(`[predictor-hello] HOST_DISPOSE profile=${profile}`);
  });
  // Fire-and-forget so boot is not blocked; results land in the server log.
  Promise.all([probeImport('@deepseek-ai/schemastery'), probeImport('zod')]).catch(() => {});
}
