/** model-governor 限流器（S2）：单 key 的 RPM 滑窗 + 并发计数 + TPM 预占位，只排队延迟、永不拒绝。
 *
 * 设计意图：
 * - 双桶 min 语义不在这里实现——调用方（cordis 中间件）对 `(provider)` 桶和 `(provider,model)` 桶各 `acquire`
 *   一次，先后两次都放行才放行，自然取 min（方案 docs/designs/2026-09-16-model-thinking-rpm-overrides.md §3.3）。
 *   因此本类只管“单桶”，不管桶组合。
 * - 每个 key 独立维护：60 秒滑窗内的放行时刻（RPM）、滑窗内的 token 占位（TPM）、当前持有人数（并发），
 *   外加一条 FIFO 等待队列。队头不满足条件就睡到“最早可能放行的时刻”再看，绝不抛错拒绝；
 *   只有调用方 `abort` 才放弃排队并以 `signal.reason` 抛错。
 * - TPM 预占数是估计值：调用方传 `options.maxTokens ?? 0`（实际用量只有流结束后才知道，事前只能按上限占位，
 *   偏保守；若单次预占超过桶容量，等窗内其它占位滑出后仍放行，保证永不饿死）。
 * - 并发槽的释放靠调用方在 gated 工作结束后调 `release(key)`（cordis 侧放 `finally` 里）；多调无害（钳在 0）。
 * - 时钟与睡眠均可注入：生产用 `Date.now` + `setTimeout`，单测用假时钟 + 手动 fire 的睡眠，
 *   断言“等了多久”这类真实语义，而不是凑绿。
 * - 非正的 rpm/tpm/maxConcurrent 按不限流处理（fail-open：配置校验在 config.ts，限流器永不把宿主卡死）。
 * - 零依赖铁律：只 type-only import 本包 `src/config.ts` 的 `LimitDims`（运行时零 import）。
 */
import type { LimitDims } from "./config.ts";

/** 毫秒时钟（生产：`Date.now`；测试：手动推进的假时钟）。 */
export type Clock = () => number;

/** 睡眠函数（生产：`setTimeout` 包一层；测试：手动 fire，顺带记录请求的等待时长）。 */
export type SleepFn = (ms: number) => Promise<void>;

const RPM_WINDOW_MS = 60_000;
const TPM_WINDOW_MS = 60_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** >0 才是有意义的限流值；缺省/0/负数一律视为不限。 */
function positive(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

type Waiter = {
  dims: LimitDims;
  reserveTokens: number;
  signal: AbortSignal | undefined;
  resolve: () => void;
  reject: (err: unknown) => void;
  cleanup: () => void;
};

type BucketState = {
  /** 滑窗内每次放行的时刻（升序，只保留窗内）。 */
  starts: number[];
  /** 滑窗内的 TPM 占位（升序，只保留窗内）。 */
  tokens: Array<{ t: number; n: number }>;
  /** 当前持有并发槽的数量（acquire 放行时 +1，release 时 -1）。 */
  inflight: number;
  /** FIFO 等待队列（队头优先）。 */
  queue: Waiter[];
  /** pump 循环是否在跑（防重入；停在 Infinity 上的并发等待不算“在跑”）。 */
  pumping: boolean;
  /** 叫醒当前睡眠的 pump（release/abort 触发早醒，超时靠 sleep 自然醒）。 */
  waker: (() => void) | null;
};

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("TokenBuckets.acquire: aborted while queued");
}

export class TokenBuckets {
  private readonly clock: Clock;
  private readonly sleep: SleepFn;
  private readonly states = new Map<string, BucketState>();

  constructor(clock: Clock = Date.now, sleep: SleepFn = defaultSleep) {
    this.clock = clock;
    this.sleep = sleep;
  }

  /** 取一次令牌：满足条件立即放行，否则按 FIFO 排队等到满足条件；abort 即放弃排队抛错。 */
  async acquire(key: string, dims: LimitDims, signal?: AbortSignal, reserveTokens = 0): Promise<void> {
    if (signal?.aborted) throw abortError(signal);
    const st = this.stateFor(key);
    // 快路：不限流 dims 且无人排队，直接过（不记录、不排队）。
    if (!this.limited(dims, reserveTokens) && st.queue.length === 0) return;
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        dims,
        reserveTokens,
        signal,
        resolve,
        reject,
        cleanup: () => {},
      };
      const onAbort = (): void => {
        const idx = st.queue.indexOf(waiter);
        if (idx >= 0) st.queue.splice(idx, 1);
        waiter.cleanup();
        waiter.reject(abortError(signal as AbortSignal));
        this.notify(st);
        this.pump(key, st);
      };
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener("abort", onAbort);
      }
      const wrappedResolve = waiter.resolve;
      waiter.resolve = () => {
        waiter.cleanup();
        wrappedResolve();
      };
      const wrappedReject = waiter.reject;
      waiter.reject = (err: unknown) => {
        waiter.cleanup();
        wrappedReject(err);
      };
      st.queue.push(waiter);
      this.pump(key, st);
    });
  }

  /** 归还一个并发槽（ shaping 给 `finally` 用；未知 key / 超额归还一律忽略）。 */
  release(key: string): void {
    const st = this.states.get(key);
    if (!st || st.inflight <= 0) return;
    st.inflight -= 1;
    this.notify(st);
    this.pump(key, st);
  }

  private stateFor(key: string): BucketState {
    let st = this.states.get(key);
    if (!st) {
      st = { starts: [], tokens: [], inflight: 0, queue: [], pumping: false, waker: null };
      this.states.set(key, st);
    }
    return st;
  }

  /** 该调用是否受任何一维约束（决定快路能否直接过）。 */
  private limited(dims: LimitDims, reserveTokens: number): boolean {
    return positive(dims.rpm) || positive(dims.maxConcurrent) || (positive(dims.tpm) && reserveTokens > 0);
  }

  private notify(st: BucketState): void {
    st.waker?.();
  }

  private prune(st: BucketState, now: number): void {
    while (st.starts.length > 0 && !(st.starts[0] > now - RPM_WINDOW_MS)) st.starts.shift();
    while (st.tokens.length > 0 && !(st.tokens[0].t > now - TPM_WINDOW_MS)) st.tokens.shift();
  }

  /** 队头此刻能否放行；不能则给出还需等待的毫秒数（Infinity = 只等 release/abort，不设闹钟）。 */
  private evaluate(st: BucketState, waiter: Waiter, now: number): { ok: true } | { ok: false; waitMs: number } {
    this.prune(st, now);
    const maxConcurrent = waiter.dims.maxConcurrent;
    if (positive(maxConcurrent) && st.inflight >= maxConcurrent) {
      // 并发满了没有“时刻”可等，只能等别人 release；若同时被 RPM/TPM 卡住则取有限等待，release 会早醒。
      const timed = this.timedWait(st, waiter, now);
      return timed === null ? { ok: false, waitMs: Number.POSITIVE_INFINITY } : { ok: false, waitMs: timed };
    }
    const timed = this.timedWait(st, waiter, now);
    return timed === null || timed <= 0 ? { ok: true } : { ok: false, waitMs: timed };
  }

  /** RPM/TPM 两维需要的等待时长（毫秒）；null = 都不卡。 */
  private timedWait(st: BucketState, waiter: Waiter, now: number): number | null {
    let waitMs = 0;
    let blocked = false;
    const rpm = waiter.dims.rpm;
    if (positive(rpm) && st.starts.length >= rpm) {
      blocked = true;
      waitMs = Math.max(waitMs, st.starts[0] + RPM_WINDOW_MS - now);
    }
    const tpm = waiter.dims.tpm;
    if (positive(tpm) && waiter.reserveTokens > 0) {
      let sum = 0;
      for (const entry of st.tokens) sum += entry.n;
      if (sum + waiter.reserveTokens > tpm && sum > 0) {
        blocked = true;
        waitMs = Math.max(waitMs, st.tokens[0].t + TPM_WINDOW_MS - now);
      }
      // sum === 0 时即使单次预占超桶也放行（窗内无竞争，再等也腾不出配额，永不饿死）。
    }
    return blocked ? Math.max(0, waitMs) : null;
  }

  private grant(st: BucketState, waiter: Waiter, now: number): void {
    this.prune(st, now);
    st.starts.push(now);
    if (waiter.reserveTokens > 0) st.tokens.push({ t: now, n: waiter.reserveTokens });
    if (positive(waiter.dims.maxConcurrent)) st.inflight += 1;
  }

  private pump(key: string, st: BucketState): void {
    if (st.pumping) return;
    st.pumping = true;
    void (async () => {
      try {
        for (;;) {
          const head = st.queue[0];
          if (!head) return;
          if (head.signal?.aborted) {
            st.queue.shift();
            head.reject(abortError(head.signal));
            continue;
          }
          const decision = this.evaluate(st, head, this.clock());
          if (decision.ok) {
            st.queue.shift();
            this.grant(st, head, this.clock());
            head.resolve();
            continue;
          }
          if (!Number.isFinite(decision.waitMs)) return; // 并发满：无闹钟，等 release/abort 来 pump。
          await this.interruptibleSleep(st, decision.waitMs);
        }
      } finally {
        // 注意：这里故意不再 re-pump。所有状态变化都有明确唤醒者：
        // 睡眠中 → waker 早醒（release/abort）；停靠在 Infinity 上 → pumping 已为 false，
        // release/abort/新 acquire 会直接调 pump 重启。re-pump 反而会在并发停靠时无限自旋。
        st.pumping = false;
      }
    })();
  }

  /** 睡到 waitMs 或被 notify 早醒（release/abort 触发），二者都只走一次。 */
  private interruptibleSleep(st: BucketState, waitMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        if (st.waker === done) st.waker = null;
        resolve();
      };
      st.waker = done;
      void this.sleep(waitMs).then(done, done);
    });
  }
}
