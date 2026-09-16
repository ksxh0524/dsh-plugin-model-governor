/** dsh-plugin-model-governor 浏览器半 v5（每卡只一行，无其他 UI）：
 *  provider-card 槽（llm-pi-ai/llm-deepseek 各占一位）每卡渲染单行：RPM 标签 +
 *  数字框 + 应用 + 探测。点探测后按钮本身变成倒计时秒数（点按=取消），结束或
 *  失败都变回“探测”，结论中文直显在行下；触顶自动填入后同组件直接回读 RPM。
 *  无标题、无徽标、无页脚区、无样式注入（纯内联样式，贴原生输入框规格：32px 高、
 *  6px 圆角、#d9d9d9 边框）。读数经 describe({provider}) 取首模型生效 rpm（同卡
 *  共享服务商默认即准确）；RPM 写入调 configure({limits:{providers:{[route]:{rpm}}}})；
 *  空输入点应用 = 无操作（不清零，不删键）。探测调 probe({provider}) 发起、
 *  probeStatus({provider}) 轮询（running 带 durationMs 做倒计时分母）、
 *  cancelProbe({provider}) 取消。
 *
 *  形态照抄 plugin-usage-stats/lib/client.js（只取形态不抄业务）：
 *  window.__ModuleLoader__.load({id, factory}）、tab 缩进、只 require("react")、
 *  无 JSX。两端契约：描述符与 src/cordis.ts 的 SRC 方法一一对应（describe/filter、
 *  configure/patch、probe/spec、probeStatus/filter、cancelProbe/target），改名须同步，
 *  sourceLocation 直指方法名首字符。调用一律先 await $mount 再经 ctx.get("remote.governor")
 *  名字解析（属性式访问在第三方 fiber 下会被可见性过滤）。
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
				descriptor("describe", "filter", { file: "src/cordis.ts", line: 262, column: 9 }),
				descriptor("configure", "patch", { file: "src/cordis.ts", line: 293, column: 9 }),
				descriptor("probe", "spec", { file: "src/cordis.ts", line: 323, column: 9 }),
				descriptor("probeStatus", "filter", { file: "src/cordis.ts", line: 392, column: 9 }),
				descriptor("cancelProbe", "target", { file: "src/cordis.ts", line: 425, column: 9 }),
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

		/* ---------- 内联样式（贴原生输入框规格，无样式表注入） ---------- */
		var S_LABEL = { fontSize: 12, color: "#666", marginRight: 8, whiteSpace: "nowrap" };
		var S_INPUT = {
			width: 90,
			height: 32,
			boxSizing: "border-box",
			padding: "0 10px",
			fontSize: 12,
			color: "#1a1a1a",
			background: "#fff",
			border: "1px solid #d9d9d9",
			borderRadius: 6,
			outline: "none",
			marginRight: 8,
		};
		var S_BTN = {
			height: 32,
			padding: "0 14px",
			fontSize: 12,
			color: "#333",
			background: "#fff",
			border: "1px solid #d9d9d9",
			borderRadius: 6,
			cursor: "pointer",
			whiteSpace: "nowrap",
		};
		var S_ERR = { fontSize: 12, color: "#d33", marginTop: 4 };
		var S_ROW = { display: "flex", alignItems: "center", padding: "4px 0" };
		var S_NOTE = { fontSize: 12, color: "#666", marginTop: 4, lineHeight: 1.6, wordBreak: "break-all" };

		/* ---------- 错误边界：卡内错只红字，不整槽崩 ---------- */
		function GvrBoundary(props) {
			var _s = useState(null),
				err = _s[0],
				setErr = _s[1];
			useEffect(function () {
				function onErr(ev) {
					if (ev && ev.error) setErr(humanizeError(String(ev.error.message || ev.error)));
				}
				if (typeof window !== "undefined" && window.addEventListener) {
					window.addEventListener("error", onErr);
					return function () {
						window.removeEventListener("error", onErr);
					};
				}
				return undefined;
			}, []);
			if (err) return h("div", { className: "gvr-rpm", style: S_ERR }, "RPM 加载失败：" + err);
			return props.children;
		}

		/* ---------- 治理单行：RPM 读写 + 探测倒计时（同行：RPM 输入 应用 探测） ---------- */
		function GovRow(props) {
			var ctx = props.ctx;
			var mounted = props.mounted;
			var routeId = (props.provider || {}).provider;
			var _v = useState(""),
				text = _v[0],
				setText = _v[1];
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
							var rows = Array.isArray(body.models) ? body.models : [];
							var rpm = rows.length > 0 && rows[0].limits ? rows[0].limits.rpm : undefined;
							setText(typeof rpm === "number" && isFinite(rpm) ? String(rpm) : "");
							setReady(true);
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

			function apply() {
				var raw = text.trim();
				if (raw === "" || busy || probing.current) return; // 空输入 = 无操作，不清零不删键。
				if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
					setErr("RPM 须为正整数");
					return;
				}
				var op = ++opSeq.current;
				setBusy(true);
				setErr(null);
				var patch = { limits: { providers: {} } };
				patch.limits.providers[routeId] = { rpm: Number(raw) };
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
					remoteOf(ctx, mounted)
						.then(function (remote) {
							return remote.cancelProbe({ provider: routeId });
						})
						.then(function () {
							return pollStatus();
						})
						.catch(function () {});
					return;
				}
				startProbe();
			}

			if (!routeId) return null;
			if (err && !ready) return h("div", { className: "gvr-rpm", style: S_ERR }, "RPM 加载失败：" + err);
			if (!ready) return null;
			var running = phase === "running";
			return h(
				"div",
				{ className: "gvr-rpm" },
				h(
					"div",
					{ style: S_ROW },
					h("span", { style: S_LABEL }, "RPM"),
					h("input", {
						style: S_INPUT,
						value: text,
						placeholder: "空=不限",
						inputMode: "numeric",
						disabled: busy || running,
						"aria-label": "RPM",
						onChange: function (ev) {
							setText(ev.target.value);
						},
						onKeyDown: function (ev) {
							if (ev.key === "Enter") apply();
						},
					}),
					h("button", { type: "button", style: S_BTN, disabled: busy || running, onClick: apply }, busy ? "应用中" : "应用"),
					h(
						"button",
						{
							type: "button",
							style: Object.assign({}, S_BTN, { marginLeft: 8 }),
							title: running ? "点击取消探测" : "自动测 RPM 并填入",
							onClick: probeClick,
						},
						running ? (typeof remain === "number" ? remain + "s" : "探测中") : "探测",
					),
				),
				phase === "done" ? h("div", { style: S_NOTE }, note) : null,
				phase === "error" ? h("div", { style: S_ERR }, note) : null,
				err ? h("div", { style: S_ERR }, err) : null,
			);
		}

		/* ---------- cordis 客户端插件入口（只挂 provider-card 槽，无 footer） ---------- */
		var inject = ["slots", "remote"];
		// keyed 槽按 options.key === entryKey 精确匹配（一 key 一位）：llm-pi-ai 系
		//（含自定义路由，CustomProviderCard 同命名空间）与 llm-deepseek 各占一位，
		// 每张服务商卡一行 RPM。服务端全按路由 id 走，与命名空间无关，故组件复用同一 CardSlot。
		var PROVIDER_KEYS = ["llm-pi-ai", "llm-deepseek"];

		function apply(ctx) {
			var mounted = ctx.remote.$mount(CONTRIBUTION);
			mounted.then(null, function () {}); // 无人等待时兜底，防未处理 rejection。
			ctx.effect(function () {
				return ctx.slots.inject("settings.models.provider-card", function () {
					return PROVIDER_KEYS.map(function (slotKey) {
						return ctx.slots.register({ name: "settings.models.provider-card", key: slotKey }, function CardSlot(slotProps) {
							return h(
								GvrBoundary,
								null,
								h(GovRow, {
									ctx: ctx,
									mounted: mounted,
									provider: slotProps.provider,
								}),
							);
						});
					});
				});
			}, "model-governor: provider rpm");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
