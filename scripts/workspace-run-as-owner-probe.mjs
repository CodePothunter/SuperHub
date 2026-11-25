/** Disposable DSH host for the run-as-owner acceptance. Only skips first-run onboarding; model calls stay real. */
export const inject = ['settings']

export function apply(ctx) {
  ctx.on('ready', () => ctx.get('settings').update('ui-settings-account', { step:'done', completion:'skipped' }))
}
