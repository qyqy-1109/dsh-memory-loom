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
      '焦点': 'Focus', '标签': 'Labels', '自转': 'Spin', '复位': 'Reset', '现在': 'Now', '光效': 'Glow',
      '呼吸': 'Breath', '逐星': 'stars', '只亮': 'focus', '整片': 'sea', '关': 'off', '金线': 'Gold', '共鸣': 'Resonance', '开': 'On', '只看': 'Only',
      '历史': 'History', '回到现在': 'Now',
      '查重': 'Dedupe', '半衰': 'Half-life',
      '活跃': 'Active', '已归档': 'Archived', '全部': 'All',
      '按文本过滤': 'Filter text',
      '还没有记忆': 'No memories yet', '没有匹配': 'No match',
      '还没有跑过召回': 'No recall yet',
      '回到顶部': 'Back to top',
      '没有需要整理的过程记录': 'Nothing to tidy',
      '已被取代': 'Superseded', '容量归档': 'Archived (capacity)', '过程记录归档': 'Archived (log)', '从未想起': 'Never recalled',
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
    const CLIENT_VERSION = '0.46.0';
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
  /* 高度不能只写 100%：宿主的 main 槽多数情况下是自动高度，百分比会退化成 auto，
     于是页面按"内容高度"长出来 —— 右侧列表一长（记忆一多），整页就比可视区高，
     底部的页脚与时间轴被挤出屏幕（用户看到的"打开闪一下就没了"）。
     这里用 JS 量出来的 --ml-page-h 兜底，保证页面永远贴着可视区。 */
  height:var(--ml-page-h, 100%);
  flex:1 1 auto;width:100%;min-height:0;
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
  position:relative;display:grid;grid-template-columns:minmax(0,1fr) 306px;grid-template-rows:minmax(0,1fr);min-height:0;overflow:hidden;
  color:#e2e9f6;border:1px solid var(--dsw-alias-border-l1,#e6e8eb);border-radius:10px;
  background:radial-gradient(120% 90% at 18% -10%, #131f38 0%, #070c17 46%, var(--ml-void) 100%);
}
/* 舞台用 grid 而不是 flex：底部时间轴必须是 auto 行（按内容定高），
   canvas 那一行 minmax(0,1fr) 自己收缩 —— flex 里底部条会被压到 0，看起来就是"时间轴消失" */
.ml-stage{position:relative;min-width:0;min-height:0;overflow:hidden;border-right:1px solid var(--ml-line);display:grid;grid-template-rows:minmax(0,1fr) auto}
.ml-canvas-wrap{position:relative;flex:1;min-height:0;cursor:grab;isolation:isolate}
/* 星云底：静态图层。早先给它加了 46s 的漂移动画，结果每帧都要重新合成一层大图，
   和 60fps 重绘的画布抢合成器 —— 转动偶尔就漏一帧。画面里的「动」交给相机就够了。 */
/* 深空底：本身就是满分辨率的位图（自带基底、银河带、星尘与暗角），必须满不透明度显示，
   再压透明度只会把它重新洗成一片灰雾 */
.ml-nebula{position:absolute;inset:-40px;z-index:0;pointer-events:none;background-repeat:no-repeat;background-size:cover;background-position:center}
/* 胶片颗粒：盖在星星之上，压掉渐变的色带、也让画面不像"纯数字渲染" */
.ml-grain{position:absolute;inset:0;z-index:2;pointer-events:none;opacity:.15;mix-blend-mode:overlay;background-repeat:repeat;background-size:128px 128px}
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
/* 历史页签：时间回放从画面底部搬到了侧栏（底部那条无论怎么修都会被挤掉） */
.ml-history{display:flex;flex-direction:column;gap:10px}
.ml-history-head{display:flex;align-items:baseline;gap:8px;font-size:11px;color:var(--ml-ink-dim)}
.ml-history-head b{color:var(--ml-gold);font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.ml-history-track{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--ml-line);border-radius:7px;background:#0a1120}
.ml-history input[type="range"]{flex:1;min-width:0;height:20px;margin:0;appearance:none;-webkit-appearance:none;background:transparent;cursor:pointer}
.ml-history input[type="range"]::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:linear-gradient(90deg,rgba(150,190,245,.8),rgba(233,192,122,.85))}
.ml-history input[type="range"]::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:13px;height:13px;border-radius:50%;background:#f0c987;margin-top:-4.5px;box-shadow:0 0 10px rgba(233,192,122,.9)}
.ml-history input[type="range"]:focus-visible{outline:none}
.ml-history input[type="range"]:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 3px rgba(233,192,122,.35),0 0 10px rgba(233,192,122,.9)}
.ml-history-label{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:var(--ml-ink-dim);white-space:nowrap}
.ml-history-actions{display:flex;gap:6px;flex-wrap:wrap}
.ml-scrub-label b{color:var(--ml-gold);font-weight:500}
.ml-history-label b{color:var(--ml-gold);font-weight:500}

.ml-rail{display:flex;flex-direction:column;min-height:0;background:var(--ml-rail);position:relative}
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
/* 回到顶端：只在滚下去之后浮出来，压在列表右下角（不占布局，不遮最后一行的正文） */
.ml-top{position:absolute;right:14px;bottom:14px;z-index:2;display:inline-flex;align-items:center;gap:4px;border:1px solid rgba(120,160,230,.32);background:rgba(8,14,26,.92);color:#c8d5ea;font:inherit;font-size:10.5px;letter-spacing:.04em;padding:3px 9px;border-radius:999px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.45)}
.ml-top:hover{color:#e8efff;border-color:rgba(120,160,230,.6)}
.ml-top:focus-visible{outline:none;box-shadow:0 0 0 2px var(--ml-gold)}
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
    /**
     * 样式表按**版本号**注入。
     *
     * 原来只按固定 id 判断"注入过没有"：页面不整刷、只换了 client bundle 时（HMR），
     * 旧的 <style> 还在，新的 CSS 就被跳过 —— 表现是"改了 CSS 但界面上没变化"。
     * 现在把版本写进 id，发现对不上就换掉旧的。
     */
    const styleTagId = `dsh-memory-loom/panel.css@${CLIENT_VERSION}`;
    if (typeof document !== 'undefined') {
      const existing = typeof document.querySelectorAll === 'function'
        ? document.querySelectorAll('style[data-plugin="dsh-memory-loom"]')
        : [];
      let current = null;
      for (const node of existing) {
        if (node?.dataset?.pluginCss === styleTagId) current = node;
        else node?.remove?.();
      }
      if (current === null) {
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-memory-loom';
        tag.dataset.pluginCss = styleTagId;
        tag.textContent = css;
        document.head.appendChild(tag);
      }
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

    /**
     * 一次「按下 → 抬起」算不算点击：位移 ≤ 5px 且不超过 800ms。
     *
     * 纯函数，不依赖任何跨事件的残留标记 —— 踩过的坑是 dragMoved 只在 onClick 里清，
     * 于是「在画布内拖动、在画布外松开」后第一次真点击被吞掉（"点了星星没反应"）。
     *
     * @param {{x: number, y: number, t?: number}|null} down
     * @param {{x: number, y: number}} up
     * @param {number} [now]
     * @returns {boolean}
     */
    function isClickGesture(down, up, now = 0) {
      if (down === null || down === undefined) return true;
      if (Math.hypot(up.x - down.x, up.y - down.y) > 5) return false;
      if (typeof down.t === 'number' && typeof now === 'number' && now > 0 && now - down.t > 800) return false;
      return true;
    }

    /**
     * 从星图定位到某条记忆时，需要放开哪些过滤。
     *
     * 星图画的是**全部**记忆（含已归档、含被「只看这组原文」聚焦掉的），而右侧列表默认
     * 只看活跃、还可能被种类/文本过滤 —— 不放开这些，点了星等于什么都没发生（行根本没渲染）。
     *
     * @param {{kind?: string, status?: string}|undefined} memory
     * @param {{statusFilter: string, kindFilter: string, textFilter: string, summaryFocus: string|null}} current
     * @returns {{statusFilter: string, kindFilter: string, clearText: boolean, clearSummaryFocus: boolean}}
     */
    function revealFiltersFor(memory, current) {
      const next = {
        statusFilter: current.statusFilter,
        kindFilter: current.kindFilter,
        clearText: false,
        clearSummaryFocus: false,
      };
      if (memory !== undefined && memory.status !== undefined && memory.status !== 'active' && current.statusFilter === 'active') {
        next.statusFilter = 'all';
      }
      if (memory !== undefined && memory.kind !== undefined && current.kindFilter !== 'all' && current.kindFilter !== memory.kind) {
        next.kindFilter = 'all';
      }
      if (typeof current.textFilter === 'string' && current.textFilter.length > 0) next.clearText = true;
      if (current.summaryFocus !== null && current.summaryFocus !== undefined) next.clearSummaryFocus = true;
      return next;
    }

    /**
     * 滚过这么多像素才浮出「回到顶端」。
     *
     * 阈值给得比一行高一些：刚滚两行就冒按钮会显得吵；一两百像素已经能看出"翻下去了"。
     */
    const TOP_BUTTON_THRESHOLD = 200;

    /**
     * 该不该显示「回到顶端」。
     * @param {number} scrollTop
     * @param {number} [threshold]
     * @returns {boolean}
     */
    function shouldShowTop(scrollTop, threshold = TOP_BUTTON_THRESHOLD) {
      const value = Number(scrollTop);
      return Number.isFinite(value) && value > threshold;
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
        if (memory.archivedReason === 'unused') return t('从未想起');
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
     * 三维布局：**按簇的大小分配体积**。
     *
     * 早先的问题（用户反馈"空的地方太空、密的地方太密"）：所有簇共用同一个球壳半径，
     * 一个 30 条的大簇和一条孤零零的小簇霸占一样大的位置 —— 大簇挤成一坨，
     * 小簇周围留出大片真空。现在改成三步：
     *
     * ① 每簇的**体积半径与 sqrt(成员数) 成正比**（体积∝数量），大簇占更大空间；
     * ② 簇心按斐波那契球面布点，再跑几十轮**松弛**：两个簇靠得比"半径和"还近就互相推开，
     *    同时轻微拉回球面，保证整体还是个球而不是炸开；
     * ③ 簇内点的扩散半径跟着簇体积走，并且略偏外壳（`rand^0.45`），
     *    免得所有点都挤在球心 —— 那是"密集处更密"的另一半原因。
     *
     * 位置只由 id 与簇决定 —— 重排数据不会让星乱跳（松弛的顺序也是确定的）。
     */
    function layoutSea(memories) {
      const clusterOf = (memory) => memory.scene || memory.kindLabel || KIND_LABEL[memory.kind] || '其它';
      const topics = [...new Set(memories.map(clusterOf))];
      // 按成员数分组（顺序确定：先按数量降序，再按名字）
      const groups = new Map();
      for (const memory of memories) {
        const key = clusterOf(memory);
        const list = groups.get(key) ?? [];
        list.push(memory);
        groups.set(key, list);
      }
      const entries = [...groups.entries()].sort(
        (left, right) => right[1].length - left[1].length || (left[0] < right[0] ? -1 : 1),
      );
      const largest = Math.max(1, ...entries.map(([, list]) => list.length));
      /** 簇体积半径：44（单点簇也得有体积）→ 140（最大簇） */
      const radiusOf = (count) => 44 + 96 * Math.sqrt(count / largest);
      const count = Math.max(1, entries.length);
      // 簇少的时候球壳也小一点，否则几颗星被甩得很开，满屏都是空的
      const shell = count <= 1 ? 0 : 210 + 26 * Math.sqrt(count);
      const nodes = entries.map(([cluster], index) => {
        const y = count === 1 ? 0 : 1 - (index / (count - 1)) * 2;
        const ring = Math.sqrt(Math.max(0, 1 - y * y));
        const phi = index * Math.PI * (3 - Math.sqrt(5)) + rand01(`${cluster}:phi`) * 0.5;
        const x = Math.cos(phi) * ring * shell;
        const yy = y * shell * 0.82;
        const z = Math.sin(phi) * ring * shell;
        return { cluster, x, y: yy, z, tx: x, ty: yy, tz: z, radius: radiusOf(entries[index][1].length) };
      });
      // 松弛：先把重叠的簇互相推开，再轻微拉回球面（两步都确定，所以结果可复现）
      for (let step = 0; step < 48; step += 1) {
        for (let i = 0; i < nodes.length; i += 1) {
          for (let j = i + 1; j < nodes.length; j += 1) {
            const a = nodes[i];
            const b = nodes[j];
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let dz = b.z - a.z;
            const dist = Math.hypot(dx, dy, dz) || 0.001;
            const need = a.radius + b.radius + 26;
            if (dist >= need) continue;
            const push = (need - dist) * 0.5;
            dx /= dist;
            dy /= dist;
            dz /= dist;
            a.x -= dx * push;
            a.y -= dy * push;
            a.z -= dz * push;
            b.x += dx * push;
            b.y += dy * push;
            b.z += dz * push;
          }
        }
        for (const node of nodes) {
          node.x += (node.tx - node.x) * 0.02;
          node.y += (node.ty - node.y) * 0.02;
          node.z += (node.tz - node.z) * 0.02;
        }
      }
      const centers = new Map();
      for (const node of nodes) centers.set(node.cluster, { x: node.x, y: node.y, z: node.z, radius: node.radius });
      /**
       * 簇内序号：按创建时间排序。
       *
       * 用序号（而不是纯 id 散列）换来了球面上的均匀分布，代价是"插入会挪动同簇其它星"——
       * 所以排序键必须是创建时间：新记忆永远排在最后，已有星的序号不变，画面上不重组。
       */
      const orderInCluster = new Map();
      for (const [cluster, list] of groups) {
        const ordered = [...list].sort(
          (left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0) || (left.id < right.id ? -1 : 1),
        );
        orderInCluster.set(cluster, new Map(ordered.map((memory, index) => [memory.id, index])));
      }
      const points = memories.map((memory) => {
        const cluster = clusterOf(memory);
        const center = centers.get(cluster) ?? { x: 0, y: 0, z: 0, radius: 60 };
        const groupSize = groups.get(cluster)?.length ?? 1;
        const index = orderInCluster.get(cluster)?.get(memory.id) ?? 0;
        /**
         * 方向：斐波那契球面，不是随机撒向。
         *
         * 随机撒在球**内**时，两点之间的距离大半消耗在**深度方向**上 —— 屏幕上根本看不出来。
         * 实测：三维间距 26.1 的两颗星，投影后只差 1.89px，看起来就是一颗更亮的星；
         * 92 颗星里有 24 对不到 6px。
         *
         * 斐波那契球面给的是**角距的几何下界**（约 1/√n 弧度）：不管相机转到哪个角度，
         * 两点在视线垂面上总有分量，所以"投影后重叠"从必然变成罕见。
         */
        const ny = groupSize <= 1 ? 0 : 1 - (2 * index + 1) / groupSize;
        const ring = Math.sqrt(Math.max(0, 1 - ny * ny));
        // 角度抖动 ±0.05 rad：纯斐波那契太整齐，像晶体不像星云；抖动由 id 决定，稳定不抖
        const phi = index * Math.PI * (3 - Math.sqrt(5)) + (rand01(`${memory.id}:a`) - 0.5) * 0.1;
        // 半径按 (i/n)^(1/3) 走：这是"体积均匀"的分布律。
        // 全部贴在球壳上是不行的 —— 球面投影到二维时赤道附近会被挤成一圈，
        // 边缘的点互相重叠（实测 92 星里仍有 7 对不到 6px，就是这种挤压造成的）。
        // 体积均匀投影到二维近似圆盘均匀，最近邻间距不随位置变化。
        const frac = groupSize <= 1 ? 0.5 : (index + 0.5) / groupSize;
        const spread = center.radius * (0.34 + 0.66 * Math.cbrt(frac));
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
          x: center.x + Math.cos(phi) * ring * spread,
          y: center.y + ny * spread * 0.72,
          z: center.z + Math.sin(phi) * ring * spread,
          phase: rand01(`${memory.id}:p`) * Math.PI * 2,
          radius: 1.1 + Math.min(2.4, weight * 1.4),
          rgb: KIND_COLOR[memory.kind] ?? KIND_COLOR.slot,
        };
      });
      // 撒点之后先推开重叠：低差异分布已经把最坏情况压到 3 对，这一步收拾剩下的边角
      // （minDist 取 26：再大就会把簇推出自己的球体，簇与簇开始混在一起）
      separatePoints(points, { minDist: 26 });
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
     * 簇内近邻排斥：把靠得太近的星推开。
     *
     * 为什么必须有这一步：簇内位置是「id 散列 + 球内均匀随机」撒出来的，纯随机会**必然**
     * 出现"两颗星糊成一颗"。实测 92 颗星在 1100×700 的画布上，有 24 对投影距离不到 6px，
     * 最极端的一对只差 0.5px —— 屏幕上就是一颗更亮的星。
     *
     * 这不是美观问题：重叠的两条记忆只会有一条能被点中，另一条永远点不到，
     * 而"点一颗星看原文"是这张图唯一的交互入口。
     *
     * 确定性与稳定性：顺序固定、推开量固定，同样的数据每次排出同样的位置。
     * 只在过近时微调，绝大多数星一个像素都不动 —— 不会"重排数据星就乱跳"。
     *
     * @param {Array<{id: string, x: number, y: number, z: number}>} points 原地修改
     * @param {{minDist?: number, rounds?: number}} [options]
     */
    function separatePoints(points, options) {
      const minDist = options?.minDist ?? 14;
      const rounds = options?.rounds ?? 4;
      if (points.length < 2) return points;
      const cell = Math.max(1, minDist);
      for (let round = 0; round < rounds; round += 1) {
        // 每轮重建网格：位置在动，网格必须跟着动
        const grid = new Map();
        for (let index = 0; index < points.length; index += 1) {
          const point = points[index];
          const key = `${Math.floor(point.x / cell)},${Math.floor(point.y / cell)},${Math.floor(point.z / cell)}`;
          const bucket = grid.get(key);
          if (bucket === undefined) grid.set(key, [index]);
          else bucket.push(index);
        }
        let moved = 0;
        for (let index = 0; index < points.length; index += 1) {
          const point = points[index];
          const gx = Math.floor(point.x / cell);
          const gy = Math.floor(point.y / cell);
          const gz = Math.floor(point.z / cell);
          for (let dx = -1; dx <= 1; dx += 1) {
            for (let dy = -1; dy <= 1; dy += 1) {
              for (let dz = -1; dz <= 1; dz += 1) {
                const bucket = grid.get(`${gx + dx},${gy + dy},${gz + dz}`);
                if (bucket === undefined) continue;
                for (const otherIndex of bucket) {
                  // 每对只处理一次（bucket 里的 index 可能小于当前 index）
                  if (otherIndex <= index) continue;
                  const other = points[otherIndex];
                  let ox = other.x - point.x;
                  let oy = other.y - point.y;
                  let oz = other.z - point.z;
                  let dist = Math.hypot(ox, oy, oz);
                  if (dist >= minDist) continue;
                  // 完全重合时给一个由两个 id 决定的固定方向：
                  // 用 Math.random 会让每次重排位置都不一样，画面就会闪
                  if (dist < 0.0001) {
                    const theta = rand01(`${point.id}>${other.id}`) * Math.PI * 2;
                    const phi = Math.acos(2 * rand01(`${other.id}>${point.id}`) - 1);
                    ox = Math.sin(phi) * Math.cos(theta);
                    oy = Math.cos(phi);
                    oz = Math.sin(phi) * Math.sin(theta);
                    dist = 1;
                  }
                  const push = (minDist - dist) * 0.5;
                  const nx = ox / dist;
                  const ny = oy / dist;
                  const nz = oz / dist;
                  point.x -= nx * push;
                  point.y -= ny * push;
                  point.z -= nz * push;
                  other.x += nx * push;
                  other.y += ny * push;
                  other.z += nz * push;
                  moved += 1;
                }
              }
            }
          }
        }
        if (moved === 0) break;
      }
      return points;
    }

    /**
     * 连线：共享关键词 / 同簇才有候选，按分数排序，每点最多 `maxNeighbors` 条。
     * supersedes 关系单独成金线。
     *
     * 每条线带一个**世界坐标的弯曲控制点**：控制点写在三维里，所以转动相机时丝带的弯
     * 是跟着海一起转的，不是屏幕上的假弧。
     */
    /**
     * 一条边在**世界坐标**里的弯曲控制点。
     *
     * 写在三维里，所以转动相机时，丝带的弯是跟着海一起转的，不是屏幕上的假弧。
     * 偏移量由两端 id 散列决定 —— 同一对星每次都是同一个弧度，重排数据不抖。
     */
    function controlPoint(a, b) {
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
      return {
        x: (a.x + b.x) / 2 + (px / plen) * bend,
        y: (a.y + b.y) / 2 + (py / plen) * bend,
        z: (a.z + b.z) / 2 + (pz / plen) * bend,
      };
    }

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
        edges.push({
          a: a.id,
          b: b.id,
          score: Number(score.toFixed(3)),
          kind,
          control: controlPoint(a, b),
        });
        return true;
      };
      for (const point of points) {
        for (const targetId of point.memory.supersedes ?? []) {
          const target = byId.get(targetId);
          // 目标可能已经不在库里（归档修剪时物理删过）：这时画不出线，
          // 也不能静默 —— 详情面板会把"作废了 N 条（M 条已不在库里）"写出来。
          if (target !== undefined) push(point, target, 1, 'supersede');
        }
        // 反向也补一次：老条目身上的 supersededBy 指向新条目，两边任一还在都能画出金线
        const successor = point.memory.supersededBy;
        if (typeof successor === 'string' && successor.length > 0) {
          const target = byId.get(successor);
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

    /**
     * 共激活边：由**使用**产生的关系，和上面按关键词相似连出来的 `topic` 边是两回事。
     *
     * - `topic` 边说的是「这两条写得像」：静态，形状完全由分词这把尺子决定；
     * - `recall` 边说的是「这两条一起被想起来过」：动态，由真实召回历史累积，
     *   没人再需要时它自己会衰减掉。这一层才可能在长时间使用后长出没人预先写过的结构。
     *
     * 这一版**只用来画**：不参与注入顺序，也不影响任何召回决策。
     * 先让关系看得见，用一段时间判断它是不是真的有意义，再决定要不要让它反过来影响行为。
     *
     * @param {Array<{id: string, x: number, y: number, z: number}>} points 已经排好位置的星
     * @param {Array<{a: string, b: string, strength: number}>} list 服务端给的可见边
     * @param {{maxEdges?: number}} [options]
     * @returns {Array<{a: string, b: string, score: number, kind: string, control: object}>}
     */
    function buildRecallEdges(points, list, options) {
      const maxEdges = options?.maxEdges ?? 900;
      const rows = Array.isArray(list) ? list : [];
      if (rows.length === 0) return [];
      const byId = new Map(points.map((point) => [point.id, point]));
      // 强度归一化到 0–1：绝对权重每次共现都在涨，画线只该关心"相对强弱"
      let peak = 0;
      for (const row of rows) peak = Math.max(peak, Number(row?.strength) ?? 0);
      const scale = peak > 0 ? peak : 1;
      const edges = [];
      for (const row of rows) {
        const a = byId.get(row?.a);
        const b = byId.get(row?.b);
        // 端点不在这张图上（被过滤/已删除）：画不出来，跳过 —— 不能画一条连到虚空里的线
        if (a === undefined || b === undefined) continue;
        edges.push({
          a: a.id,
          b: b.id,
          score: Math.min(1, Math.max(0, (Number(row.strength) ?? 0) / scale)),
          kind: 'recall',
          control: controlPoint(a, b),
        });
        if (edges.length >= maxEdges) break;
      }
      return edges;
    }

    /** 相机取值收敛：俯仰夹住、距离夹住、yaw 允许无限转。 */
    function clampCamera(camera) {
      const dist = Math.min(CAM_LIMITS.maxDist, Math.max(CAM_LIMITS.minDist, camera.dist));
      const pitch = Math.max(-CAM_LIMITS.maxPitch, Math.min(CAM_LIMITS.maxPitch, camera.pitch));
      return { yaw: camera.yaw, pitch, dist, panX: camera.panX, panY: camera.panY };
    }

    /**
     * 呼吸的原始振荡：返回 −1…1。
     *
     * 为什么不能整屏同步：同步脉动看起来像"整块屏幕在闪"，是最廉价的那种动效。
     * 相位取自点自己的稳定散列，周期 2.8–5.4 秒（相邻两颗差得很远），
     * 读起来才像"星在慢慢呼吸"，而不是灯光秀。
     *
     * 注意周期别拉太长：3.6–7.2 秒那种，在暗背景上会被直接读成"静态" ——
     * 第一版就是这么翻车的（振幅 10%、周期近 7 秒，肉眼几乎察觉不到）。
     *
     * @param {number} time 毫秒
     * @param {number} phase 0–2π（每颗星的固定相位）
     * @returns {number}
     */
    function breathAt(time, phase) {
      const base = Number.isFinite(phase) ? phase : 0;
      const period = 2800 + ((Math.sin(base * 3.7) + 1) / 2) * 2600;
      return Math.sin((time / period) * Math.PI * 2 + base);
    }

    /**
     * 呼吸系数：每颗星都用自己的相位与周期慢速明暗，返回 1±amplitude。
     *
     * @param {number} time 毫秒
     * @param {number} phase 0–2π（每颗星的固定相位）
     * @param {number} [amplitude]
     * @returns {number}
     */
    function breathOf(time, phase, amplitude = 0.1) {
      if (!(amplitude > 0)) return 1;
      return 1 + amplitude * breathAt(time, phase);
    }

    /**
     * 拖拽一步的相机增量。
     *
     * 必须**按增量**算，不能按「离按下点的总位移」算：总位移配 clamp 会粘住 ——
     * 俯仰冲过上限之后继续拖，越界量被记进了起点；往回拖得先把这段"债"还完，视图才动，
     * 手感就是"Y 轴卡手、要拖半天才回来"。
     *
     * @param {{yaw: number, pitch: number}} camera
     * @param {number} dx 本次移动的横向像素
     * @param {number} dy 本次移动的纵向像素
     * @param {{maxPitch: number}} [limits]
     * @returns {{yaw: number, pitch: number, clamped: boolean}}
     */
    function stepOrbit(camera, dx, dy, limits = CAM_LIMITS) {
      const yaw = camera.yaw + dx * 0.006;
      const raw = camera.pitch - dy * 0.006;
      const pitch = Math.max(-limits.maxPitch, Math.min(limits.maxPitch, raw));
      return { yaw, pitch, clamped: pitch !== raw };
    }

    /**
     * 深度色调桶：0 远 / 1 中 / 2 近。
     *
     * 这是"空气透视"的落地点：远处的星要变冷、变淡、变小，近处要更白更实。
     * 切成 3 桶而不是连续值，是为了让精灵贴图能按桶缓存（连续取色就没法缓存了）。
     *
     * @param {number} f 透视系数（越大越近）
     * @returns {0|1|2}
     */
    function toneOf(f) {
      if (!(f > 0)) return 0;
      if (f >= 0.95) return 2;
      if (f >= 0.55) return 1;
      return 0;
    }

    /**
     * 后期合成计划：什么时候该跑 bloom。
     *
     * 只有「光效开 + 最高画质档」才跑：bloom 是多一次全屏合成的成本，
     * 掉帧时应当第一个被牺牲（降档路径会先把 quality 打下来）。
     *
     * @param {{quality: number, glow: boolean}} input
     * @returns {{bloom: boolean, scale: number, alpha: number}}
     */
    function planBloom(input) {
      const glow = input?.glow === true;
      const quality = Number(input?.quality ?? 0);
      const enabled = glow && quality >= 2;
      return { bloom: enabled, scale: enabled ? 0.25 : 0, alpha: enabled ? 0.3 : 0 };
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

    /** 簇光晕（朴素模式）：一簇一片极淡的圆雾；焦点模式下没命中的簇要一起压暗。 */
    function paintClusterHalos(ctx, projected, width, height, quality, options = {}) {
      if (quality < 1) return 0;
      const focus = options?.focus ?? null;
      const onlyFocus = options?.onlyFocus === true;
      const groups = new Map();
      for (const p of projected) {
        if (p.ghost) continue;
        const key = p.point.cluster;
        const acc = groups.get(key) ?? { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, n: 0, rgb: p.point.rgb, members: [] };
        acc.minX = Math.min(acc.minX, p.x);
        acc.maxX = Math.max(acc.maxX, p.x);
        acc.minY = Math.min(acc.minY, p.y);
        acc.maxY = Math.max(acc.maxY, p.y);
        acc.n += 1;
        acc.members.push(p.point.id);
        groups.set(key, acc);
      }
      let drawn = 0;
      const pulseOf = typeof options?.pulseOf === 'function' ? options.pulseOf : null;
      for (const [, acc] of groups) {
        if (acc.n < 1) continue;
        const cx = (acc.minX + acc.maxX) / 2;
        const cy = (acc.minY + acc.maxY) / 2;
        const radius = Math.max(46, Math.hypot((acc.maxX - acc.minX) / 2, (acc.maxY - acc.minY) / 2) * 1.9 + 28);
        if (cx < -radius || cx > width + radius || cy < -radius || cy > height + radius) continue;
        const focused = focus === null || !onlyFocus || acc.members.some((id) => focus.has(id));
        // 朴素模式同样要让光斑跟着星一起呼吸，否则"星在动、光斑不动"
        let pulse = 0;
        if (pulseOf !== null && acc.members.length > 0) {
          let sum = 0;
          for (const member of acc.members) {
            const value = pulseOf(member);
            if (Number.isFinite(value)) sum += value;
          }
          pulse = sum / acc.members.length;
        }
        ctx.globalAlpha = (focused ? 1 : 0.15) * (1 + 0.3 * pulse);
        const size = radius * 2 * (1 + 0.06 * pulse);
        ctx.drawImage(haloSprite(acc.rgb), cx - size / 2, cy - size / 2, size, size);
        drawn += 1;
      }
      ctx.globalAlpha = 1;
      return drawn;
    }

    /**
     * 胶片颗粒：128×128 的灰阶噪声平铺在画布上（CSS 叠层，不占帧内成本）。
     *
     * 为什么需要：大面积的径向渐变在 8bit 下必然有色带，一有带子就显"廉价"；
     * 一层 3% 的噪声能把色带打散，人也更容易把它读成"照片"而不是"渲染图"。
     */
    let grainCache = null;
    function grainDataUrl() {
      if (grainCache !== null) return grainCache;
      const size = 128;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (ctx === null || typeof ctx.createImageData !== 'function' || typeof ctx.putImageData !== 'function') {
        grainCache = '';
        return '';
      }
      const image = ctx.createImageData(size, size);
      for (let index = 0; index < image.data.length; index += 4) {
        const value = 112 + Math.round(rand01(`grain:${index}`) * 86);
        image.data[index] = value;
        image.data[index + 1] = value;
        image.data[index + 2] = value;
        image.data[index + 3] = 255;
      }
      ctx.putImageData(image, 0, 0);
      grainCache = canvas.toDataURL('image/png');
      return grainCache;
    }

    /**
     * 星云精灵：一簇一张「真云」而不是一个软圆点。
     *
     * 廉价感的根源之一就是"一团均匀的光斑"。真星云有几个特征，这里逐条照做：
     * ① 不是圆的 —— 4–5 个大小不一的 blob 叠出来，边缘自然不规则；
     * ② 有冷暖差 —— 每簇主色再混一点紫 / 青 / 琥珀，单色会显得假；
     * ③ 有暗隙 —— 用 destination-out 挖几道低透明度的暗缝，看起来像被尘埃遮住；
     * ④ 有亮结 —— 云里点几颗更亮的小凸起，人眼会把它读成"深度"。
     *
     * 烘焙一次、按簇键缓存；每帧只做一次 drawImage。
     */
    const cloudSprites = new Map();
    const CLOUD_SIZE = 256;
    /** 和主色搭配的冷/暖邻居：单色云最假，混一点邻近色立刻"有气质" */
    const CLOUD_COMPANIONS = [
      [122, 96, 226],
      [70, 148, 208],
      [228, 168, 112],
    ];
    function cloudSprite(rgb, cacheKey) {
      const key = `${rgb[0]},${rgb[1]},${rgb[2]}:${cacheKey}`;
      const cached = cloudSprites.get(key);
      if (cached !== undefined) return cached;
      const sprite = document.createElement('canvas');
      sprite.width = CLOUD_SIZE;
      sprite.height = CLOUD_SIZE;
      const ctx = sprite.getContext('2d');
      if (ctx === null) {
        cloudSprites.set(key, sprite);
        return sprite;
      }
      const half = CLOUD_SIZE / 2;
      // ① + ② 叠 blob，每个 blob 稍微偏色
      const blobs = 4 + Math.floor(rand01(`${key}:n`) * 2);
      for (let index = 0; index < blobs; index += 1) {
        const cx = half + (rand01(`${key}:x:${index}`) - 0.5) * half * 0.95;
        const cy = half + (rand01(`${key}:y:${index}`) - 0.5) * half * 0.95;
        const radius = half * (0.38 + rand01(`${key}:r:${index}`) * 0.42);
        const companion = CLOUD_COMPANIONS[index % CLOUD_COMPANIONS.length];
        const tint = mixRgb(rgb, companion, 0.22 + rand01(`${key}:t:${index}`) * 0.3);
        const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        gradient.addColorStop(0, `rgba(${tint.join(',')},0.22)`);
        gradient.addColorStop(0.45, `rgba(${tint.join(',')},0.08)`);
        gradient.addColorStop(1, `rgba(${tint.join(',')},0)`);
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, CLOUD_SIZE, CLOUD_SIZE);
      }
      // ③ 暗隙：挖掉几条低透明度的缝，云才有"纤维感"
      ctx.globalCompositeOperation = 'destination-out';
      const veins = 14 + Math.floor(rand01(`${key}:v`) * 10);
      for (let index = 0; index < veins; index += 1) {
        const cx = half + (rand01(`${key}:vx:${index}`) - 0.5) * CLOUD_SIZE * 0.9;
        const cy = half + (rand01(`${key}:vy:${index}`) - 0.5) * CLOUD_SIZE * 0.9;
        const radius = 10 + rand01(`${key}:vr:${index}`) * 34;
        const punch = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        punch.addColorStop(0, `rgba(0,0,0,${0.1 + rand01(`${key}:va:${index}`) * 0.16})`);
        punch.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = punch;
        ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
      }
      // ④ 亮结
      ctx.globalCompositeOperation = 'source-over';
      const knots = 5 + Math.floor(rand01(`${key}:k`) * 5);
      for (let index = 0; index < knots; index += 1) {
        const cx = half + (rand01(`${key}:kx:${index}`) - 0.5) * half * 1.1;
        const cy = half + (rand01(`${key}:ky:${index}`) - 0.5) * half * 1.1;
        const radius = 3 + rand01(`${key}:kr:${index}`) * 7;
        const knot = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        const glow = mixRgb(rgb, [255, 255, 255], 0.45);
        knot.addColorStop(0, `rgba(${glow.join(',')},0.55)`);
        knot.addColorStop(1, `rgba(${glow.join(',')},0)`);
        ctx.fillStyle = knot;
        ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
      }
      cloudSprites.set(key, sprite);
      return sprite;
    }

    /**
     * 每帧的云层计划（纯函数，方便离线盯住排序与剔除）。
     *
     * 只在最高画质档出云：云是整屏级别的填充，掉帧时必须第一个让位。
     * 排序按深度**从远到近**，近云才能压住远处的星，画面才有前后关系。
     *
     * @param {Array<{x: number, y: number, depth: number, ghost: boolean, point: {cluster: string, rgb: number[]}}>} projected
     * @param {number} width
     * @param {number} height
     * @param {{quality?: number}} [options]
     * @returns {Array<{cluster: string, rgb: number[], x: number, y: number, radius: number, depth: number}>}
     */
    function clusterCloudPlan(projected, width, height, options = {}) {
      const quality = options?.quality ?? 2;
      if (quality < 2) return [];
      const groups = new Map();
      for (const p of projected) {
        if (p.ghost) continue;
        const key = String(p.point.cluster ?? '其它');
        const acc = groups.get(key) ?? { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, n: 0, depth: 0, rgb: p.point.rgb, members: [] };
        acc.minX = Math.min(acc.minX, p.x);
        acc.maxX = Math.max(acc.maxX, p.x);
        acc.minY = Math.min(acc.minY, p.y);
        acc.maxY = Math.max(acc.maxY, p.y);
        acc.n += 1;
        acc.depth += p.depth ?? 0;
        acc.members.push(p.point.id);
        groups.set(key, acc);
      }
      const plan = [];
      const focus = options?.focus ?? null;
      const onlyFocus = options?.onlyFocus === true;
      const pulseOf = typeof options?.pulseOf === 'function' ? options.pulseOf : null;
      for (const [cluster, acc] of groups) {
        if (acc.n === 0) continue;
        const x = (acc.minX + acc.maxX) / 2;
        const y = (acc.minY + acc.maxY) / 2;
        // 云比点云范围再外扩一圈，才像"星嵌在云里"；上限压到 440：太大的云就是一团雾
        const radius = Math.min(440, Math.max(100, Math.hypot((acc.maxX - acc.minX) / 2, (acc.maxY - acc.minY) / 2) * 1.05 + 72));
        if (x < -radius || x > width + radius || y < -radius || y > height + radius) continue;
        // 焦点模式：这一簇里有没有命中 —— 没有的话整片云也要跟着压暗，
        // 否则按钮按下后星暗了、云还亮着，看起来就是"还有些亮着"
        const focused = focus === null || !onlyFocus || acc.members.some((id) => focus.has(id));
        /**
         * 云要**跟着簇里的星一起呼吸**：取成员呼吸值的平均。
         *
         * 之前云有自己的 4.2 秒正弦（±8%），和星星的相位没关系 —— 结果就是
         * "星在呼吸、包着它的那团光没动"，看着很别扭。云是星的可见外壳，
         * 外壳必须跟着内核走，否则两层会互相拆台。
         */
        let pulse = 0;
        if (pulseOf !== null) {
          let sum = 0;
          let counted = 0;
          for (const member of acc.members) {
            const value = pulseOf(member);
            if (!Number.isFinite(value)) continue;
            sum += value;
            counted += 1;
          }
          pulse = counted === 0 ? 0 : sum / counted;
        }
        plan.push({ cluster, rgb: acc.rgb, x, y, radius, depth: acc.depth / acc.n, focused, pulse });
      }
      plan.sort((left, right) => right.depth - left.depth);
      return plan;
    }

    /** 画云层：加性合成，微弱呼吸；云在星**之下**、但在远端星之上（靠深度排序近似）。 */
    function paintClusterClouds(ctx, projected, width, height, options = {}) {
      const plan = clusterCloudPlan(projected, width, height, options);
      if (plan.length === 0) return 0;
      const presence = options?.presence ?? null;
      ctx.globalCompositeOperation = 'lighter';
      let drawn = 0;
      for (const cloud of plan) {
        // 云的通透度也跟着轮廓淡入淡出（回放时不能硬切）
        let vis = 1;
        if (presence !== null) {
          let sum = 0;
          let count = 0;
          for (const p of projected) {
            if (String(p.point.cluster ?? '其它') !== cloud.cluster) continue;
            sum += presence.get(p.point.id) ?? 1;
            count += 1;
          }
          vis = count === 0 ? 0 : sum / count;
        }
        if (vis < 0.05) continue;
        // 越远越淡：空气透视
        const depthFade = Math.max(0.35, Math.min(1, 1.35 - cloud.depth / 2600));
        // 云跟着簇内星的平均呼吸一起动（幅度比星略小：外壳不该比内核更跳）
        const breathe = 1 + 0.28 * (cloud.pulse ?? 0);
        // 焦点模式：没命中的簇整片压到 18%，跟被压暗的星保持一致
        ctx.globalAlpha = 0.14 * depthFade * breathe * vis * (cloud.focused ? 1 : 0.18);
        // 云的尺寸也跟着呼吸一起胀缩，和星的光晕同步（只动透明度会显得"壳是死的"）
        const cloudSize = cloud.radius * 2 * (1 + 0.06 * (cloud.pulse ?? 0));
        ctx.drawImage(cloudSprite(cloud.rgb, cloud.cluster), cloud.x - cloudSize / 2, cloud.y - cloudSize / 2, cloudSize, cloudSize);
        drawn += 1;
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      return drawn;
    }

    /** 帧内复用：按透明度档位分桶，把上千条线压成十几次 stroke。 */
    const EDGE_BUCKETS = 10;
    const edgeBuckets = Array.from({ length: EDGE_BUCKETS }, () => []);
    /** 取代金线单独一桶：不能和最高透明度档共用，否则会被染成金色。 */
    const goldScratch = [];
    /**
     * 共激活线（青）也单独一桶，理由同上：颜色不同就不能共用一个 strokeStyle。
     * 它和冷蓝的相似度线、金色取代线是三种完全不同的关系，混在一起就都读不出来了。
     */
    const recallScratch = [];

    /**
     * 星点用预热精灵贴图：比逐点 arc()+fill() 便宜一个数量级。
     * 这是给「光晕」用的柔光精灵（只有热点会用到）。
     */
    const POINT_SPRITE_SIZE = 40;
    const pointSprites = new Map();
    function pointSprite(rgb, tone = 1) {
      const key = `${rgb[0]},${rgb[1]},${rgb[2]}:${tone}`;
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
      const body = tone === 0 ? mixRgb(rgb, HAZE_RGB, 0.4) : tone === 2 ? mixRgb(rgb, [255, 255, 255], 0.2) : rgb;
      const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
      gradient.addColorStop(0, `rgba(${body.join(',')},1)`);
      gradient.addColorStop(0.18, `rgba(${body.join(',')},1)`);
      gradient.addColorStop(0.45, `rgba(${body.join(',')},0.34)`);
      gradient.addColorStop(1, `rgba(${body.join(',')},0)`);
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(half, half, half, 0, Math.PI * 2);
      ctx.fill();
      pointSprites.set(key, sprite);
      return sprite;
    }

    /** 颜色混合：把 rgb 朝 target 拉 t（0–1）。 */
    function mixRgb(rgb, target, t) {
      const k = Math.max(0, Math.min(1, t));
      return [
        Math.round(rgb[0] + (target[0] - rgb[0]) * k),
        Math.round(rgb[1] + (target[1] - rgb[1]) * k),
        Math.round(rgb[2] + (target[2] - rgb[2]) * k),
      ];
    }

    /** 远处的星往冷灰蓝拉：这是"空气透视"，也是画面不显平的关键之一。 */
    const HAZE_RGB = [86, 108, 146];

    /**
     * 每颗星都有的「柔光层」精灵。
     *
     * 真正的星是「亮核 + 彩色扩散」，只有实心点就像贴纸。这一层用加性合成叠上去，
     * 再配一张低分辨率的 bloom，才会看起来真的在发光。按色调桶缓存（3 档 × 6 种层色）。
     */
    const softGlowSprites = new Map();
    function softGlowSprite(rgb, tone = 1) {
      const key = `${rgb[0]},${rgb[1]},${rgb[2]}:${tone}`;
      const cached = softGlowSprites.get(key);
      if (cached !== undefined) return cached;
      const size = 64;
      const sprite = document.createElement('canvas');
      sprite.width = size;
      sprite.height = size;
      const ctx = sprite.getContext('2d');
      if (ctx === null) {
        softGlowSprites.set(key, sprite);
        return sprite;
      }
      const half = size / 2;
      const body = tone === 0 ? mixRgb(rgb, HAZE_RGB, 0.4) : tone === 2 ? mixRgb(rgb, [255, 255, 255], 0.18) : rgb;
      const peak = tone === 0 ? 0.3 : tone === 2 ? 0.62 : 0.46;
      const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
      gradient.addColorStop(0, `rgba(${body.join(',')},${peak})`);
      gradient.addColorStop(0.28, `rgba(${body.join(',')},${peak * 0.5})`);
      gradient.addColorStop(0.62, `rgba(${body.join(',')},${peak * 0.14})`);
      gradient.addColorStop(1, `rgba(${body.join(',')},0)`);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, size, size);
      softGlowSprites.set(key, sprite);
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
    function dotSprite(rgb, step, tone = 1) {
      const key = `${rgb[0]},${rgb[1]},${rgb[2]}:${step}:${tone}`;
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
      // 远：拉向冷灰、整体压暗；近：提亮并让白核更实 —— 只用三档，缓存得住
      const body = tone === 0 ? mixRgb(rgb, HAZE_RGB, 0.42) : tone === 2 ? mixRgb(rgb, [255, 255, 255], 0.16) : rgb;
      const bodyAlpha = tone === 0 ? 0.78 : tone === 2 ? 1 : 0.95;
      ctx.fillStyle = `rgba(${body.join(',')},${bodyAlpha})`;
      ctx.beginPath();
      ctx.arc(half, half, Math.max(0.5, half - 0.35), 0, Math.PI * 2);
      ctx.fill();
      if (step >= 8) {
        // 近处的大星给一点亮核，远的小点不需要
        ctx.fillStyle = tone === 0 ? 'rgba(190,205,230,0.32)' : tone === 2 ? 'rgba(255,255,255,0.78)' : 'rgba(255,255,255,0.55)';
        ctx.beginPath();
        ctx.arc(half, half, Math.max(0.5, half * (tone === 2 ? 0.5 : 0.42)), 0, Math.PI * 2);
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
      // 金线（取代关系）可以整类关掉：库里只有一两条时，一条亮金线飘在一堆冷色细线里很扎眼
      const showGold = options?.showGold !== false;
      // 共激活线同理：新库还没积累出关系时，这一层是空的，开关也不该让人以为坏了
      const showRecall = options?.showRecall !== false;
      // 「只看」：把相似度线整片藏起来，只留共激活线与取代金线 ——
      // 这一层的边天生稀薄，混在两千条蓝线里根本看不出有没有长出来
      const onlyRecall = options?.onlyRecall === true;
      for (let bucket = 0; bucket < EDGE_BUCKETS; bucket += 1) edgeBuckets[bucket].length = 0;
      goldScratch.length = 0;
      recallScratch.length = 0;
      let goldCount = 0;
      let recallCount = 0;
      let total = 0;
      let curved = 0;
      for (let index = 0; index < edges.length; index += 1) {
        const edge = edges[index];
        if (edge.kind === 'supersede' && !showGold) continue;
        if (edge.kind === 'recall' && !showRecall) continue;
        if (onlyRecall && edge.kind !== 'recall' && edge.kind !== 'supersede') continue;
        const a = positions.get(edge.a);
        const b = positions.get(edge.b);
        if (a === undefined || b === undefined) continue;
        // 可见度取两端最小值：一端还在淡出，整条线跟着淡，不会突然断
        const vis = presence === null ? (a.ghost || b.ghost ? 0 : 1) : Math.min(presence.get(edge.a) ?? 1, presence.get(edge.b) ?? 1);
        if (vis < 0.02) continue;
        if (onlyFocus && focus !== null && !(focus.has(edge.a) && focus.has(edge.b))) continue;
        const near = (a.f + b.f) * 0.5;
        // 共激活线用另一条曲线：它的 score 是"相对强度"（0–1），相似度线的 score 是 Jaccard，
        // 两者量纲不同，套同一个系数会让一类关系全军覆没
        const alpha =
          edge.kind === 'recall'
            ? Math.min(0.55, (0.06 + edge.score * 0.34) * near * 1.7) * vis
            : Math.min(0.5, (0.03 + edge.score * 0.18) * near * 1.7) * vis;
        // 远处几乎看不见的线直接跳过：省下的正是曲线光栅化的主要成本
        if (alpha < 0.03) continue;
        const mid = projectWorld !== null && edge.control !== undefined ? projectWorld(edge.control) : null;
        const target = edge.kind === 'supersede' ? goldScratch : edge.kind === 'recall' ? recallScratch : edgeBuckets[bucketOf(alpha, 0.5)];
        target.push(a.x, a.y, mid === null ? (a.x + b.x) / 2 : mid.x, mid === null ? (a.y + b.y) / 2 : mid.y, b.x, b.y);
        if (edge.kind === 'supersede') goldCount += 1;
        if (edge.kind === 'recall') recallCount += 1;
        curved += 1;
        total += 1;
      }
      ctx.globalCompositeOperation = 'lighter';
      for (let bucket = 0; bucket < EDGE_BUCKETS; bucket += 1) {
        const list = edgeBuckets[bucket];
        if (list.length === 0) continue;
        const alpha = 0.04 + (bucket / (EDGE_BUCKETS - 1)) * 0.24;
        // 线宽跟着深度走：近处的丝带略粗、远处的细到几乎看不见 —— 统一 1px 是"网格布"的来源
        ctx.lineWidth = bucket >= EDGE_BUCKETS * 0.6 ? 1.3 : 0.8;
        ctx.strokeStyle = `rgba(150,185,240,${alpha.toFixed(3)})`;
        ctx.beginPath();
        for (let index = 0; index < list.length; index += 6) {
          ctx.moveTo(list[index], list[index + 1]);
          ctx.quadraticCurveTo(list[index + 2], list[index + 3], list[index + 4], list[index + 5]);
        }
        ctx.stroke();
      }
      if (goldScratch.length > 0) {
        // 金线是"强调"，不是"主角"：0.62 的亮度配 1.5px 在冷色细线里太扎眼，压到 0.4 / 1.3
        ctx.lineWidth = 1.3;
        ctx.strokeStyle = 'rgba(233,192,122,.40)';
        ctx.beginPath();
        for (let index = 0; index < goldScratch.length; index += 6) {
          ctx.moveTo(goldScratch[index], goldScratch[index + 1]);
          ctx.quadraticCurveTo(goldScratch[index + 2], goldScratch[index + 3], goldScratch[index + 4], goldScratch[index + 5]);
        }
        ctx.stroke();
      }
      if (recallScratch.length > 0) {
        // 青色 = "这两条一起被想起来过"。比金线更淡、更细：
        // 关系是会变的（衰减、重连），它不是结论，只是使用留下的痕迹。
        // 「只看」模式下它是画面主角，给足亮度与线宽。
        ctx.lineWidth = onlyRecall ? 1.5 : 1.1;
        ctx.strokeStyle = onlyRecall ? 'rgba(140,232,204,.58)' : 'rgba(126,224,196,.40)';
        ctx.beginPath();
        for (let index = 0; index < recallScratch.length; index += 6) {
          ctx.moveTo(recallScratch[index], recallScratch[index + 1]);
          ctx.quadraticCurveTo(recallScratch[index + 2], recallScratch[index + 3], recallScratch[index + 4], recallScratch[index + 5]);
        }
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.lineWidth = 1;
      return { total, goldCount, recallCount, curved, buckets: EDGE_BUCKETS };
    }

    /** 可见度缓动：帧率无关（指数趋近），让时间轴上的星是「淡出/淡入」而不是硬切。 */
    function easePresence(current, target, dtMs) {
      const k = 1 - Math.exp(-Math.max(0, dtMs) / 110);
      const next = current + (target - current) * k;
      return Math.abs(next - target) < 0.004 ? target : next;
    }

    /**
     * 深空底：近黑基底 + 极弱的银河带 + 稀疏星尘 + 强暗角，烘焙一次当 CSS 背景。
     *
     * 两轮试错的结论：背景**不能自己"有内容"**。
     * - 大面低频渐变 = 糊（0.33 的毛病）；
     * - 上万颗星尘 + 明显银河带 = 抢眼（0.34 的毛病）：背景上又有一片星星，跟记忆星打架，
     *   整张图就变成"有很浓的背景感"的壁纸。
     *
     * 深空之所以深，是因为**背后几乎是空的**：真正的层次交给场景里的星、云、连线去撑，
     * 背景只负责"黑得下去"和"边缘收得住"。所以这里只剩：近黑基底、几乎看不见的银河痕迹、
     * 稀疏到像尘埃的碎光，以及一道很长的暗角。
     */
    function paintDeepSpace(canvas, width, height, dpr, colors) {
      const pad = 24;
      const w = width + pad;
      const h = height + pad;
      const scale = Math.min(1.5, Math.max(1, dpr || 1));
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext('2d');
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const palette = Array.isArray(colors) && colors.length > 0 ? colors : [[120, 150, 230]];

      // ① 基底：接近纯黑，只有一点极淡的冷调起伏（肉眼几乎看不出，但能避免"死黑一块板"）
      const base = ctx.createLinearGradient(0, 0, w * 0.3, h);
      base.addColorStop(0, '#010207');
      base.addColorStop(0.5, '#000208');
      base.addColorStop(1, '#000104');
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, w, h);

      // ② 银河痕迹：两层压扁椭圆，透明度低到"如果不去看就看不见"
      const bandAngle = -0.42 + rand01('band:angle') * 0.14;
      for (let layer = 0; layer < 2; layer += 1) {
        const rgb = palette[(layer + 1) % palette.length];
        const cx = w * (0.36 + layer * 0.18);
        const cy = h * (0.5 - layer * 0.08);
        const radius = Math.max(w, h) * (0.52 + layer * 0.1);
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(bandAngle + layer * 0.06);
        ctx.scale(1, 0.16 + layer * 0.04);
        const band = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
        band.addColorStop(0, `rgba(${rgb.join(',')},0.022)`);
        band.addColorStop(0.55, `rgba(${rgb.join(',')},0.008)`);
        band.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = band;
        ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
        ctx.restore();
      }

      // ③ 尘埃暗隙：只留三道极淡的，给银河一点层次，不构成"结构"
      for (let index = 0; index < 3; index += 1) {
        const cx = w * (0.2 + rand01(`dust:x:${index}`) * 0.6);
        const cy = h * (0.25 + rand01(`dust:y:${index}`) * 0.5);
        const radius = Math.max(w, h) * (0.12 + rand01(`dust:r:${index}`) * 0.16);
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(bandAngle + (rand01(`dust:a:${index}`) - 0.5) * 0.6);
        ctx.scale(1, 0.3);
        const lane = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
        lane.addColorStop(0, `rgba(0,1,4,${0.1 + rand01(`dust:o:${index}`) * 0.1})`);
        lane.addColorStop(1, 'rgba(0,1,4,0)');
        ctx.fillStyle = lane;
        ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
        ctx.restore();
      }

      // ④ 碎光：稀疏、极暗 —— 密度大约是每 2600 平方像素一颗，亮度压到"尘埃"级别，
      //    不能有任何一颗亮到能跟记忆星抢注意力
      ctx.globalCompositeOperation = 'lighter';
      const dustCount = Math.min(1800, Math.round((w * h) / 2600));
      for (let index = 0; index < dustCount; index += 1) {
        const x = rand01(`ds:x:${index}`) * w;
        const y = rand01(`ds:y:${index}`) * h;
        const bright = rand01(`ds:b:${index}`) ** 3.4;
        const size = 0.5 + bright * 0.8;
        const warm = rand01(`ds:t:${index}`) > 0.85;
        const rgb = warm ? [255, 232, 200] : [186, 204, 240];
        ctx.fillStyle = `rgba(${rgb.join(',')},${(0.04 + bright * 0.26).toFixed(3)})`;
        ctx.fillRect(x, y, size, size);
      }
      ctx.globalCompositeOperation = 'source-over';

      // ⑤ 暗角：这是"深"的主力 —— 边缘压到近黑，视线只能收进中间那片海
      const vignette = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.2, w / 2, h / 2, Math.max(w, h) * 0.82);
      vignette.addColorStop(0, 'rgba(0,0,0,0)');
      vignette.addColorStop(0.6, 'rgba(0,1,5,0.5)');
      vignette.addColorStop(1, 'rgba(0,1,5,0.94)');
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, w, h);
      return canvas;
    }

    /**
     * 星点绘制（v1 光效）。
     *
     * 三层结构，缺一层就显"贴纸感"：
     * ① **柔光层**：每颗星都有的彩色扩散，加性合成（`lighter`），近强远弱；
     * ② **实体层**：实心点（按深度分三档色调：远冷灰、中本色、近提白）；
     * ③ **焦点层**：选中金环 / 悬停细环 / 召回命中只有更亮的光晕。
     *
     * 另外可传 `bloomCtx`（1/4 分辨率的离屏上下文，已 setTransform(scale)）：
     * 柔光会顺带画一份进去，最后整张叠回主画布就是 bloom。
     * 主循环先画柔光再画实体，所以远处的光会被近处的星压住 —— 有前后关系。
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
      const halo = options?.halo === true && quality >= 1;
      const bloomCtx = options?.bloomCtx ?? null;
      const breathMode = options?.breathMode ?? 'stars';

      // 先把每颗星的可见度/尺寸算一遍（两遍绘制共用，避免重复算）
      let count = 0;
      for (let index = 0; index < projected.length; index += 1) {
        const p = projected[index];
        const point = p.point;
        const vis = presence === null ? (p.ghost ? 0 : 1) : presence.get(point.id) ?? 1;
        p.vis = vis < 0.02 ? 0 : vis;
        if (p.vis === 0) continue;
        const isFocus = focus !== null && focus.has(point.id);
        const dim = onlyFocus && focus !== null && !isFocus;
        p.base = Math.max(1.1, point.radius * (isFocus ? 1.7 : 1) * p.f * 2.6) * (0.55 + 0.45 * p.vis);
        p.tone = toneOf(p.f);
        p.depthAlpha = (dim ? 0.12 : Math.min(1, 0.22 + p.f * 1.05)) * p.vis;
        p.hot = isFocus || point.id === hovered || point.id === selected;
        // 呼吸的原始振荡（−1…1）：两遍绘制共用，避免各算一次
        p.pulse = pulseFor(breathMode, time, point.phase ?? 0, p.hot);
        count += 1;
      }

      // ① 柔光层：加性合成，近处更亮更大；每颗星按自己的相位慢速呼吸
      if (halo) {
        ctx.globalCompositeOperation = 'lighter';
        if (bloomCtx !== null) bloomCtx.globalCompositeOperation = 'lighter';
        for (let index = 0; index < projected.length; index += 1) {
          const p = projected[index];
          if (p.vis === 0) continue;
          const sizeScale = p.tone === 2 ? 7.4 : p.tone === 1 ? 6.2 : 5;
          /**
           * 呼吸：命中/悬停/选中的星幅度大一点（50%），其余 34%。
           *
           * 关键参数是被"看不出来"教出来的：
           * ① 振幅必须够 —— 10% 的透明度起伏在暗背景上等于没有；
           * ② 光晕**尺寸**也要跟着胀缩（幅度取透明度的一半），
           *    动尺寸比动透明度在余光里明显得多 —— 这才是"呼吸"被看见的原因。
           *
           * 但整体亮度被用户吐槽过"有点过于亮"：所以这里把三档色调系数从
           * 0.5/0.7/0.95 压到 0.34/0.5/0.7 —— 呼吸照旧，底噪降下来。
           */
          const amp = breathAmplitude(breathMode, p.hot);
          const size = p.base * sizeScale * (1 + amp * 0.55 * p.pulse);
          const alpha = Math.min(1, p.depthAlpha * (p.tone === 0 ? 0.34 : p.tone === 2 ? 0.7 : 0.5) * (1 + amp * p.pulse));
          const sprite = softGlowSprite(p.point.rgb, p.tone);
          ctx.globalAlpha = alpha;
          ctx.drawImage(sprite, p.x - size / 2, p.y - size / 2, size, size);
          if (bloomCtx !== null) {
            const bloomSize = size * 1.4;
            bloomCtx.globalAlpha = Math.min(1, alpha * 0.85);
            bloomCtx.drawImage(sprite, p.x - bloomSize / 2, p.y - bloomSize / 2, bloomSize, bloomSize);
          }
        }
        ctx.globalCompositeOperation = 'source-over';
        if (bloomCtx !== null) bloomCtx.globalCompositeOperation = 'source-over';
      }

      // ② 实体层 + ③ 焦点层
      ctx.globalCompositeOperation = 'source-over';
      for (let index = 0; index < projected.length; index += 1) {
        const p = projected[index];
        if (p.vis === 0) continue;
        const point = p.point;
        const [r, g, b] = point.rgb;
        const isFocus = focus !== null && focus.has(point.id);
        const isHot = point.id === hovered || point.id === selected;
        // 直径按设备像素取整到离散档位：同一档位 1:1 贴图，采样恒定，不闪。
        // 档位带迟滞：深度缓慢变化时不要在两档之间反复横跳（那本身就是一种闪烁）。
        const diameter = Math.min(40, Math.max(2, Math.round(p.base * 2 * dpr)));
        const target = nearestSizeStep(diameter);
        const current = point.dotStep ?? target;
        const step = Math.abs(target - current) >= 2 || Math.abs(diameter - current) > 1.2 ? target : current;
        point.dotStep = step;
        const sprite = dotFor(point.rgb, step, p.tone);
        // 位置**不吸附**：尺寸恒定后，亚像素位置只是同一张图的平移，采样平滑；
        // 反过来吸附到整像素会让慢速转动变成「每两帧跳一格」，那才是顿感的来源。
        const leftDev = p.x * dpr - (step >> 1);
        const topDev = p.y * dpr - (step >> 1);
        /**
         * 三种高亮必须看得出来源，不能都画成"被点中的样子"：
         * - **选中**（我刚点的）：金色实心环 + 最强光晕，常亮不呼吸；
         * - **悬停**（鼠标在上面）：同色细环 + 轻呼吸；
         * - **本轮召回命中**（焦点）：只有柔和光晕，**不画环** ——
         *   以前它和选中用同一个呼吸环，库一多就有七八颗星同时在闪，看着像"没点就选中了"。
         */
        if (quality > 0 && (isFocus || isHot)) {
          const isSelected = point.id === selected;
          const isHovered = point.id === hovered;
          const glowSprite = glowFor(point.rgb, p.tone);
          const glowSize = p.base * 7 * (1 + 0.18 * p.pulse);
          ctx.globalAlpha = Math.min(1, p.depthAlpha * (isSelected ? 0.42 : isHovered ? 0.34 : 0.24) * (1 + 0.3 * p.pulse));
          ctx.drawImage(glowSprite, p.x - glowSize / 2, p.y - glowSize / 2, glowSize, glowSize);
          if (isSelected || isHovered) {
            ctx.globalAlpha = (isSelected ? 0.95 : 0.5 + 0.25 * Math.sin(time / 600)) * p.vis;
            ctx.strokeStyle = isSelected ? 'rgba(233,192,122,0.95)' : `rgba(${r},${g},${b},1)`;
            ctx.lineWidth = isSelected ? 1.6 : 1.1;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.base * 3.2, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
        /**
         * 实心核也带一点呼吸：
         * - 光效开着时只有 16%（光晕已经把"呼吸"演得很明显，核再大就糊）；
         * - 光效关掉时没有光晕可动，**呼吸只能落在核上**，所以给到 30% ——
         *   这是"关掉光效后完全看不出呼吸"的修法（用户实测反馈）。
         */
        const coreAmp = halo ? 0.16 : 0.3;
        ctx.globalAlpha = Math.min(1, p.depthAlpha * (1 + coreAmp * p.pulse));
        ctx.drawImage(sprite, leftDev / dpr, topDev / dpr, step / dpr, step / dpr);
      }
      ctx.globalAlpha = 1;
      return count;
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
      const onlyFocus = options?.onlyFocus === true;
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
        // 焦点模式：没命中的标签也要压暗 —— 否则星暗了、标签还亮着，看起来就是"没关干净"
        const faded = onlyFocus && focus !== null && !focus.has(point.id) ? 0.12 : 1;
        // 引线：一条 1px 的细线指向它的星（比"方框里塞文字"干净得多）
        ctx.globalAlpha = next * faded * (hot ? 0.5 : 0.22);
        ctx.fillStyle = hot ? 'rgba(130,175,255,0.85)' : 'rgba(104,128,178,0.55)';
        if (planX > p.x) ctx.fillRect(p.x + 3, planY - 3, Math.max(1, planX - 5 - (p.x + 3)), 1);
        else ctx.fillRect(planX + planW + 4, planY - 3, Math.max(1, p.x - 3 - (planX + planW + 4)), 1);
        // 文字用"描边当底衬"：实心方框是工具感的来源，而纯描边在任何背景上都读得清
        ctx.globalAlpha = next * faded * (hot ? 1 : 0.82);
        ctx.lineWidth = 2.6;
        ctx.strokeStyle = 'rgba(5,9,17,0.82)';
        ctx.strokeText(point.label, planX, planY);
        ctx.fillStyle = hot ? '#eef4ff' : '#b3c2da';
        ctx.fillText(point.label, planX, planY);
        drawn += 1;
      }
      ctx.globalAlpha = 1;
      return drawn;
    }
    //#endregion

    /**
     * 呼吸模式 → 某颗星此刻的振荡值（−1…1）。
     *
     * 用户"说不出来"的时候，光靠调数值是猜。这几种模式覆盖的是**不同的审美假设**，
     * 一次点一个、当场对比，比继续盲调有效：
     * - `stars`：逐星不同相位（像一群星各自呼吸）—— 默认；
     * - `focus`：只有本轮命中/悬停/选中的星在呼吸（其余完全静止）；
     * - `sea`：**整片同步**一起缓慢起伏（像一次深呼吸），幅度更小；
     * - `off`：静态。
     *
     * @param {'stars'|'focus'|'sea'|'off'} mode
     * @param {number} time
     * @param {number} phase
     * @param {boolean} hot 是否命中/悬停/选中
     * @returns {number}
     */
    function pulseFor(mode, time, phase, hot) {
      if (mode === 'off') return 0;
      if (mode === 'sea') {
        // 整片一起：固定相位、5.2 秒一次，慢到能数得清
        return Math.sin((time / 5200) * Math.PI * 2);
      }
      if (mode === 'focus') return hot ? breathAt(time, phase) : 0;
      return breathAt(time, phase);
    }

    /**
     * 呼吸幅度：整片模式要更克制（同步的大幅脉动最容易显廉价）。
     * @param {'stars'|'focus'|'sea'|'off'} mode
     * @param {boolean} hot
     * @returns {number}
     */
    function breathAmplitude(mode, hot) {
      if (mode === 'sea') return 0.16;
      if (mode === 'off') return 0;
      return hot ? 0.5 : 0.34;
    }

    //#region 记忆海画布
    function MemorySea({ memories, recallEdges, dataKey, selectedId, onSelect, stressToken, onStressReport, animate, scrubAt, onScrub, focusIds }) {
      const wrapRef = React.useRef(null);
      const stageRef = React.useRef(null);
      const canvasRef = React.useRef(null);
      const badgeRef = React.useRef(null);
      const nebulaRef = React.useRef(null);
      const grainRef = React.useRef(null);
      const modelRef = React.useRef({
        points: [],
        edges: [],
        /**
         * 共激活边（使用痕迹）：和 `edges`（关键词相似）分开存。
         * 两类关系的更新节奏完全不同 —— 相似度只在数据变化时重算，
         * 共激活边每轮召回都在动，混在一个数组里就得为了几条边重排整片海。
         */
        recallEdges: [],
        /** 绘制用的总表（edges + recallEdges），两个来源任一变化时重建一次，帧内不再拼数组 */
        allEdges: [],
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
        /** 本次手势的按下位置与时刻（点击判定用，每次按下覆盖） */
        down: null,
        velocity: null,
        lastMoveAt: 0,
        autoOrbit: true,
        showLabels: true,
        onlyFocus: false,
        /** 光效：加性柔光 + bloom。可以关掉退回"朴素"渲染（设置记忆在 localStorage） */
        glow: (() => {
          try {
            return window.localStorage.getItem('memory-loom:glow') !== '0';
          } catch {
            return true;
          }
        })(),
        /** 呼吸模式：stars / focus / sea / off（记忆在 localStorage） */
        breathMode: (() => {
          try {
            const saved = window.localStorage.getItem('memory-loom:breath');
            return saved === 'focus' || saved === 'sea' || saved === 'off' ? saved : 'stars';
          } catch {
            return 'stars';
          }
        })(),
        /** 是否画金线（取代关系）：库里只有一两条时会显得突兀，给个开关 */
        showGold: (() => {
          try {
            return window.localStorage.getItem('memory-loom:gold') !== '0';
          } catch {
            return true;
          }
        })(),
        /**
         * 共激活线的显示方式：off / on / only。
         *
         * 为什么不是开关：这一层的边天生稀薄（真实库跑了 6 轮才有 6 条），
         * 开和关在画面上几乎看不出差别 —— 用户点了按钮会以为没生效。
         * `only` 把相似度线整片藏起来只留青线，那一眼就能看出"关系到底长出来没有"。
         */
        recallMode: (() => {
          try {
            const saved = window.localStorage.getItem('memory-loom:recall');
            if (saved === '0' || saved === 'off') return 'off';
            if (saved === 'only') return 'only';
            return 'on';
          } catch {
            return 'on';
          }
        })(),
        /** bloom 用的 1/4 分辨率离屏画布（懒建） */
        bloom: null,
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
      /** 关系表也要用 ref 拿最新的：dataKey effect 只在布局变化时跑，不能依赖它的闭包 */
      const recallEdgesRef = React.useRef(recallEdges);
      recallEdgesRef.current = recallEdges;

      /**
       * 重建共激活边，并刷新绘制用的总表。
       *
       * 单独抽出来是因为它有两个触发源：**位置**变了（点换了）和**关系**变了（又一起被
       * 想起来过）。两者都只该动线、不该重排位置 —— 每轮召回都重排一次，画面会一直抖。
       */
      const syncRecallEdges = React.useCallback((model) => {
        model.recallEdges = buildRecallEdges(model.points, recallEdgesRef.current);
        model.allEdges = model.recallEdges.length === 0 ? model.edges : model.edges.concat(model.recallEdges);
      }, []);

      React.useEffect(() => {
        const model = modelRef.current;
        const { points } = layoutSea(memoriesRef.current);
        model.points = points;
        model.edges = addCohesion(buildEdges(points, { maxNeighbors: 4, maxEdges: 1200, minScore: 0.15 }), points, { maxNeighbors: 4 });
        syncRecallEdges(model);
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

      /**
       * 关系变化只重连、不重排。
       *
       * 签名只取「条数 + 最强值」：强度每次共现都会微涨，逐条比对没有意义；
       * 条数变了或出现了更强的关系，就说明这一轮确实长出了新东西。
       */
      const recallKey = React.useMemo(() => {
        const list = Array.isArray(recallEdges) ? recallEdges : [];
        let peak = 0;
        for (const row of list) peak = Math.max(peak, Number(row?.strength) ?? 0);
        return `${list.length}:${peak.toFixed(3)}`;
      }, [recallEdges]);
      React.useEffect(() => {
        syncRecallEdges(modelRef.current);
      }, [recallKey, dataKey, syncRecallEdges]);

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
          // 深空底跟着尺寸重建，导出成 CSS 背景图（合成器负责平铺，帧内零成本）。
          // 这次要**满分辨率**：上一版半分辨率放大，几万颗星尘全糊成雾，那正是"糊"的来源。
          // toDataURL 是同步的，所以延后到下一轮事件循环、并对连续 resize 做防抖。
          const nebula = modelRef.current.nebula ?? document.createElement('canvas');
          modelRef.current.nebula = nebula;
          const nebulaWidth = Math.max(64, Math.round(rect.width));
          const nebulaHeight = Math.max(64, Math.round(rect.height));
          if (modelRef.current.nebulaTimer !== undefined) clearTimeout(modelRef.current.nebulaTimer);
          modelRef.current.nebulaTimer = setTimeout(() => {
            try {
              paintDeepSpace(nebula, nebulaWidth, nebulaHeight, dpr, Object.values(KIND_COLOR));
              if (nebulaRef.current !== null) nebulaRef.current.style.backgroundImage = `url(${nebula.toDataURL('image/png')})`;
            } catch {
              /* 导出失败就不显示深空底，不影响主画布 */
            }
          }, 120);
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

      // 颗粒贴图只生成一次（128×128 噪点），之后交给 CSS 平铺；失败就当没有这层
      React.useEffect(() => {
        const node = grainRef.current;
        if (node === null) return;
        try {
          const url = grainDataUrl();
          if (url !== '') node.style.backgroundImage = `url(${url})`;
        } catch {
          /* 生成失败不影响主画布 */
        }
      }, []);

      /**
       * 布局自检：把舞台 / 画布 / 时间轴的实际高度回报给宿主（写进 client-diag.log）。
       *
       * "时间轴打开时闪一下然后消失"这种问题，靠看代码猜不出是哪一层把它挤没了 ——
       * 直接把第一秒和两秒后的几何数据落盘，比再来十轮猜测都快。
       * 只在打开时跑一次，成本可以忽略。
       */
      React.useEffect(() => {
        const report = (phase) => {
          try {
            const stage = stageRef.current;
            const wrap = wrapRef.current;
            if (stage === null || wrap === null) return;
            const scrub = typeof stage.querySelector === 'function' ? stage.querySelector('.ml-scrub') : null;
            const box = (node) => {
              if (node === null || node === undefined) return null;
              const rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
              if (rect === null) return null;
              return { w: Math.round(rect.width), h: Math.round(rect.height), top: Math.round(rect.top), bottom: Math.round(rect.bottom) };
            };
            const computed = typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
              ? window.getComputedStyle(stage)
              : null;
            const payload = {
              kind: 'layout',
              phase,
              version: CLIENT_VERSION,
              stage: box(stage),
              wrap: box(wrap),
              scrub: box(scrub),
              page: box(stage.closest?.('.ml-page') ?? null),
              main: box(stage.parentElement ?? null),
              foot: box(stage.closest?.('.ml-page')?.querySelector?.('.ml-foot') ?? null),
              rail: box(stage.parentElement?.querySelector?.('.ml-rail') ?? null),
              stageRows: computed?.gridTemplateRows ?? '',
              stageDisplay: computed?.display ?? '',
              stageOverflow: computed?.overflow ?? '',
              viewport: { w: window.innerWidth, h: window.innerHeight },
              scrollY: window.scrollY,
              scrollHeight: document?.scrollingElement?.scrollHeight ?? 0,
            };
            fetch('/memory-loom/api/diag', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            }).catch(() => {});
          } catch {
            /* 自检失败绝不能影响渲染 */
          }
        };
        const first = setTimeout(() => report('open'), 300);
        const second = setTimeout(() => report('settled'), 2500);
        return () => {
          clearTimeout(first);
          clearTimeout(second);
        };
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

      // 预热星点精灵：挂载后的空闲里做，避免首帧现造几十张图造成长帧。
      // 这里原来判断 `if (!open)` —— 那是浮层时代的开关，改成 main 页之后 `open` 早就不存在了，
      // 于是每次挂载都抛一次 ReferenceError（effect 里的错误会被宿主吞掉，但确实在抛）。
      React.useEffect(() => {
        const timer = setTimeout(() => {
          for (const color of Object.values(KIND_COLOR)) {
            for (const step of [2, 3, 4, 5, 6, 8, 10, 12]) dotSprite(color, step);
          }
        }, 80);
        return () => clearTimeout(timer);
      }, []);

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
          let edges = model.allEdges;
          // 自检用的是合成星，没有共激活关系 —— 换回纯边表，否则会拿合成 id 去查真实位置
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

          // 空间导引 → 云层（或朴素光斑）→ 连线 → 点 → 标签（由后往前压）
          paintGuides(ctx, model.guides, camera, width, height);
          /**
           * 云层与光斑要跟星同步呼吸：把「某个点此刻的呼吸值」交给它们按成员平均。
           *
           * 这里踩过的坑：云原来有自己的 4.2 秒正弦，和星的相位毫无关系 ——
           * 表现就是"星在呼吸、包着它的那团光纹丝不动"，看着别扭（用户原话）。
           * 云是星的可见外壳，外壳必须跟内核走。
           */
          const isHotId = (id) => (focus !== null && focus.has(id)) || id === model.hovered || id === model.selected;
          const pulseOf = (id) => {
            const item = positions.get(id);
            if (item === undefined) return 0;
            return pulseFor(model.breathMode, now, item.point.phase ?? 0, isHotId(id));
          };
          if (model.glow) paintClusterClouds(ctx, projected, width, height, { quality, presence, focus, onlyFocus: model.onlyFocus, pulseOf });
          else paintClusterHalos(ctx, projected, width, height, quality, { focus, onlyFocus: model.onlyFocus, pulseOf });

          // 线：分桶批量描边；丝带的控制点也在三维里，跟着相机一起转
          const projectWorld = (world) => projectPoint(world, camera, width, height, 0, false);
          paintEdges(ctx, edges, positions, { focus, onlyFocus: model.onlyFocus, presence, projectWorld, showGold: model.showGold, showRecall: model.recallMode !== 'off', onlyRecall: model.recallMode === 'only' });

          // 后期计划：只有「光效开 + 最高画质档」才跑 bloom，降档先牺牲它
          const post = planBloom({ quality, glow: model.glow });
          let bloomCtx = null;
          if (post.bloom) {
            if (model.bloom === null) {
              model.bloom = { canvas: document.createElement('canvas'), ctx: null, width: 0, height: 0 };
            }
            const bloom = model.bloom;
            if (bloom.ctx === null) bloom.ctx = bloom.canvas.getContext('2d');
            const bw = Math.max(1, Math.round(width * post.scale));
            const bh = Math.max(1, Math.round(height * post.scale));
            if (bloom.width !== bw || bloom.height !== bh) {
              bloom.canvas.width = bw;
              bloom.canvas.height = bh;
              bloom.width = bw;
              bloom.height = bh;
            }
            bloomCtx = bloom.ctx;
            if (bloomCtx !== null) {
              bloomCtx.setTransform(1, 0, 0, 1, 0, 0);
              bloomCtx.clearRect(0, 0, bw, bh);
              // 用缩放变换，绘制时继续用 CSS 像素坐标，省得每处都乘以 scale
              bloomCtx.setTransform(post.scale, 0, 0, post.scale, 0, 0);
              bloomCtx.globalAlpha = 1;
            }
          }

          // 点（三层：柔光 → 实体 → 焦点；柔光同时写进 bloom 层）
          paintPoints(ctx, projected, {
            focus,
            onlyFocus: model.onlyFocus,
            hovered: model.hovered,
            selected: model.selected,
            time: now,
            quality,
            presence,
            dpr,
            halo: model.glow,
            breathMode: model.breathMode,
            bloomCtx,
          });

          // bloom：1/4 分辨率柔光整张叠回主画布（加性），星星才有"光溢出"
          if (bloomCtx !== null && model.bloom !== null) {
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = post.alpha;
            ctx.drawImage(model.bloom.canvas, 0, 0, width, height);
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = 1;
          }

          // 标签：候选在数据变化时就排好（按权重），所以转动时不会换批
          if (model.showLabels) {
            paintLabels(ctx, model.labelCandidates, positions, width, height, {
              alphaMap: model.labelAlpha,
              focus,
              onlyFocus: model.onlyFocus,
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

      /**
       * 这次「按下 → 抬起」算不算一次点击。
       *
       * 以前用的是 dragMoved 这个累积标记：一旦拖动过，标记就为 true，而它**只在 onClick 里清**。
       * 于是「在画布上拖动 → 指针在画布外松开」时 click 不会触发、标记留在 true，
       * 下一次真点星星就被吞掉 —— 表现就是"有时候点了没反应"。
       * 现在改成按下/抬起的位移与时长现算，不再依赖任何跨事件的残留状态。
       */
      const onClick = React.useCallback(
        (event) => {
          const model = modelRef.current;
          if (!isClickGesture(model.down, { x: event.clientX, y: event.clientY }, performance.now())) return;
          const hit = pick(event.clientX, event.clientY);
          if (hit !== null && !hit.id.startsWith('stress-')) onSelect(hit.id);
        },
        [pick, onSelect],
      );

      const onPointerDown = React.useCallback((event) => {
        const model = modelRef.current;
        if (event.button !== 0 && event.button !== 2) return;
        event.preventDefault();
        model.dragging = {
          // x/y 是"上一次"的位置：拖拽按增量推进（见 stepOrbit 的注释）
          x: event.clientX,
          y: event.clientY,
          // origin 只用来判断"这次算不算拖动"
          originX: event.clientX,
          originY: event.clientY,
          mode: event.button === 2 ? 'pan' : 'orbit',
          yaw: model.camera.yaw,
          pitch: model.camera.pitch,
          panX: model.camera.panX,
          panY: model.camera.panY,
        };
        model.dragMoved = false;
        model.velocity = null;
        model.lastMoveAt = performance.now();
        // 记下按下的位置与时刻：点击判定只看这一次手势，不留跨事件的残留标记
        model.down = { x: event.clientX, y: event.clientY, t: performance.now() };
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
            const travel = Math.hypot(event.clientX - model.dragging.originX, event.clientY - model.dragging.originY);
            if (travel > 4) model.dragMoved = true;
            const elapsed = Math.max(1, now - model.lastMoveAt);
            if (model.dragging.mode === 'orbit') {
              const step = stepOrbit(model.camera, dx, dy);
              // 撞到俯仰上下限时不要再记纵向惯性：否则松手后视图还贴着天花板"顶"一下
              model.velocity = {
                yaw: (step.yaw - model.camera.yaw) / elapsed,
                pitch: step.clamped ? 0 : (step.pitch - model.camera.pitch) / elapsed,
              };
              model.camera.yaw = step.yaw;
              model.camera.pitch = step.pitch;
            } else {
              const k = model.camera.dist / FOCAL;
              model.camera.panX -= dx * k;
              model.camera.panY -= dy * k;
            }
            model.dragging.x = event.clientX;
            model.dragging.y = event.clientY;
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
      // 初值直接取 model 里已经读过的 localStorage：按钮的亮灭必须和实际渲染一致，
      // 否则"上次关掉金线、这次重启后按钮是亮的、线却不画"，看着就是坏了。
      const [viewState, setViewState] = React.useState(() => ({
        auto: true,
        labels: true,
        onlyFocus: false,
        glow: modelRef.current.glow,
        breath: modelRef.current.breathMode,
        showGold: modelRef.current.showGold,
        recallMode: modelRef.current.recallMode,
      }));
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
      // 光效开关：加性柔光 + bloom 关掉就退回朴素渲染（记忆在 localStorage，刷新后还在）
      const toggleGlow = React.useCallback(() => {
        const model = modelRef.current;
        model.glow = !model.glow;
        try {
          window.localStorage.setItem('memory-loom:glow', model.glow ? '1' : '0');
        } catch {
          /* 隐私模式写不了就不写 */
        }
        setViewState((current) => ({ ...current, glow: model.glow }));
      }, []);
      // 呼吸模式轮换：逐星 → 只亮命中 → 整片 → 关
      const BREATH_ORDER = ['stars', 'focus', 'sea', 'off'];
      const BREATH_WORD = { stars: t('逐星'), focus: t('只亮'), sea: t('整片'), off: t('关') };
      const RECALL_WORD = { on: t('开'), only: t('只看'), off: t('关') };
      const toggleBreath = React.useCallback(() => {
        const model = modelRef.current;
        const next = BREATH_ORDER[(BREATH_ORDER.indexOf(model.breathMode) + 1) % BREATH_ORDER.length];
        model.breathMode = next;
        try {
          window.localStorage.setItem('memory-loom:breath', next);
        } catch {
          /* 隐私模式写不了就不写 */
        }
        setViewState((current) => ({ ...current, breath: next }));
      }, []);
      // 金线开关：库里只有一两条取代关系时，一条亮金线飘在冷色细线里很扎眼
      const toggleGold = React.useCallback(() => {
        const model = modelRef.current;
        model.showGold = !model.showGold;
        try {
          window.localStorage.setItem('memory-loom:gold', model.showGold ? '1' : '0');
        } catch {
          /* 隐私模式写不了就不写 */
        }
        setViewState((current) => ({ ...current, showGold: model.showGold }));
      }, []);
      // 共激活线：关 / 开 / 只看（只看会把相似度线整片藏起来，一眼看出关系长出来没有）
      const toggleRecall = React.useCallback(() => {
        const model = modelRef.current;
        const order = ['on', 'only', 'off'];
        const next = order[(order.indexOf(model.recallMode) + 1) % order.length];
        model.recallMode = next;
        try {
          window.localStorage.setItem('memory-loom:recall', next);
        } catch {
          /* 隐私模式写不了就不写 */
        }
        setViewState((current) => ({ ...current, recallMode: next }));
      }, []);

      // 时间轴已经搬到右侧「历史」页签：这里不再自己算区间与可见数，
      // 舞台只负责按 scrubAt 把未到时刻的星画成幽灵（presence / ghost 由 projected 决定）。
      return h(
        'div',
        { className: 'ml-stage', ref: stageRef },
        h(
          'div',
          { className: 'ml-canvas-wrap', ref: wrapRef },
          h('div', { className: 'ml-nebula', ref: nebulaRef, 'aria-hidden': 'true' }),
          // 颗粒层：只生成一次、贴图平铺；放在画布之上，压掉渐变色带
          h('div', { className: 'ml-grain', ref: grainRef, 'aria-hidden': 'true' }),
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
            h('button', { type: 'button', 'data-on': viewState.glow ? 'true' : 'false', onClick: toggleGlow, title: '加性柔光 + bloom：关掉退回朴素渲染' }, t('光效')),
            h('button', { type: 'button', 'data-on': viewState.breath !== 'off' ? 'true' : 'false', onClick: toggleBreath, title: '呼吸模式：逐星 / 只亮命中 / 整片同步 / 关' }, `${t('呼吸')}·${BREATH_WORD[viewState.breath] ?? ''}`),
            h('button', { type: 'button', 'data-on': viewState.showGold ? 'true' : 'false', onClick: toggleGold, title: '是否显示金线（取代关系）：库里只有一两条时可以关掉' }, t('金线')),
            h('button', { type: 'button', 'data-on': viewState.recallMode !== 'off' ? 'true' : 'false', onClick: toggleRecall, title: '共激活线：被一起想起来过的记忆之间连一条青线。「只看」把相似度线藏起来，只留关系。只观测，不影响召回' }, `${t('共鸣')}·${RECALL_WORD[viewState.recallMode] ?? ''}`),
            h('button', { type: 'button', onClick: resetView }, t('复位')),
          ),
          // 之前这里把 <b> 写在普通字符串里，屏幕上直接显示成字面量；改成真正的子节点，
          // 顺手补一句金线是什么 —— 不然只有一条金线时会以为是画错了
          h(
            'span',
            { className: 'ml-stage-tag' },
            '左键拖动旋转　滚轮推拉　右键平移　',
            h('b', {}, '点一颗星看原文'),
            '　光晕＝本轮想起　金环＝刚点中　金线＝取代关系　青线＝一起想起',
          ),
          h('span', { className: 'ml-fps', ref: badgeRef }, '— fps'),
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

    /**
     * 「作废了 N 条」的说明。
     *
     * 金线画不出来的情况必须说清楚：被作废的旧条目可能在归档修剪时被物理删除，
     * 那时 `supersedes` 里就留着一个悬空 id —— 用户看到"只有一条金线"会以为是脚本坏了。
     *
     * @param {{supersedes?: string[]}} memory
     * @param {Array<{id: string}>} ordered 全量记忆（含归档）
     * @returns {string}
     */
    function supersedeNote(memory, ordered) {
      const ids = Array.isArray(memory.supersedes) ? memory.supersedes : [];
      if (ids.length === 0) return '0 条';
      const known = new Set((ordered ?? []).map((row) => row.id));
      const missing = ids.filter((id) => !known.has(id)).length;
      return missing === 0 ? `${ids.length} 条` : `${ids.length} 条（${missing} 条已不在库里）`;
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
          memory.supersedes?.length
            ? h('dd', {}, supersedeNote(memory, ordered))
            : null,
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

    /**
     * 历史：把「时间回放」从画面底部搬到侧栏页签。
     *
     * 为什么搬：底部那条在宿主 main 槽里无论怎么证（grid 行 / flex:none / min-height /
     * 整页高度兜底）都会被挤出去，反复修了四版还是"打开闪一下就没了"。
     * 放到侧栏页签里，它跟其它面板一样是**容器内滚动**的内容 —— 不存在被裁掉的可能。
     *
     * 交互保留原语义：拖到某个时刻，星图上只留那时已经存在、或在那之前写入的记忆；
     * 右边实时列出「那一刻已有的记忆」，点一条直接在记忆库里定位。
     */
    function HistoryPane({ memories, scrubAt, onScrub, onPick }) {
      const times = memories.map((memory) => memory.createdAt ?? 0);
      const minT = times.length > 0 ? Math.min(...times) : Date.now();
      const maxT = times.length > 0 ? Math.max(...times) : Date.now() + 1000;
      const span = Math.max(1000, maxT - minT);
      const value = scrubAt == null ? maxT : Math.min(maxT, Math.max(minT, scrubAt));
      const visible = scrubAt == null ? memories : memories.filter((memory) => (memory.createdAt ?? 0) <= scrubAt);
      // 那一刻已有记忆，按写入时间倒序取最近 12 条 —— 回看时最关心"那阵子在记什么"
      const recent = [...visible]
        .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
        .slice(0, 12);
      const oldest = visible.length > 0 ? Math.min(...visible.map((memory) => memory.createdAt ?? 0)) : null;

      return h(
        'div',
        { className: 'ml-history' },
        h(
          'div',
          { className: 'ml-history-head' },
          h('b', {}, scrubAt == null ? `全部 ${memories.length} 颗` : `${visible.length}/${memories.length} 颗`),
          h('span', {}, scrubAt == null ? '拖滑杆回到过去' : `停在 ${clockText(scrubAt)}`),
        ),
        h(
          'div',
          { className: 'ml-history-track' },
          h('input', {
            type: 'range',
            min: minT,
            max: maxT,
            step: Math.max(1000, Math.floor(span / 600)),
            value,
            'aria-label': '历史：拖到某个时刻，只看那时已经存在的记忆',
            'aria-valuetext': scrubAt == null ? '全部' : `${clockText(scrubAt)}，${visible.length} 条`,
            disabled: memories.length === 0,
            onChange: (event) => {
              const next = Number(event.target.value);
              if (!Number.isFinite(next)) return;
              onScrub(next >= maxT ? null : next);
            },
            onDoubleClick: () => onScrub(null),
          }),
        ),
        h(
          'div',
          { className: 'ml-history-actions' },
          h('button', { type: 'button', className: 'ml-btn', onClick: () => onScrub(null), disabled: scrubAt == null }, t('回到现在')),
          scrubAt == null
            ? null
            : h(
                'button',
                {
                  type: 'button',
                  className: 'ml-btn',
                  title: '往回退到更早的一天',
                  onClick: () => onScrub(Math.max(minT, value - 24 * 3600 * 1000)),
                },
                '− 1 天',
              ),
        ),
        h(
          'div',
          { className: 'ml-history-label' },
          oldest === null ? '这段时间还没有记忆' : `这段时间最早一条：${clockText(oldest)}`,
        ),
        recent.length === 0
          ? h('div', { className: 'ml-empty' }, '那一刻还没有记忆')
          : h(
              'div',
              { className: 'ml-list' },
              ...recent.map((memory) =>
                h(
                  'button',
                  {
                    key: memory.id,
                    type: 'button',
                    className: 'ml-row',
                    title: '在记忆库里定位这一条',
                    onClick: () => onPick(memory.id),
                  },
                  h('div', { className: 'ml-meta' }, h('span', {}, clockText(memory.createdAt ?? 0)), h('span', {}, memory.kindLabel ?? KIND_LABEL[memory.kind] ?? memory.kind)),
                  h('div', { className: 'ml-line-text' }, memory.text),
                ),
              ),
            ),
      );
    }

    function RecallPane({ recall, recallCount, usedTotal, onQuery, results, busy }) {
      const [text, setText] = React.useState('');
      const hits = (recall?.hits ?? []).filter((hit) => typeof hit.score === 'number');
      const scored = [...hits].sort((left, right) => right.score - left.score);
      const maxScore = Math.max(0.001, ...scored.map((hit) => hit.score));
      /**
       * 闸门说人话。
       *
       * 「这一轮为什么只想起一条」是面板最该回答的问题之一：预算收紧是刻意设计，
       * 不写出来就会被当成"召回不准"。
       */
      const gateLabel = (gate) => {
        if (gate.need === 0) return '闸门：关';
        if (gate.budget === 0) return `闸门：不注入（内容词 ${gate.tokens} 个）`;
        if (gate.tokens < gate.need) return `闸门：只给一条（内容词 ${gate.tokens} 个）`;
        return `闸门：正常（内容词 ${gate.tokens} 个）`;
      };
      return h(
        React.Fragment,
        null,
        h(
          'div',
          null,
          h(
            'div',
            { className: 'ml-meta', style: { marginTop: 0 } },
            h('span', {}, `召回 ${recallCount} 次`),
            recall ? h('span', {}, `阈值 ${recall.threshold}`) : null,
            h(
              'span',
              { title: '被用上的次数：下一轮你的话里出现这条记忆的指纹词，才算用上（不是"被注入"）' },
              `用上 ${usedTotal} 次`,
            ),
            recall?.size === undefined
              ? null
              : h('span', { title: '这一轮注入的正文体积' }, `注入 ${recall.size.chars} 字 / ${recall.size.blocks} 块 / ${recall.size.entries} 条`),
            recall?.gate === undefined ? null : h('span', {}, gateLabel(recall.gate)),
          ),
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
      ['history', t('历史')],
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
      /** 星图点选的递增计数：同一颗星再点一次也要重新滚动定位 */
      const [focusTick, setFocusTick] = React.useState(0);
      /** 侧栏列表的滚动位置：只用来决定「回到顶端」露不露头 */
      const [railScroll, setRailScroll] = React.useState(0);
      const railBodyRef = React.useRef(null);
      /** 摘要试跑结果：不写库，只用来看模型产出质量 */
      const [tryRun, setTryRun] = React.useState(null);
      /** 待确认的导入：选完文件先亮一次「确认覆盖」，按了才真写 */
      const [pendingImport, setPendingImport] = React.useState(null);
      /** 待确认的过程记录整理：先预览条数，再确认归档 */
      const [pendingTidy, setPendingTidy] = React.useState(null);
      /** 待确认的「从未被想起」整理（同一套预览 → 确认） */
      const [pendingUnused, setPendingUnused] = React.useState(null);
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
      /**
       * 把页面高度钉在可视区里。
       *
       * 宿主 main 槽的高度是 auto 时，`.ml-page{height:100%}` 会退化成 content 高度：
       * 右侧列表一长（记忆一多），整页比窗口还高，底部页脚与时间轴就被挤出屏幕 ——
       * 表现正是"打开时闪一下就没了"（首屏列表还空，所以那一瞬间是可见的）。
       * 这里实测页面顶端到窗口底部的可用高度，写进 --ml-page-h 兜底。
       */
      React.useEffect(() => {
        const apply = () => {
          const node = panelRef.current;
          if (node === null || typeof node.getBoundingClientRect !== 'function') return;
          const rect = node.getBoundingClientRect();
          const available = Math.max(240, Math.round(window.innerHeight - rect.top - 10));
          node.style.setProperty('--ml-page-h', `${available}px`);
        };
        apply();
        const timer = setTimeout(apply, 400);
        window.addEventListener('resize', apply);
        return () => {
          clearTimeout(timer);
          window.removeEventListener('resize', apply);
        };
      }, []);
      /** 行节点：从星图点选时把它滚进视野，不然选中了也看不见 */
      const rowRefs = React.useRef(new Map());
      /** 上一次渲染用的数据签名：内容没变就不 setState，避免每 5 秒白掉一帧。 */
      const stateSignatureRef = React.useRef('');

      // 同一个目标再点一次就收起：列表行和星点曾共用这一套语义
      const selectFromChart = React.useCallback((id) => {
        setSelectedId((current) => nextSelection(current, id));
        setMode('list');
      }, []);

      /**
       * 星图点选 = 定位到那一条，**不是**开关切换。
       *
       * 三件事一起做，缺一样就会出现「点了星星没反应」：
       * ① 切回记忆库页（其它页根本没有列表行）；
       * ② 放开会把目标过滤掉的筛选（归档 / 种类 / 文本 / 只看某组原文）；
       * ③ 递增 focusTick，保证"再点同一颗星"也能重新滚过去（只改 selectedId 会被 React 拦掉）。
       */
      const focusFromStar = React.useCallback(
        (id) => {
          const target = (state?.memories ?? []).find((memory) => memory.id === id);
          const next = revealFiltersFor(target, { statusFilter, kindFilter, textFilter, summaryFocus });
          setSelectedId(id);
          setMode('list');
          setStatusFilter(next.statusFilter);
          setKindFilter(next.kindFilter);
          if (next.clearText) setTextFilter('');
          if (next.clearSummaryFocus) setSummaryFocus(null);
          setFocusTick((tick) => tick + 1);
        },
        [state?.memories, statusFilter, kindFilter, textFilter, summaryFocus],
      );


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
      }, [selectedId, mode, focusTick, statusFilter, kindFilter, textFilter, summaryFocus]);

      // 切页签后同一个滚动容器会保留旧位置：重新读一次，免得短列表上还挂着「回到顶端」
      React.useEffect(() => {
        const node = railBodyRef.current;
        if (node !== null) setRailScroll(node.scrollTop ?? 0);
      }, [mode]);

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

      /**
       * 「从未被想起」整理：同一套两步。
       *
       * 为什么只出候选、不自动清：`hits` 是曝光信号不是价值信号 ——
       * 一条从没被召回的记忆可能是"写得很好、只是还没遇到对的问题"。
       * 判错的代价是丢掉一条有用的结论，判对的收益只是省一点上下文。
       */
      const onTidyUnusedPreview = React.useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
          const result = await postAction('tidy-unused', { apply: false });
          if (result?.count === 0) {
            setPendingUnused(null);
            // 只说"0 条"等于点了没反应。必须说清：有几条从没被想起、最早的几天后到期
            const stats = result?.stats ?? {};
            const never = stats.never ?? 0;
            setCloseNote(
              never === 0
                ? '没有从未被想起的条目'
                : `现在可清 0 条：有 ${never} 条从未被想起，最早还要 ${stats.soonestInDays ?? '—'} 天到期（fact/self 满 7 天、world 满 30 天）`,
            );
          } else {
            setPendingUnused({ count: result.count, preview: result.preview ?? [] });
          }
        } catch (failure) {
          setError(describeFailure(failure));
        } finally {
          setBusy(false);
        }
      }, [describeFailure]);

      const confirmTidyUnused = React.useCallback(async () => {
        setBusy(true);
        try {
          const result = await postAction('tidy-unused', { apply: true });
          if (result?.ok !== true) throw new Error(result?.error ?? '整理失败');
          setPendingUnused(null);
          setCloseNote(`已归档 ${result.archived ?? result.count} 条从未被想起的记忆（可单条恢复）`);
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
          : mode === 'history'
          ? h(HistoryPane, { memories, scrubAt, onScrub: setScrubAt, onPick: focusFromStar })
          : mode === 'summary'
          ? h(SummaryPane, { summaries: state?.summaries, archivedBySummary, onRestoreSummary: (summaryId) => act('restore', '', { summaryId }), onTryRun, tryRun })
          : mode === 'recall'
          ? h(RecallPane, { recall: state?.recall ?? null, recallCount: state?.recallCount ?? 0, usedTotal: state?.counts?.usedTotal ?? 0, onQuery: runQuery, results, busy })
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
                      // 关系数 = 共激活边（使用痕迹）。它在长，说明这张网在形成；
                      // 一直是 0 说明要么还没召回够，要么 coActivate 关着（设置页可查）
                      h('span', {}, '关系 ', h('b', {}, String(state?.graph?.edges ?? 0))),
                      // 用上 = 下一轮你说的话里出现了这条记忆的指纹词。
                      // 这个数字除以召回次数才是真正的健康度：记忆有没有帮上忙。
                      h('span', { title: '被用上的次数（不是被注入的次数）' }, '用上 ', h('b', {}, String(counts.usedTotal ?? 0))),
                      stressReport === null ? null : h('span', { style: { color: '#e9c07a' } }, `自检 ${stressReport.count}星 ${stressReport.fps}fps`),
                      error === null ? null : h('span', { style: { color: '#f08a72' } }, `· ${error}`),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'ml-main' },
                    h(MemorySea, {
                      memories: ordered,
                      recallEdges: state?.edges ?? [],
                      dataKey,
                      selectedId,
                      onSelect: focusFromStar,
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
                          pendingUnused === null
                            ? h('button', { type: 'button', className: 'ml-btn', onClick: onTidyUnusedPreview, disabled: busy, title: '把「满 7 天、一次都没被召回」的事实类条目批量归档（只动 fact / self，可单条恢复）' }, '清死重')
                            : h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'ml-btn',
                                  'data-warn': 'true',
                                  disabled: busy,
                                  onClick: confirmTidyUnused,
                                  title: '只归档、不删除：归档后能单条恢复',
                                },
                                `确认归档 ${pendingUnused.count} 条`,
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
                      h(
                        'div',
                        {
                          className: 'ml-rail-body',
                          ref: railBodyRef,
                          // 只记位置用来决定按钮露不露头；真正的滚动由浏览器做，不拦事件
                          onScroll: (event) => setRailScroll(event.currentTarget.scrollTop),
                        },
                        railBody,
                      ),
                      shouldShowTop(railScroll)
                        ? h(
                            'button',
                            {
                              type: 'button',
                              className: 'ml-top',
                              title: t('回到顶部'),
                              onClick: () => {
                                const node = railBodyRef.current;
                                if (node === null) return;
                                if (typeof node.scrollTo === 'function') node.scrollTo({ top: 0, behavior: 'smooth' });
                                else node.scrollTop = 0;
                                setRailScroll(0);
                              },
                            },
                            `↑ ${t('回到顶部')}`,
                          )
                        : null,
                    ),
                  ),
                  h(
                    'div',
                    { className: 'ml-foot' },
                    h('span', {}, `${active}/${state?.cfg?.maxActiveMemories ?? 0}`),
                    h('span', {}, `${t('查重')} ${state?.cfg?.dedupeThreshold ?? '-'}`),
                    h('span', {}, `${t('召回')} ${state?.cfg?.recallThreshold ?? '-'}`),
                    h('span', {}, `${t('半衰')} ${state?.cfg?.halfLifeDays ?? '-'}d`),
                    staleServer ? h('b', { style: { color: '#c2701f' } }, `宿主 v${state.serverVersion} ≠ 面板 v${CLIENT_VERSION}：刷新页面或重启 DSH`) : null,
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
      separatePoints,
      buildEdges,
      buildRecallEdges,
      controlPoint,
      addCohesion,
      fitDistance,
      buildGuides,
      paintGuides,
      paintClusterHalos,
      projectPoint,
      projectAll,
      clampCamera,
      stepOrbit,
      toneOf,
      breathOf,
      breathAt,
      pulseFor,
      breathAmplitude,
      planBloom,
      softGlowSprite,
      cloudSprite,
      clusterCloudPlan,
      paintClusterClouds,
      supersedeNote,
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
      paintDeepSpace,
      HistoryPane,
      pointSprite,
      dotSprite,
      nearestSizeStep,
      POINT_SIZE_STEPS,
      CAM_DEFAULT,
      CAM_LIMITS,
      FOCAL,
      KIND_COLOR,
      KIND_LABEL,
      // 交互判据：点击手势与"点星要看哪一行"的过滤放开规则，都是纯函数，可以离线盯
      isClickGesture,
      revealFiltersFor,
      shouldShowTop,
      // 语言：字典与判定都导出，测试可以不依赖浏览器就盯住「英文环境翻成什么、缺词怎么办」
      EN_TEXT,
      detectLocale,
      translateWith,
      UI_LOCALE,
    };
    return module.exports;
  },
});
