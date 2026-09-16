/** limiter 单桶语义测试（S2）：假时钟 + 手动 fire 的睡眠，断言真实等待语义。
 *
 * 设计意图：
 * - 双桶 min 语义由调用方两次 acquire 表达，本文件不断“组合”，只断单桶行为，外加一个
 *   “两次 acquire 串起来”的组合示例证明 min 的表达方式成立（紧的桶卡住，松的桶有余量也得等）。
 * - 每个用例都用独立 harness（`now` 起点、`sleeps` 记录、`advance` 推时间、`fireAll` 放行），
 *   断言“排了多久的队”（sleep 请求的毫秒数精确等于滑窗剩余）而非只断“最终放行”。
 * - key 隔离：不同 key 的桶互不干扰，每个用例用专属 key（顺带覆盖）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { TokenBuckets } from "../src/limiter.ts";

const MINUTE = 60_000;

function setup() {
  let now = 1_000_000;
  const sleeps: Array<{ ms: number; fire: () => void }> = [];
  const buckets = new TokenBuckets(
    () => now,
    (ms: number) =>
      new Promise<void>((resolve) => {
        sleeps.push({ ms, fire: () => resolve(undefined) });
      }),
  );
  const tick = async (n = 10): Promise<void> => {
    for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
  };
  /** 放行当前全部睡眠并泵干微任务（pump 循环纯微任务，一次 fireAll 足够推进到再次停靠）。 */
  const fireAll = async (): Promise<void> => {
    for (const s of sleeps.splice(0)) s.fire();
    await tick();
  };
  return { buckets, sleeps, tick, fireAll, advance: (ms: number): void => void (now += ms) };
}

test("空 dims 直接过：不限流、不设闹钟；非正限流值 fail-open", async () => {
  const { buckets, sleeps } = setup();
  await buckets.acquire("empty", {});
  assert.equal(sleeps.length, 0, "空 dims 不应请求任何等待");
  await buckets.acquire("empty", { rpm: 0, tpm: -5, maxConcurrent: 0 });
  assert.equal(sleeps.length, 0, "非正限流值按不限流处理，永不把宿主卡死");
});

test("RPM 滑窗放行：窗内未满直接过", async () => {
  const { buckets, sleeps } = setup();
  await buckets.acquire("rpm-free", { rpm: 2 });
  await buckets.acquire("rpm-free", { rpm: 2 });
  assert.equal(sleeps.length, 0, "2rpm 连下两城都不该排队");
});

test("RPM 耗尽排队后放行：等满 60 秒整", async () => {
  const { buckets, sleeps, tick, fireAll, advance } = setup();
  await buckets.acquire("rpm-wait", { rpm: 1 });
  let done = false;
  const p = buckets.acquire("rpm-wait", { rpm: 1 });
  void p.then(() => void (done = true));
  await tick();
  assert.equal(done, false, "RPM 耗尽时第二次 acquire 必须排队");
  assert.equal(sleeps.length, 1, "排队恰设一个闹钟");
  assert.equal(sleeps[0].ms, MINUTE, "等待时长精确等于滑窗剩余（60s）");
  advance(MINUTE);
  await fireAll();
  await p;
  assert.equal(done, true, "窗口滑过后排队者放行，且只延迟不拒绝");
});

test("FIFO 顺序：rpm=1 时排队者按先到先发，各等一窗", async () => {
  const { buckets, sleeps, tick, fireAll, advance } = setup();
  await buckets.acquire("fifo", { rpm: 1 });
  const order: string[] = [];
  let doneB = false;
  let doneC = false;
  const pB = buckets.acquire("fifo", { rpm: 1 });
  void pB.then(() => void (doneB = true));
  void pB.then(() => void order.push("B"));
  const pC = buckets.acquire("fifo", { rpm: 1 });
  void pC.then(() => void (doneC = true));
  void pC.then(() => void order.push("C"));
  await tick();
  assert.equal(doneB, false, "B 先排队但窗未过，不能先放");
  assert.equal(doneC, false, "C 后到，更不能超车");
  assert.equal(sleeps.length, 1, "队头只有一个闹钟（C 跟在 B 后面，没有自己的闹钟）");
  advance(MINUTE);
  await fireAll();
  assert.deepEqual(order, ["B"], "第一窗只放行队头 B");
  assert.equal(doneC, false, "C 还得再等一窗（rpm=1 一窗只出一个）");
  assert.equal(sleeps.length, 1, "C 接棒成为队头，补设自己的闹钟");
  assert.equal(sleeps[0].ms, MINUTE, "C 的等待同样是完整一窗");
  advance(MINUTE);
  await fireAll();
  await pC;
  assert.deepEqual(order, ["B", "C"], "最终按先到先发，且无人被拒绝");
});

test("abort 放弃排队：抛 signal.reason，后来者不受牵连", async () => {
  const { buckets, sleeps, tick, fireAll, advance } = setup();
  await buckets.acquire("abort", { rpm: 1 });
  const controller = new AbortController();
  let doneB = false;
  const pB = buckets.acquire("abort", { rpm: 1 }, controller.signal);
  void pB.then(
    () => void (doneB = true),
    () => {},
  );
  let doneC = false;
  const pC = buckets.acquire("abort", { rpm: 1 });
  void pC.then(() => void (doneC = true));
  await tick();
  assert.equal(doneB, false, "B 排队中");
  assert.equal(doneC, false, "C 跟在 B 后面排队");
  controller.abort(new Error("stop"));
  await assert.rejects(pB, /stop/, "abort 后排队者以 signal.reason 抛错");
  assert.equal(doneB, false, "B 没有被放行而是放弃了");
  assert.equal(doneC, false, "窗口未过，C 继续等（不受 B 放弃的影响）");
  advance(MINUTE);
  await fireAll();
  await pC;
  assert.equal(doneC, true, "B 放弃后 C 顺利接棒，证明放弃者已离队");
  assert.equal(sleeps.length, 0, "全部放行后不再有残留闹钟");
});

test("已 abort 的 signal 直接拒绝：不进队", async () => {
  const { buckets, sleeps } = setup();
  const controller = new AbortController();
  controller.abort(new Error("early"));
  await assert.rejects(buckets.acquire("abort-early", { rpm: 100 }, controller.signal), /early/, "进队前已 abort 直接抛错");
  assert.equal(sleeps.length, 0, "直接拒绝不设闹钟");
});

test("并发上限排队：占满只等 release，不烧闹钟", async () => {
  const { buckets, sleeps, tick } = setup();
  await buckets.acquire("conc", { maxConcurrent: 1 });
  let done = false;
  const p = buckets.acquire("conc", { maxConcurrent: 1 });
  void p.then(() => void (done = true));
  await tick();
  assert.equal(done, false, "并发槽被占时第二次 acquire 排队");
  assert.equal(sleeps.length, 0, "并发等待不设闹钟（只等 release，不是等时刻）");
  buckets.release("conc");
  await p;
  assert.equal(done, true, "release 后排队者立即放行");
  assert.doesNotThrow(() => {
    buckets.release("conc");
    buckets.release("no-such-key");
  }, "超额归还/未知 key 忽略，不抛错");
  await buckets.acquire("other-key", { maxConcurrent: 1 });
  assert.equal(sleeps.length, 0, "不同 key 互不干扰");
});

test("双桶 min 由调用方两次 acquire 表达：紧的桶说了算", async () => {
  const { buckets, sleeps, tick, fireAll, advance } = setup();
  // 首个逻辑请求：provider 桶 + provider/model 桶各取一次，都放行。
  await buckets.acquire("prov", { rpm: 1 });
  await buckets.acquire("prov/m", { rpm: 100 });
  // 第二个逻辑请求：先取 provider 桶（紧），被卡住。
  let step1Done = false;
  const step1 = buckets.acquire("prov", { rpm: 1 });
  void step1.then(() => void (step1Done = true));
  await tick();
  assert.equal(step1Done, false, "provider 桶 RPM 耗尽，整个请求被卡住");
  assert.equal(sleeps[0].ms, MINUTE, "卡在紧的桶上，等一窗");
  advance(MINUTE);
  await fireAll();
  await step1;
  // 再取 model 桶（松）：有余量，直接过。
  await buckets.acquire("prov/m", { rpm: 100 });
  assert.equal(sleeps.length, 0, "松的桶不设闹钟——min 语义成立：整体等待 == 最紧的桶的等待");
});

test("TPM 预占位：窗内 token 超了就等，窗空了超配也放（永不饿死）", async () => {
  const { buckets, sleeps, tick, fireAll, advance } = setup();
  await buckets.acquire("tpm", { tpm: 100 }, undefined, 60);
  let done = false;
  const p = buckets.acquire("tpm", { tpm: 100 }, undefined, 60);
  void p.then(() => void (done = true));
  await tick();
  assert.equal(done, false, "60+60>100，第二次预占必须排队");
  assert.equal(sleeps[0].ms, MINUTE, "等到上一次占位滑出窗口");
  advance(MINUTE);
  await fireAll();
  await p;
  assert.equal(done, true, "占位滑出后放行");
  await buckets.acquire("tpm-big", { tpm: 50 }, undefined, 60);
  assert.equal(sleeps.length, 0, "窗内无竞争时单次超配也放行（再等也腾不出配额，不饿死）");
});

test("revoke 回滚 phantom：没发出去的占位不白占 60 秒", async () => {
  const { buckets, sleeps, tick, fireAll, advance } = setup();
  await buckets.acquire("revoke-rpm", { rpm: 1 });
  // 第二个请求本该等一窗：phantom 回滚后应直接过。
  buckets.revoke("revoke-rpm");
  await buckets.acquire("revoke-rpm", { rpm: 1 });
  assert.equal(sleeps.length, 0, "revoke 后 RPM 槽已还，不该再排队");
  // TPM 占位同样回滚（同值从尾删）。
  await buckets.acquire("revoke-tpm", { tpm: 100 }, undefined, 60);
  buckets.revoke("revoke-tpm", 60);
  await buckets.acquire("revoke-tpm", { tpm: 100 }, undefined, 60);
  assert.equal(sleeps.length, 0, "TPM 占位回滚后不该排队");
  // 未知 key / 空窗 revoke 不抛。
  assert.doesNotThrow(() => {
    buckets.revoke("no-such-key");
    buckets.revoke("revoke-rpm");
  });
  await tick();
  await fireAll();
  advance(1000);
});

test("abort 早醒不拖进程：默认睡眠 timer 一律 unref", async () => {
  // 断真实语义：排队 abort 后残留的真 timer 不得持有事件循环（曾拖住测试进程 60 秒）。
  // 包一层 setTimeout 如实记录（ms 照传、handle 照回），只看长 timer 是否 unref。
  const created: Array<{ ms: number; hasRef: () => boolean }> = [];
  const g = globalThis as { setTimeout: typeof setTimeout };
  const realSetTimeout = g.setTimeout;
  g.setTimeout = ((fn: (...args: unknown[]) => void, ms: number, ...rest: unknown[]) => {
    const handle = (realSetTimeout as (...args: unknown[]) => NodeJS.Timeout)(fn, ms, ...rest);
    created.push({ ms, hasRef: () => handle.hasRef() });
    return handle;
  }) as typeof setTimeout;
  try {
    const buckets = new TokenBuckets(); // 默认时钟 + 默认睡眠（真 timer）
    await buckets.acquire("unref-rpm", { rpm: 1 });
    const controller = new AbortController();
    const queued = buckets.acquire("unref-rpm", { rpm: 1 }, controller.signal);
    void queued.catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    controller.abort(new Error("test-abort"));
    await assert.rejects(queued);
    await new Promise((r) => setTimeout(r, 20));
    const stranded = created.filter((t) => t.ms >= 59_000);
    assert.ok(stranded.length >= 1, "排队应建过分钟级真 timer");
    for (const t of stranded) assert.equal(t.hasRef(), false, "残留 timer 必须 unref，不得拖住进程退出");
  } finally {
    g.setTimeout = realSetTimeout;
  }
});
