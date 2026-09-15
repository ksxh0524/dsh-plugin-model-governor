/** config.test.ts —— S1 配置层单测：缺省不限流 / 三维独立合并 / 非法补丁逐条中文 / 归一补缺省。
 *
 * 设计意图：断言真实语义（合并优先级、中文报错、缺省回填），禁凑绿——每个用例都打到
 * 被测函数的分支行为；中文断言统一用 HAS_CHINESE（[\u4e00-\u9fa5]）守“逐条中文”合同。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, deleteNullLeaves, effectiveLimits, effectiveProviderLimits, normalizeConfig, validateConfigPatch } from "../src/config.ts";

const HAS_CHINESE = /[\u4e00-\u9fa5]/;

describe("defaultConfig：缺省不限流", () => {
  it("limits 全空", () => {
    assert.deepStrictEqual(defaultConfig().limits, { defaults: {}, providers: {}, models: {} });
  });

  it("缺省配置下任何模型都不限流", () => {
    assert.deepStrictEqual(effectiveLimits(defaultConfig(), "opencode", "anything"), {});
  });

  it("空 limits 同样不限流", () => {
    assert.deepStrictEqual(effectiveLimits({ limits: {} }, "p", "m"), {});
  });

  it("sessionHeader 缺省开 opencode 系 + session-id", () => {
    assert.deepStrictEqual(defaultConfig().sessionHeader?.providers, ["opencode", "opencode-go"]);
    assert.strictEqual(defaultConfig().sessionHeader?.mode, "session-id");
  });

  it("每次返回全新对象，互不共享引用", () => {
    const a = defaultConfig();
    const b = defaultConfig();
    assert.notStrictEqual(a, b);
    a.limits?.providers && (a.limits.providers["x"] = { rpm: 1 });
    assert.deepStrictEqual(b.limits?.providers, {});
  });
});

describe("effectiveLimits：三维各自独立合并", () => {
  it("model → provider → defaults 逐维取最具体", () => {
    const cfg = {
      limits: {
        defaults: { rpm: 60, tpm: 1000, maxConcurrent: 5 },
        providers: { p: { rpm: 30 } },
        models: { "p/m": { tpm: 2000 } },
      },
    };
    assert.deepStrictEqual(effectiveLimits(cfg, "p", "m"), { rpm: 30, tpm: 2000, maxConcurrent: 5 });
  });

  it("同维 model 覆盖 provider", () => {
    const cfg = {
      limits: {
        defaults: { rpm: 60 },
        providers: { p: { rpm: 30, tpm: 100 } },
        models: { "p/m": { rpm: 10 } },
      },
    };
    assert.deepStrictEqual(effectiveLimits(cfg, "p", "m"), { rpm: 10, tpm: 100 });
  });

  it("未配置的 provider 回落到 defaults", () => {
    const cfg = { limits: { defaults: { rpm: 60, maxConcurrent: 2 } } };
    assert.deepStrictEqual(effectiveLimits(cfg, "unknown", "m"), { rpm: 60, maxConcurrent: 2 });
  });

  it("model 键隔离：别的模型/别的 provider 不串味", () => {
    const cfg = {
      limits: {
        defaults: { rpm: 60 },
        models: { "p/other": { rpm: 1 }, "q/m": { rpm: 2 } },
      },
    };
    assert.deepStrictEqual(effectiveLimits(cfg, "p", "m"), { rpm: 60 });
  });

  it("provider 键隔离：别的 provider 不串味", () => {
    const cfg = { limits: { providers: { q: { rpm: 5 } } } };
    assert.deepStrictEqual(effectiveLimits(cfg, "p", "m"), {});
  });

  it("只配单维就只生效单维", () => {
    const cfg = { limits: { models: { "p/m": { tpm: 500 } } } };
    const got = effectiveLimits(cfg, "p", "m");
    assert.deepStrictEqual(got, { tpm: 500 });
    assert.strictEqual("rpm" in got, false);
    assert.strictEqual("maxConcurrent" in got, false);
  });

  it("形态外输入不抛，按不限流处理", () => {
    assert.deepStrictEqual(effectiveLimits(undefined as never, "p", "m"), {});
    assert.deepStrictEqual(effectiveLimits(null as never, "p", "m"), {});
  });
});

describe("validateConfigPatch：合法补丁放行", () => {
  it("空补丁与完整合法补丁都返回 []", () => {
    assert.deepStrictEqual(validateConfigPatch({}), []);
    assert.deepStrictEqual(
      validateConfigPatch({
        limits: {
          defaults: { rpm: 60, tpm: 60000, maxConcurrent: 2 },
          providers: { opencode: { rpm: 30 } },
          models: { "opencode/qwen3-coder": { rpm: 10 } },
        },
        sessionHeader: { providers: ["opencode"], mode: "uuid", debug: true, debugFile: "/tmp/g.log" },
      }),
      [],
    );
  });
});

describe("validateConfigPatch：非法逐条中文", () => {
  it("负数 rpm：单条中文且点名 rpm", () => {
    const errors = validateConfigPatch({ limits: { defaults: { rpm: -5 } } });
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0] as string, /rpm/);
    assert.match(errors[0] as string, HAS_CHINESE);
  });

  it("零 rpm 非法（不限流请省略字段）", () => {
    const errors = validateConfigPatch({ limits: { providers: { p: { rpm: 0 } } } });
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0] as string, /rpm/);
    assert.match(errors[0] as string, HAS_CHINESE);
  });

  it("负数 tpm / maxConcurrent 各自报中文", () => {
    const tpmErrors = validateConfigPatch({ limits: { defaults: { tpm: -100 } } });
    assert.strictEqual(tpmErrors.length, 1);
    assert.match(tpmErrors[0] as string, /tpm/);
    assert.match(tpmErrors[0] as string, HAS_CHINESE);
    const concErrors = validateConfigPatch({ limits: { models: { "p/m": { maxConcurrent: -2 } } } });
    assert.strictEqual(concErrors.length, 1);
    assert.match(concErrors[0] as string, /maxConcurrent/);
    assert.match(concErrors[0] as string, HAS_CHINESE);
  });

  it("非数字维度报中文", () => {
    const errors = validateConfigPatch({ limits: { defaults: { rpm: "fast" } } });
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0] as string, HAS_CHINESE);
  });

  it("坏 models 键（无斜杠 / 多斜杠 / 空段）逐条中文点名", () => {
    const errors = validateConfigPatch({ limits: { models: { qwen: { rpm: 1 }, "a/b/c": { rpm: 1 }, "/m": { rpm: 1 } } } });
    assert.strictEqual(errors.length, 3);
    for (const e of errors) assert.match(e, HAS_CHINESE);
    assert.match(errors.join("\n"), /qwen/);
    assert.match(errors.join("\n"), /a\/b\/c/);
  });

  it("坏 provider 键（含斜杠）报中文", () => {
    const errors = validateConfigPatch({ limits: { providers: { "p/m": { rpm: 1 } } } });
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0] as string, HAS_CHINESE);
  });

  it("未知顶层字段报中文点名", () => {
    const errors = validateConfigPatch({ foo: 1 });
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0] as string, /foo/);
    assert.match(errors[0] as string, HAS_CHINESE);
  });

  it("未知嵌套字段（limits / 维度 / sessionHeader）各报一条中文", () => {
    assert.match(validateConfigPatch({ limits: { foo: 1 } })[0] as string, HAS_CHINESE);
    assert.match(validateConfigPatch({ limits: { defaults: { bogus: 1 } } })[0] as string, /bogus/);
    assert.match(validateConfigPatch({ sessionHeader: { foo: 1 } })[0] as string, HAS_CHINESE);
  });

  it("sessionHeader 非法值逐条中文", () => {
    assert.match(validateConfigPatch({ sessionHeader: { mode: "id" } })[0] as string, HAS_CHINESE);
    assert.match(validateConfigPatch({ sessionHeader: { providers: "opencode" } })[0] as string, HAS_CHINESE);
    assert.match(validateConfigPatch({ sessionHeader: { providers: ["ok", 42] } })[0] as string, HAS_CHINESE);
    assert.match(validateConfigPatch({ sessionHeader: { debug: "yes" } })[0] as string, HAS_CHINESE);
    assert.match(validateConfigPatch({ sessionHeader: { debugFile: "" } })[0] as string, HAS_CHINESE);
  });

  it("非对象补丁报中文", () => {
    assert.match(validateConfigPatch(null)[0] as string, HAS_CHINESE);
    assert.match(validateConfigPatch("rpm=60")[0] as string, HAS_CHINESE);
    assert.match(validateConfigPatch([{ limits: {} }])[0] as string, HAS_CHINESE);
  });

  it("多错并列时条数对齐、条条中文", () => {
    const errors = validateConfigPatch({ bogus: 1, limits: { defaults: { rpm: 0 } }, sessionHeader: { mode: "x" } });
    assert.strictEqual(errors.length, 3);
    for (const e of errors) assert.match(e, HAS_CHINESE);
  });
});

describe("normalizeConfig：缺键补缺省", () => {
  it("{} 归一后等于缺省", () => {
    assert.deepStrictEqual(normalizeConfig({}), defaultConfig());
  });

  it("非对象输入回缺省", () => {
    assert.deepStrictEqual(normalizeConfig(undefined), defaultConfig());
    assert.deepStrictEqual(normalizeConfig(null), defaultConfig());
    assert.deepStrictEqual(normalizeConfig(42), defaultConfig());
    assert.deepStrictEqual(normalizeConfig("x"), defaultConfig());
    assert.deepStrictEqual(normalizeConfig([]), defaultConfig());
  });

  it("部分 limits 保留，缺的表与 sessionHeader 补缺省", () => {
    const got = normalizeConfig({ limits: { defaults: { rpm: 10 } } });
    assert.deepStrictEqual(got.limits, { defaults: { rpm: 10 }, providers: {}, models: {} });
    assert.deepStrictEqual(got.sessionHeader, defaultConfig().sessionHeader);
  });

  it("合法 sessionHeader 原样保留", () => {
    const got = normalizeConfig({ sessionHeader: { providers: ["p"], mode: "uuid", debug: true, debugFile: "/tmp/g.log" } });
    assert.deepStrictEqual(got.sessionHeader, { providers: ["p"], mode: "uuid", debug: true, debugFile: "/tmp/g.log" });
  });

  it("非法 mode 回退 session-id，未知字段丢弃", () => {
    const got = normalizeConfig({ limits: { bogus: 1 }, sessionHeader: { mode: "id", foo: 1 }, extra: true });
    assert.strictEqual(got.sessionHeader?.mode, "session-id");
    assert.strictEqual("foo" in (got.sessionHeader as object), false);
    assert.strictEqual("extra" in got, false);
    assert.deepStrictEqual(got.limits, { defaults: {}, providers: {}, models: {} });
  });

  it("非有限数字维度丢弃即不限", () => {
    const got = normalizeConfig({ limits: { defaults: { rpm: "fast", tpm: Number.NaN, maxConcurrent: 2 } } });
    assert.deepStrictEqual(got.limits?.defaults, { maxConcurrent: 2 });
  });

  it("不持有入参引用、不污染入参", () => {
    const input = { limits: { defaults: { rpm: 7 } }, sessionHeader: { providers: ["p"] } };
    const got = normalizeConfig(input);
    assert.notStrictEqual(got.limits?.defaults, input.limits.defaults);
    (got.limits?.defaults as { rpm?: number }).rpm = 999;
    (got.sessionHeader?.providers as string[]).push("q");
    assert.deepStrictEqual(input, { limits: { defaults: { rpm: 7 } }, sessionHeader: { providers: ["p"] } });
  });

  it("null 维度丢弃（删除标记不进 live）", () => {
    const got = normalizeConfig({ limits: { providers: { p: { rpm: null, tpm: 100 } } } });
    assert.deepStrictEqual(got.limits?.providers?.["p"], { tpm: 100 });
  });
});

describe("effectiveProviderLimits：整条线路口径（不掺模型级）", () => {
  it("只取 provider → defaults，模型级再严也不影响线路桶", () => {
    const cfg = {
      limits: {
        defaults: { rpm: 60, tpm: 1000 },
        providers: { p: { rpm: 30 } },
        models: { "p/m": { rpm: 10, tpm: 2000 } },
      },
    };
    assert.deepStrictEqual(effectiveProviderLimits(cfg, "p"), { rpm: 30, tpm: 1000 });
    assert.deepStrictEqual(effectiveProviderLimits(cfg, "q"), { rpm: 60, tpm: 1000 });
    assert.deepStrictEqual(effectiveProviderLimits(cfg, "p").rpm, 30, "模型级 rpm:10 不得漏进线路口径");
  });
});

describe("validateConfigPatch + deleteNullLeaves：null=删除", () => {
  it("null 维度校验放行（删除语义）", () => {
    assert.deepStrictEqual(validateConfigPatch({ limits: { providers: { p: { rpm: null } } } }), []);
    assert.deepStrictEqual(validateConfigPatch({ limits: { defaults: { rpm: null, tpm: null } } }), []);
  });

  it("deleteNullLeaves 删 null 叶、保留空对象与其他分支", () => {
    const merged = { limits: { defaults: { rpm: 60 }, providers: { p: { rpm: null, tpm: 5 } } }, sessionHeader: { mode: "uuid" } };
    deleteNullLeaves(merged);
    assert.deepStrictEqual(merged, { limits: { defaults: { rpm: 60 }, providers: { p: { tpm: 5 } } }, sessionHeader: { mode: "uuid" } });
  });
});
