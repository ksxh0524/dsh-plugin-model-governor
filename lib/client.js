/** dsh-plugin-model-governor 浏览器半（手写 __ModuleLoader__ 工厂，无构建链）：
 *  宿主 Models 设置页的原位扩展（不新增 section 页）：provider-card 槽挂单路由治理卡、
 *  footer 槽挂全局区。服务端只读 browser 半不自带（ctx.remote 官方装配构建期固定，
 *  本包自己 $mount 手写 strict 描述符，再经名字解析调用）。
 *
 *  设计意图：
 *  - 形态照抄 plugin-usage-stats/lib/client.js（只取形态不抄业务）：
 *    window.__ModuleLoader__.load({id, factory}）、tab 缩进、只 require("react")、
 *    无 JSX（React.createElement）。两端契约：描述符与 src/cordis.ts 的 SRC 方法 /
 *    参数名一一对应（describe/filter、configure/patch），改名须同步，sourceLocation
 *    直指方法名首字符（contractPairSuite 三道门当场抓住漂移）。
 *  - 调用一律先 await $mount 再经 ctx.get("remote.governor") 名字解析——属性式访问在
 *    第三方 fiber 下会被可见性过滤（without inject），沿用 usage-stats 实测结论。
 *  - keyed 槽 settings.models.provider-card 按 brief 形态注册（key 固定 llm-pi-ai，
 *    即该路由族的 settingsNs）：inject 回调保持 sidebar 式无参形态，owner 份额
 *    （provider/configured/keyConfigured）由渲染侧以组件 props 交付（ui-renderer
 *    scoped-slots 的 renderEntry 末位展开 ownerProps，类型见 PropsRuntime），
 *    本包用一层薄包装组件把 owner 转交 + 注入 ctx/mounted。
 *  - 卡内经 describe({provider}) 读该路由逐模型行（自带档位 / 生效值 / 生效 limits /
 *    issues），可写覆盖调 configure；footer 经 describe({}) 读全量：全局 RPM 默认
 *    写入口 + 失配修复列表（modelErrors 清除覆盖）。
 *  - 样式只用 --dsw-* 真名 token，对齐 usage-stats 注释里的控件规格（高 34px、
 *    圆角 8px、.5px border-l4、底 bg-layer-3、13px）；报错无边框红字走
 *    --dsw-alias-state-error-primary；禁 emoji 图标（状态用文字徽标）。
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

		/** 插件 id（描述符 id 前缀）与卡槽 key（llm-pi-ai 路由族的 settingsNs）。 */
		var SETTINGS_NS = "model-governor";
		var PROVIDER_KEY = "llm-pi-ai";

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
				// acceptsUndefined：filter/patch 均可省略（官方 codegen 对可选边界的显式字段，不塞 codec 兜底）。
				// sourceLocation：契约出处锚点（官方产物恒带）；行号漂移由 contract-pair 测试当场抓住。
				parameters: [{ name: param, wire: param, source: "json", acceptsUndefined: true, codec: codec(method + ":" + param) }],
				result: codec(method + ":result"),
				sourceLocation: location,
			};
		}
		var CONTRIBUTION = {
			package: "dsh-plugin-model-governor",
			descriptors: [
				descriptor("describe", "filter", { file: "src/cordis.ts", line: 268, column: 9 }),
				descriptor("configure", "patch", { file: "src/cordis.ts", line: 365, column: 9 }),
			],
		};

		/* ---------- 样式（materialize 时注入一次） ----------
		 * 对齐宿主官方设置页规范（verbatim 来源见 usage-stats 浏览器半注释：dsh-client-ui-settings-plugins
		 * 注入的 fields.module.css）：表单控件 = 高 34px、圆角 8px、.5px 细边 border-l4、底 bg-layer-3、
		 * 13px/1.5 文字；字段分隔线 .5px border-l2；报错 = 无边框 12px 错误色文字。
		 * token 名以 dsh-client-ui-theme 运行时定义表为准，未定义名会导致真页样式塌。 */
		var CSS = [
			".gvr-card{display:flex;flex-direction:column;gap:10px;padding:10px 12px;box-sizing:border-box;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}",
			".gvr-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".gvr-head b{font-size:13px;font-weight:600}",
			".gvr-badge{font-size:11px;color:var(--dsw-alias-label-tertiary);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;padding:1px 6px;white-space:nowrap}",
			".gvr-sub{font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".gvr-muted{color:var(--dsw-alias-label-tertiary)}",
			".gvr-row{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:8px;display:flex;flex-direction:column;gap:6px}",
			".gvr-rowid{font-weight:600;font-size:13px;overflow-wrap:anywhere}",
			".gvr-kv{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:12px}",
			".gvr-kv dt{color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
			".gvr-kv dd{margin:0;overflow-wrap:anywhere}",
			".gvr-issues{display:flex;flex-direction:column;gap:4px}",
			".gvr-issue{font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}",
			".gvr-issue b{color:var(--dsw-alias-label-primary);font-weight:600}",
			/* 报错文字：无边框 12px 错误色（label-error 在 theme 真身未定义，用 state-error-primary）。 */
			".gvr-err{color:var(--dsw-alias-state-error-primary);font-size:12px;overflow-wrap:anywhere}",
			".gvr-ok{font-size:12px;color:var(--dsw-alias-label-secondary)}",
			/* 表单控件 = 宿主官方 input 规范逐参数照抄：34px 高、8px 圆角、.5px l4 边、layer-3 底、13px 字。 */
			".gvr-btn{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;align-items:center;height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3)}",
			".gvr-btn:hover{border-color:var(--dsw-alias-border-l3)}",
			".gvr-btn:focus-visible{border-color:var(--dsw-alias-brand-primary)}",
			".gvr-btn[aria-disabled=true]{color:var(--dsw-alias-label-dimmed);cursor:default}",
			".gvr-input{all:unset;box-sizing:border-box;height:34px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);min-width:0;flex:1}",
			".gvr-input:focus{border-color:var(--dsw-alias-brand-primary)}",
			".gvr-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
			".gvr-edit{display:flex;gap:8px;flex-wrap:wrap;align-items:center}",
			".gvr-fix{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:4px;background:var(--dsw-alias-bg-layer-1)}",
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

		/* ---------- 远端调用小件 ---------- */
		/** typert direct 结果包络与裸值的双形态归一（裸 DescribeResult/ConfigureResult 原样透过）。 */
		function unwrap(res) {
			if (res !== null && typeof res === "object" && res.value !== undefined && res.applied === undefined) return res.value;
			return res;
		}
		function remoteOf(ctx, mounted) {
			return mounted.then(function () {
				return ctx.get("remote.governor");
			});
		}
		/** mount/调用失败的原始报错翻译：without inject = 两端契约错位（浏览器半已刷新、
		 *  host 仍是旧服务端），明确告诉用户重启该 profile 的 host；其余错误原样透出。 */
		function humanizeError(msg) {
			if (/without inject|no longer mounted|is not a function|undefined/.test(msg)) {
				return (
					"读取治理服务失败：浏览器半调用的是 $mount 注册到本插件 fiber 的 governor 服务。" +
					"若 host 仍在运行旧版服务端（未含 describe/configure），需由你重启当前 profile 的 host 后刷新本页（服务端改动必须重启生效）。原始错误：" +
					msg
				);
			}
			return msg;
		}
		function fmtEfforts(efforts) {
			if (!Array.isArray(efforts) || efforts.length === 0) return "无";
			return efforts.join("、");
		}
		function fmtLimits(limits) {
			var l = limits || {};
			var rpm = typeof l.rpm === "number" ? "RPM " + l.rpm : "RPM不限";
			var tpm = typeof l.tpm === "number" ? "TPM " + l.tpm : "TPM不限";
			var conc = typeof l.maxConcurrent === "number" ? "并发 " + l.maxConcurrent : "并发不限";
			return rpm + " · " + tpm + " · " + conc;
		}
		function splitLevels(text) {
			return String(text || "")
				.split(/[,，、\s]+/u)
				.map(function (s) {
					return s.trim();
				})
				.filter(function (s) {
					return s.length > 0;
				});
		}

		/* ---------- issues 渲染（字符串 issue 或可行动文案 {title, body, actions}） ---------- */
		function Issue(props) {
			var issue = props.issue;
			if (typeof issue === "string") return h("div", { className: "gvr-issue" }, issue);
			if (issue !== null && typeof issue === "object") {
				var actions = Array.isArray(issue.actions) ? issue.actions : [];
				return h(
					"div",
					{ className: "gvr-issue" },
					h("b", null, issue.title || "问题"),
					issue.body ? h("div", null, issue.body) : null,
					actions.length > 0
						? h(
								"ul",
								{ style: { margin: "2px 0 2px 16px", padding: 0 } },
								actions.map(function (a, i) {
									return h("li", { key: i }, a);
								}),
							)
						: null,
				);
			}
			return null;
		}

		/* ---------- 单模型行：读出展示 + 思考强度覆盖编辑 ---------- */
		function ModelRow(props) {
			var ctx = props.ctx;
			var mounted = props.mounted;
			var entry = props.entry;
			var _e = useState(""),
				effortsText = _e[0],
				setEffortsText = _e[1];
			var _d = useState(""),
				defaultText = _d[0],
				setDefaultText = _d[1];
			var _b = useState(false),
				busy = _b[0],
				setBusy = _b[1];
			var _m = useState(null),
				msg = _m[0],
				setMsg = _m[1];
			var _er = useState(null),
				err = _er[0],
				setErr = _er[1];

			function send(op) {
				setBusy(true);
				setMsg(null);
				setErr(null);
				var patch = { provider: entry.provider, model: entry.model };
				if (op.efforts !== undefined) patch.efforts = op.efforts;
				if (op.defaultEffort !== undefined) patch.defaultEffort = op.defaultEffort;
				remoteOf(ctx, mounted)
					.then(function (remote) {
						return remote.configure(patch);
					})
					.then(function (res) {
						var body = unwrap(res);
						if (body !== null && typeof body === "object" && body.ok === false) {
							throw new Error((Array.isArray(body.errors) ? body.errors : ["写入失败"]).join("；"));
						}
						setMsg("已应用（本进程即时生效；落盘进 llm-pi-ai，重启仍在）。");
						props.onChanged();
					})
					.catch(function (e) {
						setErr(humanizeError(String((e && e.message) || e)));
					})
					.then(function () {
						setBusy(false);
					});
			}
			function applyEfforts() {
				var levels = splitLevels(effortsText);
				if (levels.length === 0) {
					setErr("档位列表为空：声明非推理模型请用「设为非推理」，清除覆盖请用「清除档位覆盖」（空数组是宿主非法值）。");
					return;
				}
				send({ efforts: levels });
			}
			function applyDefault() {
				var name = String(defaultText || "").trim();
				if (name.length === 0) {
					setErr("默认档为空：清除路由级默认请用「清除默认」（省略即不动）。");
					return;
				}
				send({ defaultEffort: name });
			}

			var eff = entry.effective || {};
			return h(
				"div",
				{ className: "gvr-row" },
				h("div", { className: "gvr-rowid" }, entry.model, entry.found ? null : h("span", { className: "gvr-badge" }, "失配")),
				h(
					"dl",
					{ className: "gvr-kv" },
					h("dt", null, "自带档位"),
					h("dd", null, fmtEfforts(entry.builtin && entry.builtin.efforts)),
					h("dt", null, "生效档位"),
					h("dd", null, fmtEfforts(eff.efforts)),
					h("dt", null, "生效默认档"),
					h("dd", null, eff.defaultEffort || "未设"),
					h("dt", null, "生效限流"),
					h("dd", null, fmtLimits(entry.limits)),
				),
				entry.issues && entry.issues.length > 0
					? h(
							"div",
							{ className: "gvr-issues" },
							entry.issues.map(function (issue, i) {
								return h(Issue, { key: i, issue: issue });
							}),
						)
					: null,
				h(
					"div",
					{ className: "gvr-edit" },
					h("input", {
						className: "gvr-input",
						value: effortsText,
						placeholder: "覆盖档位，逗号分隔（例：low、medium、high）",
						"aria-label": "覆盖档位",
						onChange: function (e) {
							setEffortsText(e.target.value);
						},
						disabled: busy,
					}),
					h("button", { className: "gvr-btn", "aria-disabled": busy ? "true" : undefined, onClick: busy ? undefined : applyEfforts }, "应用档位"),
					h(
						"button",
						{
							className: "gvr-btn",
							"aria-disabled": busy ? "true" : undefined,
							onClick: busy
								? undefined
								: function () {
										send({ efforts: false });
									},
						},
						"设为非推理",
					),
					h(
						"button",
						{
							className: "gvr-btn",
							"aria-disabled": busy ? "true" : undefined,
							onClick: busy
								? undefined
								: function () {
										send({ efforts: null });
									},
						},
						"清除档位覆盖",
					),
				),
				h(
					"div",
					{ className: "gvr-edit" },
					h("input", {
						className: "gvr-input",
						value: defaultText,
						placeholder: "路由级默认档（对该路由所有模型生效）",
						"aria-label": "默认档",
						onChange: function (e) {
							setDefaultText(e.target.value);
						},
						disabled: busy,
					}),
					h("button", { className: "gvr-btn", "aria-disabled": busy ? "true" : undefined, onClick: busy ? undefined : applyDefault }, "应用默认"),
					h(
						"button",
						{
							className: "gvr-btn",
							"aria-disabled": busy ? "true" : undefined,
							onClick: busy
								? undefined
								: function () {
										send({ defaultEffort: null });
									},
						},
						"清除默认",
					),
				),
				msg ? h("div", { className: "gvr-ok" }, msg) : null,
				err ? h("div", { className: "gvr-err" }, err) : null,
			);
		}

		/* ---------- 错误边界（ES5 类写法，无 JSX）：卡片子树内错只显示红字，
		 * 不再抛给宿主槽边界整槽 abdicate；同时把崩错文本留在页内可查。 ---------- */
		function GvrBoundary(props) {
			React.Component.call(this, props);
			this.state = { error: null };
		}
		GvrBoundary.prototype = Object.create(React.Component.prototype);
		GvrBoundary.prototype.constructor = GvrBoundary;
		GvrBoundary.getDerivedStateFromError = function (e) {
			return { error: e };
		};
		GvrBoundary.prototype.componentDidCatch = function () {};
		GvrBoundary.prototype.render = function () {
			if (this.state.error) {
				var e = this.state.error;
				return h("div", { className: "gvr-card" }, h("div", { className: "gvr-err" }, "卡片渲染失败：" + String((e && e.message) || e)));
			}
			return this.props.children;
		};

		/* ---------- provider 卡扩展：该路由逐模型治理行 ---------- */
		function ProviderCardExtras(props) {
			var ctx = props.ctx;
			var mounted = props.mounted;
			var row = props.provider || {};
			var routeId = row.provider;
			var _d = useState(null),
				models = _d[0],
				setModels = _d[1];
			var _e = useState(null),
				err = _e[0],
				setErr = _e[1];
			var _l = useState(true),
				loading = _l[0],
				setLoading = _l[1];
			var _t = useState(0),
				tick = _t[0],
				setTick = _t[1];
			var alive = useRef(0);

			var load = useCallback(
				function () {
					if (!routeId) {
						setLoading(false);
						setModels([]);
						return Promise.resolve();
					}
					var my = ++alive.current;
					setLoading(true);
					setErr(null);
					return remoteOf(ctx, mounted)
						.then(function (remote) {
							return remote.describe({ provider: routeId });
						})
						.then(function (res) {
							if (alive.current !== my) return;
							var body = unwrap(res) || {};
							setModels(Array.isArray(body.models) ? body.models : []);
						})
						.catch(function (e) {
							if (alive.current === my) setErr(humanizeError(String((e && e.message) || e)));
						})
						.then(function () {
							if (alive.current === my) setLoading(false);
						});
				},
				[ctx, mounted, routeId],
			);
			useEffect(
				function () {
					load();
				},
				[load, tick],
			);

			function reload() {
				setTick(function (x) {
					return x + 1;
				});
			}

			return h(
				"div",
				{ className: "gvr-card" },
				h(
					"div",
					{ className: "gvr-head" },
					h("b", null, "模型治理"),
					h("span", { className: "gvr-badge" }, row.displayName || routeId || "未知路由"),
					props.configured ? h("span", { className: "gvr-badge" }, "已配置") : h("span", { className: "gvr-badge" }, "未配置"),
					typeof props.keyConfigured === "boolean"
						? props.keyConfigured
							? h("span", { className: "gvr-badge" }, "密钥已配")
							: h("span", { className: "gvr-badge" }, "密钥缺失")
						: null,
					h("span", { style: { flex: 1 } }),
					h(
						"button",
						{
							className: "gvr-btn",
							onClick: function () {
								reload();
							},
							disabled: loading,
						},
						"刷新",
					),
				),
				h("div", { className: "gvr-sub" }, "自带档位只读展示；覆盖经本插件 configure 落盘（目录路由走 modelOverrides，自定义路由走 models 整数组）。"),
				loading ? h("div", { className: "gvr-muted" }, "读取中…") : null,
				err ? h("div", { className: "gvr-err" }, "读取失败：" + err) : null,
				!loading && !err && models && models.length === 0 ? h("div", { className: "gvr-muted" }, "该路由暂无可用模型。") : null,
				(models || []).map(function (entry) {
					return h(ModelRow, {
						key: entry.provider + "/" + entry.model,
						ctx: ctx,
						mounted: mounted,
						entry: entry,
						onChanged: reload,
					});
				}),
			);
		}

		/* ---------- footer 全局区：全局 RPM 默认 + 失配修复列表 ---------- */
		function FooterPanel(props) {
			var ctx = props.ctx;
			var mounted = props.mounted;
			var _d = useState(null),
				data = _d[0],
				setData = _d[1];
			var _e = useState(null),
				err = _e[0],
				setErr = _e[1];
			var _l = useState(true),
				loading = _l[0],
				setLoading = _l[1];
			var _r = useState(""),
				rpmText = _r[0],
				setRpmText = _r[1];
			var _b = useState(false),
				busy = _b[0],
				setBusy = _b[1];
			var _m = useState(null),
				msg = _m[0],
				setMsg = _m[1];
			var _t = useState(0),
				tick = _t[0],
				setTick = _t[1];
			var alive = useRef(0);

			var load = useCallback(
				function () {
					var my = ++alive.current;
					setLoading(true);
					setErr(null);
					return remoteOf(ctx, mounted)
						.then(function (remote) {
							return remote.describe({});
						})
						.then(function (res) {
							if (alive.current !== my) return;
							var body = unwrap(res) || {};
							setData({ models: Array.isArray(body.models) ? body.models : [], modelErrors: Array.isArray(body.modelErrors) ? body.modelErrors : [] });
						})
						.catch(function (e) {
							if (alive.current === my) setErr(humanizeError(String((e && e.message) || e)));
						})
						.then(function () {
							if (alive.current === my) setLoading(false);
						});
				},
				[ctx, mounted],
			);
			useEffect(
				function () {
					load();
				},
				[load, tick],
			);

			function reload() {
				setTick(function (x) {
					return x + 1;
				});
			}
			function applyRpm() {
				var n = Math.floor(Number(rpmText));
				if (!isFinite(n) || n <= 0) {
					setMsg(null);
					setErr("全局默认 RPM 须为正整数（零与负数是服务端非法值）。");
					return;
				}
				setBusy(true);
				setMsg(null);
				setErr(null);
				remoteOf(ctx, mounted)
					.then(function (remote) {
						return remote.configure({ limits: { defaults: { rpm: n } } });
					})
					.then(function (res) {
						var body = unwrap(res);
						if (body !== null && typeof body === "object" && body.ok === false) {
							throw new Error((Array.isArray(body.errors) ? body.errors : ["写入失败"]).join("；"));
						}
						setMsg("全局默认 RPM 已应用为 " + n + "（本进程即时生效；模型 / 路由级覆盖优先于它）。");
					})
					.catch(function (e) {
						setErr(humanizeError(String((e && e.message) || e)));
					})
					.then(function () {
						setBusy(false);
					});
			}
			function fixMismatch(item) {
				setBusy(true);
				setMsg(null);
				setErr(null);
				remoteOf(ctx, mounted)
					.then(function (remote) {
						return remote.configure({ provider: item.provider, model: item.model, efforts: null });
					})
					.then(function (res) {
						var body = unwrap(res);
						if (body !== null && typeof body === "object" && body.ok === false) {
							throw new Error((Array.isArray(body.errors) ? body.errors : ["写入失败"]).join("；"));
						}
						setMsg("已清除 " + item.provider + "/" + item.model + " 的档位覆盖（跟随自带）。");
						reload();
					})
					.catch(function (e) {
						setErr(humanizeError(String((e && e.message) || e)));
					})
					.then(function () {
						setBusy(false);
					});
			}

			var modelErrors = (data && data.modelErrors) || [];
			var modelCount = data && data.models ? data.models.length : 0;
			return h(
				"div",
				{ className: "gvr-card" },
				h(
					"div",
					{ className: "gvr-head" },
					h("b", null, "全局限流与失配修复"),
					h("span", { className: "gvr-muted" }, loading ? "读取中…" : "共 " + modelCount + " 个模型，" + modelErrors.length + " 个失配"),
					h("span", { style: { flex: 1 } }),
					h(
						"button",
						{
							className: "gvr-btn",
							onClick: function () {
								reload();
							},
							disabled: loading,
						},
						"刷新",
					),
				),
				err ? h("div", { className: "gvr-err" }, "读取失败：" + err) : null,
				msg ? h("div", { className: "gvr-ok" }, msg) : null,
				h(
					"div",
					{ className: "gvr-bar" },
					h("span", { className: "gvr-sub" }, "全局默认 RPM"),
					h("input", {
						className: "gvr-input",
						value: rpmText,
						placeholder: "例：60（空维即不限）",
						"aria-label": "全局默认 RPM",
						inputMode: "numeric",
						onChange: function (e) {
							setRpmText(e.target.value);
						},
						disabled: busy,
					}),
					h("button", { className: "gvr-btn", "aria-disabled": busy ? "true" : undefined, onClick: busy ? undefined : applyRpm }, "应用"),
				),
				modelErrors.length > 0
					? h(
							"div",
							{ className: "gvr-issues" },
							modelErrors.map(function (item, i) {
								return h(
									"div",
									{ key: item.provider + "/" + item.model + "/" + i, className: "gvr-fix" },
									h(Issue, { issue: item.advice || "失配覆盖：" + item.provider + "/" + item.model }),
									h(
										"div",
										{ className: "gvr-bar" },
										h(
											"button",
											{
												className: "gvr-btn",
												"aria-disabled": busy ? "true" : undefined,
												onClick: busy
													? undefined
													: function () {
															fixMismatch(item);
														},
											},
											"清除该模型档位覆盖",
										),
									),
								);
							}),
						)
					: !loading && !err
						? h("div", { className: "gvr-muted" }, "无失配覆盖。")
						: null,
			);
		}

		/* ---------- cordis 客户端插件入口 ---------- */
		var inject = ["slots", "remote"];

		function apply(ctx) {
			ensureCss();
			var mounted = ctx.remote.$mount(CONTRIBUTION);
			mounted.then(null, function () {}); // 无人等待时兜底，防未处理 rejection；组件内 await 仍会把错误抛给 try/catch
			// provider 卡扩展：keyed 槽按路由族 settingsNs 分发，本包只挂 llm-pi-ai 族。
			ctx.effect(function () {
				return ctx.slots.inject("settings.models.provider-card", function () {
					return ctx.slots.register({ name: "settings.models.provider-card", key: PROVIDER_KEY }, function CardSlot(slotProps) {
						return h(
							GvrBoundary,
							null,
							h(ProviderCardExtras, {
								ctx: ctx,
								mounted: mounted,
								provider: slotProps.provider,
								configured: slotProps.configured,
								keyConfigured: slotProps.keyConfigured,
							}),
						);
					});
				});
			}, "model-governor: provider card");
			// footer 全局区：list 槽无 key 但必须带 id（缺 id 注册即抛，会毒死整个 apply）。
			ctx.effect(function () {
				return ctx.slots.inject("settings.models.footer", function () {
					return ctx.slots.register({ name: "settings.models.footer", id: "model-governor-footer" }, function FooterSlot() {
						return h(FooterPanel, { ctx: ctx, mounted: mounted });
					});
				});
			}, "model-governor: footer");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
