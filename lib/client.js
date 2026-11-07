window.__ModuleLoader__.load({
  id: 'dsh-memory-loom',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');

    /**
     * 界面语言（v0.30.6）。
     *
     * 面板文案原来全中文硬编码，英文用户点开就是一堵中文墙。这里只翻「chrome」——
     * 页签、按钮、页脚、种类/状态词、空状态；记忆正文与注入块保持原文
     * （翻译记忆内容既不该做，也翻不准）。
     *
     * 没有打包器：client bundle 里 import 不了兄弟模块，所以字典就放在这里。
     * 判定用 `window.navigator`（不是 Node 的全局 navigator），测试环境没有它 → 默认中文。
     */
    const EN_TEXT = {
      '记忆海': 'Memory Loom',
      '记忆库': 'Library', '摘要': 'Summaries', '召回': 'Recall', '流水': 'Audit', '设置': 'Settings',
      '事实': 'Fact', '世界': 'World', '约束': 'Constraint', '经历': 'Episode', '她的经历': 'Her own', '状态': 'State',
      '正常': 'ok', '空': 'empty', '降级': 'degraded', '关闭': 'off', '未跑': 'idle',
      '动效': 'Motion', '开': 'on', '关': 'off',
      '压力自检': 'Stress', '刷新': 'Refresh', '导出': 'Export', '导入': 'Import', '整理': 'Tidy',
      '焦点': 'Focus', '标签': 'Labels', '自转': 'Spin', '复位': 'Reset', '现在': 'Now',
      '查重': 'Dedupe', '半衰': 'Half-life',
      '活跃': 'Active', '已归档': 'Archived', '全部': 'All',
      '按文本过滤': 'Filter text',
      '还没有记忆': 'No memories yet', '没有匹配': 'No match',
      '还没有跑过召回': 'No recall yet',
      '没有需要整理的过程记录': 'Nothing to tidy',
      '已被取代': 'Superseded', '容量归档': 'Archived (capacity)', '过程记录归档': 'Archived (log)',
      '已解除': 'Relaxed', '亲口': 'Said by you',
    };

    /**
     * 语言判定：中文（zh-*）以外的都按英文处理。
     * @param {{language?: string}|null} nav
     * @returns {'zh'|'en'}
     */
    function detectLocale(nav) {
      const language = nav !== null && typeof nav === 'object' && typeof nav.language === 'string' ? nav.language : '';
      if (language.length === 0) return 'zh';
      return /^zh/i.test(language) ? 'zh' : 'en';
    }

    /**
     * 翻译一条界面文案；字典里没有就原样返回（宁可中文，也不要空标签）。
     * @param {'zh'|'en'} locale
     * @param {string} text
     * @returns {string}
     */
    function translateWith(locale, text) {
      const raw = String(text ?? '');
      if (locale !== 'en') return raw;
      return EN_TEXT[raw] ?? raw;
    }

    const UI_LOCALE = detectLocale(
      typeof window !== 'undefined' && window !== null && window.navigator !== undefined ? window.navigator : null,
    );
    const t = (text) => translateWith(UI_LOCALE, text);

    /** 面板开关：模块级共享，入口按钮只改这个，覆盖层自己听 —— 完全不依赖宿主切页 */
    const panelState = { open: false, listeners: new Set() };
    function subscribePanel(listener) {
      panelState.listeners.add(listener);
      return () => panelState.listeners.delete(listener);
    }
    function getPanelOpen() {
      return panelState.open;
    }
    function setPanelOpen(next) {
      if (panelState.open === next) return;
      panelState.open = next;
      for (const listener of panelState.listeners) listener();
    }
    function usePanelOpen() {
      // 每次渲染直接读模块状态，订阅只负责触发重渲染 —— 不缓存值，
      // 也就不会出现「状态变了但组件还拿着旧闭包」的情况（React 版本无关）。
      const [, forceRender] = React.useReducer((count) => count + 1, 0);
      React.useEffect(() => subscribePanel(forceRender), []);
      return getPanelOpen();
    }

    /** 客户端版本：挂载时上报，用来确认页面到底跑的是哪一版 */
    const CLIENT_VERSION = '0.30.7';
    const h = React.createElement;

    //#region 样式
    const CSS = `
/* 记忆海是宿主 main 槽里的一页：铺满面板区域，不覆盖窗口、不进 top layer。
   两次踩坑后的结论：
   1. 把面板放进 <dialog> 的 top layer → 透明窗口会闪成桌面；
   2. body 级 fixed 浮层 → 和宿主抢 z-index，且永远盖不住原生窗口按钮。
   现在这两类问题在架构上就不存在。

   风格上分成两层：页头/页脚用宿主的设计令牌（浅色主题下和「插件」页一致），
   星海视口自己是一块深色卡片 —— 它是一片"天空"，不是页面底色。 */
.ml-page{
  --ml-ink:var(--dsw-alias-label-primary,#1f2328);
  --ml-ink-dim:var(--dsw-alias-label-secondary,#5b6470);
  --ml-ink-faint:var(--dsw-alias-label-tertiary,#8b95a4);
  --ml-line:var(--dsw-alias-border-l1,#e6e8eb);
  --ml-gold:#b8862c;
  position:relative;display:grid;grid-template-rows:auto minmax(0,1fr) auto;
  flex:1 1 auto;width:100%;height:100%;min-height:0;
  /* 桌面壳可能把顶部当成窗口拖拽区：整页声明 no-drag，否则按钮点了像没反应 */
  -webkit-app-region:no-drag;
  /* 关键：width:100% + padding 在 content-box 下会向右溢出 28px，
     页头最右边的 ✕ 就有一半落到窗口外（点它等于点窗口边缘）。 */
  box-sizing:border-box;
  gap:10px;padding:12px 14px 8px;
  overflow:hidden;color:var(--ml-ink);
  background:var(--dsw-alias-bg-base,#fff);
  font-size:13px;line-height:1.6;
}
/* 覆盖层：宿主的 shell.overlay 是"内容区里的绝对定位层"（frame 已让开标题栏），
   所以这里既不用 fixed、也不用 top layer，原生窗口按钮天然不会冲突。 */
.ml-trigger{display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:3px 9px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary,#8b95a4);font-size:12px;line-height:18px;cursor:pointer;font-family:inherit}
.ml-trigger:hover,.ml-trigger:focus-visible{color:var(--dsw-alias-label-primary,#e8eaed);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));outline:none}
.ml-trigger[data-open="true"]{color:var(--dsw-alias-label-primary,#e8eaed);border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.18))}
.ml-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary,#4c8dff)}
.ml-head{display:flex;align-items:center;gap:10px;min-height:26px}
.ml-title{font-size:14px;font-weight:600;letter-spacing:0;white-space:nowrap}
.ml-stats{display:flex;gap:12px;align-items:center;margin-left:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:var(--ml-ink-dim);white-space:nowrap;overflow:hidden}
.ml-stats b{color:var(--ml-ink);font-weight:500}
/* 页脚按钮：浅色页面上用宿主风格，别用深色卡片里的 .ml-btn（那是深底浅字） */

/* 星海视口：深色卡片，自己带一套暗色调色板（不受宿主浅色主题影响） */
.ml-main{
  --ml-ink:#e2e9f6; --ml-ink-dim:#93a5c2; --ml-ink-faint:#63748f;
  --ml-line:#1e2b45; --ml-edge:#2b3c5c; --ml-rail:#070c17; --ml-gold:#e9c07a; --ml-void:#05060b;
  position:relative;display:grid;grid-template-columns:minmax(0,1fr) 306px;min-height:0;overflow:hidden;
  color:#e2e9f6;border:1px solid var(--dsw-alias-border-l1,#e6e8eb);border-radius:10px;
  background:radial-gradient(120% 90% at 18% -10%, #131f38 0%, #070c17 46%, var(--ml-void) 100%);
}
.ml-stage{position:relative;min-width:0;min-height:0;overflow:hidden;border-right:1px solid var(--ml-line);display:flex;flex-direction:column}
.ml-canvas-wrap{position:relative;flex:1;min-height:0;cursor:grab;isolation:isolate}
/* 星云底：静态图层。早先给它加了 46s 的漂移动画，结果每帧都要重新合成一层大图，
   和 60fps 重绘的画布抢合成器 —— 转动偶尔就漏一帧。画面里的「动」交给相机就够了。 */
.ml-nebula{position:absolute;inset:-40px;z-index:0;pointer-events:none;background-repeat:no-repeat;background-size:cover;background-position:center}
.ml-canvas{position:relative;z-index:1;display:block;width:100%;height:100%;touch-action:none}
.ml-stage-tag{position:absolute;left:14px;bottom:10px;z-index:2;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;letter-spacing:.03em;color:var(--ml-ink-faint);pointer-events:none}
.ml-stage-tag b{color:var(--ml-ink-dim);font-weight:400}
.ml-fps{position:absolute;right:12px;top:10px;z-index:2;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;color:var(--ml-ink-faint);pointer-events:none}
/* 视图按钮必须在 canvas（z-index:1）之上，否则点击会被画布吃掉 */
.ml-viewtools{position:absolute;left:12px;top:10px;z-index:3;display:flex;gap:4px}
.ml-viewtools button{border:1px solid rgba(120,160,230,.22);background:rgba(10,16,28,.72);color:#aebbd6;font:inherit;font-size:10.5px;padding:2px 7px;border-radius:4px;cursor:pointer;letter-spacing:.02em}
.ml-viewtools button:hover{color:#e2e9f6;border-color:rgba(120,160,230,.4)}
.ml-viewtools button[data-on="true"]{background:rgba(120,160,230,.24);color:#e8efff;border-color:rgba(120,160,230,.5)}
.ml-viewtools button:focus-visible{outline:none;box-shadow:0 0 0 2px var(--ml-gold)}

.ml-void{position:absolute;inset:0;z-index:2;display:grid;place-items:center;pointer-events:none}
.ml-void-card{display:flex;flex-direction:column;align-items:center;gap:9px;text-align:center;padding:0 24px}
.ml-void-ring{width:74px;height:74px;border-radius:50%;border:1px dashed rgba(140,180,240,.34);display:grid;place-items:center;animation:ml-orbit 14s linear infinite}
.ml-void-ring i{display:block;width:7px;height:7px;border-radius:50%;background:var(--ml-gold);box-shadow:0 0 12px rgba(233,192,122,.8);margin-top:-37px}
@keyframes ml-orbit{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.ml-void-ring{animation:none}}
.ml-void-title{font-family:ui-serif,"Songti SC",Georgia,serif;font-size:14px;letter-spacing:.1em;color:var(--ml-ink)}
.ml-void-text{font-size:11.5px;color:var(--ml-ink-dim);max-width:340px}
.ml-void-hints{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin-top:2px}
.ml-void-hints span{font-size:10.5px;color:var(--ml-ink-dim);border:1px solid var(--ml-line);border-radius:999px;padding:2px 9px;background:rgba(10,18,32,.7)}

/* 时间快门 */
.ml-scrub{display:flex;align-items:center;gap:9px;padding:5px 12px 7px;border-top:1px solid var(--ml-line);background:rgba(6,10,20,.55)}
.ml-scrub input[type="range"]{flex:1;min-width:0;height:16px;margin:0;appearance:none;-webkit-appearance:none;background:transparent;cursor:pointer}
.ml-scrub input[type="range"]::-webkit-slider-runnable-track{height:2px;border-radius:1px;background:linear-gradient(90deg,rgba(140,180,240,.55),rgba(233,192,122,.55))}
.ml-scrub input[type="range"]::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:9px;height:9px;border-radius:50%;background:#e9c07a;margin-top:-3.5px;box-shadow:0 0 8px rgba(233,192,122,.75)}
.ml-scrub input[type="range"]:focus-visible{outline:none}
.ml-scrub input[type="range"]:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 3px rgba(233,192,122,.3),0 0 8px rgba(233,192,122,.75)}
.ml-scrub-label{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;color:var(--ml-ink-faint);white-space:nowrap}
.ml-scrub-label b{color:var(--ml-gold);font-weight:500}

.ml-rail{display:flex;flex-direction:column;min-height:0;background:var(--ml-rail)}
.ml-rail-head{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-bottom:1px solid var(--ml-line)}
.ml-seg{display:flex;gap:3px;padding:2px;border:1px solid var(--ml-line);border-radius:6px;background:#050a14}
.ml-seg button{flex:1;border:0;border-radius:4px;background:transparent;color:var(--ml-ink-dim);font:inherit;font-size:11.5px;padding:4px 0;cursor:pointer;letter-spacing:.04em}
.ml-seg button[data-active="true"]{background:#12203a;color:var(--ml-ink);box-shadow:0 1px 0 rgba(255,255,255,.05) inset}
.ml-seg button:hover{color:var(--ml-ink)}
.ml-seg button:focus-visible{outline:none;box-shadow:0 0 0 1px var(--ml-gold)}
.ml-lamps{display:flex;align-items:center;gap:5px}
.ml-lamp{width:7px;height:7px;border-radius:50%;flex:none;box-sizing:border-box;cursor:help}
.ml-lamp[data-s="ok"]{background:#4dd4ac;box-shadow:0 0 6px rgba(77,212,172,.55)}
.ml-lamp[data-s="empty"]{border:1px solid var(--ml-ink-faint)}
.ml-lamp[data-s="degraded"]{background:#e08a63;box-shadow:0 0 6px rgba(224,138,99,.5)}
.ml-lamp[data-s="disabled"]{border:1px dashed var(--ml-ink-faint)}
.ml-lamp[data-s="unknown"]{border:1px dotted var(--ml-ink-faint)}
.ml-health-toggle{margin-left:auto;display:inline-flex;align-items:center;gap:4px;border:0;background:transparent;color:var(--ml-ink-faint);font:inherit;font-size:10px;padding:0;cursor:pointer;white-space:nowrap}
.ml-health-toggle:hover{color:var(--ml-ink-dim)}
.ml-health-toggle:focus-visible{outline:none;box-shadow:0 0 0 2px var(--ml-gold);border-radius:3px}
.ml-health-toggle[aria-expanded="true"]{color:var(--ml-ink-dim)}
.ml-health{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border:1px solid var(--ml-line);border-radius:4px;background:#080e1a}
.ml-health-row{display:grid;grid-template-columns:8px 1fr auto auto;gap:7px;align-items:center;font-size:10.5px;color:var(--ml-ink-dim);cursor:help;padding:1px 0}
.ml-health-name{white-space:nowrap}
.ml-health-word{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9.5px}
.ml-health-word[data-s="ok"]{color:#5fd6b0}
.ml-health-word[data-s="degraded"]{color:#e08a63}
.ml-health-word[data-s="empty"]{color:var(--ml-ink-faint)}
.ml-health-word[data-s="disabled"]{color:var(--ml-ink-faint)}
.ml-health-word[data-s="unknown"]{color:var(--ml-ink-faint)}
.ml-health-value{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9.5px;color:var(--ml-ink-faint)}
.ml-tools{display:flex;gap:4px;flex-wrap:wrap}
.ml-rail-body{flex:1;overflow:auto;overscroll-behavior:contain;padding:10px 12px 14px;display:flex;flex-direction:column;gap:9px}
.ml-rail-body::-webkit-scrollbar{width:8px}
.ml-rail-body::-webkit-scrollbar-thumb{background:#18233a;border-radius:4px}
.ml-foot{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:0 2px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;color:var(--ml-ink-faint)}

.ml-input{width:100%;box-sizing:border-box;padding:6px 9px;border-radius:4px;border:1px solid var(--ml-line);background:#080e1a;color:var(--ml-ink);font:inherit;font-size:12px}
.ml-input::placeholder{color:var(--ml-ink-faint)}
.ml-input:focus-visible{outline:none;border-color:var(--ml-edge);box-shadow:0 0 0 2px rgba(233,192,122,.2)}
.ml-chips{display:flex;gap:4px;flex-wrap:wrap}
.ml-chip{border:1px solid var(--ml-line);background:transparent;color:var(--ml-ink-dim);border-radius:3px;font:inherit;font-size:10.5px;padding:1px 7px;cursor:pointer}
.ml-chip[data-active="true"]{background:#13213a;color:var(--ml-ink);border-color:var(--ml-edge)}
.ml-chip:hover{color:var(--ml-ink)}
.ml-chip:focus-visible{outline:none;box-shadow:0 0 0 2px var(--ml-gold)}
.ml-btn{border:1px solid var(--ml-line);background:#080e1a;color:var(--ml-ink);border-radius:4px;font:inherit;font-size:11px;padding:3px 9px;cursor:pointer}
.ml-btn:hover{border-color:var(--ml-edge)}
.ml-btn:disabled{opacity:.45;cursor:default}
.ml-btn[data-warn="true"]{border-color:#c2701f;color:#f0c088}
.ml-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--ml-gold)}
.ml-btn[data-danger="true"]{color:#f08a72;border-color:rgba(240,138,114,.4)}
.ml-actions{display:flex;gap:5px;flex-wrap:wrap}

.ml-row{display:block;width:100%;text-align:left;background:transparent;border:0;border-bottom:1px solid #101a2c;color:inherit;font:inherit;padding:6px 5px;cursor:pointer;border-radius:3px}
.ml-row:hover{background:#0c1526}
.ml-row[data-selected="true"]{background:#111d33;box-shadow:inset 2px 0 0 var(--ml-gold)}
.ml-row:focus-visible{outline:none;box-shadow:inset 0 0 0 1px var(--ml-gold)}
.ml-row-top{display:flex;align-items:center;gap:6px}
.ml-dot{width:6px;height:6px;border-radius:50%;flex:none}
.ml-kind{font-size:9.5px;letter-spacing:.07em;color:var(--ml-ink-dim)}
.ml-serial{margin-left:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9.5px;color:var(--ml-ink-faint)}
.ml-row-text{font-size:12px;line-height:1.5;margin-top:1px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.ml-meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:2px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9.5px;color:var(--ml-ink-faint)}
.ml-empty{padding:14px 10px;text-align:center;color:var(--ml-ink-dim);font-size:11.5px;border:1px dashed var(--ml-line);border-radius:4px}
.ml-detail{border:1px solid var(--ml-line);background:#080e1a;border-radius:4px;padding:10px 11px;display:flex;flex-direction:column;gap:8px}
.ml-quote{font-family:ui-serif,"Songti SC",Georgia,serif;font-size:12.5px;line-height:1.65;padding-left:9px;border-left:2px solid var(--ml-gold)}
.ml-kv{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9.5px;color:var(--ml-ink-faint)}
.ml-kv dd{margin:0;color:var(--ml-ink-dim);overflow-wrap:anywhere}
.ml-block{border-left:1px solid var(--ml-line);padding-left:8px}
.ml-block-title{font-family:ui-serif,"Songti SC",Georgia,serif;font-size:11px;letter-spacing:.06em;color:var(--ml-ink-dim)}
.ml-block-text{white-space:pre-wrap;font-size:10.5px;color:var(--ml-ink-faint);margin-top:1px}
.ml-line-row{display:flex;align-items:center;gap:7px;padding:4px 0;border-bottom:1px solid #101a2c}
.ml-gen{font-size:9.5px;line-height:1;padding:2px 5px;border-radius:4px;border:1px solid var(--ml-line);color:var(--ml-ink-faint);white-space:nowrap}
.ml-gen[data-llm="true"]{color:#8fd6b4;border-color:rgba(120,220,170,.4)}
.ml-engine{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:7px 9px;border:1px solid var(--ml-line);border-radius:7px;font-size:11px;color:var(--ml-ink-dim)}
.ml-engine b{color:var(--ml-ink);font-weight:600}
.ml-engine[data-on="true"]{border-color:rgba(120,220,170,.35)}
.ml-tune{display:grid;grid-template-columns:1fr 88px auto;align-items:center;gap:8px;font-size:11px;color:var(--ml-ink-dim)}
.ml-tune-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ml-tune .ml-input{padding:3px 6px;font-size:11px;text-align:right}
.ml-tune-range{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9.5px;color:var(--ml-ink-faint);white-space:nowrap}
.ml-summary{display:flex;flex-direction:column;gap:6px;padding:9px 10px;border:1px solid var(--ml-line);border-radius:7px;background:rgba(255,255,255,.03)}
.ml-summary-head{display:flex;align-items:center;gap:8px;font-size:11.5px}
.ml-summary-head b{color:var(--ml-ink);font-weight:600}
.ml-summary-text{font-size:11px;line-height:1.55;color:var(--ml-ink-dim);word-break:break-word}
.ml-threadline{height:2px;border-radius:1px;flex:none}
.ml-score{flex:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:9.5px;color:var(--ml-ink-faint)}
.ml-line-text{flex:1;min-width:0;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (max-width:820px){
  .ml-main{grid-template-columns:1fr;grid-template-rows:minmax(0,56%) minmax(0,44%)}
  .ml-stage{border-right:0;border-bottom:1px solid var(--ml-line)}
  .ml-stats{display:none}
}
`;
    const css = CSS;
    const styleTagId = 'dsh-memory-loom/panel.css';
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${styleTagId}"]`) === null) {
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-memory-loom';
      tag.dataset.pluginCss = styleTagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }
    //#endregion

    //#region 常量 / 纯函数
    const KINDS = ['fact', 'world', 'constraint', 'episode', 'self', 'slot'];
    const KIND_COLOR = {
      fact: [138, 180, 255],
      world: [192, 162, 255],
      constraint: [255, 157, 112],
      episode: [88, 224, 176],
      self: [255, 212, 121],
      slot: [147, 164, 191],
    };
    const KIND_LABEL = { fact: t('事实'), world: t('世界'), constraint: t('约束'), episode: t('经历'), self: t('她的经历'), slot: t('状态') };
    const REDUCED_MOTION = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches === true;

    // 相机参数照搬「记忆海」的观感：焦距 1100、初始距离 1200、俯仰 -0.30。
    const FOCAL = 1100;
    const CAM_DEFAULT = { yaw: 0.45, pitch: -0.3, dist: 1200, panX: 0, panY: 0 };
    const CAM_LIMITS = { minDist: 380, maxDist: 3200, maxPitch: 1.35 };

    /** 稳定散列：同一个 id 每次落在同一颗星上。 */
    function hash32(text) {
      let hash = 2166136261;
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619) >>> 0;
      }
      return hash >>> 0;
    }
    /** 由 id 派生的稳定随机数 [0,1)。 */
    function rand01(seed) {
      return (hash32(seed) % 100000) / 100000;
    }

    function asScrubTime(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    /** 数值覆盖值一律夹取：一个手滑写进去的 0 或 9999 就能把入口变成"看不见"。 */
    function clampNumber(raw, fallback, min, max) {
      const value = Number.parseFloat(String(raw ?? ''));
      if (!Number.isFinite(value)) return fallback;
      return Math.min(max, Math.max(min, value));
    }

    /** 点同一条再点一次就收起：选择语义抽成纯函数，方便离线盯住。 */
    function nextSelection(current, id) {
      if (id === null || id === undefined) return null;
      return current === id ? null : id;
    }

    async function loadState(signal) {
      const response = await fetch('/memory-loom/api/state', { cache: 'no-store', signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }

    async function postAction(path, body) {
      const response = await fetch(`/memory-loom/api/${path}`, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }

    function clockText(ts) {
      if (typeof ts !== 'number') return '—';
      const date = new Date(ts);
      const pad = (value) => String(value).padStart(2, '0');
      const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
      return date.toDateString() === new Date().toDateString() ? time : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
    }

    function serialOf(memory, ordered) {
      const index = ordered.findIndex((row) => row.id === memory.id);
      return `№${String((index < 0 ? ordered.length : index) + 1).padStart(4, '0')}`;
    }

    function stampOf(memory) {
      if (memory.status === 'archived') {
        if (memory.archivedReason === 'superseded') return t('已被取代');
        if (memory.archivedReason === 'capacity') return t('容量归档');
        if (memory.archivedReason === 'bulk-log') return t('过程记录归档');
        return t('已归档');
      }
      if (memory.relaxedAt != null) return t('已解除');
      if (memory.explicit === true) return t('亲口');
      return '';
    }

    /** 中文二元组 + ASCII 词：连线打分用（不引依赖）。 */
    const STOPWORDS = new Set(['今天', '明天', '昨天', '我们', '他们', '这个', '那个', '什么', '就是', '可以', '一下', '现在', '已经', '还是', '因为', '所以']);
    function keywordsOf(text, limit) {
      const normalized = String(text ?? '').toLowerCase().replace(/[^\u3400-\u4dbf\u4e00-\u9fff0-9a-z]+/g, ' ').trim();
      const out = new Map();
      for (const chunk of normalized.split(' ')) {
        if (chunk.length === 0) continue;
        if (!/[\u3400-\u4dbf\u4e00-\u9fff]/.test(chunk)) {
          if (chunk.length > 1) out.set(chunk, (out.get(chunk) ?? 0) + 1);
          continue;
        }
        const chars = [...chunk];
        for (let index = 0; index < chars.length - 1; index += 1) {
          const gram = chars[index] + chars[index + 1];
          if (STOPWORDS.has(gram)) continue;
          out.set(gram, (out.get(gram) ?? 0) + 1);
        }
      }
      return [...out.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, limit ?? 5)
        .map(([gram]) => gram);
    }

    /**
     * 三维布局：每个簇在球面上占一个方向，簇内点在各自小球壳里散开。
     * 位置只由 id 与簇决定 —— 重排数据不会让星乱跳。
     */
    function layoutSea(memories) {
      const clusterOf = (memory) => memory.scene || memory.kindLabel || KIND_LABEL[memory.kind] || '其它';
      const topics = [...new Set(memories.map(clusterOf))];
      const total = Math.max(1, topics.length);
      const centers = new Map();
      topics.forEach((topic, index) => {
        // 斐波那契球面：簇与簇之间在三维里均匀铺开
        const y = total === 1 ? 0 : 1 - (index / (total - 1)) * 2;
        const ring = Math.sqrt(Math.max(0, 1 - y * y));
        const phi = index * Math.PI * (3 - Math.sqrt(5)) + rand01(`${topic}:phi`) * 0.6;
        const radius = 230 + rand01(`${topic}:r`) * 190;
        centers.set(topic, {
          x: Math.cos(phi) * ring * radius,
          y: y * radius * 0.82,
          z: Math.sin(phi) * ring * radius,
        });
      });
      const points = memories.map((memory) => {
        const cluster = clusterOf(memory);
        const center = centers.get(cluster) ?? { x: 0, y: 0, z: 0 };
        const angle = rand01(`${memory.id}:a`) * Math.PI * 2;
        const tilt = Math.acos(2 * rand01(`${memory.id}:b`) - 1);
        const spread = 16 + rand01(`${memory.id}:r`) ** 0.65 * 120;
        const weight =
          0.35 +
          Math.min(1, (memory.significance ?? 0) * 0.18) +
          Math.min(0.5, Math.log1p(memory.hits ?? 0) * 0.22) +
          (memory.explicit === true ? 0.3 : 0);
        return {
          id: memory.id,
          memory,
          kind: memory.kind,
          kindLabel: memory.kindLabel ?? KIND_LABEL[memory.kind] ?? memory.kind,
          cluster,
          text: memory.text,
          short: memory.text.length > 26 ? `${memory.text.slice(0, 26)}…` : memory.text,
          label: memory.text.length > 14 ? `${memory.text.slice(0, 14)}…` : memory.text,
          keywords: keywordsOf(memory.text, 5),
          weight,
          archived: memory.status === 'archived',
          explicit: memory.explicit === true,
          createdAt: memory.createdAt ?? 0,
          t: memory.createdAt ?? Date.now(),
          x: center.x + Math.sin(tilt) * Math.cos(angle) * spread,
          y: center.y + Math.cos(tilt) * spread * 0.72,
          z: center.z + Math.sin(tilt) * Math.sin(angle) * spread,
          phase: rand01(`${memory.id}:p`) * Math.PI * 2,
          radius: 1.1 + Math.min(2.4, weight * 1.4),
          rgb: KIND_COLOR[memory.kind] ?? KIND_COLOR.slot,
        };
      });
      // 预生成填充色字符串：帧内只改 globalAlpha，不再逐点拼 rgba()
      for (const point of points) {
        const [r, g, b] = point.rgb;
        point.fill = `rgba(${r},${g},${b},0.86)`;
        point.fillHot = `rgba(${r},${g},${b},1)`;
        point.glowColor = `rgba(${r},${g},${b},0.35)`;
        point.glowHot = `rgba(${r},${g},${b},0.55)`;
      }
      // 把整片海平移到质心：否则簇少的时候内容会偏在一角，画面上大片空着
      if (points.length > 0) {
        let cx = 0;
        let cy = 0;
        let cz = 0;
        for (const point of points) {
          cx += point.x;
          cy += point.y;
          cz += point.z;
        }
        cx /= points.length;
        cy /= points.length;
        cz /= points.length;
        for (const point of points) {
          point.x -= cx;
          point.y -= cy;
          point.z -= cz;
        }
      }
      return { points, topics, centers };
    }

    /**
     * 连线：共享关键词 / 同簇才有候选，按分数排序，每点最多 `maxNeighbors` 条。
     * supersedes 关系单独成金线。
     *
     * 每条线带一个**世界坐标的弯曲控制点**：控制点写在三维里，所以转动相机时丝带的弯
     * 是跟着海一起转的，不是屏幕上的假弧。
     */
    function buildEdges(points, options) {
      const maxNeighbors = options?.maxNeighbors ?? 4;
      const minScore = options?.minScore ?? 0.15;
      const maxEdges = options?.maxEdges ?? 1200;
      const edges = [];
      const seen = new Set();
      const degree = new Map();
      const byId = new Map(points.map((point) => [point.id, point]));
      const keyOf = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
      const push = (a, b, score, kind) => {
        const key = keyOf(a.id, b.id);
        if (seen.has(key)) return false;
        seen.add(key);
        // 控制点：中点沿「垂直于连线」的方向偏一点，偏移量由 id 散列决定，稳定不抖
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dz = b.z - a.z;
        const length = Math.hypot(dx, dy, dz) || 1;
        const bend = (rand01(`${a.id}>${b.id}`) - 0.5) * 2 * Math.min(26, length * 0.18);
        // 任取一个与连线不平行的轴做叉积，得到稳定的垂直方向
        const ux = Math.abs(dy) < 0.9 ? 0 : 1;
        const uy = Math.abs(dy) < 0.9 ? 1 : 0;
        const px = uy * dz - 0 * dy;
        const py = 0 * dx - ux * dz;
        const pz = ux * dy - uy * dx;
        const plen = Math.hypot(px, py, pz) || 1;
        edges.push({
          a: a.id,
          b: b.id,
          score: Number(score.toFixed(3)),
          kind,
          control: {
            x: (a.x + b.x) / 2 + (px / plen) * bend,
            y: (a.y + b.y) / 2 + (py / plen) * bend,
            z: (a.z + b.z) / 2 + (pz / plen) * bend,
          },
        });
        return true;
      };
      for (const point of points) {
        for (const targetId of point.memory.supersedes ?? []) {
          const target = byId.get(targetId);
          if (target !== undefined) push(point, target, 1, 'supersede');
        }
      }

      // ② 关键词相似：同簇才做候选，避免 O(n²) 全量比较
      const byCluster = new Map();
      for (const point of points) {
        const list = byCluster.get(point.cluster) ?? [];
        list.push(point);
        byCluster.set(point.cluster, list);
      }
      const candidates = [];
      for (const [, list] of byCluster) {
        for (let i = 0; i < list.length; i += 1) {
          for (let j = i + 1; j < list.length; j += 1) {
            const left = list[i];
            const right = list[j];
            const setA = new Set(left.keywords);
            let shared = 0;
            for (const word of right.keywords) if (setA.has(word)) shared += 1;
            if (shared === 0) continue;
            const score = (2 * shared) / Math.max(1, left.keywords.length + right.keywords.length);
            if (score < minScore) continue;
            candidates.push({ a: left, b: right, score });
          }
        }
      }
      candidates.sort((left, right) => right.score - left.score);
      for (const candidate of candidates) {
        const da = degree.get(candidate.a.id) ?? 0;
        const db = degree.get(candidate.b.id) ?? 0;
        if (da >= maxNeighbors || db >= maxNeighbors) continue;
        if (push(candidate.a, candidate.b, candidate.score, 'topic')) {
          degree.set(candidate.a.id, da + 1);
          degree.set(candidate.b.id, db + 1);
        }
      }
      // 总量封顶：曲线描边的光栅成本跟条数线性相关，宁可少画几条也不能掉帧。
      // 候选已按分数降序，直接截断保留最强的那批（supersede 金线在数组前面，不会被截掉）。
      const capped = edges.length > maxEdges ? edges.slice(0, maxEdges) : edges;
      return capped;
    }

    /**
     * 兜底粘连：没连上任何线的点，连到**全场最近的一颗**（不限于同簇）。
     *
     * 记忆少的时候同簇往往只有一个点（场景各不相同），只按簇连会留下一堆孤点；
     * 跨簇连最近邻，才能让 7 颗记忆也读成一张网而不是一盘散沙。
     */
    function addCohesion(edges, points, options) {
      const maxNeighbors = options?.maxNeighbors ?? 4;
      const degree = new Map();
      const paired = new Set();
      for (const edge of edges) {
        degree.set(edge.a, (degree.get(edge.a) ?? 0) + 1);
        degree.set(edge.b, (degree.get(edge.b) ?? 0) + 1);
        paired.add(`${edge.a}|${edge.b}`);
        paired.add(`${edge.b}|${edge.a}`);
      }
      const extra = [];
      for (const point of points) {
        if ((degree.get(point.id) ?? 0) > 0) continue;
        let nearest = null;
        let best = Infinity;
        for (const other of points) {
          if (other === point) continue;
          if (paired.has(`${point.id}|${other.id}`)) continue;
          const distance = Math.hypot(other.x - point.x, other.y - point.y, other.z - point.z);
          if (distance < best) {
            best = distance;
            nearest = other;
          }
        }
        if (nearest === null) continue;
        paired.add(`${point.id}|${nearest.id}`);
        extra.push({
          a: point.id,
          b: nearest.id,
          score: 0.12,
          kind: 'topic',
          control: {
            x: (point.x + nearest.x) / 2,
            y: (point.y + nearest.y) / 2,
            z: (point.z + nearest.z) / 2,
          },
        });
        degree.set(point.id, (degree.get(point.id) ?? 0) + 1);
        degree.set(nearest.id, (degree.get(nearest.id) ?? 0) + 1);
      }
      void maxNeighbors;
      return extra.length === 0 ? edges : [...edges, ...extra];
    }

    /** 相机取值收敛：俯仰夹住、距离夹住、yaw 允许无限转。 */
    function clampCamera(camera) {
      const dist = Math.min(CAM_LIMITS.maxDist, Math.max(CAM_LIMITS.minDist, camera.dist));
      const pitch = Math.max(-CAM_LIMITS.maxPitch, Math.min(CAM_LIMITS.maxPitch, camera.pitch));
      return { yaw: camera.yaw, pitch, dist, panX: camera.panX, panY: camera.panY };
    }

    /**
     * 自动取景：按**投影后的二维包围盒**算相机距离。
     *
     * 用三维半径算是不对的：簇主要沿 z 排布时，投影到屏幕上会明显缩水，
     * 结果整片海又窄又偏。这里扫一圈 yaw（转起来也不溢出画布），取各方向上
     * 最大的横向/纵向跨度，再解出刚好铺满画面的距离（投影尺寸反比于距离，可闭式求解）。
     */
    function fitDistance(points, width, height, fill = 0.82) {
      if (points.length === 0) return CAM_DEFAULT.dist;
      const cosPitch = Math.cos(CAM_DEFAULT.pitch);
      const sinPitch = Math.sin(CAM_DEFAULT.pitch);
      let spanX = 1;
      let spanY = 1;
      const samples = 8;
      for (let step = 0; step < samples; step += 1) {
        const yaw = (step / samples) * Math.PI * 2;
        const cosYaw = Math.cos(yaw);
        const sinYaw = Math.sin(yaw);
        let maxX = 0;
        let maxY = 0;
        for (const point of points) {
          const x1 = point.x * cosYaw - point.z * sinYaw;
          const z1 = point.x * sinYaw + point.z * cosYaw;
          const y1 = point.y * cosPitch - z1 * sinPitch;
          if (Math.abs(x1) > maxX) maxX = Math.abs(x1);
          if (Math.abs(y1) > maxY) maxY = Math.abs(y1);
        }
        spanX = Math.max(spanX, maxX * 2);
        spanY = Math.max(spanY, maxY * 2);
      }
      const needForWidth = (spanX * FOCAL) / Math.max(60, width * fill);
      const needForHeight = (spanY * FOCAL) / Math.max(60, height * fill);
      const distance = Math.max(needForWidth, needForHeight);
      return Math.min(CAM_LIMITS.maxDist, Math.max(CAM_LIMITS.minDist, distance));
    }

    /**
     * 透视投影：先绕 Y 转（yaw）、再绕 X 转（pitch），最后除以深度。
     *
     * 不再给每个点加 sin 抖动的「不规则运动」：那种 ±7px 的漂移每帧只移动 0.2px，
     * 会让小亮点不停跨过像素边界，看起来就是闪和顿。运动只留给相机。
     * @returns {{x: number, y: number, f: number, depth: number}}
     */
    function projectPoint(point, camera, width, height, time, drift) {
      void time;
      void drift;
      const wx = point.x + camera.panX;
      const wy = point.y + camera.panY;
      const wz = point.z;
      const cosYaw = Math.cos(camera.yaw);
      const sinYaw = Math.sin(camera.yaw);
      const cosPitch = Math.cos(camera.pitch);
      const sinPitch = Math.sin(camera.pitch);
      const x1 = wx * cosYaw - wz * sinYaw;
      const z1 = wx * sinYaw + wz * cosYaw;
      const y1 = wy * cosPitch - z1 * sinPitch;
      const z2 = wy * sinPitch + z1 * cosPitch;
      const depth = camera.dist + z2;
      const f = FOCAL / Math.max(140, depth);
      return { x: width / 2 + x1 * f, y: height / 2 + y1 * f, f, depth };
    }

    /**
     * 一次投影整片海（回放时把未到时刻的点标成幽灵）。
     * 投影结果从对象池复用，避免每帧分配上百个临时对象触发 GC 停顿。
     */
    const projectionPool = [];
    function projectAll(points, camera, width, height, time, drift, at) {
      const projected = new Array(points.length);
      for (let index = 0; index < points.length; index += 1) {
        const point = points[index];
        const p = projectionPool[index] ?? (projectionPool[index] = { x: 0, y: 0, f: 0, depth: 0, ghost: false, point: null });
        const result = projectPoint(point, camera, width, height, time, drift);
        p.x = result.x;
        p.y = result.y;
        p.f = result.f;
        p.depth = result.depth;
        p.ghost = at !== null && at !== undefined && (point.createdAt ?? 0) > at;
        p.point = point;
        projected[index] = p;
      }
      projected.sort((left, right) => right.depth - left.depth);
      return projected;
    }
    //#endregion

    //#region 绘制
    /**
     * 空间导引：只留三圈极淡的纬线。
     * 一开始画了经纬全网格，结果整屏变成一只线框地球 —— 点少的时候它比记忆还抢眼。
     * 现在只用几圈近乎看不见的纬线交代「有纵深」，重心还给星。
     */
    function buildGuides(points) {
      let radius = 160;
      for (const point of points) {
        const distance = Math.hypot(point.x, point.y, point.z);
        if (distance > radius) radius = distance;
      }
      radius *= 0.86;
      const rings = [];
      const segments = 26;
      for (let index = 0; index < 3; index += 1) {
        const phi = -Math.PI / 3 + (index * Math.PI) / 3;
        const ringRadius = radius * Math.cos(phi);
        const y = radius * Math.sin(phi);
        const ring = [];
        for (let step = 0; step <= segments; step += 1) {
          const angle = (step / segments) * Math.PI * 2;
          ring.push({ x: Math.cos(angle) * ringRadius, y, z: Math.sin(angle) * ringRadius });
        }
        rings.push(ring);
      }
      return { rings, radius };
    }

    /** 画网格：每条环一条 path，总共 8 次 stroke。 */
    function paintGuides(ctx, guides, camera, width, height) {
      if (guides === null) return 0;
      ctx.strokeStyle = 'rgba(110,145,205,0.05)';
      ctx.lineWidth = 1;
      for (const ring of guides.rings) {
        ctx.beginPath();
        for (let index = 0; index < ring.length; index += 1) {
          const p = projectPoint(ring[index], camera, width, height, 0, false);
          if (index === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
      }
      return guides.rings.length;
    }

    /** 簇光晕精灵：一张软圆点，按需拉伸。每帧新建径向渐变会白花 50ms 里的一部分。 */
    const haloSprites = new Map();
    function haloSprite(rgb) {
      const key = rgb.join(',');
      const cached = haloSprites.get(key);
      if (cached !== undefined) return cached;
      const size = 128;
      const sprite = document.createElement('canvas');
      sprite.width = size;
      sprite.height = size;
      const ctx = sprite.getContext('2d');
      if (ctx === null) {
        haloSprites.set(key, sprite);
        return sprite;
      }
      const half = size / 2;
      const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
      gradient.addColorStop(0, `rgba(${rgb.join(',')},0.20)`);
      gradient.addColorStop(0.55, `rgba(${rgb.join(',')},0.07)`);
      gradient.addColorStop(1, `rgba(${rgb.join(',')},0)`);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, size, size);
      haloSprites.set(key, sprite);
      return sprite;
    }

    /** 簇光晕：一簇一片极淡的圆雾，让孤立的点读成「一片区域」而不是一颗尘埃。 */
    function paintClusterHalos(ctx, projected, width, height, quality) {
      if (quality < 1) return 0;
      const groups = new Map();
      for (const p of projected) {
        if (p.ghost) continue;
        const key = p.point.cluster;
        const acc = groups.get(key) ?? { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, n: 0, rgb: p.point.rgb };
        acc.minX = Math.min(acc.minX, p.x);
        acc.maxX = Math.max(acc.maxX, p.x);
        acc.minY = Math.min(acc.minY, p.y);
        acc.maxY = Math.max(acc.maxY, p.y);
        acc.n += 1;
        groups.set(key, acc);
      }
      let drawn = 0;
      for (const [, acc] of groups) {
        if (acc.n < 1) continue;
        const cx = (acc.minX + acc.maxX) / 2;
        const cy = (acc.minY + acc.maxY) / 2;
        const radius = Math.max(46, Math.hypot((acc.maxX - acc.minX) / 2, (acc.maxY - acc.minY) / 2) * 1.9 + 28);
        if (cx < -radius || cx > width + radius || cy < -radius || cy > height + radius) continue;
        ctx.globalAlpha = 1;
        ctx.drawImage(haloSprite(acc.rgb), cx - radius, cy - radius, radius * 2, radius * 2);
        drawn += 1;
      }
      ctx.globalAlpha = 1;
      return drawn;
    }

    /** 帧内复用：按透明度档位分桶，把上千条线压成十几次 stroke。 */
    const EDGE_BUCKETS = 10;
    const edgeBuckets = Array.from({ length: EDGE_BUCKETS }, () => []);
    /** 取代金线单独一桶：不能和最高透明度档共用，否则会被染成金色。 */
    const goldScratch = [];

    /**
     * 星点用预热精灵贴图：比逐点 arc()+fill() 便宜一个数量级。
     * 这是给「光晕」用的柔光精灵（只有热点会用到）。
     */
    const POINT_SPRITE_SIZE = 40;
    const pointSprites = new Map();
    function pointSprite(rgb) {
      const key = rgb.join(',');
      const cached = pointSprites.get(key);
      if (cached !== undefined) return cached;
      const sprite = document.createElement('canvas');
      sprite.width = POINT_SPRITE_SIZE;
      sprite.height = POINT_SPRITE_SIZE;
      const ctx = sprite.getContext('2d');
      if (ctx === null) {
        pointSprites.set(key, sprite);
        return sprite;
      }
      const half = POINT_SPRITE_SIZE / 2;
      const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
      gradient.addColorStop(0, `rgba(${rgb.join(',')},1)`);
      gradient.addColorStop(0.18, `rgba(${rgb.join(',')},1)`);
      gradient.addColorStop(0.45, `rgba(${rgb.join(',')},0.34)`);
      gradient.addColorStop(1, `rgba(${rgb.join(',')},0)`);
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(half, half, half, 0, Math.PI * 2);
      ctx.fill();
      pointSprites.set(key, sprite);
      return sprite;
    }

    /**
     * 实心星点的「整像素尺寸档位」。
     *
     * 关键点：每帧按浮点尺寸缩放同一张大精灵，会让浏览器每帧重新采样一次，
     * 小亮点就会闪。这里把直径量化到离散档位、按 1:1 绘制，采样恒定 —— 闪烁消失。
     */
    const POINT_SIZE_STEPS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 24, 28, 32, 40];
    const dotSprites = new Map();
    function dotSprite(rgb, step) {
      const key = `${rgb[0]},${rgb[1]},${rgb[2]}:${step}`;
      const cached = dotSprites.get(key);
      if (cached !== undefined) return cached;
      const sprite = document.createElement('canvas');
      sprite.width = step;
      sprite.height = step;
      const ctx = sprite.getContext('2d');
      if (ctx === null) {
        dotSprites.set(key, sprite);
        return sprite;
      }
      const half = step / 2;
      ctx.fillStyle = `rgba(${rgb.join(',')},0.95)`;
      ctx.beginPath();
      ctx.arc(half, half, Math.max(0.5, half - 0.35), 0, Math.PI * 2);
      ctx.fill();
      if (step >= 8) {
        // 近处的大星给一点亮核，远的小点不需要
        ctx.fillStyle = `rgba(255,255,255,0.55)`;
        ctx.beginPath();
        ctx.arc(half, half, Math.max(0.5, half * 0.42), 0, Math.PI * 2);
        ctx.fill();
      }
      dotSprites.set(key, sprite);
      return sprite;
    }

    /** 直径（设备像素）→ 最近的档位。 */
    function nearestSizeStep(diameter) {
      let best = POINT_SIZE_STEPS[0];
      let bestDelta = Infinity;
      for (let index = 0; index < POINT_SIZE_STEPS.length; index += 1) {
        const step = POINT_SIZE_STEPS[index];
        const delta = Math.abs(step - diameter);
        if (delta < bestDelta) {
          bestDelta = delta;
          best = step;
        }
      }
      return best;
    }

    function bucketOf(alpha, max) {
      return Math.min(EDGE_BUCKETS - 1, Math.max(0, Math.floor((alpha / Math.max(0.0001, max)) * EDGE_BUCKETS)));
    }

    function paintEdges(ctx, edges, positions, options) {
      const focus = options?.focus ?? null;
      const onlyFocus = options?.onlyFocus === true;
      const presence = options?.presence ?? null;
      const projectWorld = options?.projectWorld ?? null;
      for (let bucket = 0; bucket < EDGE_BUCKETS; bucket += 1) edgeBuckets[bucket].length = 0;
      goldScratch.length = 0;
      let goldCount = 0;
      let total = 0;
      let curved = 0;
      for (let index = 0; index < edges.length; index += 1) {
        const edge = edges[index];
        const a = positions.get(edge.a);
        const b = positions.get(edge.b);
        if (a === undefined || b === undefined) continue;
        // 可见度取两端最小值：一端还在淡出，整条线跟着淡，不会突然断
        const vis = presence === null ? (a.ghost || b.ghost ? 0 : 1) : Math.min(presence.get(edge.a) ?? 1, presence.get(edge.b) ?? 1);
        if (vis < 0.02) continue;
        if (onlyFocus && focus !== null && !(focus.has(edge.a) && focus.has(edge.b))) continue;
        const near = (a.f + b.f) * 0.5;
        const alpha = Math.min(0.5, (0.03 + edge.score * 0.18) * near * 1.7) * vis;
        // 远处几乎看不见的线直接跳过：省下的正是曲线光栅化的主要成本
        if (alpha < 0.03) continue;
        const mid = projectWorld !== null && edge.control !== undefined ? projectWorld(edge.control) : null;
        const target = edge.kind === 'supersede' ? goldScratch : edgeBuckets[bucketOf(alpha, 0.5)];
        target.push(a.x, a.y, mid === null ? (a.x + b.x) / 2 : mid.x, mid === null ? (a.y + b.y) / 2 : mid.y, b.x, b.y);
        if (edge.kind === 'supersede') goldCount += 1;
        curved += 1;
        total += 1;
      }
      ctx.lineWidth = 1;
      for (let bucket = 0; bucket < EDGE_BUCKETS; bucket += 1) {
        const list = edgeBuckets[bucket];
        if (list.length === 0) continue;
        const alpha = 0.06 + (bucket / (EDGE_BUCKETS - 1)) * 0.34;
        ctx.strokeStyle = `rgba(150,185,240,${alpha.toFixed(3)})`;
        ctx.beginPath();
        for (let index = 0; index < list.length; index += 6) {
          ctx.moveTo(list[index], list[index + 1]);
          ctx.quadraticCurveTo(list[index + 2], list[index + 3], list[index + 4], list[index + 5]);
        }
        ctx.stroke();
      }
      if (goldScratch.length > 0) {
        ctx.strokeStyle = 'rgba(233,192,122,.55)';
        ctx.beginPath();
        for (let index = 0; index < goldScratch.length; index += 6) {
          ctx.moveTo(goldScratch[index], goldScratch[index + 1]);
          ctx.quadraticCurveTo(goldScratch[index + 2], goldScratch[index + 3], goldScratch[index + 4], goldScratch[index + 5]);
        }
        ctx.stroke();
      }
      return { total, goldCount, curved, buckets: EDGE_BUCKETS };
    }

    /** 可见度缓动：帧率无关（指数趋近），让时间轴上的星是「淡出/淡入」而不是硬切。 */
    function easePresence(current, target, dtMs) {
      const k = 1 - Math.exp(-Math.max(0, dtMs) / 110);
      const next = current + (target - current) * k;
      return Math.abs(next - target) < 0.004 ? target : next;
    }

    /** 星云底：几张极淡的簇色光斑 + 暗角，烘焙一次，每帧只做一次 drawImage。 */
    function paintNebula(canvas, width, height, dpr, colors) {
      const pad = 24;
      const w = width + pad;
      const h = height + pad;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const palette = Array.isArray(colors) && colors.length > 0 ? colors : [[120, 150, 230]];
      const count = Math.min(5, Math.max(3, palette.length));
      for (let index = 0; index < count; index += 1) {
        const rgb = palette[index % palette.length];
        const cx = w * (0.16 + rand01(`nebula:x:${index}`) * 0.68);
        const cy = h * (0.16 + rand01(`nebula:y:${index}`) * 0.68);
        const radius = Math.max(w, h) * (0.26 + rand01(`nebula:r:${index}`) * 0.24);
        const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        gradient.addColorStop(0, `rgba(${rgb.join(',')},0.13)`);
        gradient.addColorStop(0.5, `rgba(${rgb.join(',')},0.05)`);
        gradient.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, w, h);
      }
      // 暗角：把注意力收进海中心
      const vignette = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.34, w / 2, h / 2, Math.max(w, h) * 0.78);
      vignette.addColorStop(0, 'rgba(0,0,0,0)');
      vignette.addColorStop(1, 'rgba(0,0,0,0.5)');
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, w, h);
      return canvas;
    }

    /**
     * 星点：预热精灵贴图（每颗一次 drawImage），近大远小、近亮远淡；
     * 焦点/悬停/选中额外叠一层大号精灵当光晕。逐点 arc()+fill() 太贵，已弃用。
     */
    function paintPoints(ctx, projected, options) {
      const focus = options?.focus ?? null;
      const onlyFocus = options?.onlyFocus === true;
      const hovered = options?.hovered ?? null;
      const selected = options?.selected ?? null;
      const time = options?.time ?? 0;
      const quality = options?.quality ?? 2;
      const presence = options?.presence ?? null;
      const glowFor = options?.glowFor ?? pointSprite;
      const dpr = options?.dpr ?? 1;
      const dotFor = options?.dotFor ?? dotSprite;
      for (let index = 0; index < projected.length; index += 1) {
        const p = projected[index];
        const point = p.point;
        const [r, g, b] = point.rgb;
        const isFocus = focus !== null && focus.has(point.id);
        const isHot = point.id === hovered || point.id === selected;
        const dim = onlyFocus && focus !== null && !isFocus;
        const vis = presence === null ? (p.ghost ? 0 : 1) : presence.get(point.id) ?? 1;
        if (vis < 0.02) continue;
        const base = Math.max(1.1, point.radius * (isFocus ? 1.7 : 1) * p.f * 2.6) * (0.55 + 0.45 * vis);
        // 直径按设备像素取整到离散档位：同一档位 1:1 贴图，采样恒定，不闪。
        // 档位带迟滞：深度缓慢变化时不要在两档之间反复横跳（那本身就是一种闪烁）。
        const diameter = Math.min(40, Math.max(2, Math.round(base * 2 * dpr)));
        const target = nearestSizeStep(diameter);
        const current = point.dotStep ?? target;
        const step = Math.abs(target - current) >= 2 || Math.abs(diameter - current) > 1.2 ? target : current;
        point.dotStep = step;
        const sprite = dotFor(point.rgb, step);
        // 位置**不吸附**：尺寸恒定后，亚像素位置只是同一张图的平移，采样平滑；
        // 反过来吸附到整像素会让慢速转动变成「每两帧跳一格」，那才是顿感的来源。
        const leftDev = p.x * dpr - (step >> 1);
        const topDev = p.y * dpr - (step >> 1);
        const depthAlpha = (dim ? 0.12 : Math.min(1, 0.22 + p.f * 1.05)) * vis;
        if (quality > 0 && (isFocus || isHot)) {
          const glowSprite = glowFor(point.rgb);
          const glowSize = base * 7;
          ctx.globalAlpha = depthAlpha * (point.id === selected ? 0.55 : 0.38);
          ctx.drawImage(glowSprite, p.x - glowSize / 2, p.y - glowSize / 2, glowSize, glowSize);
          ctx.globalAlpha = (0.45 + 0.3 * Math.sin(time / 600)) * vis;
          ctx.strokeStyle = `rgba(${r},${g},${b},1)`;
          ctx.lineWidth = 1.1;
          ctx.beginPath();
          ctx.arc(p.x, p.y, base * 3.2, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.globalAlpha = depthAlpha;
        ctx.drawImage(sprite, leftDev / dpr, topDev / dpr, step / dpr, step / dpr);
      }
      ctx.globalAlpha = 1;
    }

    /** 簇名占用的格子：点标签要避开它，否则会压字。 */
    function labelBudget(count) {
      return Math.max(3, Math.min(40, Math.round(count * 0.35)));
    }

    /** 标签候选：按权重定序取前 N 个（只算一次，转相机不改变这一批）。 */
    function pickLabelCandidates(points, limit = 64) {
      return [...points].sort((left, right) => right.weight - left.weight).slice(0, limit);
    }

    /** 标签避让用的屏幕格子（帧内复用，不每帧新建 Set） */
    const labelCells = new Set();

    /**
     * 点旁短标签：候选按权重预先排好，所以转动时**不会换批**（换批就是割裂感的来源）。
     * 每个标签有自己的淡入淡出（alpha 缓动）；带深色底衬，避免压在星点上读不清；
     * 宽度只量一次并缓存，按真实宽度占格子，不会互相压字。
     */
    function paintLabels(ctx, candidates, positions, width, height, options) {
      const alphaMap = options?.alphaMap ?? null;
      const focus = options?.focus ?? null;
      const hovered = options?.hovered ?? null;
      const selected = options?.selected ?? null;
      const dt = options?.dt ?? 16;
      const presence = options?.presence ?? null;
      labelCells.clear();
      let drawn = 0;
      ctx.font = '11px ui-sans-serif, system-ui, "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'left';
      for (let index = 0; index < candidates.length; index += 1) {
        const point = candidates[index];
        const p = positions.get(point.id);
        let target = 0;
        let planX = 0;
        let planY = 0;
        let planW = 0;
        // 可见度必须跟着回放走：否则幽灵点淡没了，它的标签还挂在原地
        const pointVis = presence === null || presence === undefined ? (p?.ghost ? 0 : 1) : presence.get(point.id) ?? 1;
        if (p !== undefined && p.f >= 0.5 && pointVis >= 0.35) {
          if (point.labelWidth === undefined) point.labelWidth = Math.ceil(ctx.measureText(point.label).width);
          planW = point.labelWidth;
          const preferRight = p.x + 9;
          // 右边放不下就翻到星点左边：强行贴边会把标签挤离它的星，看起来像两张皮
          if (preferRight + planW <= width - 6) {
            planX = preferRight;
          } else {
            planX = p.x - 9 - planW;
          }
          planY = p.y + 4;
          if (planX > 2 && planY > 16 && planY < height - 8) {
            const cols = Math.max(1, Math.ceil(planW / 56));
            const startCol = (planX / 56) | 0;
            const row = (planY / 15) | 0;
            let free = true;
            for (let col = 0; col < cols; col += 1) {
              const cell = `${startCol + col}:${row}`;
              if (labelCells.has(cell)) {
                free = false;
                break;
              }
            }
            if (free) {
              for (let col = 0; col < cols; col += 1) labelCells.add(`${startCol + col}:${row}`);
              target = 1;
            }
          }
        }
        const current = alphaMap === null ? target : alphaMap.get(point.id) ?? 0;
        const next = alphaMap === null ? target : easePresence(current, target, dt);
        if (alphaMap !== null) alphaMap.set(point.id, next);
        if (next < 0.06 || target === 0) continue;
        if (p === undefined) continue;
        const hot = point.id === hovered || point.id === selected || (focus !== null && focus.has(point.id));
        // 底衬 + 引线：标签要么贴着星，要么不出现
        if (next > 0.25) {
          ctx.globalAlpha = next * 0.55;
          ctx.fillStyle = 'rgba(4,8,16,0.72)';
          ctx.fillRect(planX - 5, planY - 10, planW + 10, 15);
          ctx.globalAlpha = next * 0.5;
          ctx.fillStyle = hot ? '#78aaff' : '#5b6f96';
          if (planX > p.x) ctx.fillRect(p.x + 3, planY - 3, Math.max(1, planX - 5 - (p.x + 3)), 1);
          else ctx.fillRect(planX + planW + 4, planY - 3, Math.max(1, p.x - 3 - (planX + planW + 4)), 1);
        }
        ctx.globalAlpha = next * (hot ? 0.98 : 0.72);
        ctx.fillStyle = hot ? '#eef4ff' : '#a9b8d4';
        ctx.fillText(point.label, planX, planY);
        drawn += 1;
      }
      ctx.globalAlpha = 1;
      return drawn;
    }
    //#endregion

    //#region 记忆海画布
    function MemorySea({ memories, dataKey, selectedId, onSelect, stressToken, onStressReport, animate, scrubAt, onScrub, focusIds }) {
      const wrapRef = React.useRef(null);
      const canvasRef = React.useRef(null);
      const badgeRef = React.useRef(null);
      const nebulaRef = React.useRef(null);
      const modelRef = React.useRef({
        points: [],
        edges: [],
        positions: new Map(),
        projected: [],
        camera: { ...CAM_DEFAULT },
        quality: 2,
        hovered: null,
        selected: null,
        flash: new Map(),
        stress: null,
        dragging: null,
        dragMoved: false,
        velocity: null,
        lastMoveAt: 0,
        autoOrbit: true,
        showLabels: true,
        onlyFocus: false,
        presence: new Map(),
        labelCandidates: [],
        labelAlpha: new Map(),
        guides: null,
        dust: null,
        nebula: null,
        lastNow: 0,
        size: { width: 0, height: 0, dpr: 1 },
      });
      const scrubRef = React.useRef(null);
      const focusRef = React.useRef(null);

      React.useEffect(() => {
        modelRef.current.animate = animate !== false;
      }, [animate]);
      React.useEffect(() => {
        scrubRef.current = asScrubTime(scrubAt);
      }, [scrubAt]);
      React.useEffect(() => {
        focusRef.current = focusIds instanceof Set && focusIds.size > 0 ? focusIds : null;
      }, [focusIds]);
      React.useEffect(() => {
        modelRef.current.selected = selectedId;
      }, [selectedId]);

      /** 数据变化：重排三维坐标、重算连线（这是唯一的重活，不在帧里）。 */
      const memoriesRef = React.useRef(memories);
      memoriesRef.current = memories;
      React.useEffect(() => {
        const model = modelRef.current;
        const { points } = layoutSea(memoriesRef.current);
        model.points = points;
        model.edges = addCohesion(buildEdges(points, { maxNeighbors: 4, maxEdges: 1200, minScore: 0.15 }), points, { maxNeighbors: 4 });
        const ids = new Set(points.map((point) => point.id));
        // 新点闪一下（首轮不闪）；新点的可见度从 0 开始，靠缓动淡入
        if (model.seenPoints === undefined) model.seenPoints = new Set();
        const firstLoad = model.seenPoints.size === 0;
        for (const point of points) {
          const isNew = !model.seenPoints.has(point.id);
          if (isNew && !firstLoad) {
            model.flash.set(point.id, performance.now());
            model.presence.set(point.id, 0);
          } else if (!model.presence.has(point.id)) {
            model.presence.set(point.id, 1);
          }
          model.seenPoints.add(point.id);
        }
        for (const id of [...model.seenPoints]) if (!ids.has(id)) model.seenPoints.delete(id);
        for (const id of [...model.presence.keys()]) if (!ids.has(id)) model.presence.delete(id);
        // 标签候选：按权重定序，只做一次；转相机不改变这一批，所以不会闪进闪出
        model.labelCandidates = pickLabelCandidates(points, labelBudget(points.length));
        model.labelAlpha = new Map();
        model.guides = buildGuides(points);
        // 自动取景：按点云包围半径重算相机距离，避免整片海缩在画面一角
        const viewport = model.size;
        if (viewport.width > 0 && points.length > 0) {
          model.camera.dist = fitDistance(points, viewport.width, viewport.height);
        }
      }, [dataKey]);

      // 尺寸与 DPR
      React.useEffect(() => {
        const wrap = wrapRef.current;
        if (wrap === null) return undefined;
        const apply = () => {
          const rect = wrap.getBoundingClientRect();
          // 画布像素上限：星图是柔光/曲线，1.5 倍足以，2 倍等于白白多烧 78% 填充率
          const dpr = Math.min(1.5, window.devicePixelRatio || 1);
          const size = modelRef.current.size;
          // 阈值放宽到 2px：滚动条出现/消失会让宽度抖 1px，反复重设 canvas 尺寸就是灾难级的卡顿
          if (Math.abs(rect.width - size.width) < 2 && Math.abs(rect.height - size.height) < 2) return;
          modelRef.current.size = { width: rect.width, height: rect.height, dpr };
          const canvas = canvasRef.current;
          if (canvas !== null) {
            canvas.width = Math.max(1, Math.round(rect.width * dpr));
            canvas.height = Math.max(1, Math.round(rect.height * dpr));
          }
          // 星尘位置在 resize 时算一次，帧内只改透明度
          modelRef.current.dust = Array.from({ length: 60 }, (_, index) => ({
            x: ((hash32(`bg${index}`) % 10000) / 10000) * rect.width,
            y: ((hash32(`bgy${index}`) % 10000) / 10000) * rect.height,
            phase: index,
          }));
          // 星云底跟着尺寸重建，导出成 CSS 背景图（合成器负责位移，帧内零成本）。
          // 半分辨率 + 延后到下一轮事件循环：toDataURL 是同步的，全尺寸编码一次几十毫秒，
          // 直接卡在打开面板那一帧上。星云本来就是糊的，半尺寸放大看不出来。
          const nebula = modelRef.current.nebula ?? document.createElement('canvas');
          modelRef.current.nebula = nebula;
          const nebulaWidth = Math.max(64, Math.round(rect.width / 2));
          const nebulaHeight = Math.max(64, Math.round(rect.height / 2));
          setTimeout(() => {
            try {
              paintNebula(nebula, nebulaWidth, nebulaHeight, 1, Object.values(KIND_COLOR));
              if (nebulaRef.current !== null) nebulaRef.current.style.backgroundImage = `url(${nebula.toDataURL('image/png')})`;
            } catch {
              /* 导出失败就不显示星云底，不影响主画布 */
            }
          }, 0);
          // 尺寸变化后重新取景（点云没变、视口变了）
          const model = modelRef.current;
          if (model.points.length > 0) {
            model.camera.dist = fitDistance(model.points, rect.width, rect.height);
          }
        };
        apply();
        const observer = new ResizeObserver(apply);
        observer.observe(wrap);
        return () => observer.disconnect();
      }, []);

      // 压力自检：临时塞 320 颗合成星
      React.useEffect(() => {
        if (!stressToken) return undefined;
        const synthetic = Array.from({ length: 320 }, (_, index) => ({
          id: `stress-${index}`,
          kind: KINDS[index % KINDS.length],
          kindLabel: KIND_LABEL[KINDS[index % KINDS.length]],
          text: '压力自检合成星',
          scene: index % 3 === 0 ? '自检簇' : undefined,
          createdAt: Date.now() - index * 1000,
          hits: index % 7,
          significance: (index % 5) + 1,
          status: 'active',
          supersedes: [],
        }));
        const { points } = layoutSea(synthetic);
        modelRef.current.stress = {
          points,
          edges: addCohesion(buildEdges(points, { maxNeighbors: 4, maxEdges: 1200, minScore: 0.15 }), points, { maxNeighbors: 4 }),
          until: performance.now() + 3000,
        };
      }, [stressToken]);

      // 主循环
      // 预热星点精灵：放到打开后的空闲里做，避免在首帧里现造几十张图造成长帧
      React.useEffect(() => {
        if (!open) return undefined;
        const timer = setTimeout(() => {
          for (const color of Object.values(KIND_COLOR)) {
            for (const step of [2, 3, 4, 5, 6, 8, 10, 12]) dotSprite(color, step);
          }
        }, 80);
        return () => clearTimeout(timer);
      }, [open]);

      React.useEffect(() => {
        const canvas = canvasRef.current;
        if (canvas === null) return undefined;
        const ctx = canvas.getContext('2d');
        if (ctx === null) return undefined;

        let raf = 0;
        let last = performance.now();
        let fps = 60;
        let windowStart = last;
        let windowMaxDelta = 0;
        let low = 0;
        let high = 0;
        let paused = false;

        const draw = (now) => {
          const model = modelRef.current;
          const { width, height, dpr } = model.size;
          if (width <= 0 || height <= 0) return;
          if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
            canvas.width = Math.round(width * dpr);
            canvas.height = Math.round(height * dpr);
          }
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, width, height);

          const quality = REDUCED_MOTION || model.animate === false ? 0 : model.quality;
          const at = scrubRef.current;
          const focus = focusRef.current;
          const dt = Math.min(64, Math.max(0, now - (model.lastNow === 0 ? now - 16 : model.lastNow)));
          model.lastNow = now;

          // 背景星尘：位置预计算，帧内只改 globalAlpha（不拼 rgba 字符串）
          ctx.fillStyle = '#96b4ff';
          const dustGain = (quality + 1) / 3;
          const dust = model.dust;
          if (dust !== null) {
            for (let index = 0; index < dust.length; index += 1) {
              const dot = dust[index];
              ctx.globalAlpha = (0.04 + (Math.sin(now / 2600 + dot.phase) + 1) * 0.05) * dustGain;
              ctx.fillRect(dot.x, dot.y, 1, 1);
            }
          }
          ctx.globalAlpha = 1;

          // 数据：正常 / 自检
          let points = model.points;
          let edges = model.edges;
          if (model.stress !== null && now < model.stress.until) {
            points = model.stress.points;
            edges = model.stress.edges;
          } else if (model.stress !== null) {
            const reported = { fps: Math.round(fps), count: model.stress.points.length, quality: model.quality };
            model.stress = null;
            if (typeof onStressReport === 'function') onStressReport(reported);
          }

          // 相机：自转与拖拽惯性都按真实 dt 推进（不是按帧数），掉帧也不会变速
          if (model.dragging === null) {
            const velocity = model.velocity;
            if (velocity !== null) {
              const decay = Math.exp(-dt / 220);
              model.camera.yaw += velocity.yaw * dt;
              model.camera.pitch = Math.max(-CAM_LIMITS.maxPitch, Math.min(CAM_LIMITS.maxPitch, model.camera.pitch + velocity.pitch * dt));
              velocity.yaw *= decay;
              velocity.pitch *= decay;
              if (Math.abs(velocity.yaw) + Math.abs(velocity.pitch) < 0.0002) model.velocity = null;
            } else if (model.autoOrbit && !REDUCED_MOTION) {
              // 自转与画质档位无关：档位只影响特效，不该让海停下来
              model.camera.yaw += 0.00006 * dt;
            }
          }
          const camera = clampCamera(model.camera);

          // 可见度缓动：时间轴拖动时星星是淡出/淡入，不是硬切
          const presence = model.presence;
          for (const point of points) {
            const target = at === null || (point.createdAt ?? 0) <= at ? 1 : 0;
            const current = presence.has(point.id) ? presence.get(point.id) : target;
            const next = easePresence(current, target, dt);
            if (next !== current) presence.set(point.id, next);
          }

          // 投影 + 深度排序
          const projected = projectAll(points, camera, width, height, now, quality > 0, at);
          model.projected = projected;
          const positions = model.positions;
          positions.clear();
          for (let index = 0; index < projected.length; index += 1) {
            const p = projected[index];
            positions.set(p.point.id, p);
          }

          // 空间导引 → 簇光晕 → 连线 → 簇名 → 点 → 标签（由后往前压）
          paintGuides(ctx, model.guides, camera, width, height);
          paintClusterHalos(ctx, projected, width, height, quality);

          // 线：分桶批量描边；丝带的控制点也在三维里，跟着相机一起转
          const projectWorld = (world) => projectPoint(world, camera, width, height, 0, false);
          paintEdges(ctx, edges, positions, { focus, onlyFocus: model.onlyFocus, presence, projectWorld });

          // 点
          paintPoints(ctx, projected, {
            focus,
            onlyFocus: model.onlyFocus,
            hovered: model.hovered,
            selected: model.selected,
            time: now,
            quality,
            presence,
            dpr,
          });

          // 标签：候选在数据变化时就排好（按权重），所以转动时不会换批
          if (model.showLabels) {
            paintLabels(ctx, model.labelCandidates, positions, width, height, {
              alphaMap: model.labelAlpha,
              focus,
              hovered: model.hovered,
              selected: model.selected,
              dt,
              presence,
            });
          }

          // 新点闪光
          if (model.flash.size > 0 && quality > 0) {
            for (const [id, started] of model.flash) {
              const progress = (now - started) / 900;
              if (progress >= 1) {
                model.flash.delete(id);
                continue;
              }
              const p = positions.get(id);
              if (p === undefined) continue;
              const [r, g, b] = p.point.rgb;
              const ease = 1 - progress;
              ctx.globalAlpha = ease * 0.8;
              ctx.strokeStyle = `rgba(${r},${g},${b},1)`;
              ctx.lineWidth = 1.2;
              ctx.beginPath();
              ctx.arc(p.x, p.y, 4 + progress * 26, 0, Math.PI * 2);
              ctx.stroke();
              ctx.globalAlpha = 1;
            }
          }

          // 悬停：跟手的一行字
          if (model.hovered !== null) {
            const p = positions.get(model.hovered);
            if (p !== undefined) {
              const text = p.point.short;
              ctx.font = '12px ui-sans-serif, system-ui, "Microsoft YaHei", sans-serif';
              const metrics = ctx.measureText(text);
              const boxX = Math.min(p.x + 12, width - metrics.width - 16);
              const boxY = p.y - 22;
              ctx.fillStyle = 'rgba(8,11,20,.9)';
              ctx.strokeStyle = 'rgba(120,160,255,.3)';
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.rect(boxX - 6, boxY - 12, metrics.width + 12, 20);
              ctx.fill();
              ctx.stroke();
              ctx.fillStyle = '#dfe8ff';
              ctx.fillText(text, boxX, boxY);
            }
          }
        };

        const tick = (now) => {
          const delta = now - last;
          last = now;
          if (delta > 0 && delta < 500) fps = fps * 0.9 + (1000 / delta) * 0.1;
          if (delta < 500 && delta > windowMaxDelta) windowMaxDelta = delta;
          if (now - windowStart >= 500) {
            const measured = fps;
            if (!REDUCED_MOTION) {
              if (measured < 45) {
                low += 1;
                high = 0;
                if (low >= 2 && modelRef.current.quality > 0) modelRef.current.quality -= 1;
              } else if (measured > 57) {
                high += 1;
                low = 0;
                if (high >= 6 && modelRef.current.quality < 2) modelRef.current.quality += 1;
              } else {
                low = 0;
                high = 0;
              }
            }
            if (badgeRef.current !== null) {
              const tier = REDUCED_MOTION ? '静态' : ['省电', '标准', '细腻'][modelRef.current.quality];
              // 平均帧率看不出「偶尔漏一帧」，这里把窗口内最长的那一帧也报出来
              const jitter = Math.round(windowMaxDelta);
              badgeRef.current.textContent = `${Math.round(measured)} fps · ${tier}${jitter > 28 && !REDUCED_MOTION ? ` · 抖 ${jitter}ms` : ''}`;
            }
            windowStart = now;
            windowMaxDelta = 0;
          }
          draw(now);
          raf = requestAnimationFrame(tick);
        };

        const start = () => {
          if (paused) return;
          last = performance.now();
          windowStart = last;
          raf = requestAnimationFrame(tick);
        };
        const stop = () => {
          cancelAnimationFrame(raf);
          raf = 0;
        };
        const onVisibility = () => {
          paused = document.hidden;
          if (paused) stop();
          else start();
        };
        start();
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
          stop();
          document.removeEventListener('visibilitychange', onVisibility);
        };
      }, [onStressReport]);

      const pick = React.useCallback((clientX, clientY) => {
        const canvas = canvasRef.current;
        if (canvas === null) return null;
        const rect = canvas.getBoundingClientRect();
        const mx = clientX - rect.left;
        const my = clientY - rect.top;
        let best = null;
        let bestDist = 16;
        for (const p of modelRef.current.projected) {
          if (p.ghost) continue;
          const dist = Math.hypot(p.x - mx, p.y - my);
          if (dist < bestDist) {
            bestDist = dist;
            best = p.point;
          }
        }
        return best;
      }, []);

      const onPointerDown = React.useCallback((event) => {
        const model = modelRef.current;
        if (event.button !== 0 && event.button !== 2) return;
        event.preventDefault();
        model.dragging = {
          x: event.clientX,
          y: event.clientY,
          mode: event.button === 2 ? 'pan' : 'orbit',
          yaw: model.camera.yaw,
          pitch: model.camera.pitch,
          panX: model.camera.panX,
          panY: model.camera.panY,
        };
        model.dragMoved = false;
        model.velocity = null;
        model.lastMoveAt = performance.now();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        if (wrapRef.current !== null) wrapRef.current.style.cursor = 'grabbing';
      }, []);

      const onPointerMove = React.useCallback(
        (event) => {
          const model = modelRef.current;
          if (model.dragging !== null) {
            const now = performance.now();
            const dx = event.clientX - model.dragging.x;
            const dy = event.clientY - model.dragging.y;
            if (Math.hypot(dx, dy) > 4) model.dragMoved = true;
            if (model.dragging.mode === 'orbit') {
              const nextYaw = model.dragging.yaw + dx * 0.006;
              const nextPitch = Math.max(-1.35, Math.min(1.35, model.dragging.pitch - dy * 0.006));
              // 记录瞬时角速度（rad/ms），松手后按它继续滑一段
              const elapsed = Math.max(1, now - model.lastMoveAt);
              model.velocity = {
                yaw: (nextYaw - model.camera.yaw) / elapsed,
                pitch: (nextPitch - model.camera.pitch) / elapsed,
              };
              model.camera.yaw = nextYaw;
              model.camera.pitch = nextPitch;
            } else {
              const k = model.camera.dist / FOCAL;
              model.camera.panX = model.dragging.panX - dx * k;
              model.camera.panY = model.dragging.panY - dy * k;
            }
            model.lastMoveAt = now;
            return;
          }
          const hit = pick(event.clientX, event.clientY);
          model.hovered = hit === null ? null : hit.id;
          if (wrapRef.current !== null) wrapRef.current.style.cursor = hit === null ? 'grab' : 'pointer';
        },
        [pick],
      );

      const endDrag = React.useCallback(() => {
        const model = modelRef.current;
        model.dragging = null;
        if (wrapRef.current !== null) wrapRef.current.style.cursor = 'grab';
      }, []);

      const onClick = React.useCallback(
        (event) => {
          const model = modelRef.current;
          if (model.dragMoved) {
            model.dragMoved = false;
            return;
          }
          const hit = pick(event.clientX, event.clientY);
          if (hit !== null && !hit.id.startsWith('stress-')) onSelect(hit.id);
        },
        [pick, onSelect],
      );

      const onWheel = React.useCallback((event) => {
        event.preventDefault();
        const model = modelRef.current;
        // 需要非被动监听才能 preventDefault：这里用 React 的 wheel 也能拦，但触控板惯性会连着来
        const factor = event.deltaY > 0 ? 1.08 : 0.92;
        model.camera.dist = Math.min(CAM_LIMITS.maxDist, Math.max(CAM_LIMITS.minDist, model.camera.dist * factor));
      }, []);

      React.useEffect(() => {
        const wrap = wrapRef.current;
        if (wrap === null) return undefined;
        const handler = (event) => onWheel(event);
        wrap.addEventListener('wheel', handler, { passive: false });
        return () => wrap.removeEventListener('wheel', handler);
      }, [onWheel]);

      const resetView = React.useCallback(() => {
        const model = modelRef.current;
        model.camera = { ...CAM_DEFAULT };
      }, []);
      const [viewState, setViewState] = React.useState({ auto: true, labels: true, onlyFocus: false });
      const toggleAuto = React.useCallback(() => {
        const model = modelRef.current;
        model.autoOrbit = !model.autoOrbit;
        setViewState((current) => ({ ...current, auto: model.autoOrbit }));
      }, []);
      const toggleLabels = React.useCallback(() => {
        const model = modelRef.current;
        model.showLabels = !model.showLabels;
        setViewState((current) => ({ ...current, labels: model.showLabels }));
      }, []);
      const toggleFocus = React.useCallback(() => {
        const model = modelRef.current;
        model.onlyFocus = !model.onlyFocus;
        setViewState((current) => ({ ...current, onlyFocus: model.onlyFocus }));
      }, []);

      const times = memories.map((memory) => memory.createdAt ?? 0);
      const minT = times.length > 0 ? Math.min(...times) : Date.now();
      const maxT = times.length > 0 ? Math.max(...times) : Date.now() + 1000;
      const span = Math.max(1000, maxT - minT);
      const scrubValue = scrubAt == null ? maxT : Math.min(maxT, Math.max(minT, scrubAt));
      const visibleCount = scrubAt == null ? memories.length : memories.filter((memory) => (memory.createdAt ?? 0) <= scrubAt).length;

      return h(
        'div',
        { className: 'ml-stage' },
        h(
          'div',
          { className: 'ml-canvas-wrap', ref: wrapRef },
          h('div', { className: 'ml-nebula', ref: nebulaRef, 'aria-hidden': 'true' }),
          h('canvas', {
            className: 'ml-canvas',
            ref: canvasRef,
            onPointerDown,
            onPointerMove,
            onPointerUp: endDrag,
            onPointerCancel: endDrag,
            onPointerLeave: () => {
              endDrag();
              modelRef.current.hovered = null;
            },
            onClick,
            onContextMenu: (event) => event.preventDefault(),
            role: 'img',
            'aria-label': `记忆海，共 ${memories.length} 颗星`,
          }),
          memories.length === 0
            ? h(
                'div',
                { className: 'ml-void' },
                h(
                  'div',
                  { className: 'ml-void-card' },
                  h('div', { className: 'ml-void-ring' }, h('i', null)),
                  h('div', { className: 'ml-void-title' }, '海水还是空的'),
                  h('div', { className: 'ml-void-text' }, '记忆会在对话里自己长出来：说一句「记住…」，或者让我判断这件事值得留下来。'),
                  h(
                    'div',
                    { className: 'ml-void-hints' },
                    h('span', {}, '记住：我对花生过敏'),
                    h('span', {}, '我家猫叫年糕'),
                    h('span', {}, '以后别在十点后发消息'),
                  ),
                ),
              )
            : null,
          h(
            'div',
            { className: 'ml-viewtools' },
            h('button', { type: 'button', 'data-on': viewState.auto ? 'true' : 'false', onClick: toggleAuto }, t('自转')),
            h('button', { type: 'button', 'data-on': viewState.labels ? 'true' : 'false', onClick: toggleLabels }, t('标签')),
            h('button', { type: 'button', 'data-on': viewState.onlyFocus ? 'true' : 'false', onClick: toggleFocus, title: '只连亮本轮召回命中的点' }, t('焦点')),
            h('button', { type: 'button', onClick: resetView }, t('复位')),
          ),
          h('span', { className: 'ml-stage-tag' }, '左键拖动旋转　滚轮推拉　右键平移　<b>点一颗星看原文</b>'),
          h('span', { className: 'ml-fps', ref: badgeRef }, '— fps'),
        ),
        h(
          'div',
          { className: 'ml-scrub' },
          h('span', { className: 'ml-scrub-label' }, '回放'),
          h('input', {
            type: 'range',
            min: minT,
            max: maxT,
            step: Math.max(1000, Math.floor(span / 600)),
            value: scrubValue,
            'aria-label': '时间回放：拖到某个时刻，只看那时已经存在的星',
            'aria-valuetext': scrubAt == null ? '全部' : `${clockText(scrubAt)}，${visibleCount} 条`,
            disabled: memories.length === 0,
            onChange: (event) => {
              const next = Number(event.target.value);
              if (!Number.isFinite(next)) return;
              onScrub(next >= maxT ? null : next);
            },
            onDoubleClick: () => onScrub(null),
          }),
          h(
            'span',
            { className: 'ml-scrub-label' },
            scrubAt == null ? `全部 ${memories.length} 颗` : h('b', {}, `${visibleCount}/${memories.length} 颗 ${clockText(scrubAt)}`),
          ),
          scrubAt == null ? null : h('button', { type: 'button', className: 'ml-btn', onClick: () => onScrub(null) }, t('现在')),
        ),
      );
    }
    //#endregion

    //#region 侧栏
    /** 状态词的中文说法：面板里不直接把 ok/empty 当给人看的标签。 */
    const STATUS_TEXT = { ok: t('正常'), empty: t('空'), degraded: t('降级'), disabled: t('关闭'), unknown: t('未跑') };

    function Lamps({ layers }) {
      const [open, setOpen] = React.useState(false);
      const list = Array.isArray(layers) ? layers : [];
      const ok = list.filter((layer) => layer.status === 'ok').length;
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h(
          'div',
          { className: 'ml-lamps', role: 'list' },
          ...list.map((layer) =>
            h('span', {
              key: layer.key,
              className: 'ml-lamp',
              'data-s': layer.status,
              role: 'listitem',
              title: `${layer.name}：${STATUS_TEXT[layer.status] ?? layer.status} — ${layer.detail}`,
            }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'ml-health-toggle',
              'aria-expanded': open,
              title: '六层状况：写入 / 摘要 / 召回 / 约束 / 槽位 / 经历',
              onClick: () => setOpen((current) => !current),
            },
            `${open ? '收起' : '正常'} ${ok}/${list.length}`,
            h('span', { 'aria-hidden': 'true' }, open ? '▾' : '▴'),
          ),
        ),
        open
          ? h(
              'div',
              { className: 'ml-health', role: 'list' },
              ...list.map((layer) =>
                h(
                  'div',
                  { className: 'ml-health-row', key: layer.key, role: 'listitem', title: layer.detail },
                  h('span', { className: 'ml-lamp', 'data-s': layer.status, 'aria-hidden': 'true' }),
                  h('span', { className: 'ml-health-name' }, layer.name),
                  h('span', { className: 'ml-health-word', 'data-s': layer.status }, STATUS_TEXT[layer.status] ?? layer.status),
                  h('span', { className: 'ml-health-value' }, String(layer.value ?? '')),
                ),
              ),
            )
          : null,
      );
    }

    function MemoryRow({ memory, ordered, selected, onSelect }) {
      const stamp = stampOf(memory);
      const rgb = KIND_COLOR[memory.kind] ?? KIND_COLOR.slot;
      return h(
        'button',
        {
          type: 'button',
          className: 'ml-row',
          'data-selected': selected ? 'true' : 'false',
          'aria-expanded': selected,
          title: selected ? '再点一次收起详情' : '点开看详情',
          onClick: () => onSelect(memory.id),
        },
        h(
          'div',
          { className: 'ml-row-top' },
          h('span', { className: 'ml-dot', style: { background: memory.status === 'archived' ? 'transparent' : `rgb(${rgb.join(',')})`, border: `1px solid rgb(${rgb.join(',')})` } }),
          h('span', { className: 'ml-kind' }, memory.kindLabel ?? KIND_LABEL[memory.kind]),
          stamp.length > 0 ? h('span', { className: 'ml-kind', style: { color: '#e9c07a' } }, `· ${stamp}`) : null,
          h('span', { className: 'ml-serial' }, serialOf(memory, ordered)),
        ),
        h('div', { className: 'ml-row-text' }, memory.text),
        h('div', { className: 'ml-meta' }, h('span', {}, memory.age), h('span', {}, `命中${memory.hits}`), h('span', {}, `权重${memory.weight}`), memory.eventDate ? h('span', {}, memory.eventDate) : null),
      );
    }

    function Detail({ memory, ordered, halfLifeDays, onAction, busy }) {
      const scale = 1 + 0.35 * Math.log1p(Math.max(0, memory.hits ?? 0));
      const stamp = stampOf(memory);
      const rgb = KIND_COLOR[memory.kind] ?? KIND_COLOR.slot;
      const width = 250;
      const height = 40;
      const path = Array.from({ length: 25 }, (_, index) => {
        const day = (30 * index) / 24;
        const value = scale * 0.5 ** (day / Math.max(1, halfLifeDays));
        const x = (width * index) / 24;
        const y = height - (height - 4) * (value / Math.max(scale, 1));
        return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
      return h(
        'div',
        { className: 'ml-detail' },
        h(
          'div',
          { className: 'ml-meta', style: { marginTop: 0 } },
          h('span', {}, serialOf(memory, ordered)),
          h('span', {}, memory.kindLabel ?? KIND_LABEL[memory.kind]),
          stamp.length > 0 ? h('span', { style: { color: '#e9c07a' } }, stamp) : null,
        ),
        h('div', { className: 'ml-quote' }, memory.text),
        memory.kind === 'slot'
          ? h(
              'dl',
              { className: 'ml-kv' },
              h('dt', {}, '实体'), h('dd', {}, memory.entity ?? '-'),
              h('dt', {}, '属性'), h('dd', {}, memory.attr ?? '-'),
            )
          : null,
        h(
          'dl',
          { className: 'ml-kv' },
          h('dt', {}, '写入'), h('dd', {}, `${clockText(memory.createdAt)}（${memory.age}）`),
          memory.eventDate ? h('dt', {}, '事件日') : null, memory.eventDate ? h('dd', {}, memory.eventDate) : null,
          memory.scene ? h('dt', {}, '场景') : null, memory.scene ? h('dd', {}, memory.scene) : null,
          memory.significance != null ? h('dt', {}, '重要度') : null, memory.significance != null ? h('dd', {}, String(memory.significance)) : null,
          h('dt', {}, '命中'), h('dd', {}, `${memory.hits} 次`),
          h('dt', {}, '来源'), h('dd', {}, memory.source === 'explicit' ? '用户原话' : '模型写入'),
          memory.supersedes?.length ? h('dt', {}, '作废了') : null,
          memory.supersedes?.length ? h('dd', {}, `${memory.supersedes.length} 条`) : null,
          memory.archivedReason ? h('dt', {}, '归档') : null, memory.archivedReason ? h('dd', {}, memory.archivedReason) : null,
        ),
        h(
          'svg',
          { viewBox: `0 0 ${width} ${height}`, width: '100%', height: 40, role: 'img', 'aria-label': '权重衰减' },
          h('path', { d: path, fill: 'none', stroke: `rgb(${rgb.join(',')})`, strokeWidth: 1.3 }),
        ),
        h(
          'div',
          { className: 'ml-actions' },
          // 状态类不给归档/删除：它的生命周期是"被新值覆盖"，不是一个可删的条目
          memory.kind === 'slot' ? null : memory.status === 'active' && memory.kind === 'constraint' && memory.relaxedAt == null
            ? h('button', { type: 'button', className: 'ml-btn', disabled: busy, onClick: () => onAction('relax', memory.id) }, '解除')
            : null,
          memory.kind === 'slot'
            ? null
            : memory.status === 'active'
            ? h('button', { type: 'button', className: 'ml-btn', disabled: busy, onClick: () => onAction('forget', memory.id, {}) }, '归档')
            : h(
                'button',
                {
                  type: 'button',
                  className: 'ml-btn',
                  disabled: busy,
                  title: '从归档恢复为活跃记忆（摘要归纳错了就用这个）',
                  onClick: () => onAction('restore', memory.id, {}),
                },
                '恢复',
              ),
          memory.kind === 'slot' ? null : h('button', { type: 'button', className: 'ml-btn', 'data-danger': 'true', disabled: busy, onClick: () => onAction('forget', memory.id, { hard: true }) }, '彻底删除'),
        ),
      );
    }

    function RecallPane({ recall, recallCount, onQuery, results, busy }) {
      const [text, setText] = React.useState('');
      const hits = (recall?.hits ?? []).filter((hit) => typeof hit.score === 'number');
      const scored = [...hits].sort((left, right) => right.score - left.score);
      const maxScore = Math.max(0.001, ...scored.map((hit) => hit.score));
      return h(
        React.Fragment,
        null,
        h(
          'div',
          null,
          h('div', { className: 'ml-meta', style: { marginTop: 0 } }, h('span', {}, `召回 ${recallCount} 次`), recall ? h('span', {}, `阈值 ${recall.threshold}`) : null),
          recall === null || recall === undefined
            ? h('div', { className: 'ml-empty', style: { marginTop: 8 } }, t('还没有跑过召回'))
            : h(
                React.Fragment,
                null,
                ...(recall.blocks ?? []).map((block) =>
                  h('div', { className: 'ml-block', key: block.name, style: { marginTop: 8 } }, h('div', { className: 'ml-block-title' }, block.title), h('div', { className: 'ml-block-text' }, block.text)),
                ),
                scored.length === 0
                  ? h('div', { className: 'ml-empty', style: { marginTop: 8 } }, '没有打分的命中')
                  : h(
                      'div',
                      { style: { marginTop: 8 } },
                      ...scored.map((hit) =>
                        h(
                          'div',
                          { className: 'ml-line-row', key: `${hit.block}-${hit.id}` },
                          h('span', { className: 'ml-threadline', style: { width: `${Math.max(8, (hit.score / maxScore) * 46)}px`, background: hit.weak ? '#39445e' : `rgb(${(KIND_COLOR[hit.kind] ?? KIND_COLOR.slot).join(',')})` } }),
                          h('span', { className: 'ml-line-text', title: hit.text }, hit.text),
                          h('span', { className: 'ml-score' }, hit.score.toFixed(2)),
                        ),
                      ),
                    ),
              ),
        ),
        h(
          'div',
          { style: { marginTop: 10 } },
          h('input', {
            className: 'ml-input',
            placeholder: '试查：用户住在哪',
            value: text,
            onChange: (event) => setText(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && text.trim().length > 0) onQuery(text.trim());
            },
          }),
          h(
            'div',
            { className: 'ml-actions', style: { marginTop: 6 } },
            h('button', { type: 'button', className: 'ml-btn', disabled: busy || text.trim().length === 0, onClick: () => onQuery(text.trim()) }, busy ? '检索中…' : '检索'),
          ),
          results === null
            ? null
            : results.results.length === 0
              ? h('div', { className: 'ml-empty', style: { marginTop: 8 } }, `没有命中（阈值 ${results.threshold}）`)
              : h(
                  'div',
                  { style: { marginTop: 8 } },
                  ...results.results.map((row) =>
                    h(
                      'div',
                      { className: 'ml-line-row', key: row.id },
                      h('span', { className: 'ml-threadline', style: { width: `${Math.max(8, (row.score / Math.max(0.001, results.results[0].score)) * 46)}px`, background: `rgb(${(KIND_COLOR[row.kind] ?? KIND_COLOR.slot).join(',')})` } }),
                      h('span', { className: 'ml-line-text', title: row.text }, row.text),
                      h('span', { className: 'ml-score' }, row.score.toFixed(2)),
                    ),
                  ),
                ),
        ),
      );
    }

    function AuditPane({ events, meta }) {
      const rows = events ?? [];
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'ml-meta', style: { marginTop: 0 } },
          h('span', {}, `写入${meta?.writeCount ?? 0}`),
          h('span', {}, `去重${meta?.dedupeCount ?? 0}`),
          h('span', {}, `归档${meta?.archiveCount ?? 0}`),
          h('span', {}, `解除${meta?.relaxCount ?? 0}`),
        ),
        rows.length === 0
          ? h('div', { className: 'ml-empty', style: { marginTop: 8 } }, '还没有埋点')
          : h(
              'div',
              { style: { marginTop: 8 } },
              ...rows.map((event, index) =>
                h(
                  'div',
                  { className: 'ml-line-row', key: `${event.ts}-${index}` },
                  h('span', { className: 'ml-score' }, clockText(event.ts)),
                  h('span', { className: 'ml-line-text', title: JSON.stringify(event.payload) }, event.kind),
                ),
              ),
            ),
      );
    }
    //#endregion

    /** 侧栏导航栏里的图标：和「插件 / 自动化任务」同一列，宽栏时宿主还会显示文字 */
    function MemoryLoomIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 16;
      const active = props?.active === true;
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true', fill: 'none' },
        h('circle', { cx: 7, cy: 16, r: 2, fill: 'currentColor', opacity: active ? 1 : 0.7 }),
        h('circle', { cx: 12.5, cy: 7.5, r: 2.4, fill: 'currentColor', opacity: active ? 1 : 0.9 }),
        h('circle', { cx: 18, cy: 15, r: 1.7, fill: 'currentColor', opacity: active ? 1 : 0.65 }),
        h('path', {
          d: 'M7 16 L12.5 7.5 L18 15',
          stroke: 'currentColor',
          strokeWidth: 0.9,
          strokeOpacity: active ? 0.9 : 0.4,
          strokeDasharray: '2 3',
        }),
      );
    }

    //#region 主面板
    const MODES = [
      ['list', t('记忆库')],
      ['summary', t('摘要')],
      ['recall', t('召回')],
      ['audit', t('流水')],
      ['tune', t('设置')],
    ];
    const LIST_LIMIT = 120;

    /**
     * 摘要面板：第四层过去生成出来却从没被看见过（只有注入在用）。
     * 这里把归纳结果、覆盖了多少条、以及原文指向都摆出来，才好判断"压得对不对"。
     */
    function SummaryPane({ summaries, archivedBySummary, onRestoreSummary, onTryRun, tryRun }) {
      if (!Array.isArray(summaries) || summaries.length === 0) {
        return h('div', { className: 'ml-empty' }, '还没有摘要：活跃条数到压缩线后，同主题冗余会被自动归纳到这里。');
      }
      return h(
        React.Fragment,
        null,
        tryRun?.text ? h('div', { className: 'ml-summary' }, h('div', { className: 'ml-summary-head' }, h('b', {}, '试跑结果'), h('span', { className: 'ml-gen', 'data-llm': 'true' }, '模型')), h('div', { className: 'ml-summary-text' }, tryRun.text)) : null,
        tryRun?.error ? h('div', { className: 'ml-meta', style: { color: '#f08a72' } }, '试跑失败：' + tryRun.error) : null,
        ...summaries
          .slice()
          .reverse()
          .map((summary) =>
            h(
              'div',
              { key: summary.id, className: 'ml-summary' },
              h(
                'div',
                { className: 'ml-summary-head' },
                h('b', {}, summary.topic ?? '主题'),
                h('span', { className: 'ml-meta' }, `覆盖 ${summary.memberCount ?? summary.memberIds?.length ?? 0} 条`),
                h('span', { className: 'ml-score' }, dateLabel(summary.createdAt)),
                h(
                  'span',
                  {
                    className: 'ml-gen',
                    'data-llm': summary.generator === 'llm' ? 'true' : 'false',
                    title: summary.llmError ? `模型归纳失败：${summary.llmError}` : '',
                  },
                  summary.generator === 'llm' ? '模型' : '抽取',
                ),
              ),
              h('div', { className: 'ml-summary-text' }, summary.text),
              h(
                'div',
                { className: 'ml-tools' },
                archivedBySummary.get(summary.id) === undefined
                  ? null
                  : h('button', {
                      type: 'button',
                      className: 'ml-btn',
                      onClick: () => archivedBySummary.get(summary.id)(),
                    }, `查看原文 ${summary.memberCount ?? ''}`),
                summary.generator === 'llm' || onTryRun === undefined
                  ? null
                  : h('button', {
                      type: 'button',
                      className: 'ml-btn',
                      title: '用模型重写这一条，看看质量（不改库）',
                      onClick: () => onTryRun(summary.id),
                    }, '试跑'),
                onRestoreSummary === undefined
                  ? null
                  : h('button', {
                      type: 'button',
                      className: 'ml-btn',
                      title: '归纳错了就整组回退：恢复成员并删除这条摘要',
                      onClick: () => onRestoreSummary(summary.id),
                    }, '撤销归纳'),
              ),
            ),
          ),
      );
    }

    /**
     * 设置面板：把"调手感"的旋钮摆到界面上。
     * 只显示宿主登记过的可调项（TUNABLE），越界由服务端夹取 —— 面板不做权限外的修改。
     */
    function TunePane({ tunables, tunableText, summarize, busy, onTune }) {
      const entries = Object.entries(tunables ?? {});
      if (entries.length === 0 && Object.keys(tunableText ?? {}).length === 0) return h('div', { className: 'ml-empty' }, '没有可调参数。');
      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'ml-engine', 'data-on': summarize?.enabled === true ? 'true' : 'false' },
          h('b', {}, '摘要引擎'),
          h('span', {}, summarize?.engine ?? '（未知）'),
          summarize?.provider ? h('span', { className: 'ml-score' }, `${summarize.provider} · ${summarize.model}`) : null,
          summarize?.active === true ? h('span', { className: 'ml-score' }, '归纳中…') : null,
          (summarize?.pending ?? 0) > 0 ? h('span', { className: 'ml-score' }, `排队 ${summarize.pending}`) : null,
        ),
        h('div', { className: 'ml-meta', style: { marginTop: 0 } }, '改完立即生效，并写进库（重启后保留）。'),
        ...Object.entries(tunableText ?? {}).map(([key, spec]) =>
          h(
            'label',
            { key, className: 'ml-tune' },
            h('span', { className: 'ml-tune-name' }, spec.label ?? key),
            h('input', {
              className: 'ml-input',
              type: 'text',
              placeholder: '留空=自动发现',
              defaultValue: String(spec.value ?? ''),
              disabled: busy,
              style: { gridColumn: 'span 2', textAlign: 'left' },
              onKeyDown: (event) => {
                if (event.key === 'Enter') onTune(key, event.currentTarget.value);
              },
              onBlur: (event) => {
                const next = event.currentTarget.value.trim();
                if (next !== String(spec.value ?? '')) onTune(key, next);
              },
            }),
          ),
        ),
        ...entries.map(([key, spec]) =>
          h(
            'label',
            { key, className: 'ml-tune' },
            h('span', { className: 'ml-tune-name' }, spec.label ?? key),
            h('input', {
              className: 'ml-input',
              type: 'number',
              min: spec.min,
              max: spec.max,
              step: spec.step ?? 1,
              defaultValue: String(spec.value),
              disabled: busy,
              onKeyDown: (event) => {
                if (event.key === 'Enter') onTune(key, event.currentTarget.value);
              },
              onBlur: (event) => {
                const next = Number.parseFloat(event.currentTarget.value);
                if (Number.isFinite(next) && next !== Number(spec.value)) onTune(key, next);
              },
            }),
            h('span', { className: 'ml-tune-range' }, `${spec.min}–${spec.max}`),
          ),
        ),
      );
    }

    /** 短日期：面板里只需要能分辨早晚。 */
    function dateLabel(epochMs) {
      if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return '';
      const date = new Date(epochMs);
      const pad = (value) => String(value).padStart(2, '0');
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    function MemorySeaPage(props) {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [mode, setMode] = React.useState('list');
      const [selectedId, setSelectedId] = React.useState(null);
      /** 只看某条摘要的原文（从摘要页跳过来） */
      const [summaryFocus, setSummaryFocus] = React.useState(null);
      const [kindFilter, setKindFilter] = React.useState('all');
      /** 默认只看活跃：归档（被归纳/手动归档）不该混在日常视图里 */
      const [statusFilter, setStatusFilter] = React.useState('active');
      const [textFilter, setTextFilter] = React.useState('');
      const [results, setResults] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [stressToken, setStressToken] = React.useState(0);
      const [stressReport, setStressReport] = React.useState(null);
      const [scrubAt, setScrubAt] = React.useState(null);
      /** 摘要试跑结果：不写库，只用来看模型产出质量 */
      const [tryRun, setTryRun] = React.useState(null);
      /** 待确认的导入：选完文件先亮一次「确认覆盖」，按了才真写 */
      const [pendingImport, setPendingImport] = React.useState(null);
      /** 待确认的过程记录整理：先预览条数，再确认归档 */
      const [pendingTidy, setPendingTidy] = React.useState(null);
      const importFileRef = React.useRef(null);
      /** 最近一次「回对话」尝试的结果：成功了也显示，方便确认链路通不通 */
      const [closeNote, setCloseNote] = React.useState('');
      const [animate, setAnimate] = React.useState(() => {
        try {
          return window.localStorage.getItem('memory-loom:animate') !== '0';
        } catch {
          return true;
        }
      });
      const toggleAnimate = React.useCallback(() => {
        setAnimate((current) => {
          const next = !current;
          try {
            window.localStorage.setItem('memory-loom:animate', next ? '1' : '0');
          } catch {
            /* 隐私模式写不了就不写 */
          }
          return next;
        });
      }, []);
      const panelRef = React.useRef(null);
      /** 行节点：从星图点选时把它滚进视野，不然选中了也看不见 */
      const rowRefs = React.useRef(new Map());
      /** 上一次渲染用的数据签名：内容没变就不 setState，避免每 5 秒白掉一帧。 */
      const stateSignatureRef = React.useRef('');

      // 同一个目标再点一次就收起：星点和列表行走同一个入口，行为保持一致
      const selectFromChart = React.useCallback((id) => {
        setSelectedId((current) => nextSelection(current, id));
        setMode('list');
      }, []);


      const refresh = React.useCallback(async (signal) => {
        try {
          const next = await loadState(signal);
          // 内容没变就不重渲染：每 5 秒一次的全量 setState 本身就会制造一次掉帧
          const signature = [
            next?.memories?.length ?? 0,
            next?.counts?.active ?? 0,
            next?.counts?.archived ?? 0,
            next?.recallCount ?? 0,
            (next?.health?.layers ?? []).map((layer) => layer.status).join(''),
            (next?.memories ?? []).reduce((sum, memory) => sum + (memory.hits ?? 0), 0),
          ].join('|');
          if (signature === stateSignatureRef.current) {
            setError(null);
            return;
          }
          stateSignatureRef.current = signature;
          setState(next);
          setError(null);
        } catch (failure) {
          if (failure?.name === 'AbortError') return;
          setError(failure instanceof Error ? failure.message : String(failure));
        }
      }, []);

      // 页面挂载即开始工作：不再有「打开/关闭」这套状态
      React.useEffect(() => {
        const controller = new AbortController();
        refresh(controller.signal);
        const timer = setInterval(() => refresh(controller.signal), 5000);
        return () => {
          controller.abort();
          clearInterval(timer);
        };
      }, [refresh]);

      React.useEffect(() => {
        const timer = setTimeout(() => panelRef.current?.focus(), 0);
        return () => clearTimeout(timer);
      }, []);

      // 从星图点选 / 换了一条：把那一行（连同就地展开的详情）滚进视野
      React.useEffect(() => {
        if (selectedId === null || mode !== 'list') return;
        const node = rowRefs.current.get(selectedId);
        if (node !== undefined && typeof node.scrollIntoView === 'function') {
          node.scrollIntoView({ block: 'nearest' });
        }
      }, [selectedId, mode]);

      const act = React.useCallback(
        async (kind, id, body) => {
          setBusy(true);
          try {
            if (kind === 'relax') await postAction('relax', { id });
            else if (kind === 'restore') await postAction('restore', { id, ...body });
            else await postAction('forget', { id, ...body });
            await refresh();
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
          } finally {
            setBusy(false);
          }
        },
        [refresh],
      );

      const onTryRun = React.useCallback(async (summaryId) => {
        setBusy(true);
        setTryRun(null);
        try {
          const response = await fetch('/memory-loom/api/summarize', {
            method: 'POST',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ summaryId }),
          });
          const body = await response.json();
          setTryRun(body.ok === true ? { text: body.text } : { error: body.error ?? '未知错误' });
        } catch (failure) {
          setTryRun({ error: failure instanceof Error ? failure.message : String(failure) });
        } finally {
          setBusy(false);
        }
      }, []);

      const onTune = React.useCallback(
        async (key, value) => {
          setBusy(true);
          try {
            // 数值项夹取交给服务端；文本项原样提交（空串表示回落到自动发现）
            const raw = typeof value === 'number' ? value : String(value ?? '').trim();
            const field = typeof value === 'number' ? Number.parseFloat(String(value)) : raw;
            if (typeof field === 'number' && !Number.isFinite(field)) return;
            await postAction('tune', { patch: { [key]: field } });
            await refresh();
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
          } finally {
            setBusy(false);
          }
        },
        [refresh],
      );

      const runQuery = React.useCallback(async (query) => {
        setBusy(true);
        try {
          const response = await fetch('/memory-loom/api/search', {
            method: 'POST',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query, limit: 12 }),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          setResults(await response.json());
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      }, []);

      const onStressReport = React.useCallback((report) => setStressReport(report), []);

      /**
       * 失败信息的人话版。
       *
       * 404 的真实原因基本只有一个：**宿主还是旧代码** —— 页面刷新只换了 client bundle，
       * 插件的路由要重启 DSH 才注册。不解释这一层，用户只会看到「HTTP 404」，以为插件坏了。
       */
      const describeFailure = React.useCallback(
        (failure) => {
          const message = failure instanceof Error ? failure.message : String(failure);
          const server = state?.serverVersion;
          if (!message.includes('404')) return message;
          if (typeof server === 'string' && server.length > 0) {
            return server === CLIENT_VERSION
              ? `宿主 v${server} 没有这个接口（插件可能没激活）`
              : `宿主 v${server} 比面板 v${CLIENT_VERSION} 旧：重启 DSH 后这个按钮才会生效`;
          }
          return '宿主没有这个接口：重启 DSH 后再试';
        },
        [state?.serverVersion],
      );

      /** 导出整库：拿服务端那份 JSON 直接下载，不走另一套序列化，保证与磁盘同形。 */
      const onExport = React.useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
          const response = await fetch('/memory-loom/api/export', { cache: 'no-store' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const text = await response.text();
          const stamp = new Date().toISOString().slice(0, 10);
          const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = `memory-loom-store-${stamp}.json`;
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          URL.revokeObjectURL(url);
        } catch (failure) {
          setError(describeFailure(failure));
        } finally {
          setBusy(false);
        }
      }, [describeFailure]);

      /** 选中文件：先读进内存等确认（导入是整体替换，不能点一下就干）。 */
      const onImportFile = React.useCallback(async (event) => {
        const file = event?.target?.files?.[0];
        if (event?.target !== undefined) event.target.value = '';
        if (file === undefined || file === null) return;
        try {
          const text = await file.text();
          setPendingImport({ name: file.name ?? '记忆库.json', size: text.length, text });
          setError(null);
        } catch (failure) {
          setError(describeFailure(failure));
        }
      }, [describeFailure]);

      const confirmImport = React.useCallback(async () => {
        if (pendingImport === null) return;
        setBusy(true);
        try {
          const result = await postAction('import', { json: pendingImport.text });
          if (result?.ok !== true) throw new Error(result?.error ?? '导入失败');
          setPendingImport(null);
          await refresh();
        } catch (failure) {
          setError(describeFailure(failure));
        } finally {
          setBusy(false);
        }
      }, [pendingImport, refresh, describeFailure]);

      /** 过程记录整理：先只预览（不改库），有候选才亮确认按钮。 */
      const onTidyPreview = React.useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
          const result = await postAction('tidy', { apply: false });
          if (result?.count === 0) {
            setPendingTidy(null);
            setCloseNote('没有需要整理的过程记录');
          } else {
            setPendingTidy({ count: result.count, preview: result.preview ?? [] });
          }
        } catch (failure) {
          setError(describeFailure(failure));
        } finally {
          setBusy(false);
        }
      }, [describeFailure]);

      const confirmTidy = React.useCallback(async () => {
        setBusy(true);
        try {
          const result = await postAction('tidy', { apply: true });
          if (result?.ok !== true) throw new Error(result?.error ?? '整理失败');
          setPendingTidy(null);
          setCloseNote(`已归档 ${result.archived ?? result.count} 条过程记录（可单条恢复）`);
          await refresh();
        } catch (failure) {
          setError(describeFailure(failure));
        } finally {
          setBusy(false);
        }
      }, [refresh, describeFailure]);

      const counts = state?.counts ?? {};
      const active = counts.active ?? 0;
      const memories = state?.memories ?? [];
      // 宿主版本与面板版本不一致 = 插件路由还是旧的（页面刷新不会重挂服务端）
      const staleServer = typeof state?.serverVersion === 'string' && state.serverVersion !== CLIENT_VERSION;
      // 数据签名：只有记忆本身变了才重建三维布局与连线（轮询每 5s 一次，别每次都重排）
      const dataKey = React.useMemo(() => {
        const list = state?.memories ?? [];
        let hits = 0;
        let last = 0;
        let archived = 0;
        for (const memory of list) {
          hits += memory.hits ?? 0;
          last = Math.max(last, memory.createdAt ?? 0);
          if (memory.status === 'archived') archived += 1;
        }
        return `${list.length}:${hits}:${last}:${archived}`;
      }, [state]);
      const ordered = React.useMemo(
        () => [...memories].sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0)),
        [dataKey],
      );
      const focusIds = React.useMemo(() => {
        const hits = state?.recall?.hits ?? [];
        return new Set(hits.filter((hit) => typeof hit.id === 'string').map((hit) => hit.id));
      }, [state?.recall]);
      const filtered = memories.filter((memory) => {
        if (statusFilter === 'active' && memory.status !== 'active') return false;
        if (statusFilter === 'archived' && memory.status === 'active') return false;
        if (summaryFocus !== null && memory.summarizedBy !== summaryFocus) return false;
        if (kindFilter !== 'all' && memory.kind !== kindFilter) return false;
        if (textFilter.trim().length > 0 && !memory.text.includes(textFilter.trim())) return false;
        return true;
      });

      /** 摘要 → 跳到记忆库只看这组原文 */
      const archivedBySummary = new Map(
        (state?.summaries ?? []).map((summary) => [
          summary.id,
          () => {
            setSummaryFocus(summary.id);
            setMode('list');
          },
        ]),
      );

      const railBody =
        mode === 'tune'
          ? h(TunePane, { tunables: state?.tunables, tunableText: state?.tunableText, summarize: state?.summarize, busy, onTune })
          : mode === 'summary'
          ? h(SummaryPane, { summaries: state?.summaries, archivedBySummary, onRestoreSummary: (summaryId) => act('restore', '', { summaryId }), onTryRun, tryRun })
          : mode === 'recall'
          ? h(RecallPane, { recall: state?.recall ?? null, recallCount: state?.recallCount ?? 0, onQuery: runQuery, results, busy })
          : mode === 'audit'
            ? h(AuditPane, { events: state?.events, meta: state?.meta })
            : h(
                React.Fragment,
                null,
                h('input', {
                  className: 'ml-input',
                  placeholder: t('按文本过滤'),
                  value: textFilter,
                  onChange: (event) => setTextFilter(event.target.value),
                }),
                summaryFocus === null
                  ? null
                  : h(
                      'div',
                      { className: 'ml-chips' },
                      h('button', {
                        type: 'button',
                        className: 'ml-chip',
                        'data-active': 'true',
                        onClick: () => setSummaryFocus(null),
                      }, `只看这组原文 ×`),
                    ),
                h(
                  'div',
                  { className: 'ml-chips' },
                  ...['active', 'archived', 'all'].map((key) => {
                    const label = key === 'active' ? t('活跃') : key === 'archived' ? t('已归档') : t('全部');
                    const count = memories.filter((memory) =>
                      key === 'all' ? true : key === 'active' ? memory.status === 'active' : memory.status !== 'active',
                    ).length;
                    return h(
                      'button',
                      {
                        type: 'button',
                        key,
                        className: 'ml-chip',
                        'data-active': statusFilter === key ? 'true' : 'false',
                        onClick: () => setStatusFilter(key),
                      },
                      `${label} ${count}`,
                    );
                  }),
                ),
                h(
                  'div',
                  { className: 'ml-chips' },
                  h('button', { type: 'button', className: 'ml-chip', 'data-active': kindFilter === 'all' ? 'true' : 'false', onClick: () => setKindFilter('all') }, `${t('全部')} ${memories.length}`),
                  ...KINDS.map((kind) =>
                    h(
                      'button',
                      { type: 'button', key: kind, className: 'ml-chip', 'data-active': kindFilter === kind ? 'true' : 'false', onClick: () => setKindFilter(kind) },
                      `${KIND_LABEL[kind]}${memories.filter((memory) => memory.kind === kind).length}`,
                    ),
                  ),
                ),
                ...(filtered.length === 0
                  ? [h('div', { className: 'ml-empty', key: 'none' }, memories.length === 0 ? t('还没有记忆') : t('没有匹配'))]
                  : filtered.slice(0, LIST_LIMIT).map((memory) =>
                      h(
                        'div',
                        {
                          key: memory.id,
                          ref: (node) => {
                            if (node === null) rowRefs.current.delete(memory.id);
                            else rowRefs.current.set(memory.id, node);
                          },
                        },
                        h(MemoryRow, { memory, ordered, selected: memory.id === selectedId, onSelect: selectFromChart }),
                        // 详情就地展开在这一条下面 —— 列表长了也不用滚回顶部
                        memory.id === selectedId
                          ? h(Detail, { memory, ordered, halfLifeDays: state?.cfg?.halfLifeDays ?? 30, busy, onAction: act })
                          : null,
                      ),
                    )),
                filtered.length > LIST_LIMIT ? h('div', { className: 'ml-meta', style: { justifyContent: 'center' } }, `只显示前 ${LIST_LIMIT} 条（共 ${filtered.length}）`) : null,
              );

      return h(
        'div',
        { className: 'ml-page', role: 'region', 'aria-label': '记忆海', tabIndex: -1, ref: panelRef },
        h(
          'div',
          { className: 'ml-head' },
                    h(
                      'span',
                      { className: 'ml-head-mark' },
                      h(
                        'svg',
                        { width: 18, height: 18, viewBox: '0 0 24 24', 'aria-hidden': 'true' },
                        h('circle', { cx: 6, cy: 17, r: 1.7, fill: `rgb(${KIND_COLOR.episode.join(',')})` }),
                        h('circle', { cx: 12, cy: 7.5, r: 2, fill: `rgb(${KIND_COLOR.fact.join(',')})` }),
                        h('circle', { cx: 18.5, cy: 14, r: 1.6, fill: `rgb(${KIND_COLOR.world.join(',')})` }),
                        h('path', { d: 'M6 17 L12 7.5 L18.5 14', fill: 'none', stroke: 'rgba(140,180,240,.5)', strokeWidth: 0.9, strokeDasharray: '2 3' }),
                      ),
                    ),
                    h('span', { className: 'ml-title' }, '记忆海'),
                    h(
                      'span',
                      { className: 'ml-stats' },
                      h('span', {}, h('b', {}, String(active)), ' 颗在册'),
                      h('span', {}, '归档 ', h('b', {}, String(counts.archived ?? 0))),
                      h('span', {}, '召回 ', h('b', {}, String(state?.recallCount ?? 0))),
                      stressReport === null ? null : h('span', { style: { color: '#e9c07a' } }, `自检 ${stressReport.count}星 ${stressReport.fps}fps`),
                      error === null ? null : h('span', { style: { color: '#f08a72' } }, `· ${error}`),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'ml-main' },
                    h(MemorySea, {
                      memories: ordered,
                      dataKey,
                      selectedId,
                      onSelect: selectFromChart,
                      stressToken,
                      onStressReport,
                      animate,
                      scrubAt,
                      onScrub: setScrubAt,
                      focusIds,
                    }),
                    h(
                      'div',
                      { className: 'ml-rail' },
                      h(
                        'div',
                        { className: 'ml-rail-head' },
                        h(
                          'div',
                          { className: 'ml-seg', role: 'tablist' },
                          ...MODES.map(([key, label]) =>
                            h(
                              'button',
                              {
                                key,
                                type: 'button',
                                role: 'tab',
                                'data-active': mode === key ? 'true' : 'false',
                                'aria-selected': mode === key,
                                onClick: () => setMode(key),
                              },
                              label,
                            ),
                          ),
                        ),
                        h(Lamps, { layers: state?.health?.layers }),
                        h(
                          'div',
                          { className: 'ml-tools' },
                          h('button', { type: 'button', className: 'ml-btn', onClick: toggleAnimate, title: '星海动效开关' }, `${t('动效')} ${animate ? t('开') : t('关')}`),
                          h('button', { type: 'button', className: 'ml-btn', onClick: () => setStressToken((token) => token + 1) }, t('压力自检')),
                          h('button', { type: 'button', className: 'ml-btn', onClick: () => refresh() }, t('刷新')),
                          h('button', { type: 'button', className: 'ml-btn', onClick: onExport, disabled: busy, title: '把整库导出成 JSON（与磁盘同形，可直接当备份）' }, t('导出')),
                          pendingTidy === null
                            ? h('button', { type: 'button', className: 'ml-btn', onClick: onTidyPreview, disabled: busy, title: '把「v0.30.1 修了什么」这类开发过程记录批量归档（可恢复）' }, t('整理'))
                            : h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'ml-btn',
                                  'data-warn': 'true',
                                  disabled: busy,
                                  onClick: confirmTidy,
                                  title: '只归档、不删除：归档后能单条恢复',
                                },
                                UI_LOCALE === 'en' ? `Archive ${pendingTidy.count}` : `确认归档 ${pendingTidy.count} 条`,
                              ),
                          pendingImport === null
                            ? h('button', { type: 'button', className: 'ml-btn', onClick: () => importFileRef.current?.click(), disabled: busy, title: '从一份导出的 JSON 恢复整库（写之前会自动备份）' }, t('导入'))
                            : h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'ml-btn',
                                  'data-warn': 'true',
                                  disabled: busy,
                                  onClick: confirmImport,
                                  title: '整体替换当前记忆库（已自动备份一份）',
                                },
                                UI_LOCALE === 'en'
                                  ? `Overwrite ${Math.max(1, Math.round(pendingImport.size / 1024))}KB`
                                  : `确认覆盖 ${Math.max(1, Math.round(pendingImport.size / 1024))}KB`,
                              ),
                          h('input', {
                            ref: importFileRef,
                            type: 'file',
                            accept: 'application/json,.json',
                            style: { display: 'none' },
                            onChange: onImportFile,
                          }),
                        ),
                      ),
                      h('div', { className: 'ml-rail-body' }, railBody),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'ml-foot' },
                    h('span', {}, `${active}/${state?.cfg?.maxActiveMemories ?? 0}`),
                    h('span', {}, `${t('查重')} ${state?.cfg?.dedupeThreshold ?? '-'}`),
                    h('span', {}, `${t('召回')} ${state?.cfg?.recallThreshold ?? '-'}`),
                    h('span', {}, `${t('半衰')} ${state?.cfg?.halfLifeDays ?? '-'}d`),
                    staleServer ? h('b', { style: { color: '#c2701f' } }, `宿主 v${state.serverVersion} ≠ 面板 v${CLIENT_VERSION}，重启 DSH`) : null,
                    closeNote === '' ? null : h('b', { style: { color: '#c2701f' } }, closeNote),
                    h('span', { style: { marginLeft: 'auto' } }, `v${CLIENT_VERSION} · store.json`),
                  ),
      );
    }
    //#endregion

    const inject = ['slots'];

    const PANEL_ID = 'memory-loom';

    function apply(ctx) {
      // 页面本体：main 是 keyed 槽，侧栏点它时宿主就切到这一页
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID }, MemorySeaPage),
      );
      // 入口：侧栏导航栏（宿主自己枚举 sidebar.panellist 生成列表，插件/自动化任务都在这一列）
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 6, label: t('记忆海') },
          MemoryLoomIcon,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.__internals = {
      layoutSea,
      buildEdges,
      addCohesion,
      fitDistance,
      buildGuides,
      paintGuides,
      paintClusterHalos,
      projectPoint,
      projectAll,
      clampCamera,
      paintEdges,
      paintPoints,
      paintLabels,
      pickLabelCandidates,
      labelBudget,
      keywordsOf,
      hash32,
      asScrubTime,
      nextSelection,
      clampNumber,
      setPanelOpen,
      getPanelOpen,
      easePresence,
      paintNebula,
      pointSprite,
      dotSprite,
      nearestSizeStep,
      POINT_SIZE_STEPS,
      CAM_DEFAULT,
      CAM_LIMITS,
      FOCAL,
      KIND_COLOR,
      KIND_LABEL,
      // 语言：字典与判定都导出，测试可以不依赖浏览器就盯住「英文环境翻成什么、缺词怎么办」
      EN_TEXT,
      detectLocale,
      translateWith,
      UI_LOCALE,
    };
    return module.exports;
  },
});
