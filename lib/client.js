/** dsh-plugin-model-governor 浏览器半 v6（provider-card 席位件，形态规范 = STANDARDS §4.5）：
 *  「设置 → Models」每张服务商卡（宿主 `<li class=rowCard>`）里的**一行** RPM 治理：
 *  标签 + 数字框 + 应用 + 探测；点探测后按钮本身变倒计时秒数（点按=取消），结束/失败结论跟在行下；
 *  触顶自动填入后就地回读。除此之外不占版面：无标题、无卡壳、无页脚、不折叠。
 *
 *  席位事实（宿主源码实证，改 UI 前先回读）：
 *  - 契约 `settings.models.provider-card`（keyed，`options.key === entry.settingsNs`），owner props
 *    = `{provider, configured, keyConfigured}`（ui-settings-models/src/client/slot-contract.ts:33,43-50）。
 *    **必须消费 configured/keyConfigured**：草稿卡（「添加提供方」未落盘，configured:false）与没配 key 的卡
 *    照样给可写控件 = 往不存在的行写 limits、探测必失败。故：!configured → 整行不出；
 *    configured && !keyConfigured → 只出一句 muted 说明，不给写件。
 *  - 卡壳宿主已给：席位是那张 `<li>` flex 列的**直接子节点**，外面只套一层无 DOM 的 SlotErrorBoundary
 *    （崩了才渲染 `[data-slot-error]`）。所以本半**不出** `<li>`/边框/底色/圆角，也**不自造错误边界**
 *    （v5 的 GvrBoundary 挂 `window.addEventListener("error")`：页面上任何无关脚本报错会把每张 RPM 卡
 *    永久变红且无复位——宿主件已管这事，抢戏 + 误伤 + 与浏览器件的 `[data-slot-error]` 断言对打）。
 *  - 单行常开在本位合法（§4.1 的「默认折叠成一行」只属于 settings.plugin.item）；同理本位字段范本是
 *    `<span class=fieldLabel>` + 控件 `aria-label`（同页 ProviderEditor/CustomProviderCard 一致），
 *    **不套 §4.2 的 htmlFor 判据**。
 *  - 控件走 primitives：`UI.Input`（32px / .5px border-l4 / r8 / 14-22）与 `UI.Button`（size sm = 28/r14）
 *    正是宿主同页 `.input` / `.rowActions` 的规格（AGENTS L0「共享控件走 primitives 的 require，别手搓替身」）。
 *    primitives 与 react/react-dom 同属宿主冻结模块种子表（§4.3）；缺席才退本地同规格 CSS 件。
 *  - 颜色一律 `--dsw-*` 令牌、CSS 走注入的 `<style data-plugin>`（本包前缀 `gvr-`）：v5 把色写死在内联
 *    style 对象里（#fff/#d9d9d9/#d33）——深色主题下白底控件直接贴在暗卡上，且内联 style 天生写不出
 *    `:hover`/`:focus-visible`/`::placeholder`/`:disabled`，动效门与 token 审计两道门同时假绿。
 *    （`styles.insert(css)` 是官方 `code:` 闭包半的 API（packages/extensions/cordis-client-runner）；
 *    bundle 形态的 lib/client.js 拿不到，自注入 `<style>` 是等价路径。）
 *  - **语义诚实**：本卡写的是宿主 settings 文档（model-governor 段，落 settings.yaml，
 *    热推送即时生效，重启仍在——持久化在服务端 configure 里做，见 src/cordis.ts），
 *    所以行下不再挂作用域说明；读数与写入同源（describe 的 providerLimits）。
 *  - 读数与写对象同源：RPM 取 `describe({provider}).providerLimits`（provider→defaults 整条线路执法口径，
 *    src/config.ts:275 `effectiveProviderLimits`）。v5 取 `models[0].limits.rpm` = 首模型合并值，
 *    首模型带模型级覆盖时「显示的是模型值、点应用写回服务商级」（审查中⑦）。
 *
 *  不变的部分：`window.__ModuleLoader__.load({id, factory})` 手写工厂（无构建链、无 JSX）、tab 缩进；
 *  手写 strict descriptor 与 src/cordis.ts 的 SRC 方法一一对应（describe/filter、configure/patch、
 *  probe/spec、probeStatus/filter、cancelProbe/target），改名或挪行由 dsh-check contractPairSuite 抓；
 *  调用一律先 await $mount 再 `ctx.get("remote.governor")` 名字解析（属性式访问在第三方 fiber 下被可见性过滤）。
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-model-governor",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var React = require("react");
		var h = React.createElement;
		var useState = React.useState;
		var useEffect = React.useEffect;
		var useCallback = React.useCallback;
		var useRef = React.useRef;
		/** 宿主共享控件（冻结模块种子表内词，§4.3）；缺席退本地同规格件——兜底不是常路，器件点名走的是哪条。 */
		var UI = null;
		try {
			UI = require("@deepseek-ai/dsh-client-ui-primitives") || null;
		} catch (e) {
			UI = null;
		}

		/** 描述符 id 前缀。卡槽 key = 各路由族的 settingsNs（见下方 PROVIDER_KEYS）。 */
		var SETTINGS_NS = "model-governor";

		/* ---------- Remote contribution（手写 strict 描述符；与 src/cordis.ts 的 SRC 方法一一对应） ---------- */
		var passthrough = {
			parse: function (v) {
				return v === undefined ? {} : v;
			},
		};
		function codec(sym) {
			return { mode: "strict", typeSymbol: SETTINGS_NS + "#" + sym, schema: passthrough };
		}
		function descriptor(method, param, location) {
			return {
				id: SETTINGS_NS + "#governor/" + method,
				service: "governor",
				namespace: "governor",
				method: method,
				invocation: { kind: "direct" },
				parameters: [{ name: param, wire: param, source: "json", acceptsUndefined: true, codec: codec(method + ":" + param) }],
				result: codec(method + ":result"),
				sourceLocation: location,
			};
		}
		var CONTRIBUTION = {
			package: "dsh-plugin-model-governor",
			descriptors: [
				descriptor("describe", "filter", { file: "src/cordis.ts", line: 358, column: 9 }),
				descriptor("configure", "patch", { file: "src/cordis.ts", line: 392, column: 9 }),
				descriptor("probe", "spec", { file: "src/cordis.ts", line: 441, column: 9 }),
				descriptor("probeStatus", "filter", { file: "src/cordis.ts", line: 510, column: 9 }),
				descriptor("cancelProbe", "target", { file: "src/cordis.ts", line: 543, column: 9 }),
			],
		};

		function remoteOf(ctx, mounted) {
			return Promise.resolve(mounted).then(function () {
				return ctx.get("remote.governor");
			});
		}
		function unwrap(res) {
			if (res && typeof res === "object" && "ok" in res) {
				if (!res.ok) throw new Error((res.error && res.error.message) || "governor 调用失败");
				return res.value;
			}
			return res;
		}
		function humanizeError(text) {
			return String(text)
				.replace(/^Error:\s*/, "")
				.slice(0, 160);
		}

		/* ---------- 样式注入（bundle 形态拿不到官方 styles.insert，自注 <style data-plugin> + 包前缀，§4.3） ----------
		 * 值照抄同一张 `<li>` 里宿主自绘件：字段名 12/18 500 label-secondary；说明/报错 12/18；
		 * 兜底输入框 = 席位 `.input` 逐参数（32 / .5px border-l4 / r8 / 14-22 / bg-layer-1 / focus brand）。
		 * 控件的 hover/focus/disabled 由 primitives 件自带 CSS 负责；这里只补本包自己的文本件与态色。 */
		var CSS = [
			".gvr-seat{display:flex;flex-direction:column;gap:2px}",
			// 单行是横排（方向不写就等于把布局让给巧合：模型卡竖排事故的教训——方向、对齐、子项伸缩全部显式，不靠默认值）。
			".gvr-row{display:flex;flex-direction:row;align-items:center;justify-content:flex-start;gap:8px;flex-wrap:wrap;text-align:left}",
			".gvr-row>*{flex:none}",
			".gvr-label{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary);white-space:nowrap}",
			".gvr-input{box-sizing:border-box;width:96px;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;font:inherit;font-size:14px;line-height:22px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}",
			".gvr-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}",
			".gvr-input::placeholder{color:var(--dsw-alias-label-dimmed)}",
			".gvr-input:disabled{opacity:.6}",
			".gvr-input[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}",
			".gvr-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);word-break:break-all}",
			".gvr-err{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);word-break:break-all}",
			".gvr-text{appearance:none;border:0;background:none;padding:0 2px;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer}",
			".gvr-text:hover{color:var(--dsw-alias-label-primary)}",
			".gvr-text:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;border-radius:4px}",
			// 按钮降级件（UI 缺席才走）：与宿主 Button outline/sm 同规格的描边药丸，不是裸文字按钮——
			// 降级也要长得像宿主件，否则深色主题下就是两条来历不明的边框less文字。
			".gvr-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:14px;background:transparent;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);cursor:pointer}",
			".gvr-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
			".gvr-btn:disabled{opacity:.4;cursor:not-allowed}",
			".gvr-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
			".gvr-tag{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
			// 动效自护位（§4.3）：本包目前不写 transition；日后加动效必须同带
			// `@media (prefers-reduced-motion: reduce)` 守卫——宿主 ui-theme 没有全局兜底。
		].join("\n");
		var cssDone = false;
		function ensureCss() {
			if (cssDone || typeof document === "undefined") return;
			cssDone = true;
			var el = document.createElement("style");
			el.setAttribute("data-plugin", SETTINGS_NS);
			el.textContent = CSS;
			document.head.appendChild(el);
		}

		/* ---------- 席位件：只出内容，不出卡壳（边框/底色/圆角/padding 归宿主那张 <li>） ---------- */
		function Seat(props) {
			// data-gvr-ui 诊断位：host = 宿主 primitives 生效，fallback = require 缺席走本地降级（截图/DOM 一眼可辨，不用猜）。
			return h("div", { className: "gvr-seat", "data-gvr-ui": UI && UI.Input && UI.Button ? "host" : "fallback" }, props.children);
		}
		function FieldInput(field) {
			if (UI && UI.Input) return h(UI.Input, field);
			return h("input", field); // 兜底：本地同规格 CSS 件 .gvr-input
		}
		function ActionButton(props) {
			if (UI && UI.Button) {
				return h(
					UI.Button,
					{
						type: "button",
						variant: "outline",
						size: "sm",
						disabled: props.disabled,
						onClick: props.onClick,
						title: props.title,
						"aria-label": props.ariaLabel,
					},
					props.children,
				);
			}
			return h(
				"button",
				{ type: "button", className: "gvr-btn", disabled: props.disabled, onClick: props.onClick, title: props.title, "aria-label": props.ariaLabel },
				props.children,
			);
		}

		/* ---------- 治理单行：RPM 读写 + 探测倒计时（同行：RPM 输入 应用 探测） ---------- */
		function GovRow(props) {
			var ctx = props.ctx;
			var mounted = props.mounted;
			var routeId = (props.provider || {}).provider;
			var _v = useState(""),
				text = _v[0],
				setText = _v[1];
			var _l = useState(""),
				loaded = _l[0],
				setLoaded = _l[1]; // 服务端回读基线：dirty 判定与「丢弃」都认它
			var _e = useState(null),
				err = _e[0],
				setErr = _e[1];
			var _b = useState(false),
				busy = _b[0],
				setBusy = _b[1];
			var _r = useState(false),
				ready = _r[0],
				setReady = _r[1];
			var alive = useRef(0);
			// busy 归属独立计数：重渲染触发的 load() 会推进 alive，不能让它冲掉 apply 的 busy。
			var opSeq = useRef(0);
			// 探测：idle / running（按钮变倒计时秒数，点按=取消）/ done / error（按钮变回探测，行下跟结论）。
			var _s = useState("idle"),
				phase = _s[0],
				setPhase = _s[1];
			var _t = useState(""),
				note = _t[0],
				setNote = _t[1];
			var _c = useState(null),
				remain = _c[0],
				setRemain = _c[1];
			var poller = useRef(null);
			var ticker = useRef(null);
			var probing = useRef(false);

			var load = useCallback(
				function () {
					if (!routeId) return Promise.resolve();
					var my = ++alive.current;
					return remoteOf(ctx, mounted)
						.then(function (remote) {
							return remote.describe({ provider: routeId });
						})
						.then(function (res) {
							if (alive.current !== my) return;
							var body = unwrap(res) || {};
							// 读数与写对象同源：providerLimits = provider→defaults 整条线路口径（本行写的正是 providers[route].rpm）。
							var src = body.providerLimits && typeof body.providerLimits === "object" ? body.providerLimits : null;
							var rpm = src && typeof src.rpm === "number" && isFinite(src.rpm) ? String(src.rpm) : "";
							setText(rpm);
							setLoaded(rpm);
							setReady(true);
							setErr(null); // 回读成功即作废上一条读取错误（旧错挂新数据 = 假报错）
						})
						.catch(function (e) {
							if (alive.current === my) setErr(humanizeError(String((e && e.message) || e)));
						});
				},
				[ctx, mounted, routeId],
			);
			useEffect(
				function () {
					load();
					return function () {
						alive.current += 1;
					};
				},
				[load],
			);
			useEffect(function () {
				return function () {
					alive.current += 1;
					probing.current = false;
					stopTimers();
				};
			}, []);

			var dirty = ready && text !== loaded;

			function discard() {
				setText(loaded);
				setErr(null);
			}

			function apply() {
				if (busy || probing.current) return;
				var raw = text.trim();
				if (raw !== "" && (!/^\d+$/.test(raw) || Number(raw) <= 0)) {
					setErr("RPM 须为正整数");
					return;
				}
				var op = ++opSeq.current;
				setBusy(true);
				setErr(null);
				// 空输入 = 删除该卡 RPM（发 {rpm:null} 回落不限，与占位符“空=不限”对齐；审查修复）。
				var patch = { limits: { providers: {} } };
				patch.limits.providers[routeId] = raw === "" ? { rpm: null } : { rpm: Number(raw) };
				remoteOf(ctx, mounted)
					.then(function (remote) {
						return remote.configure(patch);
					})
					.then(function (res) {
						var body = unwrap(res) || {};
						if (body.ok === false) throw new Error((body.errors || []).join("；") || "写入被拒");
					})
					.then(function () {
						// busy 只认自己的 op：重渲染的 load() 再怎么推进 alive 也冲不掉。
						if (op === opSeq.current) setBusy(false);
					})
					.then(function () {
						return load();
					})
					.catch(function (e) {
						if (op === opSeq.current) {
							setErr(humanizeError(String((e && e.message) || e)));
							setBusy(false);
						}
					});
			}

			function stopTimers() {
				if (typeof clearInterval !== "undefined") {
					if (poller.current !== null) clearInterval(poller.current);
					if (ticker.current !== null) clearInterval(ticker.current);
				}
				poller.current = null;
				ticker.current = null;
			}

			/** 剩余秒 = ceil((durationMs - elapsedMs)/1000)；服务端没给分母就显示“探测中”。 */
			function remainOf(body) {
				var total = body && typeof body.durationMs === "number" ? body.durationMs : NaN;
				var elapsed = body && typeof body.elapsedMs === "number" ? body.elapsedMs : 0;
				if (!isFinite(total) || total <= 0) return null;
				return Math.max(0, Math.ceil((total - elapsed) / 1000));
			}

			function pollStatus() {
				remoteOf(ctx, mounted)
					.then(function (remote) {
						return remote.probeStatus({ provider: routeId });
					})
					.then(function (res) {
						if (!probing.current) return;
						var body = unwrap(res) || {};
						if (body.state === "running") {
							setRemain(remainOf(body));
							return;
						}
						// done / idle：停表，按钮变回探测，行下跟结论；自动填入了就地回读。
						probing.current = false;
						stopTimers();
						if (body.state === "done" && body.result) {
							setNote(String(body.result.note || ""));
							setPhase("done");
							if (body.result.applied) load();
						} else {
							setNote("探测已结束但无结论，请重试");
							setPhase("error");
						}
					})
					.catch(function (e) {
						if (!probing.current) return;
						probing.current = false;
						stopTimers();
						setNote(humanizeError(String((e && e.message) || e)));
						setPhase("error");
					});
			}

			function startProbe() {
				if (!routeId || probing.current) return;
				probing.current = true;
				setPhase("running");
				setNote("");
				setErr(null);
				setRemain(null);
				remoteOf(ctx, mounted)
					.then(function (remote) {
						return remote.probe({ provider: routeId });
					})
					.then(function (res) {
						var body = unwrap(res) || {};
						if (body.ok === false) throw new Error((body.errors || []).join("；") || "探测被拒");
						if (typeof setInterval !== "undefined") {
							stopTimers();
							poller.current = setInterval(pollStatus, 1000);
							// 本地半秒走一格：轮询间隙倒计时也在走，体感连续（下次轮询按服务端 elapsed 校准）。
							ticker.current = setInterval(function () {
								setRemain(function (prev) {
									return typeof prev === "number" && prev > 0 ? prev - 1 : prev;
								});
							}, 500);
						}
						return pollStatus();
					})
					.catch(function (e) {
						probing.current = false;
						stopTimers();
						setNote(humanizeError(String((e && e.message) || e)));
						setPhase("error");
					});
			}

			function probeClick() {
				if (probing.current) {
					// 倒计时点按 = 取消：发取消后走一次轮询，结论（已取消）落地即停表回按钮。
					// 取消失败不静默吞（AGENTS「诊断不骗人」）：结论行直接写失败原因，表也停住。
					remoteOf(ctx, mounted)
						.then(function (remote) {
							return remote.cancelProbe({ provider: routeId });
						})
						.then(function () {
							return pollStatus();
						})
						.catch(function (e) {
							probing.current = false;
							stopTimers();
							setNote("取消探测失败：" + humanizeError(String((e && e.message) || e)));
							setPhase("error");
						});
					return;
				}
				startProbe();
			}

			var running = phase === "running";
			var blocked = busy || running || !ready;

			// 读取失败：报错 + 重试（同页范本 `<p role="alert">`，读屏才播报得到；v5 是一条无 role 的裸 div）。
			if (err && !ready) {
				return h(
					Seat,
					null,
					h("p", { className: "gvr-err", role: "alert" }, "RPM 读取失败：" + err),
					h(
						"button",
						{
							type: "button",
							className: "gvr-text",
							onClick: function () {
								setErr(null);
								load();
							},
						},
						"重试",
					),
				);
			}
			var input = {
				className: "gvr-input",
				value: text,
				placeholder: ready ? "空=不限" : "读取中…",
				inputMode: "numeric",
				disabled: blocked,
				"aria-label": "RPM",
				"aria-invalid": err && ready ? "true" : undefined,
				onChange: function (ev) {
					setText(ev.target.value);
				},
				onKeyDown: function (ev) {
					if (ev.key === "Enter") apply();
				},
			};
			return h(
				Seat,
				null,
				h(
					"div",
					{ className: "gvr-row", "aria-busy": !ready ? "true" : undefined },
					h("span", { className: "gvr-label" }, "RPM"),
					FieldInput(input),
					dirty ? h("span", { className: "gvr-tag" }, "未保存") : null,
					dirty ? h("button", { type: "button", className: "gvr-text", onClick: discard }, "丢弃") : null,
					h(ActionButton, { disabled: blocked, onClick: apply }, busy ? "应用中" : "应用"),
					h(
						ActionButton,
						{
							disabled: !ready,
							title: running ? "点击取消探测" : "自动测 RPM 并填入",
							ariaLabel: running ? "取消探测" : "探测",
							onClick: probeClick,
						},
						running ? (typeof remain === "number" ? remain + "s" : "探测中") : "探测",
					),
				),
				// 三态各归各位：读取中 / 探测结论（status）/ 校验·写入·探测失败（alert）
				!ready ? h("p", { className: "gvr-note", role: "status" }, "读取当前 RPM…") : null,
				phase === "done" ? h("p", { className: "gvr-note", role: "status" }, note) : null,
				phase === "error" ? h("p", { className: "gvr-err", role: "alert" }, note) : null,
				err && ready ? h("p", { className: "gvr-err", role: "alert" }, err) : null,
			);
		}

		/* ---------- cordis 客户端插件入口（只挂 provider-card 席位，无 footer、无自造边界） ---------- */
		var inject = ["slots", "remote"];
		// keyed 席位按 options.key === entry.settingsNs 精确匹配（一 key 一位）。**这里是显式认领**：
		// llm-pi-ai 系（含自定义路由，与 CustomProviderCard 同命名空间）与 llm-deepseek 各占一位。
		// 该位官方注册方暂空、首消费方本是站外 llm-pi-ai-oauth 的登录件——同 ns 撞位时 ui-slots 按
		// priority 仲裁（注册方禁传 priority，同 priority 直接抛错），让位方案见 docs/debt.md。
		var PROVIDER_KEYS = ["llm-pi-ai", "llm-deepseek"];

		function applyEntry(ctx) {
			ensureCss();
			var mounted = ctx.remote.$mount(CONTRIBUTION);
			mounted.then(null, function () {}); // 无人等待时兜底，防未处理 rejection。
			ctx.effect(function () {
				return ctx.slots.inject("settings.models.provider-card", function () {
					return PROVIDER_KEYS.map(function (slotKey) {
						return ctx.slots.register({ name: "settings.models.provider-card", key: slotKey }, function CardSlot(slotProps) {
							// 席位下发什么就吃什么：草稿卡（未落盘）整行不出，没配 key 的卡只说明不给写件。
							var entry = slotProps.provider || {};
							if (!entry.provider) return null;
							if (!slotProps.configured) return null;
							if (!slotProps.keyConfigured) {
								return h(Seat, null, h("p", { className: "gvr-note" }, "该服务商还没配 API key；配好后这里可设 RPM 上限与自动探测。"));
							}
							return h(GovRow, { ctx: ctx, mounted: mounted, provider: entry });
						});
					});
				});
			}, "model-governor: provider rpm");
		}

		exports.apply = applyEntry;
		exports.inject = inject;
		return module.exports;
	},
});
