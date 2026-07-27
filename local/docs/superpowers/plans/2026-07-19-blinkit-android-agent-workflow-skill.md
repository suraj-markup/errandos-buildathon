# Blinkit Android Agent Workflow and Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace live Blinkit Playwright execution with a typed, durable Android/Appium workflow on the current GCP emulator and update the ErrandOS skill so any tool-capable agent can search, authenticate, prepare, place one COD order, and reconcile safely.

**Architecture:** The existing VPC control plane keeps proposals, hashes, idempotency, receipts, and MCP. It invokes a typed worker command over the current restricted GCP SSH/IAP path; that command alone talks to local Appium and the persistent official Blinkit app. The agent uses semantic MCP tools and never receives Appium, ADB, selector, coordinate, screenshot, UI XML, or device-session access.

**Tech Stack:** TypeScript ESM, Node.js 22, pnpm workspaces, Zod, MCP SDK, Appium 3.5.2, UiAutomator2 8.1.0, Android 35 emulator, Google Compute Engine, `gcloud compute ssh --tunnel-through-iap`, Vitest.

## Global Constraints

- Support one owner, one Blinkit account key (`main`), one saved Home location, one current GCP worker, and COD only.
- Use the official Blinkit Android app; no Playwright or browser profile may execute a live Blinkit operation.
- Keep unrelated providers outside this implementation.
- Keep Appium and ADB local to the GCP VM; never expose them through MCP or a public listener.
- Pass phone and OTP through worker stdin only; never place them in process arguments, logs, errors, fixtures, screenshots, traces, or durable state.
- A material checkout change returns `stale` before dispatch.
- Persist dispatch before the final provider action and attempt `Place Order` at most once.
- Any unverified result after dispatch is `ambiguous`; reconciliation is read-only and never clicks `Place Order`.
- Do not claim success without a verified provider confirmation or unique matching provider order.
- Keep both live gates false by default. A live commit requires `ERRANDOS_LIVE_BROWSER_ACTIONS=true` and `ERRANDOS_LIVE_COMMIT=true` in the personal deployment.
- Preserve unrelated uncommitted changes in the base checkout.

## File Map

- `packages/contracts/src/android-worker.ts`: versioned typed worker request/response boundary.
- `packages/contracts/src/transactions.ts`: unavailable-item proposal projection and existing transaction inputs.
- `packages/provider-connectors/src/android/appium-client.ts`: local Appium HTTP protocol client.
- `packages/provider-connectors/src/android/worker-client.ts`: typed worker port and SSH/IAP implementation.
- `packages/provider-connectors/src/blinkit/android-stage.ts`: pure screen and overlay detection.
- `packages/provider-connectors/src/blinkit/android-driver.ts`: semantic Blinkit Android actions.
- `packages/provider-connectors/src/blinkit/android-adapter.ts`: application transaction/auth adapter and exact review mapping.
- `apps/worker/src/android-job-entry.ts`: one-request typed stdin/stdout worker command.
- `apps/control-plane/src/mcp.ts`: Android runtime wiring and Blinkit-specific MCP aliases.
- `infra/gcp/android-worker/deploy-runtime.sh`: deterministic worker build/install.
- `infra/gcp/android-worker/systemd/errandos-emulator.service`: supported `lavapipe` renderer.
- `hermes/skills/errandos/SKILL.md`: agent decision workflow.
- `hermes/skills/errandos/references/blinkit-android-workflow.md`: status and recovery reference.
- `hermes/skills/errandos/references/rendering-examples.md`: compact response shapes.

---

### Task 1: Integrate and stabilize the current Android worker infrastructure

**Files:**
- Merge commits from: `codex/gcp-android-canary`
- Modify: `infra/gcp/android-worker/systemd/errandos-emulator.service`
- Modify: `infra/gcp/android-worker/README.md`
- Test: `infra/gcp/android-worker/verify-runtime.sh`

**Interfaces:**
- Consumes: committed GCP canary infrastructure through `a4e3b1a`
- Produces: a reproducible worker with local Appium at `http://127.0.0.1:4723`, persistent AVD state, and `lavapipe` rendering

- [ ] **Step 1: Create an isolated execution worktree and integrate the committed canary branch**

Run from the base checkout:

```bash
git worktree add .worktrees/blinkit-android-agent -b codex/blinkit-android-agent main
git -C .worktrees/blinkit-android-agent merge --no-ff codex/gcp-android-canary -m "merge: integrate Android worker canary"
```

Expected: the feature worktree contains `infra/gcp/android-worker`; the base checkout's five unrelated modified files remain unchanged.

- [ ] **Step 2: Write the failing renderer assertion**

Add to `infra/gcp/android-worker/verify-runtime.sh` after the existing service checks:

```bash
unit="$(systemctl cat errandos-emulator.service)"
grep -Fq -- '-gpu lavapipe' <<<"$unit" || {
  printf 'renderer_ready=false\n' >&2
  exit 1
}
printf 'renderer_ready=true\n'
```

Run:

```bash
bash -n infra/gcp/android-worker/verify-runtime.sh
rg -- '-gpu lavapipe' infra/gcp/android-worker/systemd/errandos-emulator.service
```

Expected: syntax passes; the `rg` assertion fails because the committed unit has not yet selected `lavapipe`.

- [ ] **Step 3: Select the stable renderer and document the observed requirement**

Set the emulator `ExecStart` renderer flag to:

```ini
-gpu lavapipe
```

Add this exact operational note to `infra/gcp/android-worker/README.md`:

```markdown
The Blinkit canary uses `-gpu lavapipe`. SwiftShader variants crashed the emulator while rendering checkout; do not change the renderer without rerunning the cart and checkout canary.
```

- [ ] **Step 4: Verify and commit**

Run:

```bash
bash -n infra/gcp/android-worker/verify-runtime.sh
git diff --check
```

Expected: both commands exit `0`.

```bash
git add infra/gcp/android-worker/systemd/errandos-emulator.service infra/gcp/android-worker/README.md infra/gcp/android-worker/verify-runtime.sh
git commit -m "fix: stabilize Android checkout renderer"
```

---

### Task 2: Define the typed Android worker protocol

**Files:**
- Create: `packages/contracts/src/android-worker.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/transactions.ts`
- Test: `packages/contracts/test/android-worker.test.ts`
- Test: `packages/contracts/test/proposals.test.ts`

**Interfaces:**
- Consumes: `MoneySchema`, grocery item inputs, provider session statuses
- Produces: `AndroidWorkerRequestV1`, `AndroidWorkerResponseV1`, `AndroidCheckoutReviewV1`, and `UnavailableGroceryItemV1`

- [ ] **Step 1: Write failing protocol tests**

Create `packages/contracts/test/android-worker.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AndroidWorkerRequestSchemaV1, AndroidWorkerResponseSchemaV1 } from '../src/android-worker.js';

describe('Android worker protocol', () => {
  it('accepts semantic jobs and rejects raw device operations', () => {
    expect(AndroidWorkerRequestSchemaV1.parse({ version:1, operation:'auth_status', accountKey:'main' })).toMatchObject({ operation:'auth_status' });
    expect(() => AndroidWorkerRequestSchemaV1.parse({ version:1, operation:'tap', x:1, y:2 })).toThrow();
    expect(() => AndroidWorkerRequestSchemaV1.parse({ version:1, operation:'run_adb', command:'shell input tap' })).toThrow();
  });

  it('models a sanitized prepared checkout', () => {
    const response = AndroidWorkerResponseSchemaV1.parse({
      version:1, operation:'prepare_checkout', status:'prepared',
      checkout:{
        lines:[{productId:'lays-58',name:"Lay's Magic Masala",quantity:1,unitPrice:{currency:'INR',amount:25},lineTotal:{currency:'INR',amount:25}}],
        unavailableItems:[{query:'diet coke',reason:'out_of_stock'}], fees:[], total:{currency:'INR',amount:25},
        addressReference:'home',addressLabel:'Home',paymentMode:'cod',etaMinutes:8,providerFingerprint:'a'.repeat(64),
      },
    });
    expect(JSON.stringify(response)).not.toMatch(/selector|coordinate|xml|screenshot|phone|otp/i);
  });

  it('requires provider evidence for committed worker results', () => {
    expect(() => AndroidWorkerResponseSchemaV1.parse({ version:1,operation:'commit_once',status:'committed' })).toThrow();
    expect(AndroidWorkerResponseSchemaV1.parse({ version:1,operation:'commit_once',status:'committed',providerReference:'order-123' })).toBeTruthy();
  });

  it('binds reconciliation to exact checkout terms and a time window', () => {
    const checkout={lines:[{productId:'lays-58',name:"Lay's Magic Masala",quantity:1,unitPrice:{currency:'INR',amount:25},lineTotal:{currency:'INR',amount:25}}],unavailableItems:[],fees:[],total:{currency:'INR',amount:25},addressReference:'home',addressLabel:'Home',paymentMode:'cod',providerFingerprint:'a'.repeat(64)};
    expect(AndroidWorkerRequestSchemaV1.parse({version:1,operation:'reconcile',accountKey:'main',expected:{proposalId:'proposal-1',proposalHash:'b'.repeat(64),idempotencyKey:'message-1:proposal-1',preparedAt:'2026-07-19T10:00:00.000Z',expiresAt:'2026-07-19T10:05:00.000Z',checkout}})).toBeTruthy();
  });
});
```

Run:

```bash
pnpm --filter @errandos/contracts test -- android-worker.test.ts
```

Expected: FAIL because `android-worker.ts` does not exist.

- [ ] **Step 2: Implement the minimal Zod boundary**

Create `packages/contracts/src/android-worker.ts` with these exported shapes:

```ts
import { z } from 'zod';
import { MoneySchema } from './proposals.js';

const Id = z.string().trim().min(1).max(200);
const SecretPhone = z.string().regex(/^\d{10}$/);
const SecretOtp = z.string().regex(/^\d{4,8}$/);
const Line = z.object({ productId:Id,name:z.string().min(1).max(300),quantity:z.number().int().positive(),unitPrice:MoneySchema,lineTotal:MoneySchema }).strict();
const Unavailable = z.object({ query:z.string().min(1).max(200),reason:z.enum(['out_of_stock','not_found','ambiguous']) }).strict();

export const AndroidCheckoutReviewSchemaV1 = z.object({
  lines:z.array(Line).min(1).max(30),unavailableItems:z.array(Unavailable).max(30),fees:z.array(z.object({kind:z.string().min(1),label:z.string().min(1),amount:MoneySchema}).strict()).max(30),
  total:MoneySchema,addressReference:Id,addressLabel:z.string().min(1).max(100),paymentMode:z.literal('cod'),etaMinutes:z.number().int().positive().optional(),providerFingerprint:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const ExpectedCheckout = z.object({
  proposalId:Id,proposalHash:z.string().regex(/^[a-f0-9]{64}$/),idempotencyKey:z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/),
  preparedAt:z.string().datetime(),expiresAt:z.string().datetime(),checkout:AndroidCheckoutReviewSchemaV1,
}).strict();

export const AndroidWorkerRequestSchemaV1 = z.discriminatedUnion('operation', [
  z.object({version:z.literal(1),operation:z.literal('auth_status'),accountKey:Id}).strict(),
  z.object({version:z.literal(1),operation:z.literal('begin_login'),accountKey:Id,phone:SecretPhone}).strict(),
  z.object({version:z.literal(1),operation:z.literal('submit_otp'),accountKey:Id,otp:SecretOtp}).strict(),
  z.object({version:z.literal(1),operation:z.literal('search'),accountKey:Id,query:z.string().min(1).max(200),limit:z.number().int().min(1).max(10)}).strict(),
  z.object({version:z.literal(1),operation:z.literal('prepare_checkout'),accountKey:Id,items:z.array(z.object({query:z.string().min(1).max(200),quantity:z.number().int().min(1).max(20)}).strict()).min(1).max(30),addressReference:Id,addressLabel:z.string().min(1).max(100)}).strict(),
  z.object({version:z.literal(1),operation:z.literal('commit_once'),accountKey:Id,expected:ExpectedCheckout}).strict(),
  z.object({version:z.literal(1),operation:z.literal('reconcile'),accountKey:Id,expected:ExpectedCheckout}).strict(),
]);

export const AndroidWorkerResponseSchemaV1 = z.union([
  z.object({version:z.literal(1),operation:z.literal('auth_status'),status:z.enum(['active','login_required','challenge_required','error'])}).strict(),
  z.object({version:z.literal(1),operation:z.literal('begin_login'),status:z.enum(['otp_sent','active'])}).strict(),
  z.object({version:z.literal(1),operation:z.literal('submit_otp'),status:z.enum(['active','challenge_required','error'])}).strict(),
  z.object({version:z.literal(1),operation:z.literal('search'),status:z.literal('completed'),offers:z.array(z.object({productId:Id,title:z.string().min(1),packSize:z.string().optional(),price:MoneySchema,available:z.boolean()}).strict()).max(10)}).strict(),
  z.object({version:z.literal(1),operation:z.literal('prepare_checkout'),status:z.literal('prepared'),checkout:AndroidCheckoutReviewSchemaV1}).strict(),
  z.object({version:z.literal(1),operation:z.literal('commit_once'),status:z.literal('committed'),providerReference:Id}).strict(),
  z.object({version:z.literal(1),operation:z.literal('commit_once'),status:z.enum(['stale','ambiguous'])}).strict(),
  z.object({version:z.literal(1),operation:z.literal('reconcile'),status:z.literal('committed'),providerReference:Id}).strict(),
  z.object({version:z.literal(1),operation:z.literal('reconcile'),status:z.literal('pending')}).strict(),
  z.object({version:z.literal(1),operation:z.enum(['auth_status','begin_login','submit_otp','search','prepare_checkout','commit_once','reconcile']),status:z.literal('error'),stage:z.string().regex(/^[a-z][a-z0-9_]{1,63}$/)}).strict(),
]);

export type AndroidWorkerRequestV1=z.infer<typeof AndroidWorkerRequestSchemaV1>;
export type AndroidWorkerResponseV1=z.infer<typeof AndroidWorkerResponseSchemaV1>;
export type AndroidCheckoutReviewV1=z.infer<typeof AndroidCheckoutReviewSchemaV1>;
```

Export the module from `packages/contracts/src/index.ts`.

- [ ] **Step 3: Add unavailable items to proposal summaries**

Extend `ProposalSummarySchemaV1` in `packages/contracts/src/transactions.ts` with:

```ts
unavailableItems:z.array(z.object({query:z.string().min(1),reason:z.enum(['out_of_stock','not_found','ambiguous'])}).strict()).max(30).optional(),
```

Add a contract test asserting unavailable items survive proposal parsing and no substitute line is invented.

- [ ] **Step 4: Verify and commit**

Run:

```bash
pnpm --filter @errandos/contracts test
pnpm --filter @errandos/contracts typecheck
git diff --check
```

Expected: all pass.

```bash
git add packages/contracts
git commit -m "feat: define typed Android worker protocol"
```

---

### Task 3: Build the Appium client and pure Blinkit screen detector

**Files:**
- Create: `packages/provider-connectors/src/android/appium-client.ts`
- Create: `packages/provider-connectors/src/blinkit/android-stage.ts`
- Create: `packages/provider-connectors/test/android-stage.test.ts`
- Create: `packages/provider-connectors/test/fixtures/blinkit-android/*.xml`
- Modify: `packages/provider-connectors/src/index.ts`

**Interfaces:**
- Consumes: local Appium endpoint
- Produces: `AndroidUiPort`, `AppiumHttpClient`, `detectBlinkitAndroidStage(source)`

- [ ] **Step 1: Add sanitized failing fixtures and tests**

Create fixtures for `login`, `otp`, `storefront`, `address-picker`, `checkout`, `payment-sheet`, `confirmation`, and `review-prompt`. Use synthetic product names and the label `Home`; include no phone, OTP, street address, account name, screenshot, or real order reference.

Create `packages/provider-connectors/test/android-stage.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { detectBlinkitAndroidStage } from '../src/blinkit/android-stage.js';

const fixture=(name:string)=>readFile(new URL(`./fixtures/blinkit-android/${name}.xml`,import.meta.url),'utf8');
describe('Blinkit Android stage detection',()=>{
  for(const [name,stage] of [['login','login_required'],['otp','otp_requested'],['storefront','storefront'],['address-picker','address_picker'],['checkout','checkout'],['payment-sheet','payment_sheet'],['confirmation','confirmed'],['review-prompt','confirmed']] as const){
    it(`detects ${stage}`,async()=>expect(detectBlinkitAndroidStage(await fixture(name))).toBe(stage));
  }
  it('returns unknown for unrecognized UI',()=>expect(detectBlinkitAndroidStage('<hierarchy/>')).toBe('unknown'));
});
```

Run:

```bash
pnpm --filter @errandos/provider-connectors test -- android-stage.test.ts
```

Expected: FAIL because the detector does not exist.

- [ ] **Step 2: Implement a narrow Appium port**

Create `packages/provider-connectors/src/android/appium-client.ts` exposing:

```ts
export interface UiElement { id:string; rect:{x:number;y:number;width:number;height:number}; text?:string; contentDescription?:string; clickable:boolean }
export interface AndroidUiPort {
  source():Promise<string>;
  findExactText(text:string):Promise<UiElement[]>;
  findResourceId(id:string):Promise<UiElement[]>;
  scrollExactTextIntoView(text:string):Promise<UiElement>;
  click(element:UiElement):Promise<void>;
  setValue(element:UiElement,value:string):Promise<void>;
  back():Promise<void>;
}
```

Implement `AppiumHttpClient` with a private W3C session, `fetch`, `appPackage: com.grofers.customerapp`, `appActivity: .DEFAULT`, `noReset: true`, and exact Appium endpoints. Error messages contain only the operation name and sanitized stage, never the request body or returned XML.

- [ ] **Step 3: Implement deterministic stage detection**

Create `packages/provider-connectors/src/blinkit/android-stage.ts`:

```ts
export type BlinkitAndroidStage='login_required'|'otp_requested'|'storefront'|'address_picker'|'checkout'|'payment_sheet'|'confirmed'|'unknown';
export function detectBlinkitAndroidStage(source:string):BlinkitAndroidStage{
  const text=source.toLowerCase();
  if(text.includes('order is confirmed')||text.includes('track order'))return 'confirmed';
  if(text.includes('cash on delivery')&&text.includes('bill total'))return 'payment_sheet';
  if(text.includes('place order')&&text.includes('pay using'))return 'checkout';
  if(text.includes('select delivery location')||text.includes('your saved addresses'))return 'address_picker';
  if(text.includes('one time password')||text.includes('verification code'))return 'otp_requested';
  if(text.includes('log in or sign up')||text.includes('continue'))return 'login_required';
  if(text.includes('view cart')||text.includes('search for atta'))return 'storefront';
  return 'unknown';
}
```

- [ ] **Step 4: Verify redaction and commit**

Add a test that injects a fake phone and OTP into a rejected Appium response and asserts the thrown message contains neither value.

Run:

```bash
pnpm --filter @errandos/provider-connectors test -- android-stage.test.ts
pnpm --filter @errandos/provider-connectors typecheck
git diff --check
```

Expected: all pass.

```bash
git add packages/provider-connectors
git commit -m "feat: add semantic Appium screen runtime"
```

---

### Task 4: Implement authentication, search, cart, and checkout preparation

**Files:**
- Create: `packages/provider-connectors/src/blinkit/android-driver.ts`
- Create: `packages/provider-connectors/test/android-driver.test.ts`
- Modify: `packages/provider-connectors/src/index.ts`

**Interfaces:**
- Consumes: `AndroidUiPort`
- Produces: `BlinkitAndroidDriver.authStatus`, `beginLogin`, `submitOtp`, `search`, and `prepareCheckout`

- [ ] **Step 1: Write failing semantic-action tests**

Create a fake `AndroidUiPort` that records semantic operations. Test these behaviors independently:

```ts
it('uses exact Cash on Delivery rather than the Pay On Delivery heading',async()=>{
  const ui=fakeUi({ exactTexts:['Pay On Delivery','Cash on Delivery'] });
  await new BlinkitAndroidDriver(ui).selectCashOnDelivery();
  expect(ui.clickedTexts).toEqual(['Cash on Delivery']);
});

it('scrolls Cash on Delivery into view before clicking',async()=>{
  const ui=fakeUi({ offscreenTexts:['Cash on Delivery'] });
  await new BlinkitAndroidDriver(ui).selectCashOnDelivery();
  expect(ui.operations).toEqual(['scroll:Cash on Delivery','click:Cash on Delivery']);
});

it('reselects Home and rebuilds a cart after a location prompt',async()=>{
  const ui=fakeUi({ stages:['address_picker','storefront'] });
  await new BlinkitAndroidDriver(ui).selectSavedAddress('Home');
  expect(ui.clickedTexts).toContain('Home');
});

it('returns unavailable lines without substituting products',async()=>{
  const review=await driverForCheckoutFixture().prepareCheckout([{query:'bread',quantity:1},{query:'cola',quantity:1}],'home','Home');
  expect(review.unavailableItems).toEqual([{query:'bread',reason:'out_of_stock'}]);
  expect(review.lines.some(line=>line.name.includes('substitute'))).toBe(false);
});
```

Run:

```bash
pnpm --filter @errandos/provider-connectors test -- android-driver.test.ts
```

Expected: FAIL because `BlinkitAndroidDriver` does not exist.

- [ ] **Step 2: Implement authentication with ephemeral values**

Implement:

```ts
public async authStatus():Promise<'active'|'login_required'|'challenge_required'>
public async beginLogin(phone:string):Promise<'otp_sent'|'active'>
public async submitOtp(otp:string):Promise<'active'|'challenge_required'>
```

`beginLogin` finds the login entry, fills the exact phone control, clicks the exact Continue control once, and waits for `otp_requested`. `submitOtp` fills only the active OTP controls and waits for `storefront`. Neither method stores its argument on the class or includes it in an error.

- [ ] **Step 3: Implement exact search and quantity selection**

Implement:

```ts
public async search(query:string,limit:number):Promise<AndroidSearchOffer[]>
public async setCartQuantity(productId:string,quantity:number):Promise<void>
```

Search extracts product ID, exact title, pack size, INR price, and availability. A query with multiple same-score candidates returns an `ambiguous` unavailable item instead of selecting the first result. Quantity changes are bounded to the requested integer and verified from the resulting accessibility label.

- [ ] **Step 4: Implement checkout preparation**

Implement:

```ts
public async prepareCheckout(items:readonly RequestedItem[],addressReference:string,addressLabel:string):Promise<AndroidCheckoutReviewV1>
```

The method selects the exact saved label, recreates quantities after a store/address change, opens `view_cart` through its clickable ancestor, extracts out-of-stock lines, opens checkout, scrolls the exact `Cash on Delivery` row into view, clicks it, and re-reads checkout.

Construct `providerFingerprint` from canonical JSON containing lines, unavailable items, fees, total, safe address reference/label, ETA, and `paymentMode:'cod'`. Validate line arithmetic and total arithmetic before returning.

- [ ] **Step 5: Verify and commit**

Run:

```bash
pnpm --filter @errandos/provider-connectors test -- android-driver.test.ts
pnpm --filter @errandos/provider-connectors typecheck
pnpm --filter @errandos/provider-connectors lint
git diff --check
```

Expected: all pass.

```bash
git add packages/provider-connectors
git commit -m "feat: prepare Blinkit checkout through Android"
```

---

### Task 5: Enforce one-shot commit and read-only reconciliation on the worker

**Files:**
- Create: `packages/provider-connectors/src/blinkit/android-commit.ts`
- Create: `packages/provider-connectors/test/android-commit.test.ts`
- Modify: `packages/provider-connectors/src/blinkit/android-driver.ts`

**Interfaces:**
- Consumes: expected proposal/hash/fingerprint/idempotency context
- Produces: `AndroidCommitStore`, `commitOnce`, and `reconcileFromOrderHistory`

- [ ] **Step 1: Write failing at-most-once tests**

Cover all four cases:

```ts
it('persists dispatch before the final click',async()=>{
  const sequence:string[]=[];
  const result=await commitOnce(fixtureExpected,{recordDispatch:async()=>sequence.push('persist'),clickFinal:async()=>sequence.push('click'),readConfirmation:async()=>({status:'committed',providerReference:'order-1'})});
  expect(sequence).toEqual(['persist','click']);
  expect(result).toEqual({outcome:'committed',providerReference:'order-1'});
});

it('returns stale without clicking when terms changed',async()=>expect(await staleHarness()).toEqual({outcome:'stale'}));
it('returns ambiguous and never retries after a post-click disconnect',async()=>expect(await disconnectHarness()).toEqual({outcome:'ambiguous'}));
it('returns the stored result for a duplicate idempotency key',async()=>expect((await duplicateHarness()).finalClickCount).toBe(1));
```

Run:

```bash
pnpm --filter @errandos/provider-connectors test -- android-commit.test.ts
```

Expected: FAIL because the commit module does not exist.

- [ ] **Step 2: Implement the durable commit store**

Implement `FileAndroidCommitStore` under the worker's data root with owner-only directories/files and atomic `wx` creation. Records contain hashes, states, timestamps, and provider references only; never UI source or personal data.

State transitions are:

```text
absent -> dispatching -> committed
                     -> ambiguous
```

Existing `dispatching`, `ambiguous`, or `committed` records prohibit another final click.

- [ ] **Step 3: Implement exact revalidation and one final action**

`commitOnce` re-extracts checkout and compares every material field to the expected checkout. It writes `dispatching`, finds exactly one exact `Place Order` element, clicks once, and reads confirmation. Confirmation must include `Order is confirmed` or a unique order reference. Appium errors after dispatch are caught as `ambiguous`.

- [ ] **Step 4: Implement read-only reconciliation**

`reconcileFromOrderHistory` opens order history through semantic navigation without touching cart or checkout. It returns committed only for one order matching the proposal time window, exact lines, total, Home reference, and COD. Zero or multiple matches return `pending`.

- [ ] **Step 5: Verify and commit**

Run:

```bash
pnpm --filter @errandos/provider-connectors test -- android-commit.test.ts
pnpm --filter @errandos/provider-connectors typecheck
git diff --check
```

Expected: all pass.

```bash
git add packages/provider-connectors
git commit -m "feat: guard Android Blinkit commit at most once"
```

---

### Task 6: Add the typed worker command and SSH/IAP client

**Files:**
- Modify: `apps/worker/package.json`
- Replace: `apps/worker/src/index.ts`
- Create: `apps/worker/src/android-job-entry.ts`
- Create: `apps/worker/test/android-job-entry.test.ts`
- Create: `packages/provider-connectors/src/android/worker-client.ts`
- Create: `packages/provider-connectors/test/android-worker-client.test.ts`
- Create: `infra/gcp/android-worker/deploy-runtime.sh`

**Interfaces:**
- Consumes: one JSON request on stdin
- Produces: one validated JSON response on stdout and `AndroidWorkerPort.execute(request)` in the control plane

- [ ] **Step 1: Write failing worker-entry redaction tests**

Test `runAndroidJob(input, dependencies)` directly. Assert valid requests dispatch once, invalid operations fail generically, and fake phone/OTP values never appear in stdout, stderr, or thrown messages.

Run:

```bash
pnpm --filter @errandos/worker test
```

Expected: FAIL because `runAndroidJob` does not exist.

- [ ] **Step 2: Implement one-request stdin/stdout execution**

`apps/worker/src/android-job-entry.ts` reads at most 64 KiB from stdin, parses `AndroidWorkerRequestSchemaV1`, creates `AppiumHttpClient`, invokes the matching `BlinkitAndroidDriver` method, validates `AndroidWorkerResponseSchemaV1`, writes one JSON line, and closes the Appium session in `finally`.

Do not log request bodies. On failure write only:

```json
{"version":1,"status":"error","stage":"sanitized_worker_stage"}
```

and exit non-zero.

- [ ] **Step 3: Write and implement the SSH client tests**

Inject a `SpawnPort` and assert the production client builds exactly these arguments:

```ts
[
  'compute','ssh',vm,'--project',project,'--zone',zone,'--tunnel-through-iap',
  '--command','/opt/errandos/bin/android-worker-job'
]
```

Assert the serialized request is written to child stdin and no request field appears in arguments. Parse exactly one response line and validate it with Zod.

- [ ] **Step 4: Implement deterministic deployment**

Create `infra/gcp/android-worker/deploy-runtime.sh` that:

1. reads project, zone, and VM from the existing state file;
2. runs the workspace build locally;
3. creates a temporary deployment archive containing only built workspace packages and production manifests;
4. copies it through IAP;
5. installs it under `/opt/errandos/releases/<git-sha>`;
6. atomically updates `/opt/errandos/current`;
7. installs `/opt/errandos/bin/android-worker-job` as a fixed wrapper for `/opt/node/bin/node /opt/errandos/current/apps/worker/dist/src/android-job-entry.js`.

The script must never copy `.env`, profiles, screenshots, UI dumps, traces, logs, or the local Git directory.

- [ ] **Step 5: Verify and commit**

Run:

```bash
pnpm --filter @errandos/worker test
pnpm --filter @errandos/provider-connectors test -- android-worker-client.test.ts
bash -n infra/gcp/android-worker/deploy-runtime.sh
git diff --check
```

Expected: all pass.

```bash
git add apps/worker packages/provider-connectors infra/gcp/android-worker/deploy-runtime.sh
git commit -m "feat: dispatch typed jobs to Android worker"
```

---

### Task 7: Wire `AndroidBlinkitAdapter` into durable transactions

**Files:**
- Create: `packages/provider-connectors/src/blinkit/android-adapter.ts`
- Create: `packages/provider-connectors/test/android-adapter.test.ts`
- Modify: `packages/application/src/transactions.ts`
- Modify: `packages/application/test/transactions.test.ts`
- Modify: `packages/provider-connectors/src/index.ts`

**Interfaces:**
- Consumes: `AndroidWorkerPort`, `DurableProviderState`, and `CommitDispatchContext`
- Produces: `AndroidBlinkitAdapter implements TransactionProviderPort` and `AndroidBlinkitAuthCoordinator`

- [ ] **Step 1: Extend the provider commit port test-first**

Change the application port to:

```ts
export interface CommitDispatchContext { proposalId:string; proposalHash:string; idempotencyKey:string }
export interface TransactionProviderPort {
  prepareGrocery?(principalId:PrincipalId,input:PrepareGroceryInput):Promise<PreparedProviderState>;
  commit(principalId:PrincipalId,providerStateRef:string,context:CommitDispatchContext):Promise<CommitResult>;
  reconcile(principalId:PrincipalId,providerStateRef:string):Promise<CommitResult|{outcome:'pending'}>;
}
```

Update the transaction test fake to record the context and assert the exact proposal ID, canonical hash, and caller idempotency key reach the provider once.

Run:

```bash
pnpm --filter @errandos/application test -- transactions.test.ts
```

Expected: FAIL until `commitAuthorizedOnce` passes the context.

- [ ] **Step 2: Implement the Android adapter preparation path**

`AndroidBlinkitAdapter.prepareGrocery` sends `prepare_checkout`, validates the returned review, converts it to `GroceryProposalSnapshotV1`, and persists sanitized worker expectation state through `DurableProviderState`. The snapshot uses the safe Home reference/label and COD only.

- [ ] **Step 3: Implement commit and reconciliation**

`commit` loads the provider state, sends `commit_once` with the dispatch context and expected provider fingerprint, and maps worker outcomes to `committed`, `stale`, or `ambiguous`. `reconcile` sends only `reconcile` and maps `pending` without any mutation.

- [ ] **Step 4: Implement Android authentication coordination**

Create `AndroidBlinkitAuthCoordinator` with `status`, `begin`, and `submitOtp`. It maps existing MCP auth schemas to worker requests and creates opaque session IDs without persisting phone or OTP.

- [ ] **Step 5: Verify isolation, stale handling, and redaction**

Tests must cover two principals using different account keys, changed fingerprints returning stale, duplicate commit contexts producing one worker dispatch, post-dispatch ambiguity, and serialized state containing no phone, OTP, UI XML, screenshots, Appium IDs, or full address.

Run:

```bash
pnpm --filter @errandos/application test
pnpm --filter @errandos/provider-connectors test -- android-adapter.test.ts
pnpm --filter @errandos/application typecheck
pnpm --filter @errandos/provider-connectors typecheck
git diff --check
```

Expected: all pass.

```bash
git add packages/application packages/provider-connectors
git commit -m "feat: add durable Android Blinkit adapter"
```

---

### Task 8: Activate Android Blinkit through MCP

**Files:**
- Modify: `apps/control-plane/src/deployment.ts`
- Modify: `apps/control-plane/src/mcp.ts`
- Modify: `apps/control-plane/test/deployment.test.ts`
- Modify: `apps/control-plane/test/mcp.test.ts`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/provider-adapter-scope.md`

**Interfaces:**
- Consumes: GCP project, zone, VM, worker command, data root, live gates
- Produces: Blinkit-specific MCP tools backed only by `AndroidBlinkitAdapter`

- [ ] **Step 1: Write failing deployment tests**

Add tests requiring these settings when Android Blinkit is active:

```text
ERRANDOS_BLINKIT_EXECUTION=android
ERRANDOS_GCP_PROJECT
ERRANDOS_GCP_ZONE
ERRANDOS_GCP_ANDROID_VM
ERRANDOS_ANDROID_WORKER_COMMAND=/opt/errandos/bin/android-worker-job
```

Reject `ERRANDOS_BLINKIT_EXECUTION=playwright` whenever `ERRANDOS_LIVE_BROWSER_ACTIONS=true`.

- [ ] **Step 2: Register the Blinkit semantic aliases**

Add these MCP names with the same strict schemas and handlers as their generic counterparts:

```text
blinkit_auth_status
blinkit_begin_login
blinkit_submit_otp
blinkit_search
blinkit_prepare_cod_order
blinkit_place_cod_order
blinkit_order_status
blinkit_reconcile_order
```

Mark search/status/reconciliation read-only. Mark preparation and login as mutating but not destructive. Mark place order destructive and idempotent.

- [ ] **Step 3: Replace only Blinkit's runtime wiring**

In `createTransactionRuntime`, instantiate `GcloudAndroidWorkerClient`, `AndroidBlinkitAdapter`, and `AndroidBlinkitAuthCoordinator` for Blinkit. Do not create a Blinkit browser adapter or Blinkit browser login coordinator.

- [ ] **Step 4: Update repository policy**

Update the provider policy consistently:

- Blinkit uses the official Android app through `AndroidBlinkitAdapter`.
- Unrelated provider runtimes remain inactive.
- Raw Appium/ADB/device tools remain prohibited.
- The same proposal, hash, idempotency, final-action, receipt, and reconciliation rules apply.

- [ ] **Step 5: Verify MCP behavior and commit**

Run:

```bash
pnpm --filter @errandos/control-plane test
pnpm --filter @errandos/control-plane typecheck
pnpm --filter @errandos/control-plane lint
git diff --check
```

Expected: all pass and tool listing contains the new Blinkit aliases plus existing compatibility tools.

```bash
git add apps/control-plane AGENTS.md README.md docs/provider-adapter-scope.md
git commit -m "feat: route Blinkit MCP through Android worker"
```

---

### Task 9: Update and validate the portable ErrandOS skill

**Files:**
- Modify: `hermes/skills/errandos/SKILL.md`
- Modify: `hermes/skills/errandos/references/architecture.md`
- Create: `hermes/skills/errandos/references/blinkit-android-workflow.md`
- Create: `hermes/skills/errandos/references/rendering-examples.md`
- Create: `hermes/skills/errandos/agents/openai.yaml`
- Create: `apps/control-plane/test/hermes-skill.test.ts`

**Interfaces:**
- Consumes: typed Blinkit MCP tools
- Produces: Agent Skills-compatible instructions that never direct an agent to Appium or raw device control

- [ ] **Step 1: Write the failing skill contract test**

Create `apps/control-plane/test/hermes-skill.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { describe,expect,it } from 'vitest';

const skill=()=>readFile(new URL('../../../hermes/skills/errandos/SKILL.md',import.meta.url),'utf8');
describe('ErrandOS Hermes skill',()=>{
  it('uses the typed Android Blinkit workflow',async()=>{
    const text=await skill();
    for(const tool of ['blinkit_auth_status','blinkit_prepare_cod_order','blinkit_place_cod_order','blinkit_reconcile_order'])expect(text).toContain(tool);
    expect(text).toMatch(/ambiguous[\s\S]*never[\s\S]*(place|commit)/i);
  });
  it('does not teach raw provider control',async()=>{
    expect(await skill()).not.toMatch(/adb shell|input tap|click coordinate|appium session|browser_click|run_javascript/i);
  });
});
```

Run:

```bash
pnpm --filter @errandos/control-plane test -- hermes-skill.test.ts
```

Expected: FAIL because the current skill names only generic tools and describes persistent browser sessions.

- [ ] **Step 2: Rewrite the Blinkit decision workflow**

Keep the skill concise and make these branches explicit:

```text
search -> blinkit_search
prepare/cart/total -> auth if needed -> blinkit_prepare_cod_order -> render -> stop
order/buy/place -> auth if needed -> prepare -> render exact terms -> blinkit_place_cod_order once
stale -> prepare a new proposal
committing -> blinkit_order_status
ambiguous -> blinkit_reconcile_order only
committed -> render verified receipt
```

Use deterministic idempotency from interface event ID plus proposal ID. Never generate a replacement key for a timeout.

- [ ] **Step 3: Add the workflow and rendering references**

`blinkit-android-workflow.md` contains the semantic state machine, authentication recovery, stale cart/address behavior, exact COD selection rule, one-shot dispatch, and reconciliation behavior. It contains no selectors or coordinates.

`rendering-examples.md` contains compact examples for search results, prepared proposals, unavailable items, committed receipts, and ambiguous outcomes. Use fictional data only.

- [ ] **Step 4: Generate skill UI metadata and validate**

Run the skill creator generator with:

```bash
python /Users/suraj/.codex/skills/.system/skill-creator/scripts/generate_openai_yaml.py hermes/skills/errandos \
  --interface display_name="ErrandOS" \
  --interface short_description="Operate personal Blinkit COD errands safely" \
  --interface default_prompt="Use ErrandOS typed tools to search, prepare, place, or reconcile my Blinkit COD order."
python /Users/suraj/.codex/skills/.system/skill-creator/scripts/quick_validate.py hermes/skills/errandos
```

Expected: validation succeeds.

- [ ] **Step 5: Verify and commit**

Run:

```bash
pnpm --filter @errandos/control-plane test -- hermes-skill.test.ts
git diff --check
```

Expected: all pass.

```bash
git add hermes/skills/errandos apps/control-plane/test/hermes-skill.test.ts
git commit -m "feat: teach agents the Android Blinkit workflow"
```

---

### Task 10: Deploy, run the safe canary, and complete repository verification

**Files:**
- Modify only when a verified canary defect requires a test-first fix
- Do not commit live profiles, state, screenshots, UI XML, logs, or environment files

**Interfaces:**
- Consumes: completed Android workflow and current GCP emulator
- Produces: evidence that typed operations work end to end

- [ ] **Step 1: Run all offline gates**

Run:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
git diff --check
```

Expected: every command exits `0`. PostgreSQL integration tests must run against the documented test database; do not report a full pass if they were skipped.

- [ ] **Step 2: Deploy with both live gates disabled**

Run:

```bash
infra/gcp/android-worker/deploy-runtime.sh
```

Configure the control plane with Android Blinkit execution and:

```text
ERRANDOS_LIVE_BROWSER_ACTIONS=false
ERRANDOS_LIVE_COMMIT=false
```

Expected: health and authentication status work; mutating provider actions are rejected by the gate.

- [ ] **Step 3: Run authenticated search and preparation canaries**

Enable live browser actions while keeping commit false. Through MCP only:

1. call `blinkit_auth_status`;
2. complete typed phone/OTP login only if required;
3. search a low-value item;
4. prepare a COD proposal for Home;
5. verify exact lines, unavailable items, arithmetic, total, ETA, COD, expiry, and proposal hash;
6. call order status and confirm nothing was ordered.

Expected: no agent uses Appium, ADB, screenshots, coordinates, or raw device commands.

- [ ] **Step 4: Exercise stale and ambiguous paths without a second final action**

Use offline/fake worker injection for post-click disconnect. Verify transaction status becomes `ambiguous`, duplicate commit returns the stored ambiguous result, and reconciliation performs a read only.

- [ ] **Step 5: Run one explicitly authorized live COD canary**

Only after the owner sees and accepts the exact prepared terms, enable live commit and call `blinkit_place_cod_order` once with a deterministic key. If the response is ambiguous, call `blinkit_reconcile_order`; never call place again.

Expected: either a committed receipt with verified provider evidence or an honest ambiguous status. Disable live commit immediately afterward.

- [ ] **Step 6: Clean diagnostics and audit the tree**

Remove temporary screenshots/UI dumps on the VM and local machine. Run:

```bash
git status --short
git ls-files | rg '(\.env|screenshot|ui-dump|profile|trace|\.log$)' && exit 1 || true
```

Expected: no sensitive or generated provider artifacts are tracked.

- [ ] **Step 7: Request review and integrate**

Use `superpowers:requesting-code-review`, address findings, rerun all gates, then use `superpowers:finishing-a-development-branch` to merge or open a PR according to the owner's choice.
