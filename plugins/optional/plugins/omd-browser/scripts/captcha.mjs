const CHECKBOXES = [
  { name: 'recaptcha', frame: 'iframe[src*="/recaptcha/"][src*="anchor"]', target: '#recaptcha-anchor', token: 'textarea[name="g-recaptcha-response"]' },
  { name: 'hcaptcha', frame: 'iframe[src*="hcaptcha.com"][src*="checkbox"]', target: '#checkbox', token: 'textarea[name="h-captcha-response"]' },
  { name: 'turnstile', frame: 'iframe[src*="challenges.cloudflare.com"]', target: 'input[type=checkbox]', token: 'input[name="cf-turnstile-response"]' },
];
const IMAGE_CHALLENGES = 'iframe[src*="/recaptcha/"][src*="bframe"], iframe[src*="hcaptcha.com"][src*="challenge"]';
const INTERSTITIAL = /just a moment|checking your browser|attention required|verify you are human/i;
export const MAX_STAGES = 3;

async function detect(page) {
  if (await page.locator(IMAGE_CHALLENGES).filter({ visible: true }).count()) return { kind: 'image', name: 'image' };
  for (const widget of CHECKBOXES) {
    const frame = page.locator(widget.frame).filter({ visible: true }).first();
    if (!(await frame.count())) continue;
    const token = page.locator(widget.token).first();
    if ((await token.count()) && (await token.inputValue())) continue;
    return { kind: 'checkbox', name: widget.name, target: frame.contentFrame().locator(widget.target) };
  }
  return INTERSTITIAL.test(await page.title()) ? { kind: 'interstitial', name: 'interstitial' } : null;
}

async function humanClick(page, target) {
  const box = await target.boundingBox();
  if (!box) throw new Error('captcha_target_hidden');
  const x = box.x + box.width * (0.35 + Math.random() * 0.3);
  const y = box.y + box.height * (0.35 + Math.random() * 0.3);
  await page.mouse.move(x - 120 + Math.random() * 60, y - 80 + Math.random() * 40);
  await page.mouse.move(x, y, { steps: 12 + Math.floor(Math.random() * 8) });
  await page.waitForTimeout(120 + Math.random() * 240);
  await page.mouse.click(x, y);
}

export async function solveChallenge(page, attempted) {
  for (let stage = 0; stage < MAX_STAGES; stage += 1) {
    const found = await detect(page);
    if (!found) return { status: 'clear', stages: stage };
    if (found.kind === 'image') return { status: 'handoff', reason: 'an image challenge needs a person' };
    const key = `${page.url()}|${found.name}`;
    if (attempted.has(key)) return { status: 'handoff', reason: `the ${found.name} challenge persisted after an earlier attempt` };
    attempted.add(key);
    if (found.kind === 'checkbox') await humanClick(page, found.target);
    await page.waitForTimeout(found.kind === 'interstitial' ? 8000 : 3000);
  }
  return (await detect(page))
    ? { status: 'handoff', reason: `still challenged after ${MAX_STAGES} stages` }
    : { status: 'clear', stages: MAX_STAGES };
}
