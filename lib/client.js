/** dsh-plugin-model-governor 浏览器半 v4（RPM 单行 + 探测行，无其他 UI）：
 *  provider-card 槽（llm-pi-ai/llm-deepseek 各占一位）每卡渲染两行：① RPM 行（RPM 上限 +
 *  数字框 + 应用 + 清除；清除 = configure 写 null 删掉服务商级 rpm、回落上层）；
 *  ② 探测行（探测按钮 → 进度轮询 → 结论直显；触顶才自动填入，未触顶不写）。
 *  无标题、无徽标、无页脚区、无样式注入（纯内联样式，贴原生输入框规格：32px 高、
 *  6px 圆角、#d9d9d9 边框）。读数经 describe({provider}) 取首模型生效 rpm（同卡
 *  共享服务商默认即准确）；RPM 写入调 configure({limits:{providers:{[route]:{rpm}}}})；
 *  空输入点应用 = 无操作（不清零，不删键）。探测调 probe({provider}) 发起、
 *  probeStatus({provider}) 轮询、cancelProbe({provider}) 取消；探测结论的 note
 *  中文直显；自动填入后发 gvr-rpm-changed 事件让 RPM 行回读。
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
				descriptor("describe", "filter", { file: "src/cordis.ts", line: 260, column: 9 }),
				descriptor("configure", "patch", { file: "src/cordis.ts", line: 291, column: 9 }),
				descriptor("probe", "spec", { file: "src/cordis.ts", line: 321, column: 9 }),
				descriptor("probeStatus", "filter", { file: "src/cordis.ts", line: 390, column: 9 }),
				descriptor("cancelProbe", "target", { file: "src/cordis.ts", line: 422, column: 9 }),
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
		var S_HINT = { fontSize: 12, color: "#999", marginLeft: 8, whiteSpace: "nowrap" };
		var S_NOTE = { fontSize: 12, color: "#666", marginTop: 4, lineHeight: 1.6, wordBreak: "break-all" };
		var S_LINK = {
			height: 32,
			padding: "0 6px",
			fontSize: 12,
			color: "#999",
			background: "transparent",
			border: "none",
			cursor: "pointer",
			whiteSpace: "nowrap",
		};

		/* ---------- 跨行事件：探测自动填入后通知 RPM 行回读 ---------- */
		var RPM_CHANGED = "gvr-rpm-changed";
		function emitRpmChanged(routeId) {
			if (typeof window !== "undefined" && window.dispatchEvent) {
				window.dispatchEvent(new window.CustomEvent(RPM_CHANGED, { detail: { route: routeId } }));
			}
		}

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

		/* ---------- RPM 单行：读首模型生效 rpm，写服务商默认 ---------- */
		function RpmLine(props) {
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
					function onChanged(ev) {
						if (ev && ev.detail && ev.detail.route === routeId) load();
					}
					if (typeof window !== "undefined" && window.addEventListener) {
						window.addEventListener(RPM_CHANGED, onChanged);
					}
					return function () {
						alive.current += 1;
						if (typeof window !== "undefined" && window.removeEventListener) {
							window.removeEventListener(RPM_CHANGED, onChanged);
						}
					};
				},
				[load],
			);

			function apply() {
				var raw = text.trim();
				if (raw === "" || busy) return; // 空输入 = 无操作，不清零不删键。
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

			function clear() {
				if (busy) return; // 清除 = 写 null 删掉服务商级 rpm，回落上层。
				var op = ++opSeq.current;
				setBusy(true);
				setErr(null);
				var patch = { limits: { providers: {} } };
				patch.limits.providers[routeId] = { rpm: null };
				remoteOf(ctx, mounted)
					.then(function (remote) {
						return remote.configure(patch);
					})
					.then(function (res) {
						var body = unwrap(res) || {};
						if (body.ok === false) throw new Error((body.errors || []).join("；") || "写入被拒");
					})
					.then(function () {
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

			if (err && !ready) return h("div", { className: "gvr-rpm", style: S_ERR }, "RPM 加载失败：" + err);
			if (!ready) return null;
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
						disabled: busy,
						"aria-label": "RPM",
						onChange: function (ev) {
							setText(ev.target.value);
						},
						onKeyDown: function (ev) {
							if (ev.key === "Enter") apply();
						},
					}),
					h("button", { type: "button", style: S_BTN, disabled: busy, onClick: apply }, busy ? "应用中" : "应用"),
					h("button", { type: "button", style: S_LINK, disabled: busy, title: "删掉本服务商 RPM，回落上层", onClick: clear }, "清除"),
				),
				err ? h("div", { style: S_ERR }, err) : null,
			);
		}

		/* ---------- 探测行：发起 → 轮询进度 → 结论直显（触顶自动填入后通知 RPM 行） ---------- */
		function ProbeLine(props) {
			var ctx = props.ctx;
			var mounted = props.mounted;
			var routeId = (props.provider || {}).provider;
			var _s = useState("idle"),
				phase = _s[0],
				setPhase = _s[1];
			var _t = useState(""),
				note = _t[0],
				setNote = _t[1];
			var _p = useState(""),
				progress = _p[0],
				setProgress = _p[1];
			var alive = useRef(0);
			var timer = useRef(null);
			var probing = useRef(false);

			function stopPoll() {
				if (timer.current !== null) {
					if (typeof clearInterval !== "undefined") clearInterval(timer.current);
					timer.current = null;
				}
			}
			useEffect(function () {
				return function () {
					alive.current += 1;
					probing.current = false;
					stopPoll();
				};
			}, []);

			function pollStatus() {
				remoteOf(ctx, mounted)
					.then(function (remote) {
						return remote.probeStatus({ provider: routeId });
					})
					.then(function (res) {
						if (!probing.current) return;
						var body = unwrap(res) || {};
						if (body.state === "running") {
							setProgress("探测中 " + (body.sent || 0) + " 发·" + (body.succeeded || 0) + " 成功…");
							return;
						}
						// done / idle：停轮询，结论直显；自动填入了就让 RPM 行回读。
						probing.current = false;
						stopPoll();
						if (body.state === "done" && body.result) {
							setNote(String(body.result.note || ""));
							setPhase("done");
							if (body.result.applied) emitRpmChanged(routeId);
						} else {
							setNote("探测已结束但无结论，请重试");
							setPhase("error");
						}
					})
					.catch(function (e) {
						if (!probing.current) return;
						probing.current = false;
						stopPoll();
						setNote(humanizeError(String((e && e.message) || e)));
						setPhase("error");
					});
			}

			function start() {
				if (!routeId || probing.current) return;
				probing.current = true;
				setPhase("running");
				setNote("");
				setProgress("探测发起中…");
				remoteOf(ctx, mounted)
					.then(function (remote) {
						return remote.probe({ provider: routeId });
					})
					.then(function (res) {
						var body = unwrap(res) || {};
						if (body.ok === false) throw new Error((body.errors || []).join("；") || "探测被拒");
						if (typeof setInterval !== "undefined") {
							stopPoll();
							timer.current = setInterval(pollStatus, 1000);
						}
						return pollStatus();
					})
					.catch(function (e) {
						probing.current = false;
						stopPoll();
						setNote(humanizeError(String((e && e.message) || e)));
						setPhase("error");
					});
			}

			function cancel() {
				remoteOf(ctx, mounted)
					.then(function (remote) {
						return remote.cancelProbe({ provider: routeId });
					})
					.then(function () {
						return pollStatus();
					})
					.catch(function () {});
			}

			if (!routeId) return null;
			return h(
				"div",
				{ className: "gvr-probe" },
				h(
					"div",
					{ style: S_ROW },
					h("span", { style: S_LABEL }, "探测"),
					phase === "running"
						? h("button", { type: "button", style: S_BTN, onClick: cancel }, "取消")
						: h("button", { type: "button", style: S_BTN, onClick: start }, phase === "done" ? "重测" : "探测"),
					phase === "running" ? h("span", { style: S_HINT }, progress || "探测中…") : h("span", { style: S_HINT }, "自动测 RPM 并填入"),
				),
				phase === "done" ? h("div", { style: S_NOTE }, note) : null,
				phase === "error" ? h("div", { style: S_ERR }, note) : null,
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
								h(RpmLine, {
									ctx: ctx,
									mounted: mounted,
									provider: slotProps.provider,
								}),
								h(ProbeLine, {
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
