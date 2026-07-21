// AGPL-3.0-only
// A small React-compatible runtime for the built-in dashboard. It intentionally
// implements only the surface this UI uses: createElement, fragments, roots, and
// basic hooks. The dashboard can stay self-contained under script-src 'self'.
(function () {
  const TEXT = Symbol('text');
  const Fragment = Symbol('fragment');
  let root = null;
  let currentComponent = null;
  let hookIndex = 0;
  let renderQueued = false;

  function createElement(type, props, ...children) {
    const nextProps = { ...(props || {}) };
    const flat = [];
    const push = (child) => {
      if (Array.isArray(child)) child.forEach(push);
      else if (child === false || child === true || child == null) return;
      else flat.push(typeof child === 'string' || typeof child === 'number' ? { type: TEXT, text: String(child) } : child);
    };
    children.forEach(push);
    nextProps.children = flat;
    return { type, props: nextProps };
  }

  function createRoot(container) {
    root = { container, vnode: null, components: new Map(), effects: [], usedComponents: new Set() };
    return {
      render(vnode) {
        root.vnode = vnode;
        scheduleRender();
      },
    };
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      render();
    });
  }

  function render() {
    if (!root) return;
    const scrollState = captureScrollState(root.container);
    const focusState = captureFocusState(root.container);
    root.effects = [];
    root.usedComponents = new Set();
    const dom = toDom(root.vnode, '0');
    cleanupUnusedComponents();
    morphChildren(root.container, dom.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? Array.from(dom.childNodes) : [dom]);
    restoreScrollState(root.container, scrollState);
    restoreFocusState(root.container, focusState);
    const effects = root.effects;
    effects.forEach((run) => run());
  }

  function morphChildren(parent, nextChildren) {
    const currentChildren = Array.from(parent.childNodes);
    const count = Math.max(currentChildren.length, nextChildren.length);
    for (let i = 0; i < count; i += 1) {
      const current = currentChildren[i];
      const next = nextChildren[i];
      if (!current && next) {
        parent.appendChild(next);
      } else if (current && !next) {
        parent.removeChild(current);
      } else if (current && next) {
        morphNode(parent, current, next);
      }
    }
  }

  function morphNode(parent, current, next) {
    if (!sameNodeKind(current, next)) {
      parent.replaceChild(next, current);
      return;
    }
    if (current.nodeType === Node.TEXT_NODE) {
      if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
      return;
    }
    syncProps(current, next);
    morphChildren(current, Array.from(next.childNodes));
  }

  function sameNodeKind(a, b) {
    if (a.nodeType !== b.nodeType) return false;
    if (a.nodeType === Node.TEXT_NODE) return true;
    return a.localName === b.localName && a.namespaceURI === b.namespaceURI;
  }

  function syncProps(current, next) {
    const oldProps = current.__vprops || {};
    const newProps = next.__vprops || {};
    for (const [key, value] of Object.entries(oldProps)) {
      if (key.startsWith('on') && typeof value === 'function') {
        current.removeEventListener(key.slice(2).toLowerCase(), value);
      }
    }
    for (const attr of Array.from(current.attributes || [])) {
      if (!next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
    }
    for (const attr of Array.from(next.attributes || [])) {
      if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
    }
    current.removeAttribute('style');
    if (next.getAttribute('style')) current.setAttribute('style', next.getAttribute('style'));
    for (const [key, value] of Object.entries(newProps)) {
      if (key.startsWith('on') && typeof value === 'function') {
        current.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === 'value' || key === 'checked') {
        current[key] = value;
      } else if (key === 'ref' && value && typeof value === 'object') {
        value.current = current;
      }
    }
    current.__vprops = newProps;
  }

  function cleanupUnusedComponents() {
    for (const [key, component] of root.components.entries()) {
      if (root.usedComponents.has(key)) continue;
      component.cleanups.forEach((cleanup) => {
        if (typeof cleanup === 'function') cleanup();
      });
      root.components.delete(key);
    }
  }

  function captureScrollState(container) {
    const items = [];
    const visit = (node, path) => {
      if (!(node instanceof Element)) return;
      if (node.scrollTop || node.scrollLeft) {
        items.push({ path, top: node.scrollTop, left: node.scrollLeft });
      }
      Array.from(node.children).forEach((child, i) => visit(child, `${path}.${i}`));
    };
    visit(container, '0');
    return items;
  }

  function restoreScrollState(container, items) {
    for (const item of items) {
      const node = findByPath(container, item.path);
      if (node) {
        node.scrollTop = item.top;
        node.scrollLeft = item.left;
      }
    }
  }

  function captureFocusState(container) {
    const active = document.activeElement;
    if (!active || active === document.body || !container.contains(active)) return null;
    const path = pathForNode(container, active);
    if (!path) return null;
    return {
      path,
      start: typeof active.selectionStart === 'number' ? active.selectionStart : null,
      end: typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
    };
  }

  function restoreFocusState(container, item) {
    if (!item) return;
    const node = findByPath(container, item.path);
    if (!node || typeof node.focus !== 'function') return;
    node.focus({ preventScroll: true });
    if (item.start != null && item.end != null && typeof node.setSelectionRange === 'function') {
      try { node.setSelectionRange(item.start, item.end); } catch {}
    }
  }

  function pathForNode(container, target) {
    const parts = [];
    let node = target;
    while (node && node !== container) {
      const parent = node.parentElement;
      if (!parent) return null;
      const index = Array.prototype.indexOf.call(parent.children, node);
      if (index < 0) return null;
      parts.unshift(index);
      node = parent;
    }
    return `0${parts.map((part) => `.${part}`).join('')}`;
  }

  function findByPath(container, path) {
    const parts = path.split('.').slice(1).map((part) => Number(part));
    let node = container;
    for (const index of parts) {
      node = node?.children?.[index];
      if (!node) return null;
    }
    return node;
  }

  function toDom(vnode, path = '0') {
    if (vnode == null || vnode === false) return document.createTextNode('');
    if (Array.isArray(vnode)) {
      const fragment = document.createDocumentFragment();
      vnode.forEach((child, i) => fragment.appendChild(toDom(child, `${path}.${i}`)));
      return fragment;
    }
    if (typeof vnode === 'string' || typeof vnode === 'number') return document.createTextNode(String(vnode));
    if (vnode instanceof Node) return vnode;
    if (vnode.type === TEXT) return document.createTextNode(vnode.text);
    if (vnode.type === Fragment) {
      const fragment = document.createDocumentFragment();
      ((vnode.props || {}).children || []).forEach((child, i) => fragment.appendChild(toDom(child, `${path}.${i}`)));
      return fragment;
    }
    if (typeof vnode.type === 'function') {
      const previousComponent = currentComponent;
      const previousHookIndex = hookIndex;
      const componentKey = `${path}:${vnode.type.name || 'Component'}`;
      root.usedComponents.add(componentKey);
      currentComponent = getComponentState(componentKey);
      hookIndex = 0;
      const rendered = vnode.type({ ...(vnode.props || {}) });
      currentComponent = previousComponent;
      hookIndex = previousHookIndex;
      return toDom(rendered, `${path}.c`);
    }
    if (!vnode.type) return document.createTextNode('');

    const props = vnode.props || {};
    const el = document.createElementNS(
      isSvg(vnode.type) ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xhtml',
      vnode.type,
    );
    setProps(el, props);
    (props.children || []).forEach((child, i) => el.appendChild(toDom(child, `${path}.${i}`)));
    return el;
  }

  function getComponentState(key) {
    if (!root.components.has(key)) root.components.set(key, { hooks: [], cleanups: [] });
    return root.components.get(key);
  }

  function isSvg(type) {
    return ['svg', 'path', 'rect', 'circle', 'ellipse', 'defs', 'linearGradient', 'stop', 'text'].includes(type);
  }

  function setProps(el, props) {
    el.__vprops = props;
    for (const [key, value] of Object.entries(props)) {
      if (key === 'children' || value == null || value === false) continue;
      if (key === 'className') el.setAttribute('class', value);
      else if (key === 'htmlFor') el.setAttribute('for', value);
      else if (key === 'ref' && value && typeof value === 'object') value.current = el;
      else if (key === 'style' && typeof value === 'object') setStyle(el, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'value' || key === 'checked') el[key] = value;
      else el.setAttribute(normalizeAttr(key), value === true ? '' : String(value));
    }
  }

  const unitlessStyle = new Set([
    'animationIterationCount', 'aspectRatio', 'borderImageOutset', 'borderImageSlice',
    'borderImageWidth', 'boxFlex', 'boxFlexGroup', 'boxOrdinalGroup', 'columnCount',
    'columns', 'flex', 'flexGrow', 'flexPositive', 'flexShrink', 'flexNegative',
    'flexOrder', 'gridArea', 'gridRow', 'gridRowEnd', 'gridRowSpan', 'gridRowStart',
    'gridColumn', 'gridColumnEnd', 'gridColumnSpan', 'gridColumnStart', 'fontWeight',
    'lineClamp', 'lineHeight', 'opacity', 'order', 'orphans', 'scale', 'tabSize',
    'widows', 'zIndex', 'zoom',
  ]);

  const attrNames = {
    strokeWidth: 'stroke-width',
    strokeLinecap: 'stroke-linecap',
    strokeLinejoin: 'stroke-linejoin',
    strokeDasharray: 'stroke-dasharray',
    strokeDashoffset: 'stroke-dashoffset',
    stopColor: 'stop-color',
    stopOpacity: 'stop-opacity',
    textAnchor: 'text-anchor',
    dominantBaseline: 'dominant-baseline',
    fillRule: 'fill-rule',
    clipRule: 'clip-rule',
  };

  function setStyle(el, styles) {
    for (const [key, value] of Object.entries(styles)) {
      if (value == null || value === false) continue;
      const cssValue = typeof value === 'number' && value !== 0 && !unitlessStyle.has(key) ? `${value}px` : String(value);
      if (key.startsWith('--')) el.style.setProperty(key, cssValue);
      else el.style[key] = cssValue;
    }
  }

  function normalizeAttr(key) {
    return attrNames[key] || key;
  }

  function depsChanged(prev, next) {
    return !prev || !next || prev.length !== next.length || next.some((dep, i) => !Object.is(dep, prev[i]));
  }

  function useState(initial) {
    const i = hookIndex++;
    const component = currentComponent;
    if (!Object.prototype.hasOwnProperty.call(component.hooks, i)) {
      component.hooks[i] = typeof initial === 'function' ? initial() : initial;
    }
    const setState = (value) => {
      const next = typeof value === 'function' ? value(component.hooks[i]) : value;
      if (!Object.is(next, component.hooks[i])) {
        component.hooks[i] = next;
        scheduleRender();
      }
    };
    return [component.hooks[i], setState];
  }

  function useEffect(effect, deps) {
    const i = hookIndex++;
    const component = currentComponent;
    const prev = component.hooks[i];
    if (!depsChanged(prev, deps)) return;
    component.hooks[i] = deps;
    root.effects.push(() => {
      if (typeof component.cleanups[i] === 'function') component.cleanups[i]();
      const cleanup = effect();
      component.cleanups[i] = cleanup;
    });
  }

  function useMemo(factory, deps) {
    const i = hookIndex++;
    const prev = currentComponent.hooks[i];
    if (prev && !depsChanged(prev.deps, deps)) return prev.value;
    const value = factory();
    currentComponent.hooks[i] = { deps, value };
    return value;
  }

  function useCallback(callback, deps) {
    return useMemo(() => callback, deps);
  }

  function useRef(initial) {
    const i = hookIndex++;
    if (!currentComponent.hooks[i] || !Object.prototype.hasOwnProperty.call(currentComponent.hooks[i], 'current')) {
      currentComponent.hooks[i] = { current: initial };
    }
    return currentComponent.hooks[i];
  }

  window.React = { createElement, Fragment, useState, useEffect, useMemo, useCallback, useRef };
  window.ReactDOM = { createRoot };
})();


// tweaks-panel.jsx
// Reusable Tweaks shell + form-control helpers.
//
// Owns the host protocol (listens for __activate_edit_mode / __deactivate_edit_mode,
// posts __edit_mode_available / __edit_mode_set_keys / __edit_mode_dismissed) so
// individual prototypes don't re-roll it. Ships a consistent set of controls so you
// don't hand-draw <input type="range">, segmented radios, steppers, etc.
//
// Usage (in an HTML file that loads React + Babel):
//
//   const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
//     "primaryColor": "#D97757",
//     "fontSize": 16,
//     "density": "regular",
//     "dark": false
//   }/*EDITMODE-END*/;
//
//   function App() {
//     const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
//     return (
//       <div style={{ fontSize: t.fontSize, color: t.primaryColor }}>
//         Hello
//         <TweaksPanel>
//           <TweakSection label="Typography" />
//           <TweakSlider label="Font size" value={t.fontSize} min={10} max={32} unit="px"
//                        onChange={(v) => setTweak('fontSize', v)} />
//           <TweakRadio  label="Density" value={t.density}
//                        options={['compact', 'regular', 'comfy']}
//                        onChange={(v) => setTweak('density', v)} />
//           <TweakSection label="Theme" />
//           <TweakColor  label="Primary" value={t.primaryColor}
//                        onChange={(v) => setTweak('primaryColor', v)} />
//           <TweakToggle label="Dark mode" value={t.dark}
//                        onChange={(v) => setTweak('dark', v)} />
//         </TweaksPanel>
//       </div>
//     );
//   }
//
// ─────────────────────────────────────────────────────────────────────────────
const __TWEAKS_STYLE = `
  .twk-panel{position:fixed;right:16px;bottom:16px;z-index:2147483646;width:280px;
    max-height:calc(100vh - 32px);display:flex;flex-direction:column;
    background:rgba(250,249,247,.78);color:#29261b;
    -webkit-backdrop-filter:blur(24px) saturate(160%);backdrop-filter:blur(24px) saturate(160%);
    border:.5px solid rgba(255,255,255,.6);border-radius:14px;
    box-shadow:0 1px 0 rgba(255,255,255,.5) inset,0 12px 40px rgba(0,0,0,.18);
    font:11.5px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif;overflow:hidden}
  .twk-hd{display:flex;align-items:center;justify-content:space-between;
    padding:10px 8px 10px 14px;cursor:move;user-select:none}
  .twk-hd b{font-size:12px;font-weight:600;letter-spacing:.01em}
  .twk-x{appearance:none;border:0;background:transparent;color:rgba(41,38,27,.55);
    width:22px;height:22px;border-radius:6px;cursor:default;font-size:13px;line-height:1}
  .twk-x:hover{background:rgba(0,0,0,.06);color:#29261b}
  .twk-body{padding:2px 14px 14px;display:flex;flex-direction:column;gap:10px;
    overflow-y:auto;overflow-x:hidden;min-height:0;
    scrollbar-width:thin;scrollbar-color:rgba(0,0,0,.15) transparent}
  .twk-body::-webkit-scrollbar{width:8px}
  .twk-body::-webkit-scrollbar-track{background:transparent;margin:2px}
  .twk-body::-webkit-scrollbar-thumb{background:rgba(0,0,0,.15);border-radius:4px;
    border:2px solid transparent;background-clip:content-box}
  .twk-body::-webkit-scrollbar-thumb:hover{background:rgba(0,0,0,.25);
    border:2px solid transparent;background-clip:content-box}
  .twk-row{display:flex;flex-direction:column;gap:5px}
  .twk-row-h{flex-direction:row;align-items:center;justify-content:space-between;gap:10px}
  .twk-lbl{display:flex;justify-content:space-between;align-items:baseline;
    color:rgba(41,38,27,.72)}
  .twk-lbl>span:first-child{font-weight:500}
  .twk-val{color:rgba(41,38,27,.5);font-variant-numeric:tabular-nums}

  .twk-sect{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
    color:rgba(41,38,27,.45);padding:10px 0 0}
  .twk-sect:first-child{padding-top:0}

  .twk-field{appearance:none;width:100%;height:26px;padding:0 8px;
    border:.5px solid rgba(0,0,0,.1);border-radius:7px;
    background:rgba(255,255,255,.6);color:inherit;font:inherit;outline:none}
  .twk-field:focus{border-color:rgba(0,0,0,.25);background:rgba(255,255,255,.85)}
  select.twk-field{padding-right:22px;
    background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path fill='rgba(0,0,0,.5)' d='M0 0h10L5 6z'/></svg>");
    background-repeat:no-repeat;background-position:right 8px center}

  .twk-slider{appearance:none;-webkit-appearance:none;width:100%;height:4px;margin:6px 0;
    border-radius:999px;background:rgba(0,0,0,.12);outline:none}
  .twk-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;
    width:14px;height:14px;border-radius:50%;background:#fff;
    border:.5px solid rgba(0,0,0,.12);box-shadow:0 1px 3px rgba(0,0,0,.2);cursor:default}
  .twk-slider::-moz-range-thumb{width:14px;height:14px;border-radius:50%;
    background:#fff;border:.5px solid rgba(0,0,0,.12);box-shadow:0 1px 3px rgba(0,0,0,.2);cursor:default}

  .twk-seg{position:relative;display:flex;padding:2px;border-radius:8px;
    background:rgba(0,0,0,.06);user-select:none}
  .twk-seg-thumb{position:absolute;top:2px;bottom:2px;border-radius:6px;
    background:rgba(255,255,255,.9);box-shadow:0 1px 2px rgba(0,0,0,.12);
    transition:left .15s cubic-bezier(.3,.7,.4,1),width .15s}
  .twk-seg.dragging .twk-seg-thumb{transition:none}
  .twk-seg button{appearance:none;position:relative;z-index:1;flex:1;border:0;
    background:transparent;color:inherit;font:inherit;font-weight:500;min-height:22px;
    border-radius:6px;cursor:default;padding:4px 6px;line-height:1.2;
    overflow-wrap:anywhere}

  .twk-toggle{position:relative;width:32px;height:18px;border:0;border-radius:999px;
    background:rgba(0,0,0,.15);transition:background .15s;cursor:default;padding:0}
  .twk-toggle[data-on="1"]{background:#34c759}
  .twk-toggle i{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;
    background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}
  .twk-toggle[data-on="1"] i{transform:translateX(14px)}

  .twk-num{display:flex;align-items:center;height:26px;padding:0 0 0 8px;
    border:.5px solid rgba(0,0,0,.1);border-radius:7px;background:rgba(255,255,255,.6)}
  .twk-num-lbl{font-weight:500;color:rgba(41,38,27,.6);cursor:ew-resize;
    user-select:none;padding-right:8px}
  .twk-num input{flex:1;min-width:0;height:100%;border:0;background:transparent;
    font:inherit;font-variant-numeric:tabular-nums;text-align:right;padding:0 8px 0 0;
    outline:none;color:inherit;-moz-appearance:textfield}
  .twk-num input::-webkit-inner-spin-button,.twk-num input::-webkit-outer-spin-button{
    -webkit-appearance:none;margin:0}
  .twk-num-unit{padding-right:8px;color:rgba(41,38,27,.45)}

  .twk-btn{appearance:none;height:26px;padding:0 12px;border:0;border-radius:7px;
    background:rgba(0,0,0,.78);color:#fff;font:inherit;font-weight:500;cursor:default}
  .twk-btn:hover{background:rgba(0,0,0,.88)}
  .twk-btn.secondary{background:rgba(0,0,0,.06);color:inherit}
  .twk-btn.secondary:hover{background:rgba(0,0,0,.1)}

  .twk-swatch{appearance:none;-webkit-appearance:none;width:56px;height:22px;
    border:.5px solid rgba(0,0,0,.1);border-radius:6px;padding:0;cursor:default;
    background:transparent;flex-shrink:0}
  .twk-swatch::-webkit-color-swatch-wrapper{padding:0}
  .twk-swatch::-webkit-color-swatch{border:0;border-radius:5.5px}
  .twk-swatch::-moz-color-swatch{border:0;border-radius:5.5px}
`;
// ── useTweaks ───────────────────────────────────────────────────────────────
// Single source of truth for tweak values. setTweak persists via the host
// (__edit_mode_set_keys → host rewrites the EDITMODE block on disk).
/**
 * Manages use tweaks state for the UI.
 *
 * @param defaults defaults supplied to the function.
 * @returns The result produced by the operation.
 */
function useTweaks(defaults) {
    const [values, setValues] = React.useState(defaults);
    // Accepts either setTweak('key', value) or setTweak({ key: value, ... }) so a
    // useState-style call doesn't write a "[object Object]" key into the persisted
    // JSON block.
    const setTweak = React.useCallback((keyOrEdits, val) => {
        const edits = typeof keyOrEdits === 'object' && keyOrEdits !== null
            ? keyOrEdits : { [keyOrEdits]: val };
        setValues((prev) => ({ ...prev, ...edits }));
        window.parent.postMessage({ type: '__edit_mode_set_keys', edits }, '*');
    }, []);
    return [values, setTweak];
}
// ── TweaksPanel ─────────────────────────────────────────────────────────────
// Floating shell. Registers the protocol listener BEFORE announcing
// availability — if the announce ran first, the host's activate could land
// before our handler exists and the toolbar toggle would silently no-op.
// The close button posts __edit_mode_dismissed so the host's toolbar toggle
// flips off in lockstep; the host echoes __deactivate_edit_mode back which
// is what actually hides the panel.
/**
 * Renders the tweaks panel UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function TweaksPanel({ title = 'Tweaks', children }) {
    const [open, setOpen] = React.useState(false);
    const dragRef = React.useRef(null);
    const offsetRef = React.useRef({ x: 16, y: 16 });
    const PAD = 16;
    const clampToViewport = React.useCallback(() => {
        const panel = dragRef.current;
        if (!panel)
            return;
        const w = panel.offsetWidth, h = panel.offsetHeight;
        const maxRight = Math.max(PAD, window.innerWidth - w - PAD);
        const maxBottom = Math.max(PAD, window.innerHeight - h - PAD);
        offsetRef.current = {
            x: Math.min(maxRight, Math.max(PAD, offsetRef.current.x)),
            y: Math.min(maxBottom, Math.max(PAD, offsetRef.current.y)),
        };
        panel.style.right = offsetRef.current.x + 'px';
        panel.style.bottom = offsetRef.current.y + 'px';
    }, []);
    React.useEffect(() => {
        if (!open)
            return;
        clampToViewport();
        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', clampToViewport);
            return () => window.removeEventListener('resize', clampToViewport);
        }
        const ro = new ResizeObserver(clampToViewport);
        ro.observe(document.documentElement);
        return () => ro.disconnect();
    }, [open, clampToViewport]);
    React.useEffect(() => {
        /**
         * Handles the on msg operation.
         *
         * @param e Event object emitted by the runtime or UI.
         */
        const onMsg = (e) => {
            const t = e?.data?.type;
            if (t === '__activate_edit_mode')
                setOpen(true);
            else if (t === '__deactivate_edit_mode')
                setOpen(false);
        };
        window.addEventListener('message', onMsg);
        window.parent.postMessage({ type: '__edit_mode_available' }, '*');
        return () => window.removeEventListener('message', onMsg);
    }, []);
    /**
     * Handles the dismiss operation.
     */
    const dismiss = () => {
        setOpen(false);
        window.parent.postMessage({ type: '__edit_mode_dismissed' }, '*');
    };
    /**
     * Handles the on drag start operation.
     *
     * @param e Event object emitted by the runtime or UI.
     */
    const onDragStart = (e) => {
        const panel = dragRef.current;
        if (!panel)
            return;
        const r = panel.getBoundingClientRect();
        const sx = e.clientX, sy = e.clientY;
        const startRight = window.innerWidth - r.right;
        const startBottom = window.innerHeight - r.bottom;
        /**
         * Handles the move operation.
         *
         * @param ev ev supplied to the function.
         */
        const move = (ev) => {
            offsetRef.current = {
                x: startRight - (ev.clientX - sx),
                y: startBottom - (ev.clientY - sy),
            };
            clampToViewport();
        };
        /**
         * Handles the up operation.
         */
        const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
    };
    if (!open)
        return null;
    return (React.createElement(React.Fragment, null,
        React.createElement("style", null, __TWEAKS_STYLE),
        React.createElement("div", { ref: dragRef, className: "twk-panel", "data-noncommentable": "", style: { right: offsetRef.current.x, bottom: offsetRef.current.y } },
            React.createElement("div", { className: "twk-hd", onMouseDown: onDragStart },
                React.createElement("b", null, title),
                React.createElement("button", { className: "twk-x", "aria-label": "Close tweaks", onMouseDown: (e) => e.stopPropagation(), onClick: dismiss }, "\u2715")),
            React.createElement("div", { className: "twk-body" }, children))));
}
// ── Layout helpers ──────────────────────────────────────────────────────────
/**
 * Renders the tweak section UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function TweakSection({ label, children }) {
    return (React.createElement(React.Fragment, null,
        React.createElement("div", { className: "twk-sect" }, label),
        children));
}
/**
 * Renders the tweak row UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function TweakRow({ label, value, children, inline = false }) {
    return (React.createElement("div", { className: inline ? 'twk-row twk-row-h' : 'twk-row' },
        React.createElement("div", { className: "twk-lbl" },
            React.createElement("span", null, label),
            value != null && React.createElement("span", { className: "twk-val" }, value)),
        children));
}
// ── Controls ────────────────────────────────────────────────────────────────
/**
 * Renders the tweak slider UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function TweakSlider({ label, value, min = 0, max = 100, step = 1, unit = '', onChange }) {
    return (React.createElement(TweakRow, { label: label, value: `${value}${unit}` },
        React.createElement("input", { type: "range", className: "twk-slider", min: min, max: max, step: step, value: value, onChange: (e) => onChange(Number(e.target.value)) })));
}
/**
 * Renders the tweak toggle UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function TweakToggle({ label, value, onChange }) {
    return (React.createElement("div", { className: "twk-row twk-row-h" },
        React.createElement("div", { className: "twk-lbl" },
            React.createElement("span", null, label)),
        React.createElement("button", { type: "button", className: "twk-toggle", "data-on": value ? '1' : '0', role: "switch", "aria-checked": !!value, onClick: () => onChange(!value) },
            React.createElement("i", null))));
}
/**
 * Renders the tweak radio UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function TweakRadio({ label, value, options, onChange }) {
    const trackRef = React.useRef(null);
    const [dragging, setDragging] = React.useState(false);
    const opts = options.map((o) => (typeof o === 'object' ? o : { value: o, label: o }));
    const idx = Math.max(0, opts.findIndex((o) => o.value === value));
    const n = opts.length;
    // The active value is read by pointer-move handlers attached for the lifetime
    // of a drag — ref it so a stale closure doesn't fire onChange for every move.
    const valueRef = React.useRef(value);
    valueRef.current = value;
    /**
     * Handles the seg at operation.
     *
     * @param clientX client x supplied to the function.
     * @returns The result produced by the operation.
     */
    const segAt = (clientX) => {
        const r = trackRef.current.getBoundingClientRect();
        const inner = r.width - 4;
        const i = Math.floor(((clientX - r.left - 2) / inner) * n);
        return opts[Math.max(0, Math.min(n - 1, i))].value;
    };
    /**
     * Handles the on pointer down operation.
     *
     * @param e Event object emitted by the runtime or UI.
     */
    const onPointerDown = (e) => {
        setDragging(true);
        const v0 = segAt(e.clientX);
        if (v0 !== valueRef.current)
            onChange(v0);
        /**
         * Handles the move operation.
         *
         * @param ev ev supplied to the function.
         */
        const move = (ev) => {
            if (!trackRef.current)
                return;
            const v = segAt(ev.clientX);
            if (v !== valueRef.current)
                onChange(v);
        };
        /**
         * Handles the up operation.
         */
        const up = () => {
            setDragging(false);
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    };
    return (React.createElement(TweakRow, { label: label },
        React.createElement("div", { ref: trackRef, role: "radiogroup", onPointerDown: onPointerDown, className: dragging ? 'twk-seg dragging' : 'twk-seg' },
            React.createElement("div", { className: "twk-seg-thumb", style: { left: `calc(2px + ${idx} * (100% - 4px) / ${n})`,
                    width: `calc((100% - 4px) / ${n})` } }),
            opts.map((o) => (React.createElement("button", { key: o.value, type: "button", role: "radio", "aria-checked": o.value === value }, o.label))))));
}
/**
 * Renders the tweak select UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function TweakSelect({ label, value, options, onChange }) {
    return (React.createElement(TweakRow, { label: label },
        React.createElement("select", { className: "twk-field", value: value, onChange: (e) => onChange(e.target.value) }, options.map((o) => {
            const v = typeof o === 'object' ? o.value : o;
            const l = typeof o === 'object' ? o.label : o;
            return React.createElement("option", { key: v, value: v }, l);
        }))));
}
/**
 * Renders the tweak text UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function TweakText({ label, value, placeholder, onChange }) {
    return (React.createElement(TweakRow, { label: label },
        React.createElement("input", { className: "twk-field", type: "text", value: value, placeholder: placeholder, onChange: (e) => onChange(e.target.value) })));
}
/**
 * Renders the tweak number UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function TweakNumber({ label, value, min, max, step = 1, unit = '', onChange }) {
    /**
     * Handles the clamp operation.
     *
     * @param n n supplied to the function.
     * @returns The result produced by the operation.
     */
    const clamp = (n) => {
        if (min != null && n < min)
            return min;
        if (max != null && n > max)
            return max;
        return n;
    };
    const startRef = React.useRef({ x: 0, val: 0 });
    /**
     * Handles the on scrub start operation.
     *
     * @param e Event object emitted by the runtime or UI.
     */
    const onScrubStart = (e) => {
        e.preventDefault();
        startRef.current = { x: e.clientX, val: value };
        const decimals = (String(step).split('.')[1] || '').length;
        /**
         * Handles the move operation.
         *
         * @param ev ev supplied to the function.
         */
        const move = (ev) => {
            const dx = ev.clientX - startRef.current.x;
            const raw = startRef.current.val + dx * step;
            const snapped = Math.round(raw / step) * step;
            onChange(clamp(Number(snapped.toFixed(decimals))));
        };
        /**
         * Handles the up operation.
         */
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    };
    return (React.createElement("div", { className: "twk-num" },
        React.createElement("span", { className: "twk-num-lbl", onPointerDown: onScrubStart }, label),
        React.createElement("input", { type: "number", value: value, min: min, max: max, step: step, onChange: (e) => onChange(clamp(Number(e.target.value))) }),
        unit && React.createElement("span", { className: "twk-num-unit" }, unit)));
}
/**
 * Renders the tweak color UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function TweakColor({ label, value, onChange }) {
    return (React.createElement("div", { className: "twk-row twk-row-h" },
        React.createElement("div", { className: "twk-lbl" },
            React.createElement("span", null, label)),
        React.createElement("input", { type: "color", className: "twk-swatch", value: value, onChange: (e) => onChange(e.target.value) })));
}
/**
 * Renders the tweak button UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function TweakButton({ label, onClick, secondary = false }) {
    return (React.createElement("button", { type: "button", className: secondary ? 'twk-btn secondary' : 'twk-btn', onClick: onClick }, label));
}
Object.assign(window, {
    useTweaks, TweaksPanel, TweakSection, TweakRow,
    TweakSlider, TweakToggle, TweakRadio, TweakSelect,
    TweakText, TweakNumber, TweakColor, TweakButton,
});


// AGPL-3.0-only — 1Patch management UI API client
const SESSION_KEY = '1patch-session';
const DEMO_MODE = /^\/ui\/demo(?:\/|$)/.test(window.location.pathname) || new URLSearchParams(window.location.search).has('demo');
/**
 * Handles the session operation.
 * @returns The result produced by the operation.
 */
function session() {
    try {
        return JSON.parse(localStorage.getItem(SESSION_KEY) || '{}');
    }
    catch {
        return {};
    }
}
/**
 * Handles the store session operation.
 *
 * @param sessionBody session body supplied to the function.
 * @returns The result produced by the operation.
 */
function storeSession(sessionBody) {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
        accessToken: sessionBody.accessToken,
        user: sessionBody.user,
        authMethod: sessionBody.authMethod ?? 'password',
    }));
    window.dispatchEvent(new CustomEvent('patch-session-change', { detail: sessionBody }));
    return sessionBody;
}
/**
 * Handles the clear session operation.
 */
function clearSession() {
    localStorage.removeItem(SESSION_KEY);
    window.dispatchEvent(new CustomEvent('patch-session-change', { detail: null }));
}
/**
 * Handles the login with credentials operation.
 *
 * @param email email supplied to the function.
 * @param password password supplied to the function.
 * @returns The result produced by the operation.
 */
async function loginWithCredentials(email, password) {
    const r = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok)
        throw new Error(body.message || 'Login failed');
    if (body.mfaRequired)
        return body;
    return storeSession(body);
}
/**
 * Validates mfa with code rules.
 *
 * @param challengeToken Token used to authenticate or authorize the operation.
 * @param code code supplied to the function.
 * @returns The result produced by the operation.
 */
async function verifyMfaWithCode(challengeToken, code) {
    const r = await fetch('/auth/mfa/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ challengeToken, code }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok)
        throw new Error(body.message || 'MFA verification failed');
    return storeSession(body);
}
/**
 * Handles the token operation.
 * @returns The result produced by the operation.
 */
async function token() {
    const existing = session().accessToken;
    if (existing)
        return existing;
    const err = new Error('Authentication required');
    err.code = 'AUTH_REQUIRED';
    throw err;
}
/**
 * Handles the api operation.
 *
 * @param path Filesystem or URL path used by the operation.
 * @param init init supplied to the function.
 * @returns The result produced by the operation.
 */
async function api(path, init) {
    const headers = { 'content-type': 'application/json' };
    const t = await token();
    if (t)
        headers.authorization = `Bearer ${t}`;
    const r = await fetch(path, { ...init, headers: { ...headers, ...(init && init.headers) } });
    if (r.status === 401) {
        clearSession();
        const err = new Error('Session expired');
        err.code = 'AUTH_REQUIRED';
        throw err;
    }
    const ct = r.headers.get('content-type') || '';
    if (!r.ok) {
        const body = ct.includes('application/json') ? await r.json().catch(() => ({})) : await r.text().catch(() => '');
        throw new Error(body?.message || body?.error || body || `${r.status} ${r.statusText} — ${path}`);
    }
    return ct.includes('application/json') ? r.json() : r.text();
}
// SSO helpers
async function ssoProvidersPublic() {
    const r = await fetch('/sso/providers');
    const body = await r.json().catch(() => []);
    if (!r.ok)
        return [];
    return body;
}
async function ssoInitiate(providerId) {
    const r = await fetch(`/auth/sso/${encodeURIComponent(providerId)}/initiate`);
    const body = await r.json().catch(() => ({}));
    if (!r.ok)
        throw new Error(body.message || 'SSO initiation failed');
    return body; // { authorizationUrl }
}
async function ssoComplete(handoffToken) {
    const r = await fetch('/auth/sso/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handoffToken }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok)
        throw new Error(body.message || 'SSO completion failed');
    return storeSession(body);
}
function demoIso(minutesAgo) {
    return new Date(Date.now() - minutesAgo * 60000).toISOString();
}
function makeDemoData() {
    const sites = ['Berlin HQ', 'Munich DC', 'Frankfurt Edge', 'Hamburg Office', 'Remote EMEA', 'US East'];
    const groups = ['Finance', 'Engineering', 'Operations', 'Executive', 'Retail', 'Build Farm'];
    const nodeIds = ['node-eu-central-1', 'node-eu-west-1', 'node-us-east-1', 'node-lab-1'];
    const appDefs = [
        ['Google Chrome', 'Google', '125.0.6422.142', '124.0.6367.207', true],
        ['Microsoft Edge', 'Microsoft', '125.0.2535.92', '124.0.2478.109', false],
        ['Mozilla Firefox ESR', 'Mozilla', '115.12.0', '115.9.1', true],
        ['7-Zip', 'Igor Pavlov', '24.06', '23.01', false],
        ['Notepad++', 'Notepad++ Team', '8.6.8', '8.5.7', false],
        ['Git', 'Git SCM', '2.45.2', '2.43.0', false],
        ['OpenJDK Runtime', 'Eclipse Adoptium', '21.0.3', '17.0.10', true],
        ['Microsoft Teams', 'Microsoft', '24124.2312.2911', '24060.2623.2790', false],
        ['Zoom Workplace', 'Zoom', '6.0.11', '5.17.11', true],
        ['Docker Desktop', 'Docker', '4.31.0', '4.27.1', false],
        ['Visual Studio Code', 'Microsoft', '1.90.0', '1.88.1', false],
        ['LibreOffice', 'The Document Foundation', '24.2.4', '7.6.7', false],
    ];
    const devices = Array.from({ length: 96 }, (_, i) => {
        const n = i + 1;
        const linux = i % 5 === 0 || i % 13 === 0;
        const online = i % 9 !== 0;
        return {
            id: `dev-${String(n).padStart(4, '0')}`,
            hostname: `${linux ? 'lin' : 'win'}-${sites[i % sites.length].toLowerCase().replace(/[^a-z]+/g, '-')}-${String(n).padStart(3, '0')}`,
            os: linux ? (i % 2 ? 'Ubuntu 22.04.4 LTS' : 'Debian GNU/Linux 12') : (i % 3 ? 'Microsoft Windows 10.0.22631' : 'Microsoft Windows 10.0.26100'),
            platform: linux ? 'linux' : 'windows',
            site: sites[i % sites.length],
            group: groups[i % groups.length],
            tags: [i % 4 === 0 ? 'production' : 'standard', i % 7 === 0 ? 'browser-critical' : 'auto-update'],
            preferredNodeId: nodeIds[i % nodeIds.length],
            installedAppCount: 18 + (i % 31),
            pendingTaskCount: i % 8 === 0 ? 3 : i % 6 === 0 ? 1 : 0,
            lastSeenAt: demoIso(online ? (2 + (i % 30)) : (220 + i * 7)),
            online,
            deviceTrustScore: 96 - (i % 19),
            riskScore: i % 11 === 0 ? 74 : 18 + (i % 32),
        };
    });
    const apps = appDefs.map(([name, publisher, latestVersion, oldestVersion, critical], i) => {
        const deviceCount = 44 + ((i * 17) % 52);
        const outdatedDeviceCount = i % 4 === 0 ? 28 - i : 6 + ((i * 5) % 19);
        return { name, publisher, latestVersion, latest: latestVersion, oldestVersion, oldest: oldestVersion, deviceCount, outdatedDeviceCount, outdated: outdatedDeviceCount, critical };
    });
    const tasks = Array.from({ length: 72 }, (_, i) => {
        const app = apps[i % apps.length];
        const status = ['completed', 'completed', 'completed', 'dispatched', 'pending', 'failed', 'rejected', 'cancelled'][i % 8];
        return {
            id: `task-${String(i + 1).padStart(5, '0')}`,
            type: i % 10 === 0 ? 'refresh_inventory' : 'update_app',
            appName: app.name,
            deviceId: devices[i % devices.length].id,
            nodeId: nodeIds[i % nodeIds.length],
            status,
            fromVersion: app.oldestVersion,
            targetVersion: app.latestVersion,
            createdAt: demoIso(8 + i * 11),
            completedAt: ['completed', 'failed', 'rejected', 'cancelled'].includes(status) ? demoIso(2 + i * 10) : null,
            output: status === 'failed' ? 'Installer exited with code 1603 after signature verification succeeded.' : status === 'completed' ? 'Package installed and inventory refreshed.' : '',
        };
    });
    const alarms = [
        ['critical', 'Chrome CVE exposure remains on 28 production endpoints', devices[3].id, 12],
        ['critical', 'Backend node node-lab-1 entered quarantine after trust drop', null, 35],
        ['warning', 'High package queue lag in Frankfurt Edge', devices[14].id, 48],
        ['warning', 'Linux repo metadata stale on Munich DC cache', devices[20].id, 76],
        ['info', 'New unmanaged device discovered from enrollment token', devices[55].id, 130],
        ['warning', 'Repeated install failures for OpenJDK Runtime', devices[42].id, 155],
        ['critical', 'Unsigned package upload rejected by policy', null, 190],
        ['warning', 'Offline executive laptop missed maintenance window', devices[8].id, 260],
    ].map(([severity, message, deviceId, age], i) => ({ id: `alarm-${i + 1}`, severity, message, deviceId, createdAt: demoIso(age) }));
    const packages = appDefs.flatMap(([name, publisher, latestVersion], i) => ([
        {
            id: `pkg-win-${i + 1}`,
            name,
            publisher,
            version: latestVersion,
            type: i % 3 === 0 ? 'msi' : 'winget',
            platform: 'windows',
            architecture: 'x64',
            signatureStatus: i % 5 === 0 ? 'unknown' : 'valid',
            catalogSource: i % 4 === 0 ? 'custom' : 'central',
            catalogCategory: i % 2 ? 'Productivity' : 'Security',
            sha256: `demo-sha256-${i + 1}`,
            createdAt: demoIso(400 + i * 55),
        },
        i % 3 === 0 ? {
            id: `pkg-linux-${i + 1}`,
            name,
            publisher,
            version: latestVersion,
            type: 'apt',
            platform: 'linux',
            architecture: 'amd64',
            signatureStatus: 'valid',
            catalogSource: 'central',
            catalogCategory: 'Linux',
            sha256: `demo-linux-sha256-${i + 1}`,
            createdAt: demoIso(480 + i * 65),
        } : null,
    ])).filter(Boolean);
    const nodes = nodeIds.map((id, i) => ({
        id,
        name: id.replace(/-/g, ' '),
        publicUrl: `https://${id}.demo.1patch.local`,
        region: ['eu-central', 'eu-west', 'us-east', 'lab'][i],
        site: sites[i],
        status: i === 3 ? 'online' : 'online',
        version: `0.1.${12 - i}`,
        capabilities: ['inventory', 'package-cache', 'signed-execution', i % 2 ? 'linux' : 'windows'],
        healthState: i === 3 ? 'degraded' : 'healthy',
        maintenanceState: i === 2 ? 'draining' : 'active',
        quarantineState: i === 3 ? 'quarantined' : 'clear',
        quarantineReason: i === 3 ? 'trust score below tenant threshold' : '',
        lastSeenAt: demoIso(3 + i * 8),
        health: {
            memoryPressurePercent: [44, 62, 78, 91][i],
            diskFreeBytes: [420e9, 220e9, 84e9, 900e6][i],
            clockSkewMs: i === 3 ? 9200 : 600,
            queueLag: ['low', 'low', 'medium', 'high'][i],
            components: [
                { name: 'agent', status: i === 3 ? 'degraded' : 'healthy' },
                { name: 'cache', status: i === 2 ? 'degraded' : 'healthy' },
                { name: 'verifier', status: i === 3 ? 'unhealthy' : 'healthy' },
            ],
        },
        trust: {
            id: `trust-${id}`,
            trustScore: [96, 89, 74, 42][i],
            previousTrustScore: [95, 91, 80, 68][i],
            scoreDelta: [1, -2, -6, -26][i],
            healthState: i === 3 ? 'degraded' : 'healthy',
            certValid: i !== 3,
            latencyMs: [38, 64, 142, 680][i],
            queueLag: ['low', 'low', 'medium', 'high'][i],
            reasons: i === 3 ? ['package verifier unhealthy', 'high queue lag', 'clock skew detected'] : ['signed health report accepted'],
            securityFindings: i === 3 ? [{ severity: 'high', category: 'health', message: 'Package verifier component unhealthy' }] : [],
        },
    }));
    const audit = Array.from({ length: 48 }, (_, i) => ({
        id: `audit-${i + 1}`,
        createdAt: demoIso(5 + i * 17),
        actor: ['admin@1patch.demo', 'sre@1patch.demo', 'node-eu-central-1', 'policy-engine'][i % 4],
        action: ['task.queued', 'package.signed', 'rule.evaluated', 'device.enrolled', 'alarm.created', 'auth.mfa.verified'][i % 6],
        target: [devices[i % devices.length].id, apps[i % apps.length].name, nodeIds[i % nodeIds.length]][i % 3],
    }));
    const rules = [
        ['Critical browser CVE rollout', true, 'inventory_changed'],
        ['Quarantine low-trust node', true, 'node_trust_changed'],
        ['Refresh stale Linux inventory', true, 'schedule'],
        ['Notify SIEM on failed update burst', true, 'task_failed'],
        ['Executive laptop maintenance window', false, 'schedule'],
    ].map(([name, enabled, eventType], i) => ({
        id: `rule-${i + 1}`,
        name,
        enabled,
        description: `Demo automation rule ${i + 1}`,
        trigger: { type: 'event', eventType },
        conditionGroup: { combinator: 'AND', conditions: [{ field: 'severity', operator: 'gte', value: i === 0 ? 'critical' : 'warning' }] },
        actions: [{ type: i % 2 ? 'notify' : 'create_task', target: i % 2 ? 'siem' : 'outdated_devices' }],
    }));
    const compliantApps = apps.reduce((sum, app) => sum + app.deviceCount - app.outdatedDeviceCount, 0);
    const outdatedApps = apps.reduce((sum, app) => sum + app.outdatedDeviceCount, 0);
    return { devices, apps, tasks, alarms, packages, nodes, audit, rules, summary: {
            managedDevices: devices.length,
            onlineDevices: devices.filter(d => d.online).length,
            coverage: 87,
            compliantApps,
            outdatedApps,
            criticalAlarms: alarms.filter(a => a.severity === 'critical').length,
            activeRules: rules.filter(r => r.enabled).length,
        } };
}
const DEMO_DATA = DEMO_MODE ? makeDemoData() : null;
const demoResolve = (value) => Promise.resolve(JSON.parse(JSON.stringify(value)));
const demoSession = {
    accessToken: 'demo-token',
    user: {
        email: 'admin@1patch.demo',
        permissions: ['auth:manage', 'users:manage', 'roles:manage', 'tasks:manage', 'packages:manage'],
    },
    authMethod: 'demo',
};
const DEMO_API = DEMO_MODE ? {
    session: () => demoSession,
    login: () => demoResolve(demoSession),
    verifyMfa: () => demoResolve(demoSession),
    ssoProviders: () => demoResolve([]),
    ssoInitiate: () => demoResolve({ authorizationUrl: '/ui/demo' }),
    ssoComplete: () => demoResolve(demoSession),
    logout: () => { },
    summary: () => demoResolve(DEMO_DATA.summary),
    coverageHistory: (days = 30) => demoResolve(Array.from({ length: days }, (_, i) => ({ date: demoIso((days - i) * 1440), value: 74 + Math.round(i * 0.46) + (i % 5 === 0 ? -2 : i % 7 === 0 ? 1 : 0) }))),
    devices: () => demoResolve(DEMO_DATA.devices),
    device: (id) => {
        const device = DEMO_DATA.devices.find(d => d.id === id) || DEMO_DATA.devices[0];
        const installedApps = DEMO_DATA.apps.slice(0, 10).map((app, i) => ({ ...app, version: i % 3 === 0 ? app.oldestVersion : app.latestVersion, latestVersion: app.latestVersion, packageId: `pkg-win-${i + 1}` }));
        const tasks = DEMO_DATA.tasks.filter(t => t.deviceId === device.id).slice(0, 8);
        return demoResolve({ device, installedApps, tasks });
    },
    deviceGroups: () => demoResolve([]),
    createDevice: (body) => demoResolve({ id: 'demo-created-device', ...body }),
    createDeviceEnrollment: (body) => demoResolve({ id: 'demo-enrollment', count: body?.maxUses || 1, oneLineJson: JSON.stringify({ Demo: true, TenantId: body?.tenantId || 'default' }), config: { Demo: true, TenantId: body?.tenantId || 'default' } }),
    apps: () => demoResolve(DEMO_DATA.apps),
    packages: () => demoResolve(DEMO_DATA.packages),
    packageCatalog: () => demoResolve(DEMO_DATA.packages.slice(0, 12)),
    createPackage: (body) => demoResolve({ id: 'demo-created-package', createdAt: new Date().toISOString(), signatureStatus: 'valid', ...body }),
    deployPackageAll: (id) => demoResolve({ tasks: DEMO_DATA.tasks.slice(0, 7).map(t => ({ ...t, packageArtifactId: id, status: 'pending' })) }),
    rules: () => demoResolve(DEMO_DATA.rules),
    createRule: (body) => demoResolve({ id: 'demo-created-rule', ...body }),
    updateRule: (id, body) => demoResolve({ id, ...body }),
    toggleRule: (id, enabled) => demoResolve({ id, enabled }),
    testRule: () => demoResolve({ matched: 18, actions: ['create_task', 'notify'] }),
    triggerRule: () => demoResolve([{ id: 'demo-triggered-task', status: 'pending' }]),
    ruleTemplates: () => demoResolve([]),
    createRuleDraftFromTemplate: (_id, body) => demoResolve({ name: 'Demo rule draft', ...body }),
    importRuleTemplateConfig: (body) => demoResolve({ name: 'Imported demo rule', ...body }),
    ruleAudit: () => demoResolve(DEMO_DATA.audit.slice(0, 10)),
    tasks: () => demoResolve(DEMO_DATA.tasks),
    cancelTask: (id) => demoResolve({ id, status: 'cancelled' }),
    scanTask: (id) => demoResolve({ id, status: 'security_scanned' }),
    approveTask: (id) => demoResolve({ id, status: 'mfa_approved' }),
    signTask: (id) => demoResolve({ id, status: 'signed' }),
    issueMfaChallenge: () => demoResolve({ challengeId: 'demo-challenge-id' }),
    verifyMfaChallenge: () => demoResolve({ verified: true }),
    nodes: () => demoResolve(DEMO_DATA.nodes),
    nodeTrustCenter: () => demoResolve(DEMO_DATA.nodes),
    nodeTrustDetail: (id) => demoResolve(DEMO_DATA.nodes.find(n => n.id === id) || DEMO_DATA.nodes[0]),
    clearNodeQuarantine: (id) => demoResolve({ id, quarantineState: 'clear' }),
    createNodeEnrollment: (body) => demoResolve({ id: 'demo-node-enrollment', token: 'demo-node-token', ...body }),
    deleteNode: (id) => demoResolve({ id, deleted: true }),
    alarms: () => demoResolve(DEMO_DATA.alarms),
    resolveAlarm: (id) => demoResolve({ id, resolved: true }),
    resolveAllAlarms: () => demoResolve({ resolved: DEMO_DATA.alarms.length }),
    audit: (limit = 100) => demoResolve(DEMO_DATA.audit.slice(0, limit)),
    siemConfig: (tenantId = 'default') => demoResolve({ tenantId, config: { enabled: true, webhook: { enabled: true, url: 'https://siem.demo/ingest' }, syslog: { enabled: true, host: 'syslog.demo', port: 514 }, sentinel: { enabled: false } } }),
    saveSiemConfig: (_tenantId, body) => demoResolve({ saved: true, config: body }),
    testSiem: () => demoResolve({ ok: true, message: 'Demo SIEM event accepted' }),
    verifySiem: () => demoResolve({ ok: true, findings: [] }),
    siemQueueStatus: () => demoResolve({ pending: 42, failed: 1, deliveredLastHour: 1284 }),
    securityPosture: () => demoResolve({ score: 91, findings: [], checks: [] }),
    fixSecurityPosture: () => demoResolve({ fixed: 0 }),
    tenantPolicy: () => demoResolve({ requireApproval: true, maxConcurrentTasks: 250, allowedPackageSources: ['central', 'custom'] }),
    saveTenantPolicy: (_tenantId, body) => demoResolve(body),
    adminUsers: () => demoResolve([{ id: 'usr-1', email: 'admin@1patch.demo', roleId: 'role-admin', mfaEnabled: true, disabled: false }, { id: 'usr-2', email: 'sre@1patch.demo', roleId: 'role-operator', mfaEnabled: true, disabled: false }]),
    adminRbac: () => demoResolve({ roles: [{ id: 'role-admin', name: 'Administrator', permissions: demoSession.user.permissions }, { id: 'role-operator', name: 'Operator', permissions: ['tasks:manage', 'packages:read'] }], permissions: demoSession.user.permissions }),
    adminCreateUser: (body) => demoResolve({ id: 'demo-user', ...body }),
    adminUpdateUser: (id, body) => demoResolve({ id, ...body }),
    adminDeleteUser: (id) => demoResolve({ id, deleted: true }),
    adminCreateRole: (body) => demoResolve({ id: 'demo-role', ...body }),
    adminUpdateRole: (id, body) => demoResolve({ id, ...body }),
    adminDeleteRole: (id) => demoResolve({ id, deleted: true }),
    ssoProvidersAdmin: () => demoResolve([]),
    ssoCreateProvider: (body) => demoResolve({ id: 'demo-sso', ...body }),
    ssoUpdateProvider: (id, body) => demoResolve({ id, ...body }),
    ssoDeleteProvider: (id) => demoResolve({ id, deleted: true }),
    retirementPolicies: () => demoResolve([{ id: 'retire-1', name: 'Retire inactive endpoints', description: 'Flag devices inactive for 90 days.', enabled: true, priority: 20, conditionCombinator: 'AND', conditions: [{ type: 'inactive_days', days: 90 }], actions: [{ type: 'tag_device', tag: 'retired' }], lastEvaluatedAt: demoIso(300), matchCount: 7 }]),
    createRetirementPolicy: (body) => demoResolve({ id: 'demo-retirement', ...body }),
    updateRetirementPolicy: (id, body) => demoResolve({ id, ...body }),
    deleteRetirementPolicy: (id) => demoResolve({ id, deleted: true }),
    evaluateRetirementPolicy: () => demoResolve({ matchCount: 7, totalDevices: DEMO_DATA.devices.length, matchedDevices: DEMO_DATA.devices.slice(0, 7) }),
    refreshInventory: (id) => demoResolve({ id, queued: true }),
    updateAllOutdated: (id) => demoResolve({ tasks: DEMO_DATA.tasks.slice(0, 5).map(t => ({ ...t, deviceId: id, status: 'pending' })) }),
    updateAllForApp: (name) => demoResolve(DEMO_DATA.tasks.slice(0, 12).map(t => ({ ...t, appName: name, status: 'pending' }))),
    updateDeviceForApp: (name, body) => demoResolve({ id: 'demo-device-task', appName: name, ...body, status: 'pending' }),
} : null;
const LIVE_API = {
    session,
    /**
     * Handles the login operation.
     *
     * @param email email supplied to the function.
     * @param password password supplied to the function.
     */
    login: (email, password) => loginWithCredentials(email, password),
    /**
     * Validates mfa rules.
     *
     * @param challengeToken Token used to authenticate or authorize the operation.
     * @param code code supplied to the function.
     */
    verifyMfa: (challengeToken, code) => verifyMfaWithCode(challengeToken, code),
    ssoProviders: () => ssoProvidersPublic(),
    ssoInitiate: (id) => ssoInitiate(id),
    ssoComplete: (token) => ssoComplete(token),
    ssoProvidersAdmin: () => api('/sso/providers/all'),
    ssoCreateProvider: (b) => api('/sso/providers', { method: 'POST', body: JSON.stringify(b) }),
    ssoUpdateProvider: (id, b) => api(`/sso/providers/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(b) }),
    ssoDeleteProvider: (id) => api(`/sso/providers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /**
     * Handles the logout operation — revokes the token server-side, then clears local session.
     */
    logout: () => {
        const tok = session().accessToken;
        if (tok) {
            // Best-effort server-side revocation — always clear locally regardless of outcome
            fetch('/auth/logout', {
                method: 'POST',
                headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
            }).catch(() => { });
        }
        clearSession();
    },
    /**
     * Handles the summary operation.
     */
    summary: () => api('/dashboard/summary'),
    /**
     * Handles the coverage history operation.
     *
     * @param d d supplied to the function.
     */
    coverageHistory: (d = 30) => api(`/dashboard/coverage-history?days=${d}`),
    /**
     * Handles the devices operation.
     *
     * @param q Search query or filter supplied by the caller.
     */
    devices: (q) => api('/devices' + (q ? `?q=${encodeURIComponent(q)}` : '')),
    /**
     * Handles the device operation.
     *
     * @param id Identifier used to locate the target record.
     */
    device: (id) => api(`/devices/${id}`),
    /**
     * Handles the device groups operation.
     *
     * @param t t supplied to the function.
     */
    deviceGroups: (t = 'default') => api(`/devices/groups?tenantId=${encodeURIComponent(t)}`),
    /**
     * Creates a device record.
     *
     * @param b b supplied to the function.
     */
    createDevice: (b) => api('/devices', { method: 'POST', body: JSON.stringify(b) }),
    /**
     * Updates the device record or state.
     *
     * @param id Identifier used to locate the target record.
     * @param b b supplied to the function.
     */
    updateDevice: (id, b) => api(`/devices/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
    /**
     * Creates a device enrollment record.
     *
     * @param b b supplied to the function.
     */
    createDeviceEnrollment: (b) => api('/devices/enrollments', { method: 'POST', body: JSON.stringify(b) }),
    /**
     * Handles the apps operation.
     *
     * @param q Search query or filter supplied by the caller.
     */
    apps: (q) => api('/apps' + (q ? `?q=${encodeURIComponent(q)}` : '')),
    /**
     * Handles the packages operation.
     */
    packages: () => api('/packages'),
    /**
     * Handles the rules operation.
     */
    rules: () => api('/rules'),
    /**
     * Handles the tasks operation.
     */
    tasks: () => api('/tasks'),
    tenantPolicy: (t = 'default') => api(`/tasks/policy/${encodeURIComponent(t)}`),
    saveTenantPolicy: (t = 'default', b) => api(`/tasks/policy/${encodeURIComponent(t)}`, { method: 'PUT', body: JSON.stringify(b) }),
    /**
     * Handles the cancel task operation.
     *
     * @param id Identifier used to locate the target record.
     */
    cancelTask: (id) => api(`/tasks/${id}`, { method: 'DELETE' }),
    scanTask: (id) => api(`/tasks/${id}/scan`, { method: 'POST', body: '{}' }),
    approveTask: (id, mfaChallengeId) => api(`/tasks/${id}/approve`, { method: 'POST', body: JSON.stringify({ mfaChallengeId: mfaChallengeId || '' }) }),
    signTask: (id) => api(`/tasks/${id}/sign`, { method: 'POST', body: '{}' }),
    issueMfaChallenge: () => api('/tasks/mfa-challenge/issue', { method: 'POST', body: '{}' }),
    verifyMfaChallenge: (challengeId, totpCode) => api('/tasks/mfa-challenge/verify', { method: 'POST', body: JSON.stringify({ challengeId, totpCode }) }),
    /**
     * Handles the nodes operation.
     */
    nodes: () => api('/nodes'),
    nodeTrustCenter: () => api('/nodes/trust-center'),
    nodeTrustDetail: (id) => api(`/nodes/${encodeURIComponent(id)}/trust-center`),
    clearNodeQuarantine: (id) => api(`/nodes/${encodeURIComponent(id)}/quarantine/clear`, { method: 'POST', body: '{}' }),
    /**
     * Creates a node enrollment record.
     *
     * @param b b supplied to the function.
     */
    createNodeEnrollment: (b) => api('/nodes/enrollments', { method: 'POST', body: JSON.stringify(b) }),
    deleteNode: (id) => api('/nodes/' + encodeURIComponent(id), { method: 'DELETE' }),
    /**
     * Handles the alarms operation.
     */
    alarms: () => api('/alarms'),
    /**
     * Handles the audit operation.
     *
     * @param l l supplied to the function.
     */
    audit: (l = 100) => api(`/audit?limit=${l}`),
    adminUsers: () => api('/admin/users'),
    adminCreateUser: (b) => api('/admin/users', { method: 'POST', body: JSON.stringify(b) }),
    adminUpdateUser: (id, b) => api(`/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(b) }),
    adminDeleteUser: (id) => api(`/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    adminRbac: () => api('/admin/rbac'),
    adminCreateRole: (b) => api('/admin/roles', { method: 'POST', body: JSON.stringify(b) }),
    adminUpdateRole: (id, b) => api(`/admin/roles/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(b) }),
    adminDeleteRole: (id) => api(`/admin/roles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    /**
     * Handles the siem config operation.
     *
     * @param t t supplied to the function.
     */
    siemConfig: (t = 'default') => api(`/siem/config/${encodeURIComponent(t)}`),
    /**
     * Saves siem config data.
     *
     * @param t t supplied to the function.
     * @param b b supplied to the function.
     */
    saveSiemConfig: (t, b) => api(`/siem/config/${encodeURIComponent(t)}`, { method: 'PUT', body: JSON.stringify(b) }),
    /**
     * Handles the test siem operation.
     *
     * @param t t supplied to the function.
     */
    testSiem: (t = 'default') => api(`/siem/test/${encodeURIComponent(t)}`, { method: 'POST', body: '{}' }),
    /**
     * Validates siem rules.
     *
     * @param t t supplied to the function.
     */
    verifySiem: (t = 'default') => api(`/siem/verify/${encodeURIComponent(t)}`, { method: 'POST', body: '{}' }),
    /**
     * Handles the siem queue status operation.
     */
    siemQueueStatus: () => api('/siem/queue/status'),
    /**
     * Handles the security posture operation.
     *
     * @param t t supplied to the function.
     */
    securityPosture: (t = 'default') => api(`/security/posture?tenantId=${encodeURIComponent(t)}`),
    /**
     * Handles the fix security posture operation.
     *
     * @param t t supplied to the function.
     * @param actions actions supplied to the function.
     */
    fixSecurityPosture: (t = 'default', actions) => api(`/security/posture/fix?tenantId=${encodeURIComponent(t)}`, { method: 'POST', body: JSON.stringify(actions ? { actions } : {}) }),
    /**
     * Creates a package record.
     *
     * @param b b supplied to the function.
     */
    packageCatalog: () => api('/packages/catalog'),
    createPackage: (b) => api('/packages', { method: 'POST', body: JSON.stringify(b) }),
    /**
     * Handles the deploy package all operation.
     *
     * @param id Identifier used to locate the target record.
     */
    deployPackageAll: (id) => api(`/packages/${id}/deploy-all`, { method: 'POST', body: '{}' }),
    /**
     * Updates the all for app record or state.
     *
     * @param n n supplied to the function.
     * @param b b supplied to the function.
     */
    updateAllForApp: (n, b) => api(`/apps/${encodeURIComponent(n)}/update-all`, { method: 'POST', body: JSON.stringify(b || { targetVersion: 'latest' }) }),
    /**
     * Updates the device for app record or state.
     *
     * @param n n supplied to the function.
     * @param b b supplied to the function.
     */
    updateDeviceForApp: (n, b) => api(`/apps/${encodeURIComponent(n)}/update-device`, { method: 'POST', body: JSON.stringify(b) }),
    /**
     * Handles the refresh inventory operation.
     *
     * @param id Identifier used to locate the target record.
     */
    refreshInventory: (id) => api(`/tasks/refresh-inventory/${id}`, { method: 'POST', body: '{}' }),
    /**
     * Updates the all outdated record or state.
     *
     * @param id Identifier used to locate the target record.
     */
    updateAllOutdated: (id) => api(`/devices/${id}/update-all-outdated`, { method: 'POST', body: '{}' }),
    /**
     * Creates a rule record.
     *
     * @param b b supplied to the function.
     */
    createRule: (b) => api('/rules', { method: 'POST', body: JSON.stringify(b) }),
    /**
     * Updates the rule record or state.
     *
     * @param id Identifier used to locate the target record.
     * @param b b supplied to the function.
     */
    updateRule: (id, b) => api(`/rules/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
    /**
     * Changes the rule state.
     *
     * @param id Identifier used to locate the target record.
     * @param e Event object emitted by the runtime or UI.
     */
    toggleRule: (id, e) => api(`/rules/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled: e }) }),
    /**
     * Handles the test rule operation.
     *
     * @param id Identifier used to locate the target record.
     * @param b b supplied to the function.
     */
    testRule: (id, b) => api(`/rules/${id}/test`, { method: 'POST', body: JSON.stringify(b || {}) }),
    /**
     * Handles the trigger rule operation.
     *
     * @param id Identifier used to locate the target record.
     * @param b b supplied to the function.
     */
    triggerRule: (id, b) => api(`/rules/${id}/trigger`, { method: 'POST', body: JSON.stringify(b || {}) }),
    /**
     * Handles the rule templates operation.
     *
     * @param t t supplied to the function.
     */
    ruleTemplates: (t = 'default') => api(`/rule-templates?tenantId=${encodeURIComponent(t)}`),
    /**
     * Creates a rule draft from template record.
     *
     * @param id Identifier used to locate the target record.
     * @param b b supplied to the function.
     */
    createRuleDraftFromTemplate: (id, b) => api(`/rule-templates/${encodeURIComponent(id)}/create-draft`, { method: 'POST', body: JSON.stringify(b || {}) }),
    /**
     * Handles the import rule template config operation.
     *
     * @param b b supplied to the function.
     */
    importRuleTemplateConfig: (b) => api('/rule-templates/custom/import', { method: 'POST', body: JSON.stringify(b || {}) }),
    /**
     * Handles the rule audit operation.
     *
     * @param id Identifier used to locate the target record.
     */
    ruleAudit: (id) => api(id ? `/rules/${id}/audit` : '/rules/audit'),
    /**
     * Resolves alarm configuration.
     *
     * @param id Identifier used to locate the target record.
     */
    resolveAlarm: (id) => api(`/alarms/${id}/resolve`, { method: 'POST', body: '{}' }),
    resolveAllAlarms: () => api('/alarms/resolve-all', { method: 'POST', body: '{}' }),
    retirementPolicies: (t = 'default') => api(`/devices/retirement-policies?tenantId=${encodeURIComponent(t)}`),
    createRetirementPolicy: (b) => api('/devices/retirement-policies', { method: 'POST', body: JSON.stringify(b) }),
    updateRetirementPolicy: (id, b) => api(`/devices/retirement-policies/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(b) }),
    deleteRetirementPolicy: (id) => api(`/devices/retirement-policies/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    evaluateRetirementPolicy: (id) => api(`/devices/retirement-policies/${encodeURIComponent(id)}/evaluate`, { method: 'POST', body: '{}' }),
};
window.PatchAPI = DEMO_MODE ? DEMO_API : LIVE_API;


// Shared SVG icons + small primitives
const Icon = {
    dashboard: (React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5" },
        React.createElement("rect", { x: "2", y: "2", width: "5", height: "5", rx: "1" }),
        React.createElement("rect", { x: "9", y: "2", width: "5", height: "5", rx: "1" }),
        React.createElement("rect", { x: "2", y: "9", width: "5", height: "5", rx: "1" }),
        React.createElement("rect", { x: "9", y: "9", width: "5", height: "5", rx: "1" }))),
    devices: (React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5" },
        React.createElement("rect", { x: "2", y: "3", width: "12", height: "8", rx: "1" }),
        React.createElement("path", { d: "M5 14h6M8 11v3" }))),
    groups: (React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5" },
        React.createElement("rect", { x: "2", y: "2.5", width: "5", height: "4", rx: "1" }),
        React.createElement("rect", { x: "9", y: "2.5", width: "5", height: "4", rx: "1" }),
        React.createElement("rect", { x: "5.5", y: "9.5", width: "5", height: "4", rx: "1" }),
        React.createElement("path", { d: "M4.5 6.5v1.2c0 .7.4 1.3 1.1 1.6M11.5 6.5v1.2c0 .7-.4 1.3-1.1 1.6" }))),
    apps: (React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5" },
        React.createElement("circle", { cx: "4", cy: "4", r: "2" }),
        React.createElement("circle", { cx: "12", cy: "4", r: "2" }),
        React.createElement("circle", { cx: "4", cy: "12", r: "2" }),
        React.createElement("circle", { cx: "12", cy: "12", r: "2" }))),
    packages: (React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5" },
        React.createElement("path", { d: "M8 2 2 5v6l6 3 6-3V5L8 2zM2 5l6 3 6-3M8 8v6" }))),
    rules: (React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5" },
        React.createElement("path", { d: "M3 4h7M3 8h10M3 12h6" }),
        React.createElement("circle", { cx: "12", cy: "4", r: "1.5" }),
        React.createElement("circle", { cx: "11", cy: "12", r: "1.5" }))),
    tasks: (React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5" },
        React.createElement("path", { d: "M2 4h2l1 1h9v8H2zM6 8l1.5 1.5L11 6" }))),
    nodes: (React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5" },
        React.createElement("circle", { cx: "8", cy: "3", r: "1.5" }),
        React.createElement("circle", { cx: "3", cy: "13", r: "1.5" }),
        React.createElement("circle", { cx: "13", cy: "13", r: "1.5" }),
        React.createElement("path", { d: "M8 4.5v3M7 8.5l-3 3M9 8.5l3 3" }))),
    alarms: (React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5" },
        React.createElement("path", { d: "M8 2a4 4 0 0 0-4 4v3l-1 2h10l-1-2V6a4 4 0 0 0-4-4zM6.5 13a1.5 1.5 0 0 0 3 0" }))),
    audit: (React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5" },
        React.createElement("path", { d: "M3 2h7l3 3v9H3z" }),
        React.createElement("path", { d: "M10 2v3h3M5 8h6M5 11h4" }))),
    shield: (React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5" },
        React.createElement("path", { d: "M8 2 13 4v3.5c0 3-2 5.4-5 6.5-3-1.1-5-3.5-5-6.5V4z" }),
        React.createElement("path", { d: "m5.8 8 1.4 1.4L10.5 6" }))),
    search: (React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5" },
        React.createElement("circle", { cx: "7", cy: "7", r: "4.5" }),
        React.createElement("path", { d: "m10.5 10.5 3 3" }))),
    bell: (React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5" },
        React.createElement("path", { d: "M8 2a4 4 0 0 0-4 4v3l-1 2h10l-1-2V6a4 4 0 0 0-4-4zM6.5 13a1.5 1.5 0 0 0 3 0" }))),
    refresh: (React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5" },
        React.createElement("path", { d: "M3 8a5 5 0 0 1 8.5-3.5L13 6M13 8a5 5 0 0 1-8.5 3.5L3 10" }),
        React.createElement("path", { d: "M13 3v3h-3M3 13v-3h3" }))),
    plus: (React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5" },
        React.createElement("path", { d: "M8 3v10M3 8h10" }))),
    arrowR: (React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5" },
        React.createElement("path", { d: "M6 4l4 4-4 4" }))),
    arrowL: (React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5" },
        React.createElement("path", { d: "M10 4l-4 4 4 4" }))),
    copy: (React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5" },
        React.createElement("rect", { x: "5", y: "5", width: "8", height: "9", rx: "1" }),
        React.createElement("path", { d: "M3 11V3h8" }))),
    check: (React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "2" },
        React.createElement("path", { d: "M3 8l3.5 3.5L13 5" }))),
    externalLink: (React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5" },
        React.createElement("path", { d: "M7 3H3v10h10V9M13 3H9m4 0v4" }))),
    lightbulb: (React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5" },
        React.createElement("path", { d: "M8 2a4 4 0 0 1 2.1 7.4L10 11H6l-.1-1.6A4 4 0 0 1 8 2z" }),
        React.createElement("path", { d: "M6.5 11h3v1.5h-3zM7.2 13.5h1.6" }))),
    windows: (React.createElement("svg", { viewBox: "0 0 16 16", fill: "currentColor" },
        React.createElement("path", { d: "M2 3.2 7.3 2.5v5H2zM7.9 2.4 14 1.5v6H7.9zM2 8.5h5.3v5L2 12.8zM7.9 8.5H14v6l-6.1-.9z" }))),
    linux: (React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.4" },
        React.createElement("ellipse", { cx: "8", cy: "10", rx: "4.5", ry: "4" }),
        React.createElement("circle", { cx: "6.5", cy: "6.5", r: ".7", fill: "currentColor" }),
        React.createElement("circle", { cx: "9.5", cy: "6.5", r: ".7", fill: "currentColor" }),
        React.createElement("path", { d: "M7 8.5l1 .8 1-.8" }))),
    close: (React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5" },
        React.createElement("path", { d: "m4 4 8 8M12 4l-8 8" }))),
    filter: (React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5" },
        React.createElement("path", { d: "M2 4h12l-4.5 5v4l-3 1V9z" }))),
    download: (React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5" },
        React.createElement("path", { d: "M8 3v8m0 0L5 8m3 3 3-3M3 13h10" }))),
    play: (React.createElement("svg", { viewBox: "0 0 16 16", fill: "currentColor" },
        React.createElement("path", { d: "M5 3.5v9l8-4.5z" }))),
    logout: (React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5" },
        React.createElement("path", { d: "M6 3H3v10h3M10.5 5.5 13 8l-2.5 2.5M13 8H6" }))),
    settings: (React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5" },
        React.createElement("circle", { cx: "8", cy: "8", r: "2" }),
        React.createElement("path", { d: "M8 2v1M8 13v1M2 8h1M13 8h1M3.5 3.5l.7.7M11.8 11.8l.7.7M3.5 12.5l.7-.7M11.8 4.2l.7-.7" }))),
};
/**
 * Renders the sparkline UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function Sparkline({ data, color = "var(--accent)", height = 56, width = 240 }) {
    const max = Math.max(...data), min = Math.min(...data);
    const range = max - min || 1;
    const stepX = width / (data.length - 1);
    const pts = data.map((v, i) => [i * stepX, height - ((v - min) / range) * (height - 8) - 4]);
    const line = pts.map((p, i) => (i === 0 ? "M" : "L") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
    const area = line + ` L${width},${height} L0,${height} Z`;
    return (React.createElement("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", height: height, preserveAspectRatio: "none" },
        React.createElement("defs", null,
            React.createElement("linearGradient", { id: "sparkfill", x1: "0", y1: "0", x2: "0", y2: "1" },
                React.createElement("stop", { offset: "0%", stopColor: color, stopOpacity: "0.18" }),
                React.createElement("stop", { offset: "100%", stopColor: color, stopOpacity: "0" }))),
        React.createElement("path", { d: area, fill: "url(#sparkfill)" }),
        React.createElement("path", { d: line, fill: "none", stroke: color, strokeWidth: "1.5", strokeLinejoin: "round", strokeLinecap: "round" }),
        React.createElement("circle", { cx: pts[pts.length - 1][0], cy: pts[pts.length - 1][1], r: "3", fill: color })));
}
/**
 * Renders the donut UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function Donut({ value, size = 140, stroke = 14 }) {
    // value 0..100
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const offset = c - (value / 100) * c;
    const color = value >= 90 ? "var(--ok)" : value >= 75 ? "var(--accent)" : value >= 60 ? "var(--warn)" : "var(--crit)";
    return (React.createElement("svg", { width: size, height: size, viewBox: `0 0 ${size} ${size}` },
        React.createElement("circle", { cx: size / 2, cy: size / 2, r: r, fill: "none", stroke: "var(--line)", strokeWidth: stroke }),
        React.createElement("circle", { cx: size / 2, cy: size / 2, r: r, fill: "none", stroke: color, strokeWidth: stroke, strokeDasharray: c, strokeDashoffset: offset, strokeLinecap: "round", transform: `rotate(-90 ${size / 2} ${size / 2})`, style: { transition: "stroke-dashoffset .6s ease" } }),
        React.createElement("text", { x: "50%", y: "50%", textAnchor: "middle", dominantBaseline: "central", fontSize: "22", fontWeight: "600", fill: "var(--text)", style: { letterSpacing: "-0.02em" } },
            value,
            "%")));
}
/**
 * Renders the status pill UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function StatusPill({ status }) {
    const map = {
        online: { cls: "ok", label: "Online" },
        offline: { cls: "", label: "Offline" },
        draft: { cls: "", label: "Draft" },
        security_scanned: { cls: "warn", label: "Needs Approval" },
        mfa_approved: { cls: "accent", label: "Needs Signing" },
        signed: { cls: "accent", label: "Signed" },
        executable: { cls: "accent", label: "Queued" },
        revoked: { cls: "crit", label: "Revoked" },
        pending: { cls: "", label: "Pending" },
        dispatched: { cls: "accent", label: "Dispatched" },
        completed: { cls: "ok", label: "Completed" },
        failed: { cls: "crit", label: "Failed" },
        rejected: { cls: "warn", label: "Rejected" },
        cancelled: { cls: "", label: "Cancelled" },
        valid: { cls: "ok", label: "Signed" },
        unsigned: { cls: "warn", label: "Unsigned" },
        unknown: { cls: "", label: "Unknown" },
        healthy: { cls: "ok", label: "Healthy" },
        degraded: { cls: "warn", label: "Degraded" },
        unhealthy: { cls: "crit", label: "Unhealthy" },
        quarantined: { cls: "crit", label: "Quarantined" },
        stale: { cls: "", label: "Stale" },
    };
    const it = map[status] || { cls: "", label: status };
    return React.createElement("span", { className: "pill " + it.cls },
        React.createElement("span", { className: "dot" }),
        it.label);
}
function fmtBytes(bytes) {
    if (bytes == null || !Number.isFinite(bytes))
        return "—";
    if (bytes >= 1e9)
        return (bytes / 1e9).toFixed(1) + " GB";
    if (bytes >= 1e6)
        return (bytes / 1e6).toFixed(1) + " MB";
    return (bytes / 1e3).toFixed(0) + " KB";
}
/**
 * Renders the os icon UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function OsIcon({ platform }) {
    return React.createElement("span", { style: { display: "inline-flex", width: 14, height: 14, color: "var(--text-3)" } }, platform === "linux" ? Icon.linux : Icon.windows);
}
/**
 * Formats the os value.
 *
 * @param os os supplied to the function.
 * @returns The result produced by the operation.
 */
function formatOs(os) {
    const raw = String(os || "").trim();
    if (!raw)
        return "—";
    const win = raw.match(/(?:Microsoft\s+)?Windows\s+(\d+)\.(\d+)\.(\d+)/i);
    if (!win)
        return raw.replace(/^Microsoft\s+/i, "");
    const build = Number(win[3]);
    if (!Number.isFinite(build))
        return raw.replace(/^Microsoft\s+/i, "");
    const release = build >= 26100 ? "24H2" :
        build >= 22631 ? "23H2" :
            build >= 22621 ? "22H2" :
                build >= 22000 ? "21H2" :
                    "";
    const name = build >= 22000 ? "Windows 11" : "Windows 10";
    return `${name}${release ? ` ${release}` : ""} (${win[1]}.${win[2]}.${win[3]})`;
}
/**
 * Handles the task label operation.
 *
 * @param task task supplied to the function.
 * @returns The result produced by the operation.
 */
function taskLabel(task) {
    if (!task)
        return "Task";
    if (task.type === "refresh_inventory")
        return "Refresh inventory";
    return task.appName || task.packageId || task.packageArtifactId || task.type || task.id;
}
/**
 * Handles the task version label operation.
 *
 * @param task task supplied to the function.
 * @returns The result produced by the operation.
 */
function taskVersionLabel(task) {
    if (!task)
        return "—";
    if (task.type === "refresh_inventory")
        return "Inventory scan";
    return (task.fromVersion || "—") + " → " + (task.targetVersion ?? task.toVersion ?? "latest");
}
/**
 * Handles the sort tasks newest first operation.
 *
 * @param tasks tasks supplied to the function.
 * @returns The result produced by the operation.
 */
function sortTasksNewestFirst(tasks) {
    return (tasks || []).slice().sort((a, b) => {
        const aTime = a.createdAt || a.dispatchedAt || a.completedAt || "";
        const bTime = b.createdAt || b.dispatchedAt || b.completedAt || "";
        return bTime.localeCompare(aTime);
    });
}
Object.assign(window, { Icon, Sparkline, Donut, StatusPill, OsIcon, formatOs, taskLabel, taskVersionLabel, sortTasksNewestFirst, fmtBytes });


// AGPL-3.0-only — Page components for the 1Patch management UI (live data, no mocks)
const { useState, useEffect, useMemo, useCallback, useRef } = React;
// ---------- Loader hook ----------
/**
 * Handles the data signature operation.
 *
 * @param value Value to read, render, or store.
 * @returns The result produced by the operation.
 */
function dataSignature(value) {
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
}
/**
 * Manages use resource state for the UI.
 *
 * @param loader loader supplied to the function.
 * @param deps deps supplied to the function.
 * @returns The result produced by the operation.
 */
function useResource(loader, deps = []) {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);
    const signatureRef = useRef("");
    const requestRef = useRef(0);
    const mountedRef = useRef(false);
    const load = useCallback((silent = false) => {
        if (!mountedRef.current)
            return Promise.resolve(null);
        const requestId = requestRef.current + 1;
        requestRef.current = requestId;
        if (!silent)
            setLoading(true);
        setError(null);
        return Promise.resolve(loader())
            .then(d => {
            if (!mountedRef.current || requestId !== requestRef.current)
                return d;
            const nextSignature = dataSignature(d);
            if (nextSignature !== signatureRef.current) {
                signatureRef.current = nextSignature;
                setData(d);
            }
            return d;
        })
            .catch(e => { if (mountedRef.current && requestId === requestRef.current)
            setError(e); })
            .finally(() => { if (mountedRef.current && requestId === requestRef.current)
            setLoading(false); });
    }, deps);
    const reload = useCallback((silent = false) => load(silent), [load]);
    useEffect(() => {
        mountedRef.current = true;
        load(false);
        return () => {
            mountedRef.current = false;
            requestRef.current += 1;
        };
        // eslint-disable-next-line
    }, [load]);
    return { data, error, loading, reload };
}
/**
 * Manages use live resource state for the UI.
 *
 * @param resource resource supplied to the function.
 * @param intervalMs interval ms supplied to the function.
 */
function useLiveResource(resource, intervalMs = 5000) {
    useEffect(() => {
        let inFlight = false;
        /**
         * Handles the tick operation.
         */
        const tick = () => {
            if (inFlight || document.visibilityState === "hidden")
                return;
            inFlight = true;
            Promise.resolve(resource.reload(true)).finally(() => { inFlight = false; });
        };
        /**
         * Handles the on visible operation.
         */
        const onVisible = () => {
            if (document.visibilityState === "visible")
                tick();
        };
        const id = setInterval(tick, intervalMs);
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            clearInterval(id);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [resource.reload, intervalMs]);
}
/**
 * Renders the skeleton UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function Skeleton({ w = "100%", h = 16, r = 4, style }) {
    return React.createElement("span", { className: "skel", style: { display: "inline-block", width: w, height: h, borderRadius: r, ...style } });
}
/**
 * Renders the error alert UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function ErrorAlert({ error, onRetry }) {
    return (React.createElement("div", { className: "alert" },
        React.createElement("strong", null, "Couldn't load."),
        " ",
        React.createElement("span", { className: "muted" }, error?.message || String(error)),
        onRetry && React.createElement("button", { className: "btn sm", onClick: onRetry }, "Retry")));
}
/**
 * Renders the skeleton rows UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function SkeletonRows({ n = 6, cols = 6 }) {
    return Array.from({ length: n }).map((_, i) => (React.createElement("tr", { key: i }, Array.from({ length: cols }).map((_, j) => React.createElement("td", { key: j },
        React.createElement(Skeleton, { w: j === 0 ? 160 : 80 }))))));
}
/**
 * Handles the fmt ago operation.
 *
 * @param iso iso supplied to the function.
 * @returns The result produced by the operation.
 */
function fmtAgo(iso) {
    if (!iso)
        return "never";
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60000)
        return `${Math.round(ms / 1000)}s ago`;
    if (ms < 3600000)
        return `${Math.round(ms / 60000)}m ago`;
    if (ms < 86400000)
        return `${Math.round(ms / 3600000)}h ago`;
    return `${Math.round(ms / 86400000)}d ago`;
}
/**
 * Handles the copy text to clipboard operation.
 *
 * @param text text supplied to the function.
 * @returns The result produced by the operation.
 */
async function copyTextToClipboard(text) {
    const value = typeof text === "string" ? text : String(text ?? "");
    if (!value)
        return false;
    if (navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(value);
            return true;
        }
        catch { }
    }
    const active = document.activeElement;
    const selection = document.getSelection();
    const selectedRanges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i)) : [];
    const el = document.createElement("textarea");
    el.value = value;
    el.readOnly = true;
    el.setAttribute("aria-hidden", "true");
    Object.assign(el.style, {
        position: "fixed",
        top: "0",
        left: "0",
        width: "1px",
        height: "1px",
        padding: "0",
        border: "0",
        opacity: "0",
        pointerEvents: "none",
    });
    document.body.appendChild(el);
    el.focus({ preventScroll: true });
    el.select();
    let copied = false;
    try {
        copied = document.execCommand("copy");
    }
    catch {
        copied = false;
    }
    document.body.removeChild(el);
    if (active?.focus)
        active.focus({ preventScroll: true });
    if (selection) {
        try {
            selection.removeAllRanges();
            selectedRanges.forEach(range => selection.addRange(range));
        }
        catch { }
    }
    return copied;
}
// ---------- Overview ----------
/**
 * Renders the overview page UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function OverviewPage({ onNav, onOpenDevice }) {
    const summary = useResource(() => PatchAPI.summary());
    const apps = useResource(() => PatchAPI.apps());
    const tasks = useResource(() => PatchAPI.tasks());
    const alarms = useResource(() => PatchAPI.alarms());
    const history = useResource(() => PatchAPI.coverageHistory(30));
    useLiveResource(summary, 5000);
    useLiveResource(apps, 5000);
    useLiveResource(tasks, 3000);
    useLiveResource(alarms, 5000);
    useLiveResource(history, 30000);
    const s = summary.data || {};
    const historyRows = history.data || [];
    const coverage = s.coverage ?? historyRows[historyRows.length - 1]?.value ?? 0;
    const trend = [...historyRows.map(p => p.value)];
    if (!trend.length || trend[trend.length - 1] !== coverage)
        trend.push(coverage);
    const trendStart = trend[0] ?? coverage;
    const trendDelta = coverage - trendStart;
    const topApps = (apps.data || [])
        .filter(a => (a.outdatedDeviceCount ?? a.outdated) > 0)
        .sort((a, b) => (b.outdatedDeviceCount ?? b.outdated ?? 0) - (a.outdatedDeviceCount ?? a.outdated ?? 0))
        .slice(0, 6);
    const recentTasks = sortTasksNewestFirst(tasks.data || []).slice(0, 7);
    const recentAlarms = (alarms.data || []).slice(0, 5);
    const compliantApps = s.compliantApps ?? Math.max(0, (apps.data || []).reduce((n, a) => n + (a.deviceCount - (a.outdatedDeviceCount ?? a.outdated ?? 0)), 0));
    const outdatedApps = s.outdatedApps ?? (apps.data || []).reduce((n, a) => n + (a.outdatedDeviceCount ?? a.outdated ?? 0), 0);
    const totalApps = compliantApps + outdatedApps;
    return (React.createElement("div", { className: "page" },
        React.createElement("div", { className: "page-head" },
            React.createElement("div", null,
                React.createElement("h2", null, "Fleet overview"),
                React.createElement("p", null,
                    "Real-time patch coverage",
                    summary.data && ` across ${s.managedDevices} devices`)),
            React.createElement("div", { style: { display: "flex", gap: 8 } },
                React.createElement("button", { className: "btn", onClick: () => { summary.reload(); apps.reload(); tasks.reload(); alarms.reload(); history.reload(); } },
                    React.createElement("span", { style: { width: 14, height: 14, display: "inline-flex" } }, Icon.refresh),
                    "Refresh"))),
        React.createElement("div", { className: "card" },
            React.createElement("div", { className: "card-body fleet-pulse" },
                React.createElement("div", { className: "donut-wrap" }, history.loading || summary.loading ? React.createElement(Skeleton, { w: 140, h: 140, r: 70 }) : React.createElement(Donut, { value: coverage })),
                React.createElement("div", { className: "pulse-meta" },
                    React.createElement("div", null,
                        React.createElement("div", { className: "pulse-sub" }, "Patch coverage"),
                        React.createElement("div", { className: "pulse-headline" }, apps.loading
                            ? React.createElement(Skeleton, { w: 280, h: 28 })
                            : React.createElement("span", null,
                                React.createElement("span", { className: "accent" }, compliantApps),
                                " of ",
                                totalApps,
                                " apps compliant"))),
                    React.createElement("div", { style: { display: "flex", gap: 18, flexWrap: "wrap" } },
                        React.createElement(Metric, { label: "Outdated", value: apps.loading ? "—" : outdatedApps, tone: "warn" }),
                        React.createElement(Metric, { label: "Critical alarms", value: alarms.loading ? "—" : (s.criticalAlarms ?? (alarms.data || []).filter(a => a.severity === "critical").length), tone: "crit" }),
                        React.createElement(Metric, { label: "Failed tasks", value: tasks.loading ? "—" : (tasks.data || []).filter(t => t.status === "failed").length, tone: "crit" }),
                        React.createElement(Metric, { label: "Active rules", value: s.activeRules ?? "—" }))),
                React.createElement("div", { className: "pulse-spark", style: { display: "flex", flexDirection: "column", justifyContent: "space-between" } },
                    React.createElement("div", { className: "pulse-sub", style: { display: "flex", justifyContent: "space-between" } },
                        React.createElement("span", null, "30-day trend"),
                        trend.length > 1 && React.createElement("span", { style: { color: trendDelta < 0 ? "var(--warn)" : "var(--ok)" } },
                            trendDelta > 0 ? "+" : "",
                            trendDelta,
                            "%")),
                    history.loading
                        ? React.createElement(Skeleton, { w: 260, h: 64 })
                        : trend.length > 1
                            ? React.createElement(Sparkline, { data: trend, height: 64, width: 260 })
                            : React.createElement("div", { className: "muted", style: { fontSize: 12 } }, "Collecting history\u2026")))),
        React.createElement("div", { className: "stats" },
            React.createElement(Stat, { label: "Devices", value: summary.loading ? "—" : s.managedDevices, sub: summary.loading ? "" : `${s.onlineDevices ?? 0} online · ${(s.managedDevices ?? 0) - (s.onlineDevices ?? 0)} offline` }),
            React.createElement(Stat, { label: "Pending tasks", value: tasks.loading ? "—" : (tasks.data || []).filter(t => ["pending", "dispatched"].includes(t.status)).length }),
            React.createElement(Stat, { label: "Active alarms", value: alarms.loading ? "—" : (alarms.data || []).length, sub: alarms.loading ? "" : `${(alarms.data || []).filter(a => a.severity === "critical").length} critical`, tone: (alarms.data || []).some(a => a.severity === "critical") ? "crit" : "" }),
            React.createElement(Stat, { label: "Apps tracked", value: apps.loading ? "—" : (apps.data || []).length })),
        React.createElement("div", { className: "row-2" },
            React.createElement("div", { className: "card" },
                React.createElement("div", { className: "card-head" },
                    React.createElement("div", null,
                        React.createElement("h3", null, "Apps needing attention"),
                        React.createElement("div", { className: "sub" }, "Sorted by devices on outdated versions")),
                    React.createElement("button", { className: "btn ghost sm", onClick: () => onNav("apps") },
                        "View all ",
                        React.createElement("span", { style: { width: 12, height: 12, display: "inline-flex" } }, Icon.arrowR))),
                React.createElement("div", { className: "card-body tight" },
                    apps.error && React.createElement("div", { style: { padding: 16 } },
                        React.createElement(ErrorAlert, { error: apps.error, onRetry: apps.reload })),
                    apps.loading && Array.from({ length: 4 }).map((_, i) => (React.createElement("div", { className: "app-chip", key: i },
                        React.createElement(Skeleton, { w: 32, h: 32, r: 8 }),
                        React.createElement(Skeleton, { w: 180, h: 14 }),
                        React.createElement(Skeleton, { w: 50, h: 12 })))),
                    !apps.loading && topApps.length === 0 && React.createElement("div", { style: { padding: 24, color: "var(--text-3)" } }, "Everything is up to date."),
                    !apps.loading && topApps.map(a => {
                        const outdated = a.outdatedDeviceCount ?? a.outdated ?? 0;
                        const total = a.deviceCount ?? 1;
                        return (React.createElement("div", { className: "app-chip", key: a.name, onClick: () => onNav("apps") },
                            React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 12, minWidth: 0 } },
                                React.createElement("div", { style: { width: 32, height: 32, borderRadius: 8, background: "var(--bg-sub)", display: "grid", placeItems: "center", flexShrink: 0, fontWeight: 600, color: "var(--text-2)" } }, (a.name || "·").split(" ").map(w => w[0]).slice(0, 2).join("")),
                                React.createElement("div", { style: { minWidth: 0 } },
                                    React.createElement("div", { className: "name" },
                                        a.name,
                                        " ",
                                        a.critical && React.createElement("span", { className: "pill crit", style: { marginLeft: 6 } }, "CVE")),
                                    React.createElement("div", { className: "pub" },
                                        a.publisher,
                                        " \u00B7 latest ",
                                        a.latestVersion ?? a.latest))),
                            React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 12 } },
                                React.createElement("span", { className: "muted mono", style: { fontSize: 12 } },
                                    outdated,
                                    "/",
                                    total),
                                React.createElement("div", { className: "bar" },
                                    React.createElement("span", { style: { width: (outdated / total * 100) + "%" } })))));
                    }))),
            React.createElement("div", { className: "card" },
                React.createElement("div", { className: "card-head" },
                    React.createElement("div", null,
                        React.createElement("h3", null, "Active alarms"),
                        React.createElement("div", { className: "sub" },
                            alarms.loading ? "…" : (alarms.data || []).length,
                            " unresolved")),
                    React.createElement("button", { className: "btn ghost sm", onClick: () => onNav("alarms") },
                        "All ",
                        React.createElement("span", { style: { width: 12, height: 12, display: "inline-flex" } }, Icon.arrowR))),
                React.createElement("div", { className: "card-body tight" },
                    alarms.error && React.createElement("div", { style: { padding: 16 } },
                        React.createElement(ErrorAlert, { error: alarms.error, onRetry: alarms.reload })),
                    alarms.loading && React.createElement("div", { style: { padding: 16 } },
                        React.createElement(Skeleton, { h: 40 })),
                    !alarms.loading && recentAlarms.length === 0 && React.createElement("div", { style: { padding: 24, color: "var(--text-3)" } }, "No active alarms."),
                    !alarms.loading && recentAlarms.map(a => (React.createElement("div", { key: a.id, style: { display: "flex", gap: 12, padding: "12px 16px", borderBottom: "1px solid var(--line)" } },
                        React.createElement("div", { className: "sev-strip " + a.severity }),
                        React.createElement("div", { style: { flex: 1, minWidth: 0 } },
                            React.createElement("strong", { style: { fontWeight: 500, fontSize: 13 } }, a.message),
                            React.createElement("div", { className: "muted", style: { fontSize: 12 } },
                                a.deviceId && React.createElement("span", { className: "mono" }, a.deviceId),
                                " \u00B7 ",
                                fmtAgo(a.createdAt))))))))),
        React.createElement("div", { className: "card" },
            React.createElement("div", { className: "card-head" },
                React.createElement("div", null,
                    React.createElement("h3", null, "Recent tasks"),
                    React.createElement("div", { className: "sub" }, "Last 7 update jobs across the fleet")),
                React.createElement("button", { className: "btn ghost sm", onClick: () => onNav("tasks") },
                    "All ",
                    React.createElement("span", { style: { width: 12, height: 12, display: "inline-flex" } }, Icon.arrowR))),
            React.createElement("div", { className: "card-body tight", style: { overflowX: "auto" } },
                React.createElement("table", { className: "tbl" },
                    React.createElement("thead", null,
                        React.createElement("tr", null,
                            React.createElement("th", null, "App"),
                            React.createElement("th", null, "Device"),
                            React.createElement("th", null, "Version"),
                            React.createElement("th", null, "Node"),
                            React.createElement("th", null, "Status"),
                            React.createElement("th", null, "Created"))),
                    React.createElement("tbody", null,
                        tasks.loading && React.createElement(SkeletonRows, { n: 5, cols: 6 }),
                        !tasks.loading && recentTasks.length === 0 && React.createElement("tr", null,
                            React.createElement("td", { colSpan: 6, style: { padding: 24, color: "var(--text-3)" } }, "No tasks yet.")),
                        !tasks.loading && recentTasks.map(t => (React.createElement("tr", { key: t.id, onClick: () => onOpenDevice(t.deviceId) },
                            React.createElement("td", null,
                                React.createElement("strong", { style: { fontWeight: 500 } }, taskLabel(t))),
                            React.createElement("td", { className: "mono" }, t.deviceId),
                            React.createElement("td", { className: "mono muted" }, taskVersionLabel(t)),
                            React.createElement("td", { className: "mono muted" }, t.nodeId),
                            React.createElement("td", null,
                                React.createElement(StatusPill, { status: t.status })),
                            React.createElement("td", { className: "muted" }, fmtAgo(t.createdAt)))))))))));
}
/**
 * Renders the stat UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function Stat({ label, value, sub, tone }) {
    return (React.createElement("div", { className: "stat" },
        React.createElement("div", { className: "label" }, label),
        React.createElement("div", { className: "value", style: tone === "crit" ? { color: "var(--crit)" } : {} }, value),
        sub && React.createElement("div", { className: "delta" }, sub)));
}
/**
 * Renders the metric UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function Metric({ label, value, tone }) {
    const color = tone === "crit" ? "var(--crit)" : tone === "warn" ? "var(--warn)" : "var(--text)";
    return (React.createElement("div", null,
        React.createElement("div", { style: { fontSize: 12, color: "var(--text-3)" } }, label),
        React.createElement("div", { style: { fontSize: 20, fontWeight: 600, color, fontVariantNumeric: "tabular-nums" } }, value)));
}
// ---------- Devices ----------
/**
 * Renders the devices page UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function DevicesPage({ onOpenDevice, globalSearch = "" }) {
    const [filter, setFilter] = useState("all");
    const [q, setQ] = useState("");
    const activeQ = globalSearch || q;
    const [enrolling, setEnrolling] = useState(false);
    const [manualDevice, setManualDevice] = useState(false);
    const devices = useResource(() => PatchAPI.devices());
    useLiveResource(devices, 2500);
    const rows = (devices.data || []).filter(d => {
        const platform = d.platform || (/(windows|win)/i.test(d.os || "") ? "windows" : "linux");
        if (!textMatches(activeQ, [d.hostname, formatOs(d.os), d.os, d.site, d.id, d.preferredNodeId, d.group, ...(d.tags || [])]))
            return false;
        if (filter === "windows" && platform !== "windows")
            return false;
        if (filter === "linux" && platform !== "linux")
            return false;
        if (filter === "online" && !d.online)
            return false;
        if (filter === "offline" && d.online)
            return false;
        return true;
    });
    return (React.createElement("div", { className: "page" },
        React.createElement("div", { className: "page-head" },
            React.createElement("div", null,
                React.createElement("h2", null, "Devices"),
                React.createElement("p", null, devices.loading ? "Loading…" : `${(devices.data || []).length} managed endpoints`)),
            React.createElement("div", { style: { display: "flex", gap: 8 } },
                React.createElement("button", { className: "btn" },
                    React.createElement("span", { style: { width: 14, height: 14, display: "inline-flex" } }, Icon.download),
                    "Export CSV"),
                React.createElement("button", { className: "btn", onClick: () => setManualDevice(true) },
                    React.createElement("span", { style: { width: 14, height: 14, display: "inline-flex" } }, Icon.plus),
                    "Manual device"),
                React.createElement("button", { className: "btn primary", onClick: () => setEnrolling(true) },
                    React.createElement("span", { style: { width: 14, height: 14, display: "inline-flex" } }, Icon.plus),
                    "Add clients"))),
        React.createElement("div", { className: "card" },
            React.createElement("div", { className: "filterbar" },
                [["all", "All"], ["windows", "Windows"], ["linux", "Linux"], ["online", "Online"], ["offline", "Offline"]].map(([k, l]) => (React.createElement("button", { key: k, className: "chip " + (filter === k ? "active" : ""), onClick: () => setFilter(k) }, l))),
                React.createElement("div", { style: { flex: 1 } }),
                React.createElement("div", { className: "searchbox", style: { width: 220 } },
                    React.createElement("span", { style: { width: 14, height: 14, display: "inline-flex" } }, Icon.search),
                    React.createElement("input", { placeholder: "Filter hostname, OS, site\u2026", value: globalSearch || q, onChange: e => setQ(e.target.value) }))),
            devices.error && React.createElement("div", { style: { padding: 16 } },
                React.createElement(ErrorAlert, { error: devices.error, onRetry: devices.reload })),
            React.createElement("div", { style: { overflowX: "auto", maxHeight: "calc(100vh - 280px)", overflowY: "auto" } },
                React.createElement("table", { className: "tbl" },
                    React.createElement("thead", null,
                        React.createElement("tr", null,
                            React.createElement("th", null, "Hostname"),
                            React.createElement("th", null, "OS"),
                            React.createElement("th", null, "Site"),
                            React.createElement("th", null, "Node"),
                            React.createElement("th", { className: "num" }, "Apps"),
                            React.createElement("th", { className: "num" }, "Pending"),
                            React.createElement("th", null, "Last seen"),
                            React.createElement("th", null, "Status"))),
                    React.createElement("tbody", null,
                        devices.loading && React.createElement(SkeletonRows, { n: 8, cols: 8 }),
                        !devices.loading && rows.length === 0 && React.createElement("tr", null,
                            React.createElement("td", { colSpan: 8, style: { padding: 24, color: "var(--text-3)" } }, "No devices match.")),
                        !devices.loading && rows.map(d => {
                            const platform = d.platform || (/(windows|win)/i.test(d.os || "") ? "windows" : "linux");
                            return (React.createElement("tr", { key: d.id, onClick: () => onOpenDevice(d.id) },
                                React.createElement("td", null,
                                    React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                                        React.createElement(OsIcon, { platform: platform }),
                                        React.createElement("span", { className: "mono" }, d.hostname))),
                                React.createElement("td", { className: "muted" }, formatOs(d.os)),
                                React.createElement("td", { className: "muted" }, d.site || "—"),
                                React.createElement("td", { className: "muted mono" }, d.preferredNodeId || "—"),
                                React.createElement("td", { className: "num mono" }, d.installedAppCount ?? "—"),
                                React.createElement("td", { className: "num mono" }, d.pendingTaskCount ?? 0),
                                React.createElement("td", { className: "muted" }, fmtAgo(d.lastSeenAt)),
                                React.createElement("td", null,
                                    React.createElement(StatusPill, { status: d.online ? "online" : "offline" }))));
                        }))))),
        enrolling && React.createElement(ClientEnrollmentWizard, { onClose: () => setEnrolling(false), onCreated: devices.reload }),
        manualDevice && React.createElement(ManualDeviceDialog, { groups: buildDeviceGroupOptions(devices.data || []), onClose: () => setManualDevice(false), onCreated: () => { devices.reload(); setManualDevice(false); } })));
}
/**
 * Renders the device groups page UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function DeviceGroupsPage({ onOpenDevice, globalSearch = "" }) {
    const [selected, setSelected] = useState("all");
    const [q, setQ] = useState("");
    const [manualDevice, setManualDevice] = useState(false);
    const devices = useResource(() => PatchAPI.devices());
    useLiveResource(devices, 2500);
    const groups = useMemo(() => buildDeviceGroupOptions(devices.data || []), [devices.data]);
    const activeQ = globalSearch || q;
    const visibleGroups = groups.filter(group => textMatches(activeQ, [group.name, ...group.samples, ...group.tags]));
    const selectedGroup = selected === "all" ? null : groups.find(group => group.name === selected);
    const groupDevices = (devices.data || []).filter(device => selected === "all" || (device.group || "ungrouped") === selected);
    return (React.createElement("div", { className: "page" },
        React.createElement("div", { className: "page-head" },
            React.createElement("div", null,
                React.createElement("h2", null, "Device Groups"),
                React.createElement("p", null, devices.loading ? "Loading…" : `${groups.length} groups across ${(devices.data || []).length} devices`)),
            React.createElement("div", { style: { display: "flex", gap: 8 } },
                React.createElement("button", { className: "btn", onClick: () => setManualDevice(true) },
                    React.createElement("span", { style: { width: 14, height: 14, display: "inline-flex" } }, Icon.plus),
                    "Manual device"),
                React.createElement("button", { className: "btn primary", onClick: () => setSelected("all") }, "All groups"))),
        React.createElement("div", { className: "card" },
            React.createElement("div", { className: "filterbar" },
                React.createElement("div", { className: "searchbox", style: { width: 280 } },
                    React.createElement("span", { style: { width: 14, height: 14, display: "inline-flex" } }, Icon.search),
                    React.createElement("input", { placeholder: "Search groups, hostnames, tags\u2026", value: globalSearch || q, onChange: e => setQ(e.target.value) })),
                React.createElement("div", { style: { flex: 1 } }),
                React.createElement("span", { className: "muted" },
                    visibleGroups.length,
                    " visible")),
            devices.error && React.createElement("div", { style: { padding: 16 } },
                React.createElement(ErrorAlert, { error: devices.error, onRetry: devices.reload })),
            React.createElement("div", { className: "device-group-board" },
                React.createElement("button", { className: "device-group-card large " + (selected === "all" ? "active" : ""), onClick: () => setSelected("all") },
                    React.createElement("strong", null, "All devices"),
                    React.createElement("span", null,
                        (devices.data || []).length,
                        " endpoints"),
                    React.createElement("em", null, "Fleet-wide scope for rules and inventory views")),
                visibleGroups.map(group => (React.createElement("button", { className: "device-group-card large " + (selected === group.name ? "active" : ""), key: group.name, onClick: () => setSelected(group.name) },
                    React.createElement("strong", null, group.name),
                    React.createElement("span", null,
                        group.count,
                        " devices \u00B7 ",
                        group.online,
                        " online"),
                    React.createElement("em", null,
                        group.windows,
                        " Windows \u00B7 ",
                        group.linux,
                        " Linux \u00B7 ",
                        group.samples.join(", ") || "no samples")))))),
        React.createElement("div", { className: "card" },
            React.createElement("div", { className: "card-head" },
                React.createElement("div", null,
                    React.createElement("h3", null, selectedGroup ? selectedGroup.name : "All devices"),
                    React.createElement("div", { className: "sub" }, selectedGroup ? `${selectedGroup.count} devices in this group` : "Devices across every group"))),
            React.createElement("div", { className: "card-body tight", style: { overflowX: "auto" } },
                React.createElement("table", { className: "tbl" },
                    React.createElement("thead", null,
                        React.createElement("tr", null,
                            React.createElement("th", null, "Hostname"),
                            React.createElement("th", null, "Group"),
                            React.createElement("th", null, "OS"),
                            React.createElement("th", null, "Tags"),
                            React.createElement("th", null, "Last seen"),
                            React.createElement("th", null, "Status"))),
                    React.createElement("tbody", null,
                        devices.loading && React.createElement(SkeletonRows, { n: 6, cols: 6 }),
                        !devices.loading && groupDevices.length === 0 && React.createElement("tr", null,
                            React.createElement("td", { colSpan: 6, style: { padding: 24, color: "var(--text-3)" } }, "No devices in this group.")),
                        !devices.loading && groupDevices.map(device => {
                            const platform = device.platform || (/(windows|win)/i.test(device.os || "") ? "windows" : "linux");
                            return (React.createElement("tr", { key: device.id, onClick: () => onOpenDevice(device.id) },
                                React.createElement("td", null,
                                    React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                                        React.createElement(OsIcon, { platform: platform }),
                                        React.createElement("span", { className: "mono" }, device.hostname))),
                                React.createElement("td", { className: "mono muted" }, device.group || "ungrouped"),
                                React.createElement("td", { className: "muted" }, formatOs(device.os)),
                                React.createElement("td", { className: "muted" }, (device.tags || []).join(", ") || "—"),
                                React.createElement("td", { className: "muted" }, fmtAgo(device.lastSeenAt)),
                                React.createElement("td", null,
                                    React.createElement(StatusPill, { status: device.online ? "online" : "offline" }))));
                        }))))),
        manualDevice && React.createElement(ManualDeviceDialog, { groups: groups, onClose: () => setManualDevice(false), onCreated: () => { devices.reload(); setManualDevice(false); } })));
}
/**
 * Renders the manual device dialog UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function ManualDeviceDialog({ groups, onClose, onCreated }) {
    const [form, setForm] = useState({ tenantId: "default", hostname: "", os: "windows", group: groups[0]?.name || "ungrouped", tags: "", preferredNodeId: "", deviceTrustScore: 80, riskScore: "" });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    /**
     * Sets the set value.
     *
     * @param key key supplied to the function.
     * @param value Value to read, render, or store.
     */
    const set = (key, value) => setForm(prev => ({ ...prev, [key]: value }));
    /**
     * Handles the submit operation.
     *
     * @param e Event object emitted by the runtime or UI.
     */
    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await PatchAPI.createDevice({
                tenantId: form.tenantId,
                hostname: form.hostname,
                os: form.os,
                group: form.group,
                tags: form.tags,
                preferredNodeId: form.preferredNodeId || undefined,
                deviceTrustScore: Number(form.deviceTrustScore || 80),
                riskScore: form.riskScore === "" ? undefined : Number(form.riskScore),
            });
            onCreated?.();
        }
        catch (err) {
            setError(err);
        }
        finally {
            setBusy(false);
        }
    };
    return (React.createElement(React.Fragment, null,
        React.createElement("div", { className: "drawer-backdrop", onClick: onClose }),
        React.createElement("div", { className: "output-dialog" },
            React.createElement("div", { className: "output-dialog-box" },
                React.createElement("div", { className: "output-dialog-head" },
                    React.createElement("h3", null, "Add Manual Device"),
                    React.createElement("button", { className: "icon-btn", onClick: onClose }, Icon.close)),
                React.createElement("form", { onSubmit: submit, style: { padding: 16, display: "flex", flexDirection: "column", gap: 14 } },
                    React.createElement("div", { className: "form-grid" },
                        React.createElement("label", { className: "field" },
                            React.createElement("span", null, "Hostname"),
                            React.createElement("input", { required: true, value: form.hostname, onChange: e => set("hostname", e.target.value), placeholder: "prod-win-042" })),
                        React.createElement("label", { className: "field" },
                            React.createElement("span", null, "Tenant"),
                            React.createElement("input", { value: form.tenantId, onChange: e => set("tenantId", e.target.value || "default") })),
                        React.createElement("label", { className: "field" },
                            React.createElement("span", null, "Operating system"),
                            React.createElement("select", { value: form.os, onChange: e => set("os", e.target.value) },
                                React.createElement("option", { value: "windows" }, "Windows"),
                                React.createElement("option", { value: "linux" }, "Linux"),
                                React.createElement("option", { value: "macos" }, "macOS"))),
                        React.createElement("label", { className: "field" },
                            React.createElement("span", null, "Device group"),
                            React.createElement(GroupSelect, { groups: groups, value: form.group, onChange: value => set("group", value) })),
                        React.createElement("label", { className: "field" },
                            React.createElement("span", null, "Preferred node"),
                            React.createElement("input", { value: form.preferredNodeId, onChange: e => set("preferredNodeId", e.target.value), placeholder: "optional" })),
                        React.createElement("label", { className: "field" },
                            React.createElement("span", null, "Trust score"),
                            React.createElement("input", { type: "number", min: "0", max: "100", value: form.deviceTrustScore, onChange: e => set("deviceTrustScore", e.target.value) }))),
                    React.createElement("label", { className: "field" },
                        React.createElement("span", null, "Tags"),
                        React.createElement("input", { value: form.tags, onChange: e => set("tags", e.target.value), placeholder: "production, browser-critical" })),
                    React.createElement("div", { className: "success-card" },
                        React.createElement("strong", null, "Manual inventory record"),
                        React.createElement("span", null, "This creates a visible device record for planning, grouping, and rules. It will not receive executable tasks until it enrolls through a real client/node path.")),
                    error && React.createElement(ErrorAlert, { error: error }),
                    React.createElement("div", { style: { display: "flex", justifyContent: "space-between", gap: 8 } },
                        React.createElement("button", { type: "button", className: "btn", onClick: onClose }, "Cancel"),
                        React.createElement("button", { className: "btn primary", disabled: busy || !form.hostname.trim() }, busy ? "Adding..." : "Add device")))))));
}
/**
 * Renders the client enrollment wizard UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function ClientEnrollmentWizard({ onClose, onCreated }) {
    const browserManagementUrl = `${window.location.protocol}//${window.location.host}`;
    const [step, setStep] = useState("details");
    const [mode, setMode] = useState("single");
    const [form, setForm] = useState({
        tenantId: "default",
        managementUrl: browserManagementUrl,
        trustedDownloadHosts: browserManagementUrl,
        clientName: "",
        maxUses: 10,
        heartbeatSeconds: 60,
        inventoryMinutes: 30,
        nodeProbeTimeoutMilliseconds: 2000,
    });
    const [result, setResult] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState("");
    const noticeTimer = useRef(null);
    /**
     * Sets the set value.
     *
     * @param key key supplied to the function.
     * @param value Value to read, render, or store.
     */
    const set = (key, value) => setForm(prev => ({ ...prev, [key]: value }));
    const steps = [
        ["details", "Details"],
        ["config", "Config"],
        ["install", "Install"],
    ];
    const configText = !result
        ? ""
        : result.oneLineJson || (result.config ? JSON.stringify(result.config) : "");
    const prettyConfig = !result
        ? ""
        : JSON.stringify(result.config, null, 2);
    /**
     * Handles the submit operation.
     *
     * @param e Event object emitted by the runtime or UI.
     */
    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        setNotice("");
        try {
            const created = await PatchAPI.createDeviceEnrollment({
                mode,
                tenantId: form.tenantId.trim(),
                managementUrl: form.managementUrl.trim(),
                trustedDownloadHosts: form.trustedDownloadHosts.split(/\r?\n|,/).map(v => v.trim()).filter(Boolean),
                heartbeatSeconds: Number(form.heartbeatSeconds),
                inventoryMinutes: Number(form.inventoryMinutes),
                nodeProbeTimeoutMilliseconds: Number(form.nodeProbeTimeoutMilliseconds),
                clientName: mode === "single" ? form.clientName.trim() : undefined,
                maxUses: mode === "batch" ? Number(form.maxUses) : 1,
            });
            setResult(created);
            setStep("config");
            setNotice(mode === "batch" ? "Reusable batch config created." : "Client config created.");
            onCreated?.();
        }
        catch (err) {
            setError(err);
        }
        finally {
            setBusy(false);
        }
    };
    /**
     * Handles the copy operation.
     *
     * @param text text supplied to the function.
     * @param message message supplied to the function.
     */
    const copy = async (text, message) => {
        const copied = await copyTextToClipboard(text);
        setNotice(copied ? message : "Copy failed. Select the JSON and copy it manually.");
        if (noticeTimer.current)
            clearTimeout(noticeTimer.current);
        noticeTimer.current = setTimeout(() => setNotice(""), 2400);
    };
    return (React.createElement(React.Fragment, null,
        React.createElement("div", { className: "drawer-backdrop", onClick: onClose }),
        React.createElement("div", { className: "wizard-modal", role: "dialog", "aria-modal": "true" },
            React.createElement("div", { className: "wizard-head" },
                React.createElement("div", null,
                    React.createElement("h3", null, "Add Clients"),
                    React.createElement("p", null, "Generate one-line JSON config for one client or a reusable batch install.")),
                React.createElement("button", { className: "icon-btn", onClick: onClose },
                    React.createElement("span", { style: { width: 14, height: 14, display: "inline-flex" } }, Icon.close))),
            React.createElement("div", { className: "wizard-body" },
                React.createElement("div", { className: "wizard-steps" }, steps.map(([id, label]) => {
                    const done = (id === "details" && result) || (id === "config" && result && step === "install");
                    const active = step === id;
                    return (React.createElement("button", { key: id, className: "wizard-step " + (active ? "active " : "") + (done ? "done" : ""), onClick: () => (id === "details" || result) && setStep(id) },
                        React.createElement("span", null, done ? "OK" : "--"),
                        label));
                })),
                React.createElement("div", { className: "wizard-panel" },
                    React.createElement("div", { className: "notice-slot " + (notice ? "show" : ""), "aria-live": "polite", "aria-hidden": !notice }, notice),
                    step === "details" && (React.createElement("form", { onSubmit: submit, style: { display: "flex", flexDirection: "column", gap: 14 } },
                        React.createElement("div", { className: "segmented" },
                            React.createElement("button", { type: "button", className: mode === "single" ? "active" : "", onClick: () => setMode("single") }, "Single client"),
                            React.createElement("button", { type: "button", className: mode === "batch" ? "active" : "", onClick: () => setMode("batch") }, "Batch")),
                        React.createElement("div", { className: "form-grid" },
                            React.createElement("label", { className: "field" },
                                React.createElement("span", null, "Tenant"),
                                React.createElement("input", { required: true, value: form.tenantId, onChange: e => set("tenantId", e.target.value) })),
                            React.createElement("label", { className: "field" },
                                React.createElement("span", null, "Management URL"),
                                React.createElement("input", { required: true, value: form.managementUrl, onChange: e => set("managementUrl", e.target.value) })),
                            React.createElement("label", { className: "field" },
                                React.createElement("span", null, "Heartbeat seconds"),
                                React.createElement("input", { type: "number", min: "1", value: form.heartbeatSeconds, onChange: e => set("heartbeatSeconds", e.target.value) })),
                            React.createElement("label", { className: "field" },
                                React.createElement("span", null, "Inventory minutes"),
                                React.createElement("input", { type: "number", min: "1", value: form.inventoryMinutes, onChange: e => set("inventoryMinutes", e.target.value) }))),
                        React.createElement("label", { className: "field" },
                            React.createElement("span", null, "Trusted download hosts"),
                            React.createElement("textarea", { value: form.trustedDownloadHosts, onChange: e => set("trustedDownloadHosts", e.target.value), placeholder: "https://packages.example.com" })),
                        mode === "single" && (React.createElement("label", { className: "field" },
                            React.createElement("span", null, "Optional client name override"),
                            React.createElement("input", { value: form.clientName, onChange: e => set("clientName", e.target.value), placeholder: "Leave blank to use device hostname" }))),
                        mode === "batch" && (React.createElement(React.Fragment, null,
                            React.createElement("label", { className: "field" },
                                React.createElement("span", null, "Allowed devices"),
                                React.createElement("input", { type: "number", min: "1", max: "10000", value: form.maxUses, onChange: e => set("maxUses", e.target.value) })),
                            React.createElement("div", { className: "success-card" },
                                React.createElement("strong", null, "One reusable config"),
                                React.createElement("span", null,
                                    "Install this same config on up to ",
                                    Number(form.maxUses) || 1,
                                    " clients. Each device reports its own hostname and generates its own device identity.")))),
                        error && React.createElement(ErrorAlert, { error: error }),
                        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 } },
                            React.createElement("span", { className: "muted" }, mode === "batch" ? `One reusable config, limited to ${Number(form.maxUses) || 1} devices.` : "One client config will be generated."),
                            React.createElement("button", { className: "btn primary", disabled: busy }, busy ? "Creating..." : "Create config")))),
                    step === "config" && result && (React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 14 } },
                        React.createElement("div", { className: "alert", style: { color: "var(--ok)", background: "var(--ok-soft)", borderColor: "transparent" } },
                            React.createElement("strong", null, mode === "batch" ? `Reusable batch config created for ${result.count} devices.` : "Config created."),
                            React.createElement("span", { className: "muted" }, "Use the one-line JSON for client setup.")),
                        React.createElement("textarea", { className: "codebox one-line", readOnly: true, value: configText }),
                        React.createElement("details", null,
                            React.createElement("summary", { className: "muted", style: { cursor: "pointer" } }, "Pretty appsettings.json preview"),
                            React.createElement("textarea", { className: "codebox", readOnly: true, value: prettyConfig })),
                        React.createElement("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" } },
                            React.createElement("button", { type: "button", className: "btn", disabled: !configText, onClick: () => copy(configText, "Copied one-line JSON.") }, "Copy JSON"),
                            React.createElement("button", { type: "button", className: "btn", disabled: !prettyConfig, onClick: () => copy(prettyConfig, "Copied pretty config.") }, "Copy pretty JSON"),
                            React.createElement("button", { className: "btn primary", onClick: () => setStep("install") }, "Next")))),
                    step === "install" && result && (React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 14 } },
                        React.createElement("div", { className: "success-card" },
                            React.createElement("strong", null, "Ready to install"),
                            React.createElement("span", null,
                                "Start the client in an interactive console, choose JSON setup, and paste the copied JSON. ",
                                mode === "batch" ? `Use the same JSON on up to ${result.count} clients; hostnames come from the devices themselves.` : "If no name override was set, the device hostname is used.")),
                        React.createElement("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
                            React.createElement("button", { className: "btn", onClick: () => setStep("config") }, "Back"),
                            React.createElement("button", { className: "btn primary", onClick: onClose }, "Done")))))))));
}
// ---------- Apps ----------
/**
 * Renders the apps page UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function AppsPage({ globalSearch = "" }) {
    const [q, setQ] = useState("");
    const activeQ = globalSearch || q;
    const apps = useResource(() => PatchAPI.apps());
    useLiveResource(apps, 5000);
    const [queuing, setQueuing] = useState(new Set());
    const [recentlyQueued, setRecentlyQueued] = useState(new Set());
    const [notice, setNotice] = useState(null);
    /**
     * Updates the all record or state.
     *
     * @param name name supplied to the function.
     */
    const updateAll = async (name) => {
        if (recentlyQueued.has(name))
            return;
        setQueuing(prev => new Set([...prev, name]));
        setRecentlyQueued(prev => new Set([...prev, name]));
        setTimeout(() => setRecentlyQueued(prev => { const s = new Set(prev); s.delete(name); return s; }), 30000);
        try {
            const result = await PatchAPI.updateAllForApp(name);
            const count = Array.isArray(result) ? result.length : (result?.tasks?.length ?? 0);
            const msg = count > 0
                ? `Queued ${count} update task${count !== 1 ? "s" : ""} for ${name}.`
                : `No outdated installs of ${name}.`;
            setNotice({ ok: count > 0, msg });
        }
        catch (e) {
            setNotice({ ok: false, msg: `Failed to queue updates for ${name}: ${e?.message ?? "unknown error"}` });
        }
        finally {
            setQueuing(prev => { const s = new Set(prev); s.delete(name); return s; });
            setTimeout(() => setNotice(null), 5000);
        }
    };
    const rows = (apps.data || []).filter(a => !activeQ || `${a.name} ${a.publisher}`.toLowerCase().includes(activeQ.toLowerCase()));
    return (React.createElement("div", { className: "page" },
        React.createElement("div", { className: "page-head" },
            React.createElement("div", null,
                React.createElement("h2", null, "Apps"),
                React.createElement("p", null, "Discovered across the fleet \u00B7 grouped by name")),
            React.createElement("button", { className: "btn accent" }, "Update all outdated")),
        React.createElement("div", { className: "card" },
            React.createElement("div", { className: "filterbar" },
                React.createElement("div", { className: "searchbox", style: { flex: 1, maxWidth: 320 } },
                    React.createElement("span", { style: { width: 14, height: 14, display: "inline-flex", alignItems: "center", justifyContent: "center" } }, apps.loading ? React.createElement("span", { className: "search-spinner" }) : Icon.search),
                    React.createElement("input", { placeholder: "Filter apps\u2026", value: globalSearch || q, onChange: e => setQ(e.target.value) }))),
            notice && (React.createElement("div", { className: `toast-inline${notice.ok ? "" : " error"}`, style: { margin: "12px 16px 0" } }, notice.msg)),
            apps.error && React.createElement("div", { style: { padding: 16 } },
                React.createElement(ErrorAlert, { error: apps.error, onRetry: apps.reload })),
            React.createElement("div", { style: { overflowX: "auto" } },
                React.createElement("table", { className: "tbl" },
                    React.createElement("thead", null,
                        React.createElement("tr", null,
                            React.createElement("th", null, "App"),
                            React.createElement("th", null, "Publisher"),
                            React.createElement("th", null, "Latest"),
                            React.createElement("th", null, "Oldest in fleet"),
                            React.createElement("th", { className: "num" }, "Devices"),
                            React.createElement("th", { className: "num" }, "Outdated"),
                            React.createElement("th", null, "Coverage"),
                            React.createElement("th", null))),
                    React.createElement("tbody", null,
                        apps.loading && React.createElement(SkeletonRows, { n: 6, cols: 8 }),
                        !apps.loading && rows.length === 0 && React.createElement("tr", null,
                            React.createElement("td", { colSpan: 8, style: { padding: 24, color: "var(--text-3)" } }, "No apps tracked yet.")),
                        !apps.loading && rows.map(a => {
                            const outdated = a.outdatedDeviceCount ?? a.outdated ?? 0;
                            const total = a.deviceCount ?? 1;
                            const pct = Math.round(((total - outdated) / total) * 100);
                            const isQueuing = queuing.has(a.name);
                            const isLocked = isQueuing || recentlyQueued.has(a.name);
                            return (React.createElement("tr", { key: a.name + (a.publisher || "") },
                                React.createElement("td", null,
                                    React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
                                        React.createElement("div", { style: { width: 28, height: 28, borderRadius: 6, background: "var(--bg-sub)", display: "grid", placeItems: "center", fontWeight: 600, fontSize: 11, color: "var(--text-2)" } }, (a.name || "·").split(" ").map(w => w[0]).slice(0, 2).join("")),
                                        React.createElement("strong", { style: { fontWeight: 500 } }, a.name),
                                        a.critical && React.createElement("span", { className: "pill crit" }, "CVE"))),
                                React.createElement("td", { className: "muted" }, a.publisher),
                                React.createElement("td", { className: "mono" }, a.latestVersion ?? a.latest),
                                React.createElement("td", { className: "mono muted" }, a.oldestVersion ?? a.oldest ?? "—"),
                                React.createElement("td", { className: "num mono" }, total),
                                React.createElement("td", { className: "num" },
                                    React.createElement("span", { style: { color: outdated ? "var(--warn)" : "var(--text-3)", fontFamily: "var(--font-mono)" } }, outdated)),
                                React.createElement("td", null,
                                    React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                                        React.createElement("div", { style: { width: 80, height: 4, background: "var(--bg-sub)", borderRadius: 2, overflow: "hidden" } },
                                            React.createElement("div", { style: { width: pct + "%", height: "100%", background: pct >= 90 ? "var(--ok)" : pct >= 70 ? "var(--accent)" : "var(--warn)" } })),
                                        React.createElement("span", { className: "mono muted", style: { fontSize: 12 } },
                                            pct,
                                            "%"))),
                                React.createElement("td", null, outdated > 0 && React.createElement("button", { className: "btn sm", disabled: isLocked, onClick: () => updateAll(a.name) }, isQueuing ? "Queuing…" : isLocked ? "Queued" : `Update ${outdated}`))));
                        })))))));
}
// ---------- Packages ----------
function PackagesPage({ globalSearch = "" }) {
    const pkgs = useResource(() => PatchAPI.packages());
    const [storeOpen, setStoreOpen] = useState(false);
    const [wizardOpen, setWizardOpen] = useState(false);
    const [selected, setSelected] = useState(null);
    const [notice, setNotice] = useState(null);
    useLiveResource(pkgs, 10000);
    const allRows = pkgs.data || [];
    const centralCount = allRows.filter(p => p.catalogSource === "central").length;
    const customCount = allRows.filter(p => p.catalogSource !== "central").length;
    const rows = allRows.filter(p => textMatches(globalSearch, [p.name, p.publisher, p.version, p.type, p.platform, p.architecture, p.sha256, p.packageId, p.catalogCategory]));
    const handleDeployed = (msg) => {
        setNotice(msg);
        setSelected(null);
        pkgs.reload();
        setTimeout(() => setNotice(null), 5000);
    };
    return (React.createElement("div", { className: "page" },
        React.createElement("div", { className: "page-head" },
            React.createElement("div", null,
                React.createElement("h2", null, "Package library"),
                React.createElement("p", null,
                    customCount,
                    " custom packages \u00B7 ",
                    centralCount,
                    " available in catalog")),
            React.createElement("div", { style: { display: "flex", gap: 8 } },
                React.createElement("button", { className: "btn", onClick: () => setWizardOpen(true) },
                    React.createElement("span", { style: { width: 14, height: 14, display: "inline-flex" } }, Icon.plus),
                    "Add custom"),
                React.createElement("button", { className: "btn primary", onClick: () => setStoreOpen(true) },
                    React.createElement("span", { style: { width: 14, height: 14, display: "inline-flex" } }, Icon.packages),
                    "Browse catalog"))),
        React.createElement("div", { className: "stats" },
            React.createElement(Stat, { label: "Packages", value: pkgs.loading ? "—" : allRows.length, sub: "In your library" }),
            React.createElement(Stat, { label: "Windows", value: pkgs.loading ? "—" : allRows.filter(p => p.platform === "windows").length }),
            React.createElement(Stat, { label: "Linux", value: pkgs.loading ? "—" : allRows.filter(p => p.platform === "linux").length }),
            React.createElement(Stat, { label: "Custom", value: pkgs.loading ? "—" : customCount, sub: "Uploads & vendor URLs" })),
        notice && React.createElement("div", { className: "toast-inline", style: { marginBottom: 12 } }, notice),
        React.createElement("div", { className: "card" },
            pkgs.error && React.createElement("div", { style: { padding: 16 } },
                React.createElement(ErrorAlert, { error: pkgs.error, onRetry: pkgs.reload })),
            React.createElement("table", { className: "tbl" },
                React.createElement("thead", null,
                    React.createElement("tr", null,
                        React.createElement("th", null, "Name"),
                        React.createElement("th", null, "Version"),
                        React.createElement("th", null, "Type"),
                        React.createElement("th", null, "Platform"),
                        React.createElement("th", null, "Signature"),
                        React.createElement("th", null, "Added"))),
                React.createElement("tbody", null,
                    pkgs.loading && React.createElement(SkeletonRows, { n: 5, cols: 6 }),
                    !pkgs.loading && rows.length === 0 && (React.createElement("tr", null,
                        React.createElement("td", { colSpan: 6, style: { padding: 32, color: "var(--text-3)", textAlign: "center" } },
                            "No packages in your library yet \u2014 use ",
                            React.createElement("strong", null, "Add custom"),
                            " for MSI/EXE/APT or ",
                            React.createElement("strong", null, "Browse catalog"),
                            " to add winget packages."))),
                    !pkgs.loading && rows.map(p => (React.createElement("tr", { key: p.id || p.sha256, onClick: () => setSelected(p), style: { cursor: "pointer" } },
                        React.createElement("td", null,
                            React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
                                React.createElement("div", { className: "pkg-avatar" }, (p.name || "?")[0].toUpperCase()),
                                React.createElement("div", null,
                                    React.createElement("strong", { style: { fontWeight: 500 } }, p.name),
                                    React.createElement("div", { className: "muted", style: { fontSize: 12 } },
                                        p.publisher,
                                        p.catalogCategory ? ` · ${p.catalogCategory}` : "")))),
                        React.createElement("td", { className: "mono" }, p.version),
                        React.createElement("td", null,
                            React.createElement("span", { className: "pill" }, p.type)),
                        React.createElement("td", { className: "muted" },
                            p.platform,
                            p.architecture && p.architecture !== "any" ? " · " + p.architecture : ""),
                        React.createElement("td", null,
                            React.createElement(StatusPill, { status: p.signatureStatus })),
                        React.createElement("td", { className: "muted" }, fmtAgo(p.createdAt)))))))),
        selected && React.createElement(PackageDetailPanel, { pkg: selected, onClose: () => setSelected(null), onDeployed: handleDeployed }),
        wizardOpen && React.createElement(PackageWizard, { onClose: () => setWizardOpen(false), onCreated: (pkg) => { setWizardOpen(false); setNotice(`Package ${pkg.name} added.`); pkgs.reload(); setTimeout(() => setNotice(null), 5000); } }),
        storeOpen && React.createElement(PackageStore, { onClose: () => setStoreOpen(false), onDeployed: (msg) => { setStoreOpen(false); setNotice(msg); pkgs.reload(); setTimeout(() => setNotice(null), 5000); } })));
}
function PackageWizard({ onClose, onCreated }) {
    const [step, setStep] = useState(0);
    const [file, setFile] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [form, setForm] = useState({
        type: "winget",
        platform: "windows",
        architecture: "any",
        name: "",
        publisher: "",
        version: "latest",
        packageId: "",
        packageScope: "system",
        sourceUrl: "",
        sha256: "",
        installArgs: "",
        signatureStatus: "unknown",
        catalogCategory: "Custom",
    });
    const set = (key, value) => setForm(prev => ({ ...prev, [key]: value }));
    const chooseType = (type) => {
        const platform = ["apt", "snap", "flatpak"].includes(type) ? "linux" : "windows";
        setForm(prev => ({
            ...prev,
            type,
            platform,
            packageScope: type === "scoop" ? "global" : "system",
            installArgs: type === "msi" ? "/qn /norestart" : type === "exe" ? "/quiet /norestart" : "",
            version: prev.version || "latest",
        }));
        setStep(1);
    };
    const managerType = ["winget", "chocolatey", "scoop", "apt", "snap", "flatpak"].includes(form.type);
    const downloadableType = ["msi", "exe"].includes(form.type);
    const canContinue = step === 0 || (form.name.trim() && form.publisher.trim() && form.version.trim() && (!managerType || form.packageId.trim()) && (!downloadableType || file || (form.sourceUrl.trim() && form.sha256.trim())));
    const save = async () => {
        setBusy(true);
        setError("");
        try {
            const payload = {
                ...form,
                packageManager: form.type,
                applicability: { appName: form.name, manufacturer: form.publisher },
            };
            if (file) {
                payload.fileName = file.name;
                payload.fileBase64 = await readFileBase64(file);
            }
            if (!payload.installArgs && form.type === "msi")
                payload.installArgs = "/qn /norestart";
            if (!payload.installArgs && form.type === "exe")
                payload.installArgs = "/quiet /norestart";
            const created = await PatchAPI.createPackage(payload);
            onCreated?.(created);
        }
        catch (err) {
            setError(err?.message || String(err));
        }
        finally {
            setBusy(false);
        }
    };
    const steps = ["Type", "Details", "Review"];
    return (React.createElement("div", { className: "modal-overlay", onClick: onClose },
        React.createElement("div", { className: "modal-box package-wizard", onClick: e => e.stopPropagation() },
            React.createElement("div", { className: "wizard-top" },
                React.createElement("div", null,
                    React.createElement("h3", null, "Add package"),
                    React.createElement("p", null, "Custom artifacts are stored by management, cached by backend nodes, and executed only through signed tasks.")),
                React.createElement("button", { className: "icon-btn", onClick: onClose, "aria-label": "Close" }, Icon.close)),
            React.createElement("div", { className: "sso-wizard-steps package-wizard-steps" }, steps.map((label, i) => (React.createElement(React.Fragment, { key: label },
                React.createElement("div", { className: "sso-wizard-step-dot " + (step === i ? "active" : step > i ? "done" : "") },
                    React.createElement("span", { className: "sso-wizard-dot-num" }, step > i ? Icon.check : i + 1),
                    React.createElement("span", { className: "sso-wizard-dot-label" }, label)),
                i < steps.length - 1 && React.createElement("div", { className: "sso-wizard-connector " + (step > i ? "filled" : "") }))))),
            step === 0 && (React.createElement("div", { className: "package-type-grid" }, [
                ["winget", "winget", Icon.windows, "Windows package manager"],
                ["msi", "MSI", Icon.packages, "Uploaded or vendor-hosted installer"],
                ["exe", "EXE", Icon.play, "Installer with safe silent parameters"],
                ["apt", "APT", Icon.linux, "Ubuntu/Debian repo package"],
                ["snap", "Snap", Icon.linux, "Linux Snap package"],
                ["flatpak", "Flatpak", Icon.linux, "Linux desktop package"],
                ["chocolatey", "Chocolatey", Icon.packages, "Chocolatey managed package"],
                ["scoop", "Scoop", Icon.download, "Scoop managed package"],
            ].map(([id, label, icon, desc]) => (React.createElement("button", { key: id, className: "package-type-card " + (form.type === id ? "selected" : ""), onClick: () => chooseType(id) },
                React.createElement("span", null, icon),
                React.createElement("strong", null, label),
                React.createElement("em", null, desc)))))),
            step === 1 && (React.createElement("div", { className: "package-wizard-body" },
                React.createElement("div", { className: "form-grid" },
                    React.createElement("label", { className: "field" },
                        React.createElement("span", null, "Name"),
                        React.createElement("input", { value: form.name, onChange: e => set("name", e.target.value), placeholder: "Google Chrome" })),
                    React.createElement("label", { className: "field" },
                        React.createElement("span", null, "Publisher"),
                        React.createElement("input", { value: form.publisher, onChange: e => set("publisher", e.target.value), placeholder: "Google" })),
                    React.createElement("label", { className: "field" },
                        React.createElement("span", null, "Version"),
                        React.createElement("input", { value: form.version, onChange: e => set("version", e.target.value), placeholder: "latest" })),
                    React.createElement("label", { className: "field" },
                        React.createElement("span", null, "Architecture"),
                        React.createElement("select", { value: form.architecture, onChange: e => set("architecture", e.target.value) },
                            React.createElement("option", { value: "any" }, "Any"),
                            React.createElement("option", { value: "x64" }, "x64"),
                            React.createElement("option", { value: "x86" }, "x86"),
                            React.createElement("option", { value: "arm64" }, "arm64")))),
                managerType && (React.createElement("div", { className: "form-grid", style: { marginTop: 14 } },
                    React.createElement("label", { className: "field" },
                        React.createElement("span", null, "Package ID"),
                        React.createElement("input", { value: form.packageId, onChange: e => set("packageId", e.target.value), placeholder: form.type === "flatpak" ? "org.example.App" : ["apt", "snap"].includes(form.type) ? "nginx" : "Google.Chrome" })),
                    React.createElement("label", { className: "field" },
                        React.createElement("span", null, "Scope"),
                        React.createElement("select", { value: form.packageScope, onChange: e => set("packageScope", e.target.value) },
                            React.createElement("option", { value: "system" }, "System"),
                            React.createElement("option", { value: "global" }, "Global"),
                            React.createElement("option", { value: "user" }, "User"))))),
                downloadableType && (React.createElement("div", { className: "package-source-box" },
                    React.createElement("label", { className: "field" },
                        React.createElement("span", null, "Upload installer"),
                        React.createElement("input", { type: "file", accept: form.type === "msi" ? ".msi" : ".exe", onChange: e => setFile(e.target.files?.[0] || null) })),
                    React.createElement("div", { className: "sub" }, "or use a vendor URL with a pinned SHA-256"),
                    React.createElement("div", { className: "form-grid" },
                        React.createElement("label", { className: "field" },
                            React.createElement("span", null, "Source URL"),
                            React.createElement("input", { value: form.sourceUrl, onChange: e => set("sourceUrl", e.target.value), placeholder: "https://vendor.example/app.msi" })),
                        React.createElement("label", { className: "field" },
                            React.createElement("span", null, "SHA-256"),
                            React.createElement("input", { value: form.sha256, onChange: e => set("sha256", e.target.value), placeholder: "64 hex characters" }))),
                    React.createElement("label", { className: "field", style: { marginTop: 14 } },
                        React.createElement("span", null, "Install parameters"),
                        React.createElement("input", { value: form.installArgs, onChange: e => set("installArgs", e.target.value), placeholder: form.type === "exe" ? "/quiet /norestart" : "/qn /norestart" })))))),
            step === 2 && (React.createElement("div", { className: "package-review" },
                React.createElement("div", null,
                    React.createElement("span", null, "Name"),
                    React.createElement("strong", null, form.name)),
                React.createElement("div", null,
                    React.createElement("span", null, "Type"),
                    React.createElement("strong", null,
                        form.type,
                        " \u00B7 ",
                        form.platform)),
                React.createElement("div", null,
                    React.createElement("span", null, "Source"),
                    React.createElement("strong", null, managerType ? form.packageId : file ? file.name : form.sourceUrl)),
                React.createElement("div", null,
                    React.createElement("span", null, "Execution"),
                    React.createElement("strong", null, downloadableType ? "Backend-node cache proxy" : "Native package manager")))),
            error && React.createElement("div", { className: "banner error" }, error),
            React.createElement("div", { className: "modal-actions" },
                React.createElement("button", { className: "btn ghost", onClick: step === 0 ? onClose : () => setStep(step - 1), disabled: busy }, step === 0 ? "Cancel" : "Back"),
                step < 2
                    ? React.createElement("button", { className: "btn primary", disabled: !canContinue, onClick: () => setStep(step + 1) }, "Next")
                    : React.createElement("button", { className: "btn primary", disabled: busy || !canContinue, onClick: save }, busy ? "Saving..." : "Create package")))));
}
function PackageDetailPanel({ pkg, onClose, onDeployed }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const deploy = async () => {
        setBusy(true);
        setError("");
        try {
            const result = await PatchAPI.deployPackageAll(pkg.id);
            const count = result?.tasks?.length ?? (Array.isArray(result) ? result.length : 0);
            const skipped = result?.skippedDeviceCount ?? 0;
            onDeployed(`${count} deployment task${count === 1 ? "" : "s"} queued${skipped ? `; ${skipped} skipped` : ""}.`);
        }
        catch (err) {
            setError(err?.message || String(err));
            setBusy(false);
        }
    };
    const rows = [
        ["Version", pkg.version],
        ["Type", pkg.type],
        ["Platform", pkg.platform + (pkg.architecture && pkg.architecture !== "any" ? " · " + pkg.architecture : "")],
        ["Category", pkg.catalogCategory || "—"],
        ["Source", pkg.catalogSource === "central" ? "Central catalog" : "Custom"],
        ["Signature", pkg.signatureStatus],
        pkg.packageId ? ["Package ID", pkg.packageId] : null,
        pkg.sha256 ? ["SHA-256", pkg.sha256.slice(0, 16) + "…"] : null,
        pkg.sourceUrl ? ["Source URL", pkg.sourceUrl] : null,
        ["Added", fmtAgo(pkg.createdAt)],
    ].filter(Boolean);
    return (React.createElement("div", { className: "detail-panel-overlay", onClick: onClose },
        React.createElement("div", { className: "detail-panel", onClick: e => e.stopPropagation() },
            React.createElement("div", { className: "detail-panel-head" },
                React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 12, minWidth: 0 } },
                    React.createElement("div", { className: "pkg-avatar lg" }, (pkg.name || "?")[0].toUpperCase()),
                    React.createElement("div", { style: { minWidth: 0 } },
                        React.createElement("h3", { style: { margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, pkg.name),
                        React.createElement("div", { className: "muted", style: { fontSize: 13 } }, pkg.publisher))),
                React.createElement("button", { className: "icon-btn", onClick: onClose, "aria-label": "Close" }, Icon.close)),
            React.createElement("div", { className: "detail-panel-body" },
                React.createElement("div", { className: "pkg-detail-grid" }, rows.map(([label, value]) => (React.createElement("div", { key: label, className: "pkg-detail-row" },
                    React.createElement("span", { className: "pkg-detail-label" }, label),
                    React.createElement("span", { className: "pkg-detail-value" }, value))))),
                pkg.installArgs && (React.createElement("div", { style: { marginTop: 16 } },
                    React.createElement("div", { className: "pkg-detail-label", style: { marginBottom: 6 } }, "Install args"),
                    React.createElement("code", { style: { display: "block", background: "var(--bg-sub)", border: "1px solid var(--line)", borderRadius: "var(--r-sm)", padding: "8px 10px", fontSize: 12, overflowX: "auto" } }, pkg.installArgs))),
                error && React.createElement("div", { className: "banner error", style: { marginTop: 16 } }, error)),
            React.createElement("div", { className: "detail-panel-foot" },
                React.createElement("button", { className: "btn primary", style: { flex: 1 }, onClick: deploy, disabled: busy }, busy ? "Deploying…" : "Deploy to all matching devices")))));
}
function PackageStore({ onClose, onDeployed }) {
    const catalogRes = useResource(() => PatchAPI.packageCatalog());
    const [platform, setPlatform] = useState("all");
    const [manager, setManager] = useState("all");
    const [category, setCategory] = useState("All");
    const [search, setSearch] = useState("");
    const [deploying, setDeploying] = useState(null);
    const [notice, setNotice] = useState(null);
    const catalog = catalogRes.data || [];
    const platforms = ["all", ...Array.from(new Set(catalog.map(p => p.platform).filter(Boolean))).sort()];
    const managers = ["all", ...Array.from(new Set(catalog.filter(p => platform === "all" || p.platform === platform).map(p => p.packageManager).filter(Boolean))).sort()];
    const scopedCatalog = catalog.filter(p => (platform === "all" || p.platform === platform) &&
        (manager === "all" || p.packageManager === manager));
    const categories = ["All", ...Array.from(new Set(scopedCatalog.map(p => p.category).filter(Boolean))).sort()];
    const catCount = (cat) => cat === "All" ? scopedCatalog.length : scopedCatalog.filter(p => p.category === cat).length;
    const filtered = scopedCatalog.filter(p => {
        if (category !== "All" && p.category !== category)
            return false;
        if (search)
            return textMatches(search, [p.name, p.publisher, p.packageId, p.category, p.platform, p.packageManager]);
        return true;
    });
    const deploy = async (entry) => {
        setDeploying(`${entry.platform}:${entry.packageManager}:${entry.packageId}`);
        try {
            const artifact = await PatchAPI.createPackage({
                name: entry.name,
                publisher: entry.publisher,
                version: "latest",
                type: entry.packageManager,
                platform: entry.platform,
                architecture: "any",
                packageId: entry.packageId,
                packageScope: "system",
                catalogCategory: entry.category,
                installArgs: "",
                signatureStatus: "unknown",
            });
            const result = await PatchAPI.deployPackageAll(artifact.id);
            const count = result?.tasks?.length ?? (Array.isArray(result) ? result.length : 0);
            onDeployed?.(`${entry.name} added to library and ${count} deployment task${count === 1 ? "" : "s"} queued.`);
        }
        catch (err) {
            setNotice(`Error: ${err?.message || String(err)}`);
        }
        finally {
            setDeploying(null);
        }
    };
    return (React.createElement("div", { className: "modal-overlay", onClick: onClose },
        React.createElement("div", { className: "pkg-store-modal", onClick: e => e.stopPropagation() },
            React.createElement("div", { className: "pkg-store-header" },
                React.createElement("div", null,
                    React.createElement("h3", { style: { margin: "0 0 2px" } }, "Package Catalog"),
                    React.createElement("p", { style: { margin: 0, fontSize: 13, color: "var(--text-3)" } },
                        catalog.length,
                        " packages \u00B7 ",
                        categories.length - 1,
                        " categories \u00B7 Windows and Linux")),
                React.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
                    React.createElement("input", { className: "pkg-store-search", placeholder: "Search packages\u2026", value: search, onChange: e => setSearch(e.target.value), autoFocus: true }),
                    React.createElement("button", { className: "icon-btn", onClick: onClose, "aria-label": "Close" }, Icon.close))),
            notice && React.createElement("div", { className: "toast-inline", style: { margin: "8px 20px 0" } }, notice),
            React.createElement("div", { className: "pkg-store-layout" },
                React.createElement("nav", { className: "pkg-store-sidebar" },
                    React.createElement("div", { className: "pkg-store-filter-block" },
                        React.createElement("span", null, "Platform"),
                        platforms.map(value => (React.createElement("button", { key: value, className: "pkg-store-filter-btn " + (platform === value ? "active" : ""), onClick: () => { setPlatform(value); setManager("all"); setCategory("All"); } }, value === "all" ? "All platforms" : value)))),
                    React.createElement("div", { className: "pkg-store-filter-block" },
                        React.createElement("span", null, "Manager"),
                        managers.map(value => (React.createElement("button", { key: value, className: "pkg-store-filter-btn " + (manager === value ? "active" : ""), onClick: () => { setManager(value); setCategory("All"); } }, value === "all" ? "All managers" : value)))),
                    categories.map(cat => (React.createElement("button", { key: cat, className: "pkg-store-cat-btn " + (category === cat ? "active" : ""), onClick: () => setCategory(cat) },
                        React.createElement("span", null, cat),
                        React.createElement("span", { className: "pkg-store-cat-count" }, catCount(cat)))))),
                React.createElement("div", { className: "pkg-store-content" },
                    catalogRes.loading && React.createElement("div", { style: { padding: "48px 0", color: "var(--text-3)", textAlign: "center" } }, "Loading catalog\u2026"),
                    !catalogRes.loading && filtered.length === 0 && (React.createElement("div", { style: { padding: "48px 0", color: "var(--text-3)", textAlign: "center" } }, "No packages match your search.")),
                    React.createElement("div", { className: "pkg-catalog-grid" }, filtered.map(p => (React.createElement("div", { key: `${p.platform}:${p.packageManager}:${p.packageId}`, className: "pkg-catalog-card" },
                        React.createElement("div", { className: "pkg-catalog-card-top" },
                            React.createElement("div", { className: "pkg-avatar" }, (p.name || "?")[0].toUpperCase()),
                            React.createElement("span", { className: "pill ok" }, p.packageManager)),
                        React.createElement("div", { className: "pkg-catalog-card-name" }, p.name),
                        React.createElement("div", { className: "pkg-catalog-card-pub" }, p.publisher),
                        React.createElement("div", { className: "pkg-catalog-card-meta" },
                            p.platform,
                            " \u00B7 ",
                            p.category),
                        React.createElement("div", { className: "pkg-catalog-card-foot" },
                            React.createElement("button", { className: "btn sm primary", onClick: () => deploy(p), disabled: deploying === `${p.platform}:${p.packageManager}:${p.packageId}` }, deploying === `${p.platform}:${p.packageManager}:${p.packageId}` ? "…" : "Deploy")))))))))));
}
function readFileBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || "").split(",", 2)[1] || "");
        reader.onerror = () => reject(reader.error || new Error("Could not read file"));
        reader.readAsDataURL(file);
    });
}
// ---------- Rules ----------
/**
 * Renders the rules page UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function RulesPage({ globalSearch = "" }) {
    const [editing, setEditing] = useState(null);
    const [testing, setTesting] = useState(null);
    const rules = useResource(() => PatchAPI.rules());
    const audit = useResource(() => PatchAPI.ruleAudit());
    useLiveResource(rules, 10000);
    useLiveResource(audit, 10000);
    /**
     * Changes the toggle state.
     *
     * @param r r supplied to the function.
     */
    const toggle = async (r) => { try {
        await PatchAPI.toggleRule(r.id, !r.enabled);
    }
    finally {
        rules.reload();
        audit.reload(true);
    } };
    const rows = (rules.data || []).filter(r => textMatches(globalSearch, [r.name, r.description, r.trigger?.type, r.trigger?.eventType, JSON.stringify(r.conditionGroup), JSON.stringify(r.actions), r.enabled ? "enabled" : "disabled"]));
    return (React.createElement("div", { className: "page" },
        React.createElement("div", { className: "page-head" },
            React.createElement("div", null,
                React.createElement("h2", null, "Rules Engine"),
                React.createElement("p", null, "Policy automation that creates visible, scanned task drafts through the signed pipeline")),
            React.createElement("button", { className: "btn primary", onClick: () => setEditing(defaultRule()) },
                React.createElement("span", { style: { width: 14, height: 14, display: "inline-flex" } }, Icon.plus),
                "New rule")),
        React.createElement("div", { className: "card" },
            rules.error && React.createElement("div", { style: { padding: 16 } },
                React.createElement(ErrorAlert, { error: rules.error, onRetry: rules.reload })),
            React.createElement("table", { className: "tbl" },
                React.createElement("thead", null,
                    React.createElement("tr", null,
                        React.createElement("th", null, "Name"),
                        React.createElement("th", null, "Trigger"),
                        React.createElement("th", null, "Conditions"),
                        React.createElement("th", null, "Actions"),
                        React.createElement("th", null, "Last run"),
                        React.createElement("th", null, "Status"),
                        React.createElement("th", null))),
                React.createElement("tbody", null,
                    rules.loading && React.createElement(SkeletonRows, { n: 4, cols: 7 }),
                    !rules.loading && rows.length === 0 && React.createElement("tr", null,
                        React.createElement("td", { colSpan: 7, style: { padding: 24, color: "var(--text-3)" } }, "No rules configured.")),
                    !rules.loading && rows.map(r => (React.createElement("tr", { key: r.id },
                        React.createElement("td", null,
                            React.createElement("strong", { style: { fontWeight: 500 } }, r.name),
                            React.createElement("div", { className: "muted", style: { fontSize: 12 } }, r.description || `Priority ${r.priority ?? 100}`)),
                        React.createElement("td", { className: "mono muted" },
                            r.trigger?.type || "manual",
                            r.trigger?.eventType ? ` · ${r.trigger.eventType}` : ""),
                        React.createElement("td", { className: "mono muted" }, conditionSummary(r.conditionGroup || { combinator: "AND", conditions: r.conditions || [] })),
                        React.createElement("td", { className: "mono muted" }, (r.actions || []).map(actionSummary).join(", ")),
                        React.createElement("td", { className: "muted" }, fmtAgo(r.lastRunAt)),
                        React.createElement("td", null,
                            React.createElement("button", { onClick: (e) => { e.stopPropagation(); toggle(r); }, style: { border: 0, padding: 0, background: "transparent", cursor: "pointer" } },
                                React.createElement("span", { className: "pill " + (r.enabled ? "ok" : "") },
                                    React.createElement("span", { className: "dot" }),
                                    r.enabled ? "Enabled" : "Disabled"))),
                        React.createElement("td", { style: { whiteSpace: "nowrap" } },
                            React.createElement("button", { className: "btn sm ghost", onClick: () => setTesting(r) }, "Test"),
                            React.createElement("button", { className: "btn sm", onClick: () => setEditing(r) }, "Edit")))))))),
        React.createElement("div", { className: "card" },
            React.createElement("div", { className: "card-head" },
                React.createElement("div", null,
                    React.createElement("h3", null, "Rule audit"),
                    React.createElement("div", { className: "sub" }, "Recent triggered, executed, failed, rate-limited, and conflict records"))),
            React.createElement("div", { className: "card-body tight", style: { overflowX: "auto" } },
                React.createElement("table", { className: "tbl" },
                    React.createElement("thead", null,
                        React.createElement("tr", null,
                            React.createElement("th", null, "Rule"),
                            React.createElement("th", null, "Device"),
                            React.createElement("th", null, "Result"),
                            React.createElement("th", null, "Risk"),
                            React.createElement("th", null, "Tasks"),
                            React.createElement("th", null, "Why"),
                            React.createElement("th", null, "Time"))),
                    React.createElement("tbody", null,
                        audit.loading && React.createElement(SkeletonRows, { n: 4, cols: 7 }),
                        !audit.loading && (audit.data || []).slice(0, 8).map(e => (React.createElement("tr", { key: e.id },
                            React.createElement("td", { className: "mono" }, e.ruleId),
                            React.createElement("td", { className: "mono muted" }, e.deviceId || "—"),
                            React.createElement("td", null,
                                React.createElement("span", { className: "pill " + (e.status === "failed" ? "crit" : e.matched ? "ok" : "") }, e.status)),
                            React.createElement("td", { className: "mono" }, e.riskScore),
                            React.createElement("td", { className: "mono muted" }, (e.taskIds || []).length),
                            React.createElement("td", { className: "muted", style: { maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, (e.conflicts || []).concat(e.reasons || []).join(" · ")),
                            React.createElement("td", { className: "muted" }, fmtAgo(e.triggeredAt))))),
                        !audit.loading && (audit.data || []).length === 0 && React.createElement("tr", null,
                            React.createElement("td", { colSpan: 7, style: { padding: 24, color: "var(--text-3)" } }, "No rule executions yet.")))))),
        editing && React.createElement(RuleWizard, { rule: editing, onClose: () => setEditing(null), onCreated: () => { rules.reload(); audit.reload(true); } }),
        testing && React.createElement(RuleTester, { rule: testing, onClose: () => setTesting(null), onExecuted: () => { rules.reload(); audit.reload(true); } })));
}
/**
 * Renders the rule wizard UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function RuleWizard({ rule, onClose, onCreated }) {
    const [step, setStep] = useState(() => rule?.id ? "trigger" : "templates");
    const [form, setForm] = useState(() => normalizeRuleForm(rule));
    const templates = useResource(() => PatchAPI.ruleTemplates(form.tenantId || "default").catch(() => DASHBOARD_RULE_TEMPLATES), [form.tenantId]);
    const [templateCategory, setTemplateCategory] = useState("Recommended");
    const [selectedTemplateId, setSelectedTemplateId] = useState("");
    const [templateInputs, setTemplateInputs] = useState({});
    const [templatePreview, setTemplatePreview] = useState(null);
    const [templateImportOpen, setTemplateImportOpen] = useState(false);
    const [templateImportText, setTemplateImportText] = useState("");
    const [templateImportNotice, setTemplateImportNotice] = useState(null);
    const devices = useResource(() => PatchAPI.devices(), []);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    /**
     * Sets the set value.
     *
     * @param key key supplied to the function.
     * @param value Value to read, render, or store.
     */
    const set = (key, value) => setForm(prev => ({ ...prev, [key]: value }));
    const templateRows = templates.data || [];
    const deviceGroups = useMemo(() => buildDeviceGroupOptions(devices.data || []), [devices.data]);
    const templateCategories = ["Recommended", "Patch Automation", "Security / Inventory", "Failure Handling", "Compliance", "Notifications"];
    const selectedTemplate = templateRows.find(t => t.id === selectedTemplateId) || templateRows.find(t => t.category === templateCategory) || templateRows[0];
    useEffect(() => {
        if (!selectedTemplateId && selectedTemplate?.id)
            setSelectedTemplateId(selectedTemplate.id);
    }, [selectedTemplateId, selectedTemplate?.id]);
    /**
     * Manages use template state for the UI.
     */
    const useTemplate = async () => {
        if (!selectedTemplate)
            return;
        setBusy(true);
        setError(null);
        try {
            const inputs = withTemplateDefaults(selectedTemplate, templateInputs, form.tenantId);
            const result = await PatchAPI.createRuleDraftFromTemplate(selectedTemplate.id, inputs).catch(() => clientRuleDraftFromTemplate(selectedTemplate, inputs, form.tenantId || "default"));
            setForm(normalizeRuleForm(result.draftRule));
            setTemplatePreview(result.preview);
            setStep("preview");
        }
        catch (err) {
            setError(err);
        }
        finally {
            setBusy(false);
        }
    };
    /**
     * Handles the import template config operation.
     */
    const importTemplateConfig = async () => {
        const configString = templateImportText.trim();
        if (!configString) {
            setTemplateImportNotice({ ok: false, text: "Paste a template config string first." });
            return;
        }
        setBusy(true);
        setError(null);
        setTemplateImportNotice(null);
        try {
            const imported = await PatchAPI.importRuleTemplateConfig({ configString, tenantId: form.tenantId || "default" });
            setTemplateImportText("");
            setTemplateImportNotice({ ok: true, text: `Imported ${imported.name}.` });
            setTemplateCategory(imported.category || "Recommended");
            setSelectedTemplateId(imported.id);
            await templates.reload(false);
        }
        catch (err) {
            setTemplateImportNotice({ ok: false, text: err?.message || String(err) });
        }
        finally {
            setBusy(false);
        }
    };
    /**
     * Saves save data.
     *
     * @param e Event object emitted by the runtime or UI.
     */
    const save = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const payload = rulePayload(form);
            if (form.id)
                await PatchAPI.updateRule(form.id, payload);
            else
                await PatchAPI.createRule(payload);
            onCreated?.();
            onClose();
        }
        catch (err) {
            setError(err);
        }
        finally {
            setBusy(false);
        }
    };
    const tabs = [...(form.id ? [] : [["templates", "Templates"]]), ["trigger", "Trigger"], ["conditions", "Conditions"], ["actions", "Actions"], ["schedule", "Schedule"], ["preview", "Preview"]];
    return (React.createElement(React.Fragment, null,
        React.createElement("div", { className: "drawer-backdrop", onClick: onClose }),
        React.createElement("div", { className: "wizard-modal", role: "dialog", "aria-modal": "true" },
            React.createElement("div", { className: "wizard-head" },
                React.createElement("div", null,
                    React.createElement("h3", null, form.id ? "Edit Rule" : "New Rule"),
                    React.createElement("p", null, "Rules create auditable task drafts; clients still only receive signed tasks.")),
                React.createElement("button", { className: "icon-btn", onClick: onClose },
                    React.createElement("span", { style: { width: 14, height: 14, display: "inline-flex" } }, Icon.close))),
            React.createElement("form", { className: "wizard-body", onSubmit: save },
                React.createElement("div", { className: "wizard-steps" }, tabs.map(([id, label]) => React.createElement("button", { type: "button", key: id, className: "wizard-step " + (step === id ? "active" : ""), onClick: () => setStep(id) },
                    React.createElement("span", null, id === step ? ">>" : "--"),
                    label))),
                React.createElement("div", { className: "wizard-panel", style: { display: "flex", flexDirection: "column", gap: 14 } },
                    step === "templates" && (React.createElement(React.Fragment, null,
                        React.createElement("div", { className: "template-market-head" },
                            React.createElement("div", null,
                                React.createElement("h4", null, "Start from template"),
                                React.createElement("p", null, "Pick a safe blueprint, fill the missing inputs, then review the disabled draft before saving.")),
                            React.createElement("div", { className: "template-head-actions" },
                                React.createElement("button", { type: "button", className: "btn", onClick: () => setTemplateImportOpen(open => !open) }, "Import config"),
                                React.createElement("button", { type: "button", className: "btn", onClick: () => setStep("trigger") }, "Blank rule"))),
                        templateImportOpen && (React.createElement("div", { className: "template-import-panel" },
                            React.createElement("label", { className: "field" },
                                React.createElement("span", null, "Template config"),
                                React.createElement("textarea", { className: "mono", value: templateImportText, onChange: e => setTemplateImportText(e.target.value), placeholder: "Paste copied 1Patch template JSON" })),
                            React.createElement("div", { className: "template-import-actions" },
                                React.createElement("button", { type: "button", className: "btn primary", disabled: busy, onClick: importTemplateConfig }, busy ? "Importing..." : "Import template"),
                                React.createElement("button", { type: "button", className: "btn", onClick: () => { setTemplateImportText(""); setTemplateImportNotice(null); } }, "Clear")),
                            templateImportNotice && React.createElement("div", { className: `template-import-notice ${templateImportNotice.ok ? "ok" : "error"}` }, templateImportNotice.text))),
                        templates.error && React.createElement(ErrorAlert, { error: templates.error, onRetry: templates.reload }),
                        React.createElement("div", { className: "template-category-row" }, templateCategories.map(category => (React.createElement("button", { type: "button", key: category, className: category === templateCategory ? "active" : "", onClick: () => { setTemplateCategory(category); const first = templateRows.find(t => t.category === category); if (first)
                                setSelectedTemplateId(first.id); } }, category)))),
                        React.createElement("div", { className: "template-market-grid" },
                            templates.loading && Array.from({ length: 4 }).map((_, i) => React.createElement("div", { className: "template-market-card", key: i },
                                React.createElement("div", { className: "skel", style: { height: 16, width: "70%" } }),
                                React.createElement("div", { className: "skel", style: { height: 42 } }))),
                            !templates.loading && templateRows.filter(t => t.category === templateCategory).map(template => (React.createElement("button", { type: "button", key: template.id, className: "template-market-card " + (selectedTemplate?.id === template.id ? "selected" : ""), onClick: () => setSelectedTemplateId(template.id) },
                                React.createElement("div", { className: "template-market-card-top" },
                                    React.createElement("strong", null, template.name),
                                    React.createElement("span", { className: "risk-badge " + template.riskLevel }, template.riskLevel)),
                                React.createElement("p", null, template.description),
                                React.createElement("div", { className: "template-badges" },
                                    React.createElement("span", null, template.recommendedSecurityMode),
                                    React.createElement("span", null, template.trigger?.type || "manual"),
                                    React.createElement("span", null,
                                        (template.requiredInputs || []).length || "no",
                                        " inputs")),
                                React.createElement("div", { className: "template-does" }, (template.explanation || []).slice(0, 3).map(item => React.createElement("em", { key: item }, item))))))),
                        selectedTemplate && (React.createElement("div", { className: "template-detail-panel" },
                            React.createElement("div", { className: "template-detail-main" },
                                React.createElement("div", { className: "template-section-title" }, "What this template does"),
                                React.createElement("ul", { className: "template-check-list" }, (selectedTemplate.explanation || []).map(item => React.createElement("li", { key: item }, item))),
                                React.createElement("div", { className: "template-section-title" }, "Safety defaults"),
                                React.createElement("ul", { className: "template-check-list" }, (selectedTemplate.safety || []).map(item => React.createElement("li", { key: item }, item)))),
                            React.createElement("div", { className: "template-input-panel" },
                                React.createElement("div", { className: "template-section-title" }, "Required inputs"),
                                (selectedTemplate.requiredInputs || []).length === 0 && React.createElement("div", { className: "muted" }, "No missing inputs. You can generate the draft now."),
                                (selectedTemplate.requiredInputs || []).map(input => (input.type === "device_group" ? (React.createElement(DeviceGroupPicker, { key: input.id, input: input, groups: deviceGroups, loading: devices.loading, value: templateInputs[input.id] ?? input.defaultValue ?? "", onChange: value => setTemplateInputs(prev => ({ ...prev, [input.id]: value })) })) : input.type === "maintenance_window" ? (React.createElement(MaintenanceWindowPicker, { key: input.id, input: input, value: templateInputs[input.id] ?? input.defaultValue, onChange: value => setTemplateInputs(prev => ({ ...prev, [input.id]: value })) })) : (React.createElement("label", { className: "field", key: input.id },
                                    React.createElement("span", null, input.label),
                                    React.createElement("input", { type: input.type === "number" ? "number" : "text", value: templateInputDisplay(templateInputs[input.id] ?? input.defaultValue ?? ""), onChange: e => setTemplateInputs(prev => ({ ...prev, [input.id]: parseTemplateInput(input, e.target.value) })), placeholder: input.description }))))),
                                React.createElement("button", { type: "button", className: "btn primary", disabled: busy, onClick: useTemplate }, busy ? "Generating..." : "Use template")))),
                        error && React.createElement(ErrorAlert, { error: error }))),
                    step === "trigger" && (React.createElement(React.Fragment, null,
                        React.createElement("div", { className: "form-grid" },
                            React.createElement("label", { className: "field" },
                                React.createElement("span", null, "Name"),
                                React.createElement("input", { required: true, value: form.name, onChange: e => set("name", e.target.value), placeholder: "Auto patch Chrome weekly" })),
                            React.createElement("label", { className: "field" },
                                React.createElement("span", null, "Tenant"),
                                React.createElement("input", { value: form.tenantId, onChange: e => set("tenantId", e.target.value || "default") })),
                            React.createElement("label", { className: "field" },
                                React.createElement("span", null, "Priority"),
                                React.createElement("input", { type: "number", value: form.priority, onChange: e => set("priority", Number(e.target.value || 100)) })),
                            React.createElement("label", { className: "field" },
                                React.createElement("span", null, "Status"),
                                React.createElement("select", { value: form.enabled ? "enabled" : "disabled", onChange: e => set("enabled", e.target.value === "enabled") },
                                    React.createElement("option", { value: "disabled" }, "Disabled"),
                                    React.createElement("option", { value: "enabled" }, "Enabled")))),
                        React.createElement("label", { className: "field" },
                            React.createElement("span", null, "Description"),
                            React.createElement("input", { value: form.description, onChange: e => set("description", e.target.value), placeholder: "Weekly low-risk browser patch policy" })),
                        React.createElement("div", { className: "form-grid" },
                            React.createElement("label", { className: "field" },
                                React.createElement("span", null, "Trigger"),
                                React.createElement("select", { value: form.triggerType, onChange: e => set("triggerType", e.target.value) },
                                    React.createElement("option", { value: "manual" }, "Manual"),
                                    React.createElement("option", { value: "schedule" }, "Schedule"),
                                    React.createElement("option", { value: "event" }, "Event"))),
                            form.triggerType === "event" && React.createElement("label", { className: "field" },
                                React.createElement("span", null, "Event"),
                                React.createElement("select", { value: form.eventType, onChange: e => set("eventType", e.target.value) },
                                    React.createElement("option", { value: "device.inventory.updated" }, "device.inventory.updated"),
                                    React.createElement("option", { value: "task.failed" }, "task.failed"),
                                    React.createElement("option", { value: "vulnerability.detected" }, "vulnerability.detected"),
                                    React.createElement("option", { value: "package.high_priority.detected" }, "package.high_priority.detected"),
                                    React.createElement("option", { value: "task.security_scan.completed" }, "task.security_scan.completed"),
                                    React.createElement("option", { value: "rule.task_candidate.created" }, "rule.task_candidate.created"))),
                            form.triggerType === "schedule" && React.createElement("label", { className: "field" },
                                React.createElement("span", null, "Cron"),
                                React.createElement("input", { value: form.cron, onChange: e => set("cron", e.target.value), placeholder: "0 2 * * 0" }))))),
                    step === "conditions" && (React.createElement(React.Fragment, null,
                        React.createElement("div", { className: "segmented" },
                            React.createElement("button", { type: "button", className: form.combinator === "AND" ? "active" : "", onClick: () => set("combinator", "AND") }, "AND"),
                            React.createElement("button", { type: "button", className: form.combinator === "OR" ? "active" : "", onClick: () => set("combinator", "OR") }, "OR")),
                        form.conditions.map((condition, index) => (React.createElement("div", { className: "form-grid", key: index },
                            React.createElement("label", { className: "field" },
                                React.createElement("span", null, "Field"),
                                React.createElement("select", { value: condition.field, onChange: e => updateCondition(setForm, index, { field: e.target.value }) }, conditionFields.map(f => React.createElement("option", { key: f, value: f }, f)))),
                            React.createElement("label", { className: "field" },
                                React.createElement("span", null, "Operator"),
                                React.createElement("select", { value: condition.operator, onChange: e => updateCondition(setForm, index, { operator: e.target.value }) }, conditionOperators.map(o => React.createElement("option", { key: o, value: o }, o)))),
                            React.createElement("label", { className: "field" },
                                React.createElement("span", null, "Value"),
                                React.createElement("input", { value: String(condition.value), onChange: e => updateCondition(setForm, index, { value: parseConditionValue(e.target.value) }) })),
                            React.createElement("button", { type: "button", className: "btn sm", onClick: () => removeCondition(setForm, index) }, "Remove")))),
                        React.createElement("button", { type: "button", className: "btn", onClick: () => set("conditions", [...form.conditions, { field: "device.os", operator: "eq", value: "windows" }]) },
                            React.createElement("span", { style: { width: 14, height: 14, display: "inline-flex" } }, Icon.plus),
                            "Add condition"))),
                    step === "actions" && (React.createElement(React.Fragment, null,
                        React.createElement("div", { className: "form-grid" },
                            React.createElement("label", { className: "field" },
                                React.createElement("span", null, "Action"),
                                React.createElement("select", { value: form.actionType, onChange: e => set("actionType", e.target.value) },
                                    React.createElement("option", { value: "create_patch_task" }, "Create patch task"),
                                    React.createElement("option", { value: "create_security_task" }, "Create security task"),
                                    React.createElement("option", { value: "notify" }, "Notify SIEM"),
                                    React.createElement("option", { value: "mark_device" }, "Mark device"),
                                    React.createElement("option", { value: "block_task_creation" }, "Block task creation"))),
                            form.actionType === "create_patch_task" && React.createElement("label", { className: "field" },
                                React.createElement("span", null, "Patch mode"),
                                React.createElement("select", { value: form.patchMode, onChange: e => set("patchMode", e.target.value) },
                                    React.createElement("option", { value: "all_outdated" }, "All outdated packages"),
                                    React.createElement("option", { value: "specific_package" }, "Specific package"))),
                            form.actionType === "create_patch_task" && form.patchMode === "specific_package" && React.createElement("label", { className: "field" },
                                React.createElement("span", null, "Package"),
                                React.createElement("input", { value: form.packageName, onChange: e => set("packageName", e.target.value), placeholder: "Google Chrome, Microsoft Edge" })),
                            form.actionType === "create_patch_task" && React.createElement("label", { className: "field" },
                                React.createElement("span", null, "Target version"),
                                React.createElement("input", { value: form.targetVersion, onChange: e => set("targetVersion", e.target.value || "latest") })),
                            form.actionType === "create_security_task" && React.createElement("label", { className: "field" },
                                React.createElement("span", null, "Security task"),
                                React.createElement("select", { value: form.securityTask, onChange: e => set("securityTask", e.target.value) },
                                    React.createElement("option", { value: "refresh_inventory" }, "Refresh inventory"))),
                            form.actionType === "notify" && React.createElement("label", { className: "field" },
                                React.createElement("span", null, "Message"),
                                React.createElement("input", { value: form.notifyMessage, onChange: e => set("notifyMessage", e.target.value) })),
                            form.actionType === "mark_device" && React.createElement("label", { className: "field" },
                                React.createElement("span", null, "Tag"),
                                React.createElement("input", { value: form.tag, onChange: e => set("tag", e.target.value), placeholder: "needs-review" })),
                            form.actionType === "block_task_creation" && React.createElement("label", { className: "field" },
                                React.createElement("span", null, "Reason"),
                                React.createElement("input", { value: form.blockReason, onChange: e => set("blockReason", e.target.value), placeholder: "Unsafe automation candidate" }))),
                        React.createElement("div", { className: "success-card" },
                            React.createElement("strong", null, "Safety boundary"),
                            React.createElement("span", null, "No action can run commands, hide tasks, disable the kill switch, skip SIEM, or bypass scan, approval, signing, ledger, and delay gates.")))),
                    step === "schedule" && (React.createElement("div", { className: "form-grid" },
                        React.createElement("label", { className: "field" },
                            React.createElement("span", null, "Maintenance start UTC"),
                            React.createElement("input", { type: "number", min: "0", max: "23", value: form.startHourUtc, onChange: e => set("startHourUtc", Number(e.target.value || 0)) })),
                        React.createElement("label", { className: "field" },
                            React.createElement("span", null, "Maintenance end UTC"),
                            React.createElement("input", { type: "number", min: "1", max: "24", value: form.endHourUtc, onChange: e => set("endHourUtc", Number(e.target.value || 24)) })),
                        React.createElement("label", { className: "field" },
                            React.createElement("span", null, "Safe mode approval risk"),
                            React.createElement("input", { type: "number", min: "0", max: "100", value: form.requireApprovalAtRiskScore, onChange: e => set("requireApprovalAtRiskScore", Number(e.target.value || 60)) })))),
                    step === "preview" && (React.createElement(React.Fragment, null,
                        templatePreview && React.createElement("div", { className: "template-preview-box" },
                            React.createElement("strong", null, "Review before saving"),
                            React.createElement("ul", null, (templatePreview.summary || []).map(item => React.createElement("li", { key: item }, item))),
                            React.createElement("span", null,
                                "Estimated affected devices: ",
                                templatePreview.estimatedAffectedDevices ?? "unknown",
                                " \u00B7 Risk: ",
                                templatePreview.riskLevel,
                                " \u00B7 Mode: ",
                                templatePreview.securityMode)),
                        React.createElement("div", { className: "success-card" },
                            React.createElement("strong", null, form.name || "Untitled rule"),
                            React.createElement("span", null,
                                form.triggerType,
                                " trigger \u00B7 ",
                                form.combinator,
                                " conditions \u00B7 ",
                                actionSummary(rulePayload(form).actions[0]))),
                        React.createElement("pre", { className: "mono", style: { whiteSpace: "pre-wrap", maxHeight: 260, overflow: "auto", background: "var(--bg-sub)", border: "1px solid var(--line)", padding: 12, borderRadius: 6 } }, JSON.stringify(rulePayload(form), null, 2)))),
                    error && React.createElement(ErrorAlert, { error: error }),
                    React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 } },
                        React.createElement("button", { type: "button", className: "btn", onClick: onClose }, "Cancel"),
                        React.createElement("button", { className: "btn primary", disabled: busy || !form.name.trim() }, busy ? "Saving..." : "Save rule")))))));
}
/**
 * Renders the rule tester UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function RuleTester({ rule, onClose, onExecuted }) {
    const devices = useResource(() => PatchAPI.devices());
    const [deviceId, setDeviceId] = useState("");
    const [result, setResult] = useState(null);
    const [busy, setBusy] = useState("");
    const sampleId = deviceId || devices.data?.[0]?.id || "";
    /**
     * Handles the test operation.
     */
    const test = async () => { setBusy("test"); try {
        setResult(await PatchAPI.testRule(rule.id, { deviceId: sampleId }));
    }
    finally {
        setBusy("");
    } };
    /**
     * Handles the run operation.
     */
    const run = async () => { setBusy("run"); try {
        setResult({ executed: await PatchAPI.triggerRule(rule.id, { deviceId: sampleId }) });
        onExecuted?.();
    }
    finally {
        setBusy("");
    } };
    return (React.createElement(React.Fragment, null,
        React.createElement("div", { className: "drawer-backdrop", onClick: onClose }),
        React.createElement("div", { className: "output-dialog" },
            React.createElement("div", { className: "output-dialog-box" },
                React.createElement("div", { className: "output-dialog-head" },
                    React.createElement("h3", null, "Test Rule"),
                    React.createElement("button", { className: "icon-btn", onClick: onClose }, Icon.close)),
                React.createElement("div", { style: { padding: 16, display: "flex", flexDirection: "column", gap: 14 } },
                    React.createElement("label", { className: "field" },
                        React.createElement("span", null, "Sample device"),
                        React.createElement("select", { value: sampleId, onChange: e => setDeviceId(e.target.value) }, (devices.data || []).map(d => React.createElement("option", { key: d.id, value: d.id }, d.hostname || d.id)))),
                    React.createElement("div", { style: { display: "flex", gap: 8 } },
                        React.createElement("button", { className: "btn primary", onClick: test, disabled: !sampleId || busy }, busy === "test" ? "Testing..." : "Test rule"),
                        React.createElement("button", { className: "btn", onClick: run, disabled: !sampleId || busy }, "Manual trigger")),
                    result && !result.executed && React.createElement("div", { className: "success-card" },
                        React.createElement("strong", null, result.wouldTrigger ? "Would trigger" : "Would not trigger"),
                        React.createElement("span", null,
                            "Risk ",
                            result.riskScore,
                            "/100 \u00B7 ",
                            (result.actions || []).reduce((n, a) => n + (a.taskDrafts || []).length, 0),
                            " task draft(s) \u00B7 ",
                            result.approvalRequired ? "approval required" : "standard pipeline")),
                    result?.executed && React.createElement("div", { className: "success-card" },
                        React.createElement("strong", null, "Manual trigger submitted"),
                        React.createElement("span", null,
                            result.executed.length,
                            " execution record(s) created.")),
                    result && React.createElement("pre", { className: "mono", style: { whiteSpace: "pre-wrap", maxHeight: 300, overflow: "auto", background: "var(--bg-sub)", border: "1px solid var(--line)", padding: 12, borderRadius: 6 } }, JSON.stringify(result, null, 2)))))));
}
const conditionFields = ["device.os", "device.hostname", "device.group", "device.tag", "device.deviceTrustScore", "device.lastInventoryAgeHours", "package.outdated", "package.name", "package.severity", "package.version", "lastTask.failed", "lastTask.retryCount", "lastTask.failureRetryable", "currentTime.maintenanceWindow", "riskScore", "task.sourceHostTrusted", "task.hashPresent"];
const conditionOperators = ["eq", "neq", "contains", "matches", "lt", "lte", "gt", "gte", "in"];
/**
 * Handles the with template defaults operation.
 *
 * @param template template supplied to the function.
 * @param values values supplied to the function.
 * @param tenantId Identifier used to locate the target record.
 * @returns The result produced by the operation.
 */
function withTemplateDefaults(template, values, tenantId) {
    const out = { ...values, tenantId };
    (template.requiredInputs || []).forEach(input => {
        if (out[input.id] === undefined || out[input.id] === "")
            out[input.id] = input.defaultValue;
    });
    return out;
}
/**
 * Handles the template input display operation.
 *
 * @param value Value to read, render, or store.
 * @returns The result produced by the operation.
 */
function templateInputDisplay(value) {
    if (value && typeof value === "object") {
        if (Number.isFinite(value.startHourUtc) && Number.isFinite(value.endHourUtc))
            return `${value.startHourUtc}-${value.endHourUtc}`;
        return JSON.stringify(value);
    }
    return value ?? "";
}
/**
 * Parses template input input.
 *
 * @param input input supplied to the function.
 * @param value Value to read, render, or store.
 * @returns The result produced by the operation.
 */
function parseTemplateInput(input, value) {
    if (input.type === "number")
        return Number(value || 0);
    if (input.type === "maintenance_window") {
        const match = String(value).match(/(\d{1,2})\D+(\d{1,2})/);
        return { daysOfWeek: [0], startHourUtc: match ? Number(match[1]) : 3, endHourUtc: match ? Number(match[2]) : 5 };
    }
    return value;
}
/**
 * Builds the device group options payload.
 *
 * @param devices devices supplied to the function.
 * @returns The result produced by the operation.
 */
function buildDeviceGroupOptions(devices) {
    const groups = new Map();
    for (const device of devices || []) {
        const name = device.group || "ungrouped";
        const current = groups.get(name) || { name, count: 0, online: 0, windows: 0, linux: 0, tags: new Set(), samples: [] };
        const platform = device.platform || (/(windows|win)/i.test(device.os || "") ? "windows" : /(linux|ubuntu|debian|rhel|fedora|suse)/i.test(device.os || "") ? "linux" : "other");
        current.count += 1;
        current.online += device.online ? 1 : 0;
        current.windows += platform === "windows" ? 1 : 0;
        current.linux += platform === "linux" ? 1 : 0;
        (device.tags || []).forEach(tag => current.tags.add(tag));
        if (current.samples.length < 3)
            current.samples.push(device.hostname || device.id);
        groups.set(name, current);
    }
    return [...groups.values()].map(group => ({ ...group, tags: [...group.tags].sort() })).sort((a, b) => a.name.localeCompare(b.name));
}
/**
 * Renders the group select UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function GroupSelect({ groups, value, onChange }) {
    const [query, setQuery] = useState(value || "");
    const matches = groups.filter(group => textMatches(query, [group.name, ...group.samples, ...group.tags])).slice(0, 8);
    useEffect(() => setQuery(value || ""), [value]);
    return (React.createElement("div", { className: "group-select" },
        React.createElement("div", { className: "group-select-search" },
            React.createElement("span", { style: { width: 14, height: 14, display: "inline-flex" } }, Icon.search),
            React.createElement("input", { value: query, onChange: e => setQuery(e.target.value), placeholder: "Search groups..." })),
        React.createElement("div", { className: "group-option-list" },
            matches.map(group => (React.createElement("button", { type: "button", key: group.name, className: "group-option " + (value === group.name ? "selected" : ""), onClick: () => { onChange(group.name); setQuery(group.name); } },
                React.createElement("strong", null, group.name),
                React.createElement("span", null,
                    group.count,
                    " devices \u00B7 ",
                    group.online,
                    " online"),
                React.createElement("em", null, group.samples.join(", ") || "No sample devices")))),
            matches.length === 0 && query.trim() && (React.createElement("button", { type: "button", className: "group-option create", onClick: () => onChange(query.trim()) },
                React.createElement("strong", null,
                    "Create \"",
                    query.trim(),
                    "\""),
                React.createElement("span", null, "Use this new group name"))))));
}
/**
 * Renders the device group picker UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function DeviceGroupPicker({ input, groups, loading, value, onChange }) {
    return (React.createElement("div", { className: "field" },
        React.createElement("span", null, input.label),
        loading ? React.createElement("div", { className: "skel", style: { height: 42, borderRadius: 6 } }) : React.createElement(GroupSelect, { groups: groups, value: value, onChange: onChange }),
        React.createElement("small", { className: "field-hint" }, groups.length ? "Search and select an existing device group, or type a new one." : "No groups found yet. Add or enroll devices to build group options.")));
}
/**
 * Renders the maintenance window picker UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function MaintenanceWindowPicker({ input, value, onChange }) {
    const current = value && typeof value === "object" ? value : { daysOfWeek: [0], startHourUtc: 3, endHourUtc: 5 };
    const selectedDays = new Set(current.daysOfWeek?.length ? current.daysOfWeek : [0]);
    /**
     * Sets the day value.
     *
     * @param day day supplied to the function.
     */
    const setDay = (day) => {
        const next = new Set(selectedDays);
        next.has(day) ? next.delete(day) : next.add(day);
        onChange({ ...current, daysOfWeek: [...next].sort((a, b) => a - b) });
    };
    /**
     * Sets the hour value.
     *
     * @param key key supplied to the function.
     * @param raw raw supplied to the function.
     */
    const setHour = (key, raw) => {
        const hour = Math.max(0, Math.min(key === "endHourUtc" ? 24 : 23, Number(raw)));
        const next = { ...current, [key]: hour };
        if (next.endHourUtc <= next.startHourUtc) {
            if (key === "startHourUtc")
                next.endHourUtc = Math.min(24, next.startHourUtc + 1);
            else
                next.startHourUtc = Math.max(0, next.endHourUtc - 1);
        }
        onChange(next);
    };
    const presets = [
        ["sun-3-5", "Sun 03-05", { daysOfWeek: [0], startHourUtc: 3, endHourUtc: 5 }],
        ["sat-sun-2-6", "Weekend 02-06", { daysOfWeek: [0, 6], startHourUtc: 2, endHourUtc: 6 }],
        ["daily-1-3", "Daily 01-03", { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startHourUtc: 1, endHourUtc: 3 }],
    ];
    return (React.createElement("div", { className: "field maintenance-picker" },
        React.createElement("span", null, input.label),
        React.createElement("div", { className: "maintenance-presets" }, presets.map(([id, label, preset]) => React.createElement("button", { type: "button", key: id, onClick: () => onChange(preset) }, label))),
        React.createElement("div", { className: "dow-picker" }, ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, day) => (React.createElement("button", { type: "button", key: label, className: selectedDays.has(day) ? "active" : "", onClick: () => setDay(day) }, label)))),
        React.createElement("div", { className: "time-range" },
            React.createElement("label", null,
                React.createElement("span", null, "Start"),
                React.createElement("select", { value: current.startHourUtc, onChange: e => setHour("startHourUtc", e.target.value) }, hourOptions(0, 23))),
            React.createElement("label", null,
                React.createElement("span", null, "End"),
                React.createElement("select", { value: current.endHourUtc, onChange: e => setHour("endHourUtc", e.target.value) }, hourOptions(1, 24)))),
        React.createElement("div", { className: "window-summary" },
            "UTC window \u00B7 ",
            daysLabel([...selectedDays]),
            " \u00B7 ",
            formatHour(current.startHourUtc),
            "-",
            formatHour(current.endHourUtc)),
        React.createElement("small", { className: "field-hint" }, "Tasks are still delayed, scanned, approved, and signed by policy before dispatch.")));
}
/**
 * Handles the hour options operation.
 *
 * @param min min supplied to the function.
 * @param max max supplied to the function.
 * @returns The result produced by the operation.
 */
function hourOptions(min, max) {
    const items = [];
    for (let hour = min; hour <= max; hour++)
        items.push(React.createElement("option", { key: hour, value: hour }, formatHour(hour)));
    return items;
}
/**
 * Formats the hour value.
 *
 * @param hour hour supplied to the function.
 * @returns The result produced by the operation.
 */
function formatHour(hour) {
    return `${String(hour).padStart(2, "0")}:00`;
}
/**
 * Handles the days label operation.
 *
 * @param days Number of days to include in the range.
 * @returns The result produced by the operation.
 */
function daysLabel(days) {
    if (days.length === 7)
        return "Daily";
    return days.map(day => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day]).join(", ");
}
/**
 * Handles the client rule draft from template operation.
 *
 * @param template template supplied to the function.
 * @param inputs inputs supplied to the function.
 * @param tenantId Identifier used to locate the target record.
 * @returns The result produced by the operation.
 */
function clientRuleDraftFromTemplate(template, inputs, tenantId) {
    const rule = {
        id: undefined,
        tenantId,
        name: template.name,
        description: `${template.description}\n\nCreated from template: ${template.name}`,
        enabled: false,
        priority: 100,
        trigger: template.trigger || { type: "manual" },
        conditionGroup: replaceTemplateValues(template.conditions || { combinator: "AND", conditions: [] }, inputs),
        actions: (template.actions || []).map(action => replaceTemplateValues(action, inputs)),
        schedule: { ...(template.schedule || {}), maintenanceWindow: inputs.maintenanceWindow || template.schedule?.maintenanceWindow },
        safeMode: { enabled: true, requireApprovalAtRiskScore: template.recommendedSecurityMode === "tinfoil" ? 40 : template.recommendedSecurityMode === "strict" ? 50 : 60 },
        sourceTemplateId: template.id,
        sourceTemplateName: template.name,
    };
    return {
        draftRule: rule,
        preview: {
            summary: [`target devices in group ${inputs.targetDeviceGroup || "selected group"}`, ...(template.explanation || []), "start disabled for review before saving", "use the normal task security pipeline"],
            estimatedAffectedDevices: null,
            riskLevel: template.riskLevel || "medium",
            requiredApprovals: ["tenant policy"],
            securityMode: template.recommendedSecurityMode || "normal",
        },
    };
}
/**
 * Handles the replace template values operation.
 *
 * @param value Value to read, render, or store.
 * @param inputs inputs supplied to the function.
 * @returns The result produced by the operation.
 */
function replaceTemplateValues(value, inputs) {
    if (typeof value === "string" && value.startsWith("$input."))
        return inputs[value.slice(7)];
    if (Array.isArray(value))
        return value.map(item => replaceTemplateValues(item, inputs));
    if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, replaceTemplateValues(nested, inputs)]));
    return value;
}
const DASHBOARD_BROWSER_PACKAGES = ["Google Chrome", "Microsoft Edge", "Mozilla Firefox"];
const DASHBOARD_DEV_PACKAGES = ["Visual Studio Code", "Git", "Node.js"];
const DASHBOARD_COLLAB_PACKAGES = ["Microsoft Teams", "Zoom", "Slack"];
const DASHBOARD_GROUP_INPUT = { id: "targetDeviceGroup", label: "Target device group", type: "device_group", required: true, description: "Device group the generated rule should target." };
const DASHBOARD_PACKAGE_INPUT = { id: "packageName", label: "Package name", type: "package_name", required: true, description: "Exact package/app name this rule is allowed to patch.", defaultValue: "Google Chrome" };
const DASHBOARD_WINDOW_INPUT = { id: "maintenanceWindow", label: "Maintenance window", type: "maintenance_window", required: true, description: "UTC window in which scheduled patch tasks may be created.", defaultValue: { daysOfWeek: [0], startHourUtc: 3, endHourUtc: 5 } };
const DASHBOARD_MAX_DEVICES_INPUT = { id: "maxDevices", label: "Max devices per run", type: "number", required: true, description: "Upper bound for task drafts created by one rule execution.", defaultValue: 10 };
const DASHBOARD_RETRY_LIMIT_INPUT = { id: "retryLimit", label: "Retry limit", type: "number", required: true, description: "Maximum retry attempts before escalation.", defaultValue: 2 };
const DASHBOARD_RULE_TEMPLATES = [
    { id: "weekly-browser-updates", name: "Weekly Browser Updates", description: "Patch only Chrome, Edge, and Firefox on Windows during a maintenance window.", category: "Recommended", recommendedSecurityMode: "strict", riskLevel: "medium", tags: ["browser", "windows", "weekly"], trigger: { type: "schedule" }, schedule: { cron: "0 3 * * 0", timezone: "UTC", maintenanceWindow: { daysOfWeek: [0], startHourUtc: 3, endHourUtc: 5 } }, conditions: { combinator: "AND", conditions: [{ field: "device.group", operator: "eq", value: "$input.targetDeviceGroup" }, { field: "device.os", operator: "eq", value: "windows" }, { field: "package.name", operator: "in", value: DASHBOARD_BROWSER_PACKAGES }, { field: "package.outdated", operator: "eq", value: true }, { field: "currentTime.maintenanceWindow", operator: "eq", value: true }] }, actions: [{ type: "create_patch_task", mode: "specific_package", packageNames: DASHBOARD_BROWSER_PACKAGES, targetVersion: "latest", maxDevices: "$input.maxDevices" }], requiredInputs: [DASHBOARD_GROUP_INPUT, DASHBOARD_WINDOW_INPUT, { ...DASHBOARD_MAX_DEVICES_INPUT, defaultValue: 25 }], explanation: ["patch only Chrome, Edge, and Firefox packages", "skip browsers that are already current", "use delayed execution and security scanning before dispatch"], safety: ["specific package allow-list", "maintenance window required", "disabled by default"] },
    { id: "critical-patch-fast-track", name: "Critical Patch Fast Track", description: "Fast-track one named critical package outside production while preserving approval gates.", category: "Recommended", recommendedSecurityMode: "tinfoil", riskLevel: "high", tags: ["critical", "vulnerability", "approval"], trigger: { type: "event", eventType: "vulnerability.detected" }, schedule: {}, conditions: { combinator: "AND", conditions: [{ field: "device.group", operator: "neq", value: "production" }, { field: "package.name", operator: "eq", value: "$input.packageName" }, { field: "package.severity", operator: "eq", value: "critical" }, { field: "package.outdated", operator: "eq", value: true }] }, actions: [{ type: "create_patch_task", mode: "specific_package", packageName: "$input.packageName", targetVersion: "latest", maxDevices: "$input.maxDevices" }, { type: "notify", channel: "siem", message: "Critical package fast-track draft created" }], requiredInputs: [DASHBOARD_PACKAGE_INPUT, DASHBOARD_MAX_DEVICES_INPUT], explanation: ["patch only the named critical package", "exclude production by default", "send a SIEM notification"], safety: ["specific package required", "MFA approval applies through tenant policy", "small max-device cap"] },
    { id: "patch-test-group-first", name: "Patch Test Group First", description: "Patch all outdated packages only in the test group before any wider rollout.", category: "Recommended", recommendedSecurityMode: "strict", riskLevel: "low", tags: ["test-first", "patch", "pilot"], trigger: { type: "schedule" }, schedule: { cron: "0 2 * * 0", timezone: "UTC", maintenanceWindow: { daysOfWeek: [0], startHourUtc: 2, endHourUtc: 5 } }, conditions: { combinator: "AND", conditions: [{ field: "device.group", operator: "eq", value: "test" }, { field: "package.outdated", operator: "eq", value: true }, { field: "currentTime.maintenanceWindow", operator: "eq", value: true }] }, actions: [{ type: "create_patch_task", mode: "all_outdated", targetVersion: "latest", maxDevices: 10 }], requiredInputs: [], explanation: ["patch only the hard-coded test ring", "allow broader all-outdated coverage only in that pilot ring"], safety: ["no production devices affected", "max 10 devices per run", "disabled by default"] },
    { id: "chrome-zero-day-response", name: "Chrome Zero-Day Response", description: "Create capped Chrome patch drafts when a high-priority browser issue is detected.", category: "Patch Automation", recommendedSecurityMode: "tinfoil", riskLevel: "high", tags: ["browser", "zero-day", "chrome"], trigger: { type: "event", eventType: "package.high_priority.detected" }, schedule: {}, conditions: { combinator: "AND", conditions: [{ field: "device.os", operator: "eq", value: "windows" }, { field: "package.name", operator: "eq", value: "Google Chrome" }, { field: "package.outdated", operator: "eq", value: true }] }, actions: [{ type: "create_patch_task", mode: "specific_package", packageName: "Google Chrome", targetVersion: "latest", maxDevices: 10 }, { type: "notify", channel: "siem", message: "Chrome high-priority patch draft created" }], requiredInputs: [], explanation: ["patch only Google Chrome", "react to high-priority package events", "notify SIEM"], safety: ["specific package only", "max 10 devices per execution", "high-risk approvals apply"] },
    { id: "microsoft-edge-stable-ring", name: "Microsoft Edge Stable Ring", description: "Patch Edge on a named Windows device group during a weekly window.", category: "Patch Automation", recommendedSecurityMode: "strict", riskLevel: "medium", tags: ["browser", "edge", "windows"], trigger: { type: "schedule" }, schedule: { cron: "30 3 * * 0", timezone: "UTC", maintenanceWindow: { daysOfWeek: [0], startHourUtc: 3, endHourUtc: 5 } }, conditions: { combinator: "AND", conditions: [{ field: "device.group", operator: "eq", value: "$input.targetDeviceGroup" }, { field: "device.os", operator: "eq", value: "windows" }, { field: "package.name", operator: "eq", value: "Microsoft Edge" }, { field: "package.outdated", operator: "eq", value: true }, { field: "currentTime.maintenanceWindow", operator: "eq", value: true }] }, actions: [{ type: "create_patch_task", mode: "specific_package", packageName: "Microsoft Edge", targetVersion: "latest", maxDevices: "$input.maxDevices" }], requiredInputs: [DASHBOARD_GROUP_INPUT, DASHBOARD_WINDOW_INPUT, { ...DASHBOARD_MAX_DEVICES_INPUT, defaultValue: 20 }], explanation: ["patch only Microsoft Edge", "limit rollout to the selected group"], safety: ["specific package only", "maintenance window required", "device cap required"] },
    { id: "firefox-maintenance-ring", name: "Firefox Maintenance Ring", description: "Patch Firefox on a selected endpoint ring without touching other apps.", category: "Patch Automation", recommendedSecurityMode: "strict", riskLevel: "medium", tags: ["browser", "firefox"], trigger: { type: "schedule" }, schedule: { cron: "0 4 * * 0", timezone: "UTC", maintenanceWindow: { daysOfWeek: [0], startHourUtc: 4, endHourUtc: 6 } }, conditions: { combinator: "AND", conditions: [{ field: "device.group", operator: "eq", value: "$input.targetDeviceGroup" }, { field: "package.name", operator: "eq", value: "Mozilla Firefox" }, { field: "package.outdated", operator: "eq", value: true }, { field: "currentTime.maintenanceWindow", operator: "eq", value: true }] }, actions: [{ type: "create_patch_task", mode: "specific_package", packageName: "Mozilla Firefox", targetVersion: "latest", maxDevices: "$input.maxDevices" }], requiredInputs: [DASHBOARD_GROUP_INPUT, DASHBOARD_WINDOW_INPUT, { ...DASHBOARD_MAX_DEVICES_INPUT, defaultValue: 20 }], explanation: ["patch only Mozilla Firefox", "skip unrelated outdated software"], safety: ["specific package only", "disabled by default"] },
    { id: "developer-tooling-weekly", name: "Developer Tooling Weekly", description: "Patch VS Code, Git, and Node.js on developer workstations.", category: "Patch Automation", recommendedSecurityMode: "strict", riskLevel: "medium", tags: ["developer", "tooling", "weekly"], trigger: { type: "schedule" }, schedule: { cron: "0 5 * * 6", timezone: "UTC", maintenanceWindow: { daysOfWeek: [6], startHourUtc: 5, endHourUtc: 8 } }, conditions: { combinator: "AND", conditions: [{ field: "device.group", operator: "eq", value: "$input.targetDeviceGroup" }, { field: "package.name", operator: "in", value: DASHBOARD_DEV_PACKAGES }, { field: "package.outdated", operator: "eq", value: true }, { field: "currentTime.maintenanceWindow", operator: "eq", value: true }] }, actions: [{ type: "create_patch_task", mode: "specific_package", packageNames: DASHBOARD_DEV_PACKAGES, targetVersion: "latest", maxDevices: "$input.maxDevices" }], requiredInputs: [DASHBOARD_GROUP_INPUT, { ...DASHBOARD_WINDOW_INPUT, defaultValue: { daysOfWeek: [6], startHourUtc: 5, endHourUtc: 8 } }, { ...DASHBOARD_MAX_DEVICES_INPUT, defaultValue: 15 }], explanation: ["patch only common developer tools", "avoid broad workstation updates"], safety: ["specific package allow-list", "weekend maintenance default"] },
    { id: "collaboration-app-weekly", name: "Collaboration Apps Weekly", description: "Patch Teams, Zoom, and Slack on office endpoints.", category: "Patch Automation", recommendedSecurityMode: "strict", riskLevel: "medium", tags: ["collaboration", "teams", "zoom", "slack"], trigger: { type: "schedule" }, schedule: { cron: "0 4 * * 6", timezone: "UTC", maintenanceWindow: { daysOfWeek: [6], startHourUtc: 4, endHourUtc: 7 } }, conditions: { combinator: "AND", conditions: [{ field: "device.group", operator: "eq", value: "$input.targetDeviceGroup" }, { field: "package.name", operator: "in", value: DASHBOARD_COLLAB_PACKAGES }, { field: "package.outdated", operator: "eq", value: true }, { field: "currentTime.maintenanceWindow", operator: "eq", value: true }] }, actions: [{ type: "create_patch_task", mode: "specific_package", packageNames: DASHBOARD_COLLAB_PACKAGES, targetVersion: "latest", maxDevices: "$input.maxDevices" }], requiredInputs: [DASHBOARD_GROUP_INPUT, { ...DASHBOARD_WINDOW_INPUT, defaultValue: { daysOfWeek: [6], startHourUtc: 4, endHourUtc: 7 } }, { ...DASHBOARD_MAX_DEVICES_INPUT, defaultValue: 20 }], explanation: ["patch only Teams, Zoom, and Slack", "keep unrelated apps out of scope"], safety: ["specific package allow-list", "maintenance window required"] },
    { id: "vpn-client-maintenance", name: "VPN Client Maintenance", description: "Patch one VPN client package on remote-user devices.", category: "Patch Automation", recommendedSecurityMode: "tinfoil", riskLevel: "high", tags: ["vpn", "remote-access"], trigger: { type: "schedule" }, schedule: { cron: "0 2 * * 6", timezone: "UTC", maintenanceWindow: { daysOfWeek: [6], startHourUtc: 2, endHourUtc: 4 } }, conditions: { combinator: "AND", conditions: [{ field: "device.group", operator: "eq", value: "$input.targetDeviceGroup" }, { field: "package.name", operator: "eq", value: "$input.packageName" }, { field: "package.outdated", operator: "eq", value: true }, { field: "currentTime.maintenanceWindow", operator: "eq", value: true }] }, actions: [{ type: "create_patch_task", mode: "specific_package", packageName: "$input.packageName", targetVersion: "latest", maxDevices: "$input.maxDevices" }, { type: "notify", channel: "siem", message: "VPN client patch draft created" }], requiredInputs: [DASHBOARD_GROUP_INPUT, { ...DASHBOARD_PACKAGE_INPUT, defaultValue: "FortiClient VPN" }, { ...DASHBOARD_WINDOW_INPUT, defaultValue: { daysOfWeek: [6], startHourUtc: 2, endHourUtc: 4 } }, { ...DASHBOARD_MAX_DEVICES_INPUT, defaultValue: 10 }], explanation: ["patch only the named VPN client", "notify security monitoring"], safety: ["specific package required", "high-risk approvals apply"] },
    { id: "refresh-inventory-daily", name: "Refresh Inventory Daily", description: "Refresh stale device inventory once per day.", category: "Security / Inventory", recommendedSecurityMode: "normal", riskLevel: "low", tags: ["inventory", "daily"], trigger: { type: "schedule" }, schedule: { cron: "0 1 * * *", timezone: "UTC" }, conditions: { combinator: "AND", conditions: [{ field: "device.group", operator: "eq", value: "$input.targetDeviceGroup" }, { field: "device.lastInventoryAgeHours", operator: "gt", value: 24 }] }, actions: [{ type: "create_security_task", task: "refresh_inventory" }], requiredInputs: [DASHBOARD_GROUP_INPUT], explanation: ["refresh inventory for devices whose data should stay current"], safety: ["low risk", "uses supported signed refresh task"] },
    { id: "inventory-before-maintenance", name: "Inventory Before Maintenance", description: "Refresh stale inventory shortly before a patch window.", category: "Security / Inventory", recommendedSecurityMode: "normal", riskLevel: "low", tags: ["inventory", "preflight"], trigger: { type: "schedule" }, schedule: { cron: "0 0 * * 0", timezone: "UTC" }, conditions: { combinator: "AND", conditions: [{ field: "device.group", operator: "eq", value: "$input.targetDeviceGroup" }, { field: "device.lastInventoryAgeHours", operator: "gt", value: 12 }] }, actions: [{ type: "create_security_task", task: "refresh_inventory" }], requiredInputs: [DASHBOARD_GROUP_INPUT], explanation: ["refresh stale inventory before patch decisions are made"], safety: ["no package update action", "uses signed inventory task"] },
    { id: "low-trust-inventory-refresh", name: "Low-Trust Inventory Refresh", description: "Refresh and tag devices whose trust score drops below a review threshold.", category: "Security / Inventory", recommendedSecurityMode: "strict", riskLevel: "low", tags: ["trust", "inventory", "review"], trigger: { type: "event", eventType: "device.inventory.updated" }, schedule: {}, conditions: { combinator: "AND", conditions: [{ field: "device.deviceTrustScore", operator: "lt", value: 60 }] }, actions: [{ type: "create_security_task", task: "refresh_inventory" }, { type: "mark_device", tag: "trust-review" }, { type: "notify", channel: "siem", message: "Low-trust device inventory refresh requested" }], requiredInputs: [], explanation: ["refresh questionable inventory", "tag the device for review", "notify SIEM"], safety: ["no package execution action", "metadata tag only"] },
    { id: "retry-failed-updates", name: "Retry Failed Package Update", description: "Retry one named package after a transient failure with capped exponential backoff.", category: "Failure Handling", recommendedSecurityMode: "strict", riskLevel: "medium", tags: ["retry", "failed-task", "specific-package"], trigger: { type: "event", eventType: "task.failed" }, schedule: {}, conditions: { combinator: "AND", conditions: [{ field: "lastTask.failed", operator: "eq", value: true }, { field: "lastTask.retryCount", operator: "lt", value: "$input.retryLimit" }, { field: "lastTask.failureRetryable", operator: "eq", value: true }, { field: "package.name", operator: "eq", value: "$input.packageName" }, { field: "package.outdated", operator: "eq", value: true }] }, actions: [{ type: "create_patch_task", mode: "specific_package", packageName: "$input.packageName", targetVersion: "latest", retryLimit: "$input.retryLimit", backoff: "exponential", maxDevices: 1 }], requiredInputs: [DASHBOARD_PACKAGE_INPUT, DASHBOARD_RETRY_LIMIT_INPUT], explanation: ["retry only the named package", "create at most one retry draft"], safety: ["exponential backoff", "retry count prevents loops", "no all-outdated retry"] },
    { id: "repeated-failure-inventory-reset", name: "Repeated Failure Inventory Reset", description: "Refresh inventory and notify SIEM after repeated update failures.", category: "Failure Handling", recommendedSecurityMode: "strict", riskLevel: "low", tags: ["failure", "inventory", "siem"], trigger: { type: "event", eventType: "task.failed" }, schedule: {}, conditions: { combinator: "AND", conditions: [{ field: "lastTask.failed", operator: "eq", value: true }, { field: "lastTask.retryCount", operator: "gte", value: 2 }] }, actions: [{ type: "create_security_task", task: "refresh_inventory" }, { type: "notify", channel: "siem", message: "Inventory refresh created after repeated patch failures" }], requiredInputs: [], explanation: ["refresh inventory instead of blindly retrying patches", "notify SIEM after repeated failures"], safety: ["no package execution action", "breaks retry loops"] },
    { id: "failed-task-siem-escalation", name: "Failed Task SIEM Escalation", description: "Escalate repeated failed tasks without creating new patch work.", category: "Failure Handling", recommendedSecurityMode: "normal", riskLevel: "low", tags: ["failure", "siem", "tag"], trigger: { type: "event", eventType: "task.failed" }, schedule: {}, conditions: { combinator: "AND", conditions: [{ field: "lastTask.failed", operator: "eq", value: true }, { field: "lastTask.retryCount", operator: "gte", value: 2 }] }, actions: [{ type: "mark_device", tag: "patch-failure-review" }, { type: "notify", channel: "siem", message: "Device marked for patch failure review" }], requiredInputs: [], explanation: ["tag devices after repeated failures", "notify SIEM for manual follow-up"], safety: ["no retry task created", "metadata-only device mark"] },
    { id: "production-maintenance-window-only", name: "Production Package Window", description: "Patch one named production package only inside an explicit maintenance window.", category: "Compliance", recommendedSecurityMode: "tinfoil", riskLevel: "high", tags: ["production", "maintenance-window", "specific-package"], trigger: { type: "schedule" }, schedule: { cron: "0 3 * * 0", timezone: "UTC", maintenanceWindow: { daysOfWeek: [0], startHourUtc: 3, endHourUtc: 5 } }, conditions: { combinator: "AND", conditions: [{ field: "device.group", operator: "eq", value: "production" }, { field: "package.name", operator: "eq", value: "$input.packageName" }, { field: "package.outdated", operator: "eq", value: true }, { field: "currentTime.maintenanceWindow", operator: "eq", value: true }] }, actions: [{ type: "create_patch_task", mode: "specific_package", packageName: "$input.packageName", targetVersion: "latest", maxDevices: "$input.maxDevices" }], requiredInputs: [{ ...DASHBOARD_PACKAGE_INPUT, defaultValue: "Microsoft Edge" }, DASHBOARD_WINDOW_INPUT, { ...DASHBOARD_MAX_DEVICES_INPUT, defaultValue: 5 }], explanation: ["patch only one named production package", "create drafts only during the configured window"], safety: ["specific package required", "max 5 devices by default", "tinfoil approval defaults"] },
    { id: "production-hotfix-window", name: "Production Hotfix Window", description: "Create tightly capped production hotfix drafts for one critical package.", category: "Compliance", recommendedSecurityMode: "tinfoil", riskLevel: "critical", tags: ["production", "hotfix", "critical"], trigger: { type: "event", eventType: "vulnerability.detected" }, schedule: { maintenanceWindow: { daysOfWeek: [0], startHourUtc: 3, endHourUtc: 5 } }, conditions: { combinator: "AND", conditions: [{ field: "device.group", operator: "eq", value: "production" }, { field: "package.name", operator: "eq", value: "$input.packageName" }, { field: "package.severity", operator: "eq", value: "critical" }, { field: "package.outdated", operator: "eq", value: true }, { field: "currentTime.maintenanceWindow", operator: "eq", value: true }] }, actions: [{ type: "create_patch_task", mode: "specific_package", packageName: "$input.packageName", targetVersion: "latest", maxDevices: "$input.maxDevices" }, { type: "notify", channel: "siem", message: "Production critical hotfix draft created" }], requiredInputs: [DASHBOARD_PACKAGE_INPUT, DASHBOARD_WINDOW_INPUT, { ...DASHBOARD_MAX_DEVICES_INPUT, defaultValue: 3 }], explanation: ["patch only the named critical production package", "notify SIEM immediately"], safety: ["critical risk approval path", "max 3 devices by default", "maintenance window required"] },
    { id: "block-production-outside-window", name: "Block Production Outside Window", description: "Block production task candidates outside the configured maintenance window.", category: "Compliance", recommendedSecurityMode: "tinfoil", riskLevel: "low", tags: ["production", "guardrail", "maintenance-window"], trigger: { type: "event", eventType: "rule.task_candidate.created" }, schedule: { maintenanceWindow: { daysOfWeek: [0], startHourUtc: 3, endHourUtc: 5 } }, conditions: { combinator: "AND", conditions: [{ field: "device.group", operator: "eq", value: "production" }, { field: "currentTime.maintenanceWindow", operator: "eq", value: false }] }, actions: [{ type: "block_task_creation", reason: "Production task candidate outside maintenance window" }, { type: "notify", channel: "siem", message: "Blocked production task outside maintenance window" }], requiredInputs: [DASHBOARD_WINDOW_INPUT], explanation: ["block instead of creating endpoint work", "notify SIEM on policy violation"], safety: ["no executable task created", "guardrail action only"] },
    { id: "block-unsafe-automation", name: "Block Unsafe Automation", description: "Stop automation candidates with critical risk, untrusted source, or missing hashes.", category: "Compliance", recommendedSecurityMode: "tinfoil", riskLevel: "low", tags: ["block", "guardrail"], trigger: { type: "event", eventType: "rule.task_candidate.created" }, schedule: {}, conditions: { combinator: "OR", conditions: [{ field: "riskScore", operator: "gte", value: 90 }, { field: "task.sourceHostTrusted", operator: "eq", value: false }, { field: "task.hashPresent", operator: "eq", value: false }] }, actions: [{ type: "block_task_creation", reason: "Unsafe automation candidate" }, { type: "notify", channel: "siem", message: "Blocked unsafe automation candidate" }], requiredInputs: [], explanation: ["do not create an executable task", "notify admins and SIEM"], safety: ["no hidden task", "no arbitrary command", "blocks instead of executes"] },
    { id: "low-trust-automation-block", name: "Low-Trust Automation Block", description: "Block task candidates for low-trust devices or high-risk automation.", category: "Compliance", recommendedSecurityMode: "tinfoil", riskLevel: "low", tags: ["trust", "block", "guardrail"], trigger: { type: "event", eventType: "rule.task_candidate.created" }, schedule: {}, conditions: { combinator: "OR", conditions: [{ field: "device.deviceTrustScore", operator: "lt", value: 40 }, { field: "riskScore", operator: "gte", value: 80 }, { field: "task.sourceHostTrusted", operator: "eq", value: false }, { field: "task.hashPresent", operator: "eq", value: false }] }, actions: [{ type: "block_task_creation", reason: "Low-trust or high-risk automation candidate" }, { type: "notify", channel: "siem", message: "Blocked low-trust automation candidate" }], requiredInputs: [], explanation: ["block risky automation candidates", "notify SIEM with audit context"], safety: ["no hidden task", "no arbitrary command", "blocks instead of executes"] },
    { id: "notify-on-high-risk-task", name: "Notify on High-Risk Task", description: "Notify security systems when a task scan returns high risk.", category: "Notifications", recommendedSecurityMode: "normal", riskLevel: "low", tags: ["notification", "siem"], trigger: { type: "event", eventType: "task.security_scan.completed" }, schedule: {}, conditions: { combinator: "AND", conditions: [{ field: "riskScore", operator: "gte", value: 70 }] }, actions: [{ type: "notify", channel: "siem", message: "High-risk task detected by rule template" }], requiredInputs: [], explanation: ["send SIEM and configured tenant notifications for high-risk task scans"], safety: ["no execution action"] },
    { id: "stale-inventory-notification", name: "Stale Inventory Notification", description: "Notify SIEM when devices in a group have stale inventory.", category: "Notifications", recommendedSecurityMode: "normal", riskLevel: "low", tags: ["inventory", "notification"], trigger: { type: "schedule" }, schedule: { cron: "0 8 * * *", timezone: "UTC" }, conditions: { combinator: "AND", conditions: [{ field: "device.group", operator: "eq", value: "$input.targetDeviceGroup" }, { field: "device.lastInventoryAgeHours", operator: "gt", value: 72 }] }, actions: [{ type: "notify", channel: "siem", message: "Stale device inventory detected" }], requiredInputs: [DASHBOARD_GROUP_INPUT], explanation: ["notify without creating tasks", "surface stale inventory for operations review"], safety: ["notification only", "no endpoint execution"] },
];
/**
 * Handles the default rule operation.
 * @returns The result produced by the operation.
 */
function defaultRule() {
    return { enabled: true, tenantId: "default", name: "", description: "", priority: 100, trigger: { type: "manual" }, conditionGroup: { combinator: "AND", conditions: [{ field: "package.outdated", operator: "eq", value: true }] }, actions: [{ type: "create_patch_task", mode: "all_outdated", targetVersion: "latest" }], schedule: { maintenanceWindow: { startHourUtc: 0, endHourUtc: 6 } }, safeMode: { enabled: true, requireApprovalAtRiskScore: 60 } };
}
/**
 * Handles the normalize rule form operation.
 *
 * @param rule rule supplied to the function.
 * @returns The result produced by the operation.
 */
function normalizeRuleForm(rule) {
    const r = rule || defaultRule();
    const action = (r.actions || defaultRule().actions)[0];
    return { id: r.id, tenantId: r.tenantId || "default", name: r.name || "", description: r.description || "", enabled: r.enabled !== false, priority: r.priority ?? 100, triggerType: r.trigger?.type || "manual", eventType: r.trigger?.eventType || "device.inventory.updated", cron: r.schedule?.cron || "0 2 * * 0", combinator: r.conditionGroup?.combinator || "AND", conditions: r.conditionGroup?.conditions?.filter(c => !c.combinator) || [], actions: r.actions || [], actionType: action.type, patchMode: action.mode || "all_outdated", packageName: action.packageName || (action.packageNames || []).join(", "), targetVersion: action.targetVersion || "latest", securityTask: action.task || "refresh_inventory", notifyMessage: action.message || "Rule matched", tag: action.tag || "rule-matched", blockReason: action.reason || "Unsafe automation candidate", startHourUtc: r.schedule?.maintenanceWindow?.startHourUtc ?? 0, endHourUtc: r.schedule?.maintenanceWindow?.endHourUtc ?? 6, requireApprovalAtRiskScore: r.safeMode?.requireApprovalAtRiskScore ?? 60, sourceTemplateId: r.sourceTemplateId, sourceTemplateName: r.sourceTemplateName };
}
/**
 * Handles the rule payload operation.
 *
 * @param form form supplied to the function.
 * @returns The result produced by the operation.
 */
function rulePayload(form) {
    const packageNames = String(form.packageName || "").split(",").map(name => name.trim()).filter(Boolean);
    const originalActions = Array.isArray(form.actions) ? form.actions : [];
    const originalAction = originalActions[0] || {};
    const originalPatchAction = originalAction.type === "create_patch_task" ? { ...originalAction } : {};
    delete originalPatchAction.packageName;
    delete originalPatchAction.packageNames;
    delete originalPatchAction.packageId;
    const action = form.actionType === "create_patch_task" ? cleanPatchAction({ ...originalPatchAction, type: "create_patch_task", mode: form.patchMode, ...(form.patchMode === "specific_package" ? (packageNames.length > 1 ? { packageNames } : { packageName: packageNames[0] || undefined }) : {}), targetVersion: form.targetVersion || "latest" }) : form.actionType === "create_security_task" ? { type: "create_security_task", task: form.securityTask } : form.actionType === "notify" ? { type: "notify", channel: "siem", message: form.notifyMessage || "Rule matched" } : form.actionType === "block_task_creation" ? { type: "block_task_creation", reason: form.blockReason || "Unsafe automation candidate" } : { type: "mark_device", tag: form.tag || "rule-matched" };
    const actions = originalActions.length > 1 && originalAction.type === action.type ? [action, ...originalActions.slice(1)] : [action];
    return { tenantId: form.tenantId || "default", name: form.name.trim(), description: form.description.trim(), enabled: form.enabled, priority: Number(form.priority || 100), trigger: { type: form.triggerType, ...(form.triggerType === "event" ? { eventType: form.eventType } : {}) }, conditionGroup: { combinator: form.combinator, conditions: form.conditions }, actions, schedule: { cron: form.triggerType === "schedule" ? form.cron : undefined, maintenanceWindow: { startHourUtc: Number(form.startHourUtc), endHourUtc: Number(form.endHourUtc) } }, safeMode: { enabled: true, requireApprovalAtRiskScore: Number(form.requireApprovalAtRiskScore || 60) }, sourceTemplateId: form.sourceTemplateId, sourceTemplateName: form.sourceTemplateName };
}
/**
 * Handles the clean patch action operation.
 *
 * @param action action supplied to the function.
 * @returns The result produced by the operation.
 */
function cleanPatchAction(action) {
    if (action.mode !== "specific_package") {
        delete action.packageName;
        delete action.packageNames;
        delete action.packageId;
    }
    return action;
}
/**
 * Updates the condition record or state.
 *
 * @param setForm set form supplied to the function.
 * @param index index supplied to the function.
 * @param patch patch supplied to the function.
 */
function updateCondition(setForm, index, patch) { setForm(prev => ({ ...prev, conditions: prev.conditions.map((c, i) => i === index ? { ...c, ...patch } : c) })); }
/**
 * Removes the condition record or state.
 *
 * @param setForm set form supplied to the function.
 * @param index index supplied to the function.
 */
function removeCondition(setForm, index) { setForm(prev => ({ ...prev, conditions: prev.conditions.filter((_, i) => i !== index) })); }
/**
 * Parses condition value input.
 *
 * @param value Value to read, render, or store.
 * @returns The result produced by the operation.
 */
function parseConditionValue(value) { if (value === "true")
    return true; if (value === "false")
    return false; const n = Number(value); return value.trim() !== "" && Number.isFinite(n) ? n : value; }
/**
 * Handles the condition summary operation.
 *
 * @param group group supplied to the function.
 * @returns The result produced by the operation.
 */
function conditionSummary(group) { const count = group?.conditions?.length || 0; return `${group?.combinator || "AND"} · ${count} condition${count === 1 ? "" : "s"}`; }
/**
 * Handles the action summary operation.
 *
 * @param action action supplied to the function.
 * @returns The result produced by the operation.
 */
function actionSummary(action) { if (!action)
    return "none"; if (action.type === "create_patch_task")
    return action.mode === "all_outdated" ? "patch all outdated" : `patch ${action.packageName || (action.packageNames || []).join(", ") || action.packageId || "package"}`; if (action.type === "create_security_task")
    return action.task; if (action.type === "notify")
    return `notify ${action.channel}`; if (action.type === "mark_device")
    return `tag ${action.tag}`; return action.type; }
// ---------- Tasks ----------
/**
 * Renders the tasks page UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function TasksPage({ globalSearch = "" }) {
    const [filter, setFilter] = useState("all");
    const tasks = useResource(() => PatchAPI.tasks());
    useLiveResource(tasks, 2500);
    const [cancelling, setCancelling] = useState(new Set());
    const [actionLoading, setActionLoading] = useState(new Set());
    const [actionError, setActionError] = useState(null);
    const [mfaDialog, setMfaDialog] = useState(null); // { taskId, challengeId }
    const [mfaCode, setMfaCode] = useState("");
    const [mfaError, setMfaError] = useState("");
    const [outputTaskId, setOutputTaskId] = useState(null);
    const outputTask = outputTaskId ? (tasks.data || []).find(t => t.id === outputTaskId) ?? null : null;
    const [copied, setCopied] = useState(false);
    // Ticker so fmtAgo values stay fresh when no task data changes
    const [, setTimeTick] = useState(0);
    useEffect(() => {
        const id = setInterval(() => setTimeTick(n => n + 1), 30000);
        return () => clearInterval(id);
    }, []);
    /**
     * Handles the cancel operation.
     *
     * @param id Identifier used to locate the target record.
     */
    const cancel = async (id) => {
        setCancelling(prev => new Set([...prev, id]));
        try {
            await PatchAPI.cancelTask(id);
            tasks.reload(true);
        }
        catch (e) { /* task may have already moved past pending */ }
        finally {
            setCancelling(prev => { const s = new Set(prev); s.delete(id); return s; });
        }
    };
    const markLoading = (key) => setActionLoading(prev => new Set([...prev, key]));
    const clearLoading = (key) => setActionLoading(prev => { const s = new Set(prev); s.delete(key); return s; });
    const scanTask = async (id) => {
        markLoading(`scan-${id}`);
        setActionError(null);
        try {
            await PatchAPI.scanTask(id);
            tasks.reload(true);
        }
        catch (e) {
            setActionError(e?.message || "Scan failed");
        }
        finally {
            clearLoading(`scan-${id}`);
        }
    };
    const approveTask = async (id) => {
        markLoading(`approve-${id}`);
        setActionError(null);
        try {
            await PatchAPI.approveTask(id, '');
            tasks.reload(true);
        }
        catch (e) {
            if (e?.message?.toLowerCase().includes('mfa') || e?.message?.toLowerCase().includes('challenge')) {
                try {
                    const { challengeId } = await PatchAPI.issueMfaChallenge();
                    setMfaDialog({ taskId: id, challengeId });
                    setMfaCode("");
                    setMfaError("");
                }
                catch (mfaErr) {
                    setActionError(mfaErr?.message || "Could not issue MFA challenge");
                }
            }
            else {
                setActionError(e?.message || "Approval failed");
            }
        }
        finally {
            clearLoading(`approve-${id}`);
        }
    };
    const submitMfaApproval = async () => {
        if (!mfaDialog)
            return;
        setMfaError("");
        try {
            await PatchAPI.verifyMfaChallenge(mfaDialog.challengeId, mfaCode);
            await PatchAPI.approveTask(mfaDialog.taskId, mfaDialog.challengeId);
            setMfaDialog(null);
            setMfaCode("");
            tasks.reload(true);
        }
        catch (e) {
            setMfaError(e?.message || "MFA approval failed");
        }
    };
    const signTask = async (id) => {
        markLoading(`sign-${id}`);
        setActionError(null);
        try {
            await PatchAPI.signTask(id);
            tasks.reload(true);
        }
        catch (e) {
            setActionError(e?.message || "Signing failed");
        }
        finally {
            clearLoading(`sign-${id}`);
        }
    };
    /**
     * Handles the copy output operation.
     */
    const copyOutput = () => {
        navigator.clipboard.writeText(outputTask?.output || "").then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };
    const rows = sortTasksNewestFirst(tasks.data || []).filter(t => (filter === "all" || t.status === filter) &&
        textMatches(globalSearch, [taskLabel(t), t.type, t.appName, t.deviceId, t.nodeId, t.status, t.fromVersion, t.targetVersion, t.output]));
    return (React.createElement("div", { className: "page" },
        React.createElement("div", { className: "page-head" },
            React.createElement("div", null,
                React.createElement("h2", null, "Tasks"),
                React.createElement("p", null, tasks.loading ? "…" : `${(tasks.data || []).length} update jobs`)),
            React.createElement("button", { className: "btn", onClick: () => tasks.reload() }, "Refresh")),
        React.createElement("div", { className: "card" },
            React.createElement("div", { className: "filterbar" }, [["all", "All"], ["security_scanned", "Needs Approval"], ["mfa_approved", "Needs Signing"], ["pending", "Pending"], ["dispatched", "Dispatched"], ["completed", "Completed"], ["failed", "Failed"], ["cancelled", "Cancelled"]].map(([k, l]) => (React.createElement("button", { key: k, className: "chip " + (filter === k ? "active" : ""), onClick: () => setFilter(k) }, l)))),
            tasks.error && React.createElement("div", { style: { padding: 16 } },
                React.createElement(ErrorAlert, { error: tasks.error, onRetry: tasks.reload })),
            actionError && React.createElement("div", { style: { padding: "8px 16px", color: "var(--crit)", fontSize: 13 } }, actionError),
            React.createElement("div", { style: { overflowX: "auto" } },
                React.createElement("table", { className: "tbl" },
                    React.createElement("thead", null,
                        React.createElement("tr", null,
                            React.createElement("th", null, "App"),
                            React.createElement("th", null, "Device"),
                            React.createElement("th", null, "Version"),
                            React.createElement("th", null, "Node"),
                            React.createElement("th", null, "Status"),
                            React.createElement("th", null, "Output"),
                            React.createElement("th", null, "Created"),
                            React.createElement("th", null))),
                    React.createElement("tbody", null,
                        tasks.loading && React.createElement(SkeletonRows, { n: 6, cols: 8 }),
                        !tasks.loading && rows.length === 0 && React.createElement("tr", null,
                            React.createElement("td", { colSpan: 8, style: { padding: 24, color: "var(--text-3)" } }, "No tasks match.")),
                        !tasks.loading && rows.map(t => (React.createElement("tr", { key: t.id },
                            React.createElement("td", null,
                                React.createElement("strong", { style: { fontWeight: 500 } }, taskLabel(t))),
                            React.createElement("td", { className: "mono" }, t.deviceId),
                            React.createElement("td", { className: "mono muted" }, taskVersionLabel(t)),
                            React.createElement("td", { className: "mono muted" }, t.nodeId),
                            React.createElement("td", null,
                                React.createElement(StatusPill, { status: t.status })),
                            React.createElement("td", { className: "mono muted", style: { maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: t.output ? "pointer" : "default" }, title: t.output ? "Click to view full output" : undefined, onClick: () => t.output && setOutputTaskId(t.id) }, t.output || "—"),
                            React.createElement("td", { className: "muted" }, fmtAgo(t.createdAt)),
                            React.createElement("td", null,
                                t.status === "pending" && (React.createElement("button", { className: "btn sm", disabled: cancelling.has(t.id), onClick: () => cancel(t.id) }, cancelling.has(t.id) ? "…" : "Cancel")),
                                t.status === "draft" && (React.createElement("button", { className: "btn sm", disabled: actionLoading.has(`scan-${t.id}`), onClick: () => scanTask(t.id) }, actionLoading.has(`scan-${t.id}`) ? "…" : "Scan")),
                                t.status === "security_scanned" && (React.createElement("button", { className: "btn sm", disabled: actionLoading.has(`approve-${t.id}`), onClick: () => approveTask(t.id) }, actionLoading.has(`approve-${t.id}`) ? "…" : "Approve")),
                                t.status === "mfa_approved" && (React.createElement("button", { className: "btn sm", disabled: actionLoading.has(`sign-${t.id}`), onClick: () => signTask(t.id) }, actionLoading.has(`sign-${t.id}`) ? "…" : "Sign")))))))))),
        outputTask && (React.createElement(React.Fragment, null,
            React.createElement("div", { className: "drawer-backdrop", onClick: () => setOutputTaskId(null) }),
            React.createElement("div", { className: "output-dialog" },
                React.createElement("div", { className: "output-dialog-box" },
                    React.createElement("div", { className: "output-dialog-head" },
                        React.createElement("h4", null, taskLabel(outputTask)),
                        React.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
                            React.createElement("button", { className: "btn sm", onClick: copyOutput }, copied ? "Copied!" : "Copy"),
                            React.createElement("button", { className: "icon-btn", onClick: () => setOutputTaskId(null) },
                                React.createElement("span", { style: { width: 14, height: 14, display: "inline-flex" } }, Icon.close)))),
                    React.createElement("div", { className: "output-dialog-body" },
                        React.createElement("pre", null, outputTask.output)))))),
        mfaDialog && (React.createElement(React.Fragment, null,
            React.createElement("div", { className: "drawer-backdrop", onClick: () => setMfaDialog(null) }),
            React.createElement("div", { className: "output-dialog" },
                React.createElement("div", { className: "output-dialog-box" },
                    React.createElement("div", { className: "output-dialog-head" },
                        React.createElement("h4", null, "MFA Approval Required"),
                        React.createElement("button", { className: "icon-btn", onClick: () => setMfaDialog(null) },
                            React.createElement("span", { style: { width: 14, height: 14, display: "inline-flex" } }, Icon.close))),
                    React.createElement("div", { className: "output-dialog-body", style: { padding: 24, display: "flex", flexDirection: "column", gap: 16 } },
                        React.createElement("p", { style: { margin: 0, fontSize: 14 } }, "Enter your authenticator code to approve this task."),
                        React.createElement("input", { className: "input", value: mfaCode, onChange: e => { setMfaCode(e.target.value); setMfaError(""); }, onKeyDown: e => e.key === "Enter" && submitMfaApproval(), placeholder: "6-digit code", maxLength: 6, autoFocus: true, style: { letterSpacing: "0.2em", width: 140, textAlign: "center" } }),
                        mfaError && React.createElement("div", { style: { color: "var(--crit)", fontSize: 13 } }, mfaError),
                        React.createElement("div", { style: { display: "flex", gap: 8 } },
                            React.createElement("button", { className: "btn", onClick: submitMfaApproval, disabled: mfaCode.length < 6 }, "Approve"),
                            React.createElement("button", { className: "btn ghost", onClick: () => setMfaDialog(null) }, "Cancel")))))))));
}
// ---------- Nodes ----------
const FINDING_SEVERITY_COLOR = {
    critical: "var(--crit)",
    high: "var(--warn)",
    medium: "var(--accent)",
    low: "var(--text-3)",
    info: "var(--text-3)",
};
const FINDING_CATEGORY_LABEL = {
    os_security: "OS security",
    ip_reputation: "Public URL / IP",
    node_age: "Node age",
    configuration: "Configuration",
    health: "Health",
};
function trustReasonImpact(reason) {
    const text = String(reason || "").toLowerCase();
    if (text.includes("unhealthy component"))
        return "-25 each";
    if (text.includes("degraded component"))
        return "-8 each";
    if (text.includes("scanner unhealthy"))
        return "-12";
    if (text.includes("cache unhealthy"))
        return "-8";
    if (text.includes("package verifier"))
        return "-20";
    if (text.includes("update source"))
        return "-6";
    if (text.includes("clock skew"))
        return "-15";
    if (text.includes("high queue"))
        return "-8";
    if (text.includes("high latency"))
        return "-6";
    if (text.includes("less than 1 hour"))
        return "-20 and cap 60";
    if (text.includes("less than 24 hours"))
        return "-10 and cap 75";
    if (text.includes("less than 7 days"))
        return "-5 and cap 90";
    if (text.includes("denylisted"))
        return "-35";
    if (text.includes("warnlisted"))
        return "-18";
    if (text.includes("local-only"))
        return "-15";
    if (text.includes("private or reserved"))
        return "-8";
    if (text.includes("raw public ip"))
        return "-8";
    if (text.includes("plain http"))
        return "-12";
    if (text.includes("unusual public"))
        return "-3";
    if (text.includes("invalid public url"))
        return "-7";
    return "factor";
}
function NodeTrustBreakdown({ trust, node }) {
    const findings = trust?.securityFindings || [];
    const reasons = (trust?.reasons || []).filter(r => r !== "signed health report accepted");
    const quarantines = node?.activeQuarantineEvents || node?.quarantineEvents || [];
    const history = node?.trustHistory || [];
    const trustScore = trust?.trustScore ?? node?.trustScore ?? 0;
    const shouldDefaultOpen = trustScore < 70 || node?.quarantineState === "quarantined" || findings.length > 0 || reasons.length > 0;
    const [open, setOpen] = useState(shouldDefaultOpen);
    useEffect(() => { if (shouldDefaultOpen)
        setOpen(true); }, [shouldDefaultOpen, trust?.id]);
    if (findings.length === 0 && reasons.length === 0 && quarantines.length === 0 && history.length === 0)
        return null;
    const grouped = findings.reduce((acc, finding) => {
        const key = finding.category || "health";
        if (!acc[key])
            acc[key] = [];
        acc[key].push(finding);
        return acc;
    }, {});
    const categories = Object.keys(grouped);
    const highRisk = findings.some(f => f.severity === "critical" || f.severity === "high") || trustScore < 30 || node?.quarantineState === "quarantined";
    const previous = trust?.previousTrustScore;
    const delta = trust?.scoreDelta;
    return (React.createElement("div", { style: { paddingTop: 10, borderTop: "1px solid var(--line)" } },
        React.createElement("button", { type: "button", onClick: () => setOpen(v => !v), style: { all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, width: "100%" } },
            React.createElement("span", { className: "muted", style: { fontSize: 10, flex: 1 } }, "WHY THIS TRUST SCORE"),
            delta != null && (React.createElement("span", { style: { fontSize: 10, color: delta < 0 ? "var(--crit)" : "var(--ok)" } },
                previous ?? "?",
                " -> ",
                trust?.trustScore ?? "?",
                " (",
                delta > 0 ? "+" : "",
                delta,
                ")")),
            findings.length > 0 && (React.createElement("span", { style: { fontSize: 10, color: highRisk ? "var(--crit)" : "var(--warn)" } },
                findings.length,
                " finding",
                findings.length === 1 ? "" : "s")),
            React.createElement("span", { style: { fontSize: 10, color: "var(--text-3)" } }, open ? "Hide" : "Show")),
        open && (React.createElement("div", { style: { marginTop: 8, display: "flex", flexDirection: "column", gap: 10 } },
            node?.quarantineState === "quarantined" && (React.createElement("div", { style: { padding: 10, border: "1px solid color-mix(in oklch, var(--crit), white 70%)", background: "var(--crit-soft)", borderRadius: 8 } },
                React.createElement("div", { style: { fontSize: 11, fontWeight: 700, color: "var(--crit)", marginBottom: 4 } }, "Node is quarantined"),
                React.createElement("div", { style: { fontSize: 11 } }, node.quarantineReason || quarantines[0]?.reason || "Trust fell below the quarantine threshold."),
                quarantines[0]?.trigger && (React.createElement("div", { className: "mono muted", style: { fontSize: 10, marginTop: 4 } },
                    "trigger: ",
                    quarantines[0].trigger,
                    " \u00B7 ",
                    fmtAgo(quarantines[0].createdAt))))),
            (reasons.length > 0 || delta != null || trust?.maxTrustScore != null) && (React.createElement("div", null,
                React.createElement("div", { className: "muted", style: { fontSize: 9, fontWeight: 700, marginBottom: 4 } }, "SCORING FACTORS"),
                delta != null && (React.createElement("div", { style: { display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11, padding: "6px 0", borderBottom: "1px solid var(--line)" } },
                    React.createElement("span", null,
                        "Latest signed health report changed trust from ",
                        React.createElement("strong", null, previous),
                        " to ",
                        React.createElement("strong", null, trust.trustScore),
                        "."),
                    React.createElement("span", { className: "mono", style: { color: delta < 0 ? "var(--crit)" : "var(--ok)", whiteSpace: "nowrap" } },
                        delta > 0 ? "+" : "",
                        delta))),
                trust?.maxTrustScore != null && trust.maxTrustScore < 100 && (React.createElement("div", { style: { display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11, padding: "6px 0", borderBottom: "1px solid var(--line)" } },
                    React.createElement("span", null, "Trust is capped while this node builds an operational baseline."),
                    React.createElement("span", { className: "mono", style: { color: "var(--warn)", whiteSpace: "nowrap" } },
                        "cap ",
                        trust.maxTrustScore))),
                reasons.map(reason => (React.createElement("div", { key: reason, style: { display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11, padding: "6px 0", borderBottom: "1px solid var(--line)" } },
                    React.createElement("span", { style: { color: "var(--text)" } }, reason),
                    React.createElement("span", { className: "mono", style: { color: "var(--warn)", whiteSpace: "nowrap" } }, trustReasonImpact(reason))))))),
            categories.map(category => (React.createElement("div", { key: category },
                React.createElement("div", { className: "muted", style: { fontSize: 9, fontWeight: 700, marginBottom: 4 } },
                    FINDING_CATEGORY_LABEL[category] || category,
                    " findings"),
                grouped[category].map(finding => (React.createElement("div", { key: finding.code, style: {
                        marginBottom: 6,
                        paddingLeft: 8,
                        borderLeft: "2px solid " + (FINDING_SEVERITY_COLOR[finding.severity] || "var(--line)"),
                    } },
                    React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 5, marginBottom: 2, flexWrap: "wrap" } },
                        React.createElement("span", { style: { fontSize: 10, fontWeight: 700, color: FINDING_SEVERITY_COLOR[finding.severity] || "var(--text-3)", textTransform: "uppercase" } }, finding.severity),
                        React.createElement("span", { className: "mono", style: { fontSize: 10, color: "var(--text-3)" } }, finding.code)),
                    React.createElement("div", { style: { fontSize: 11, color: "var(--text)" } }, finding.message),
                    finding.remediationHint && (React.createElement("div", { style: { fontSize: 10, color: "var(--text-3)", marginTop: 2 } },
                        "Fix: ",
                        finding.remediationHint)))))))),
            history.length > 1 && (React.createElement("div", null,
                React.createElement("div", { className: "muted", style: { fontSize: 9, fontWeight: 700, marginBottom: 4 } }, "RECENT TRUST HISTORY"),
                history.slice(0, 5).map(item => (React.createElement("div", { key: item.id, style: { display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11, marginBottom: 4 } },
                    React.createElement("span", null,
                        fmtAgo(item.createdAt),
                        " \u00B7 ",
                        (item.reasons || []).filter(r => r !== "signed health report accepted")[0] || item.healthState),
                    React.createElement("span", { className: "mono", style: { color: (item.scoreDelta ?? 0) < 0 ? "var(--crit)" : "var(--ok)" } },
                        item.previousTrustScore ?? "?",
                        " -> ",
                        item.trustScore))))))))));
}
function NodeTrustInvestigationDrawer({ node, onClose, onResetSafe }) {
    if (!node)
        return null;
    const [confirmReset, setConfirmReset] = useState(false);
    const [resetBusy, setResetBusy] = useState(false);
    const [resetError, setResetError] = useState('');
    const trust = node.trust || {};
    const trustScore = trust.trustScore ?? node.trustScore ?? 0;
    const healthState = node.quarantineState === "quarantined" ? "quarantined" : (node.healthState ?? trust.healthState ?? node.status);
    const findings = trust.securityFindings || [];
    const reasons = (trust.reasons || []).filter(r => r !== "signed health report accepted");
    const latestReason = node.quarantineReason || reasons[0] || findings[0]?.message || "No trust findings recorded.";
    const components = node.health?.components || [];
    const quarantines = node.activeQuarantineEvents || node.quarantineEvents || [];
    const canReset = node.quarantineState === "quarantined" || trustScore < 70;
    const resetSafe = () => {
        setResetBusy(true);
        setResetError('');
        PatchAPI.clearNodeQuarantine(node.id)
            .then((updated) => {
            setConfirmReset(false);
            onResetSafe?.(updated);
        })
            .catch(err => setResetError(err.message || "Trust reset failed"))
            .finally(() => setResetBusy(false));
    };
    return (React.createElement(React.Fragment, null,
        React.createElement("div", { className: "drawer-backdrop", onClick: onClose }),
        React.createElement("div", { className: "trust-detail-drawer", role: "dialog", "aria-modal": "true", "aria-label": `Trust investigation for ${node.name || node.id}` },
            React.createElement("div", { className: "wizard-head" },
                React.createElement("div", null,
                    React.createElement("h3", null, "Trust investigation"),
                    React.createElement("p", null, node.name || node.id)),
                React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                    canReset && (React.createElement("button", { className: "btn sm primary", onClick: () => setConfirmReset(true) }, "Mark safe & reset trust")),
                    React.createElement("button", { className: "icon-btn", onClick: onClose, "aria-label": "Close trust investigation" },
                        React.createElement("span", { style: { width: 14, height: 14, display: "inline-flex" } }, Icon.close)))),
            React.createElement("div", { className: "trust-detail-body" },
                resetError && React.createElement("div", { className: "banner error" }, resetError),
                React.createElement("div", { className: "trust-detail-summary" },
                    React.createElement("div", null,
                        React.createElement("span", { className: "muted" }, "Current trust"),
                        React.createElement("strong", null, trustScore)),
                    React.createElement("div", null,
                        React.createElement("span", { className: "muted" }, "State"),
                        React.createElement(StatusPill, { status: healthState })),
                    React.createElement("div", null,
                        React.createElement("span", { className: "muted" }, "Findings"),
                        React.createElement("strong", null, findings.length)),
                    React.createElement("div", null,
                        React.createElement("span", { className: "muted" }, "Quarantine events"),
                        React.createElement("strong", null, quarantines.length))),
                React.createElement("div", { className: "trust-detail-callout " + (node.quarantineState === "quarantined" ? "crit" : trustScore < 70 ? "warn" : "ok") },
                    React.createElement("strong", null, node.quarantineState === "quarantined" ? "Node is quarantined" : trustScore < 70 ? "Node trust is degraded" : "Node trust is acceptable"),
                    React.createElement("span", null, latestReason),
                    canReset && (React.createElement("button", { className: "btn sm", style: { justifySelf: "start", marginTop: 6 }, onClick: () => setConfirmReset(true) }, "I verified this node is safe"))),
                React.createElement("div", { className: "card" },
                    React.createElement("div", { className: "card-head" },
                        React.createElement("h3", null, "Health Components"),
                        React.createElement("div", { className: "sub" }, components.length ? `${components.length} reported` : "No report")),
                    React.createElement("div", { className: "card-body" },
                        React.createElement(NodeComponentsRow, { components: components }),
                        components.length === 0 && React.createElement("div", { className: "empty" }, "No health component report has been received."),
                        components.length > 0 && (React.createElement("div", { className: "trust-component-list" }, components.map(component => (React.createElement("div", { key: component.name },
                            React.createElement(NodeHealthDot, { status: component.status }),
                            React.createElement("span", null, component.name),
                            React.createElement("strong", null, component.status),
                            component.message && React.createElement("em", null, component.message)))))))),
                React.createElement("div", { className: "card" },
                    React.createElement("div", { className: "card-head" },
                        React.createElement("h3", null, "Score Explanation"),
                        React.createElement("div", { className: "sub" }, "Audit-grade scoring reasons")),
                    React.createElement("div", { className: "card-body" },
                        React.createElement(NodeTrustBreakdown, { trust: trust, node: node }))))),
        confirmReset && (React.createElement("div", { className: "modal-overlay", onClick: () => !resetBusy && setConfirmReset(false) },
            React.createElement("div", { className: "modal-box", onClick: e => e.stopPropagation() },
                React.createElement("h3", null, "Reset node trust?"),
                React.createElement("p", null, "This clears quarantine and restores this node to the manual reapproval baseline. Only do this after verifying certificate identity, node host integrity, package cache integrity, and network exposure."),
                resetError && React.createElement("div", { className: "banner error" }, resetError),
                React.createElement("div", { className: "modal-actions" },
                    React.createElement("button", { className: "btn ghost", onClick: () => setConfirmReset(false), disabled: resetBusy }, "Cancel"),
                    React.createElement("button", { className: "btn danger", onClick: resetSafe, disabled: resetBusy },
                        resetBusy ? React.createElement("span", { className: "search-spinner" }) : null,
                        "Mark safe & reset")))))));
}
function NodeHealthDot({ status }) {
    const color = status === "ok" ? "var(--ok)" : status === "degraded" ? "var(--warn)" : status === "unhealthy" ? "var(--crit)" : "var(--text-3)";
    return React.createElement("span", { style: { display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0 } });
}
function NodeComponentsRow({ components }) {
    if (!components || components.length === 0)
        return null;
    const show = components.filter(c => c.status !== "ok");
    if (show.length === 0)
        return (React.createElement("div", { style: { fontSize: 11, color: "var(--ok)", display: "flex", alignItems: "center", gap: 5 } },
            React.createElement(NodeHealthDot, { status: "ok" }),
            " All components healthy"));
    return (React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: "4px 10px" } }, show.map(c => (React.createElement("span", { key: c.name, style: { display: "flex", alignItems: "center", gap: 4, fontSize: 11 } },
        React.createElement(NodeHealthDot, { status: c.status }),
        React.createElement("span", { style: { color: "var(--text-2)" } }, c.name),
        React.createElement("span", { style: { color: c.status === "degraded" ? "var(--warn)" : "var(--crit)" } }, c.status))))));
}
/**
 * Renders the nodes page UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function NodesPage({ globalSearch = "" }) {
    const nodes = useResource(() => PatchAPI.nodeTrustCenter ? PatchAPI.nodeTrustCenter() : PatchAPI.nodes());
    useLiveResource(nodes, 5000);
    const [filter, setFilter] = useState("all");
    const all = nodes.data || [];
    const counts = {
        all: all.length,
        healthy: all.filter(n => (n.healthState ?? n.trust?.healthState) === "healthy").length,
        "low-trust": all.filter(n => (n.trust?.trustScore ?? n.trustScore ?? 0) < 70).length,
        maintenance: all.filter(n => ["maintenance", "draining"].includes(n.maintenanceState)).length,
        quarantined: all.filter(n => n.quarantineState === "quarantined").length,
    };
    const rows = all.filter(n => {
        const trust = n.trust?.trustScore ?? n.trustScore ?? 0;
        if (filter === "quarantined" && n.quarantineState !== "quarantined")
            return false;
        if (filter === "low-trust" && trust >= 70)
            return false;
        if (filter === "maintenance" && !["maintenance", "draining"].includes(n.maintenanceState))
            return false;
        if (filter === "healthy" && (n.healthState ?? n.trust?.healthState) !== "healthy")
            return false;
        return textMatches(globalSearch, [n.name, n.id, n.publicUrl, n.url, n.region, n.site, n.status, n.version, n.healthState, n.quarantineState, ...(n.capabilities || [])]);
    });
    const onlineCount = all.filter(n => n.status === "online" || n.healthState === "healthy" || n.healthState === "degraded").length;
    const avgTrust = all.length > 0 ? Math.round(all.reduce((s, n) => s + (n.trust?.trustScore ?? n.trustScore ?? 0), 0) / all.length) : null;
    const [enrolling, setEnrolling] = useState(false);
    const [removing, setRemoving] = useState(null);
    const [investigatingNode, setInvestigatingNode] = useState(null);
    const [removeBusy, setRemoveBusy] = useState(false);
    const [removeError, setRemoveError] = useState('');
    const handleRemove = () => {
        setRemoveBusy(true);
        setRemoveError('');
        PatchAPI.deleteNode(removing.id)
            .then(() => { setRemoving(null); nodes.reload(); })
            .catch(err => setRemoveError(err.message || 'Remove failed'))
            .finally(() => setRemoveBusy(false));
    };
    return (React.createElement("div", { className: "page" },
        React.createElement("div", { className: "page-head" },
            React.createElement("div", null,
                React.createElement("h2", null, "Node Trust Center"),
                React.createElement("p", null, "Regional execution, cache health, trust scoring, quarantine, and failover state")),
            React.createElement("button", { className: "btn primary", onClick: () => setEnrolling(true) },
                React.createElement("span", { style: { width: 14, height: 14, display: "inline-flex" } }, Icon.plus),
                "Enroll node")),
        !nodes.loading && all.length > 0 && (React.createElement("div", { style: { display: "flex", gap: 24, padding: "10px 0 4px", flexWrap: "wrap" } }, [
            ["Nodes", all.length, null],
            ["Online", onlineCount, "var(--ok)"],
            ["Avg trust", avgTrust != null ? avgTrust : "—", avgTrust >= 90 ? "var(--ok)" : avgTrust >= 70 ? "var(--accent)" : "var(--warn)"],
            ["Low trust", counts["low-trust"], counts["low-trust"] > 0 ? "var(--warn)" : null],
            ["Quarantined", counts.quarantined, counts.quarantined > 0 ? "var(--crit)" : null],
        ].map(([label, val, color]) => (React.createElement("div", { key: label, style: { display: "flex", flexDirection: "column", gap: 2 } },
            React.createElement("span", { className: "muted", style: { fontSize: 11 } }, label),
            React.createElement("span", { style: { fontSize: 20, fontWeight: 700, color: color || "var(--text)", letterSpacing: "-0.02em" } }, val)))))),
        React.createElement("div", { className: "filterbar" }, [["all", "All"], ["healthy", "Healthy"], ["low-trust", "Low trust"], ["maintenance", "Maintenance"], ["quarantined", "Quarantined"]].map(([k, l]) => (React.createElement("button", { key: k, className: "chip " + (filter === k ? "active" : ""), onClick: () => setFilter(k) },
            l,
            counts[k] > 0 && k !== "all" ? React.createElement("span", { style: { marginLeft: 5, opacity: 0.6, fontSize: 11 } }, counts[k]) : null)))),
        nodes.error && React.createElement(ErrorAlert, { error: nodes.error, onRetry: nodes.reload }),
        React.createElement("div", { className: "row-3" },
            nodes.loading && Array.from({ length: 3 }).map((_, i) => React.createElement("div", { className: "card", key: i },
                React.createElement("div", { className: "card-body" },
                    React.createElement(Skeleton, { h: 140 })))),
            !nodes.loading && rows.length === 0 && (React.createElement("div", { className: "card" },
                React.createElement("div", { className: "card-body", style: { color: "var(--text-3)" } }, filter === "all" ? "No nodes enrolled." : "No nodes match this filter."))),
            !nodes.loading && rows.map(n => {
                const trustScore = n.trust?.trustScore ?? n.trustScore ?? 0;
                const healthState = n.quarantineState === "quarantined" ? "quarantined" : (n.healthState ?? n.trust?.healthState ?? n.status);
                const reasons = (n.trust?.reasons || []).filter(r => r !== "signed health report accepted");
                const components = n.health?.components || [];
                const mem = n.health?.memoryPressurePercent;
                const disk = n.health?.diskFreeBytes;
                const skew = n.health?.clockSkewMs;
                const latency = n.trust?.latencyMs;
                const queueLag = n.health?.queueLag ?? n.trust?.queueLag;
                const certValid = n.trust?.certValid;
                const quarantined = n.quarantineState === "quarantined";
                const inMaintenance = ["maintenance", "draining"].includes(n.maintenanceState);
                return (React.createElement("div", { className: "card", key: n.id, style: { overflow: "hidden" } },
                    quarantined && (React.createElement("div", { style: { background: "var(--crit)", color: "#fff", fontSize: 11, fontWeight: 600, padding: "5px 14px", letterSpacing: "0.03em" } },
                        "QUARANTINED",
                        n.quarantineReason ? ` — ${n.quarantineReason}` : "")),
                    !quarantined && inMaintenance && (React.createElement("div", { style: { background: "var(--accent)", color: "#fff", fontSize: 11, fontWeight: 600, padding: "5px 14px", letterSpacing: "0.03em" } },
                        "MAINTENANCE",
                        n.maintenanceState === "draining" ? " (draining)" : "")),
                    React.createElement("div", { className: "card-body", style: { display: "flex", flexDirection: "column", gap: 14 } },
                        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 } },
                            React.createElement("div", { style: { flex: 1, minWidth: 0 } },
                                React.createElement("div", { style: { fontWeight: 700, fontSize: 15, marginBottom: 3 } }, n.name),
                                React.createElement("a", { href: n.publicUrl || n.url || "#", target: "_blank", rel: "noreferrer", style: { display: "flex", alignItems: "center", gap: 4, textDecoration: "none" } },
                                    React.createElement("span", { className: "muted mono", style: { fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, n.publicUrl || n.url || "—"),
                                    React.createElement("span", { style: { width: 10, height: 10, display: "inline-flex", color: "var(--text-3)", flexShrink: 0 } }, Icon.externalLink)),
                                (n.region || n.site) && (React.createElement("div", { style: { display: "flex", gap: 6, marginTop: 5, flexWrap: "wrap" } },
                                    n.region && React.createElement("span", { className: "pill" }, n.region),
                                    n.site && React.createElement("span", { className: "pill" }, n.site)))),
                            React.createElement("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: 4, flexShrink: 0 } },
                                React.createElement(Donut, { value: trustScore, size: 62, stroke: 8 }),
                                React.createElement(StatusPill, { status: healthState }))),
                        React.createElement("div", { style: { paddingTop: 10, borderTop: "1px solid var(--line)" } },
                            React.createElement(NodeComponentsRow, { components: components }),
                            components.length === 0 && (React.createElement("div", { style: { fontSize: 11, color: "var(--text-3)" } }, "No health data yet"))),
                        React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 16px" } }, [
                            ["LAST SEEN", fmtAgo(n.lastSeenAt)],
                            ["VERSION", n.version || "—"],
                            mem != null ? ["MEMORY", mem + "%", mem > 90 ? "var(--crit)" : mem > 75 ? "var(--warn)" : null] : null,
                            disk != null ? ["DISK FREE", fmtBytes(disk), disk < 1e9 ? "var(--warn)" : null] : null,
                            latency != null ? ["LATENCY", latency + " ms", latency > 500 ? "var(--warn)" : null] : null,
                            skew != null && skew > 5000 ? ["CLOCK SKEW", Math.round(skew / 1000) + "s", "var(--warn)"] : null,
                            queueLag ? ["QUEUE LAG", queueLag, queueLag === "high" ? "var(--crit)" : queueLag === "medium" ? "var(--warn)" : null] : null,
                            certValid != null ? ["CERT", certValid ? "valid" : "expired/none", certValid ? null : "var(--warn)"] : null,
                        ].filter(Boolean).map(([label, val, color]) => (React.createElement("div", { key: label },
                            React.createElement("div", { className: "muted", style: { fontSize: 10 } }, label),
                            React.createElement("div", { className: "mono", style: { fontSize: 12, color: color || "var(--text)" } }, val))))),
                        React.createElement("div", { style: { paddingTop: 10, borderTop: "1px solid var(--line)", display: "grid", gap: 8 } },
                            React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 } },
                                React.createElement("div", { style: { minWidth: 0 } },
                                    React.createElement("div", { className: "muted", style: { fontSize: 10 } }, "TRUST INVESTIGATION"),
                                    React.createElement("div", { style: { fontSize: 12, color: quarantined ? "var(--crit)" : trustScore < 70 ? "var(--warn)" : "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, n.quarantineReason || reasons[0] || n.trust?.securityFindings?.[0]?.message || "No active trust findings")),
                                React.createElement("button", { className: "btn sm", onClick: () => setInvestigatingNode(n) }, "Investigate trust"))),
                        (n.capabilities || []).length > 0 && (React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 5, paddingTop: 8, borderTop: "1px solid var(--line)" } }, n.capabilities.map(c => React.createElement("span", { className: "pill", key: c, style: { fontSize: 11 } }, c)))),
                        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 8, borderTop: "1px solid var(--line)" } },
                            React.createElement("span", { className: "muted", style: { fontSize: 11 } }, n.firstSeenAt ? `Since ${fmtAgo(n.firstSeenAt)}` : n.id),
                            React.createElement("button", { className: "btn sm ghost danger", onClick: () => { setRemoveError(''); setRemoving(n); } }, "Remove")))));
            })),
        investigatingNode && (React.createElement(NodeTrustInvestigationDrawer, { node: (nodes.data || []).find(item => item.id === investigatingNode.id) || investigatingNode, onClose: () => setInvestigatingNode(null), onResetSafe: () => {
                nodes.reload();
                setInvestigatingNode(null);
            } })),
        enrolling && React.createElement(EnrollNodeWizard, { onClose: () => setEnrolling(false), onCreated: nodes.reload }),
        removing && (React.createElement("div", { className: "modal-overlay", onClick: () => !removeBusy && setRemoving(null) },
            React.createElement("div", { className: "modal-box", onClick: e => e.stopPropagation() },
                React.createElement("h3", null, "Remove node?"),
                React.createElement("p", null,
                    "This will permanently decommission ",
                    React.createElement("strong", null, removing.name),
                    ", revoke its mTLS certificate, and remove it from all node lists. This cannot be undone."),
                removeError && React.createElement("div", { className: "banner error" }, removeError),
                React.createElement("div", { className: "modal-actions" },
                    React.createElement("button", { className: "btn ghost", onClick: () => setRemoving(null), disabled: removeBusy }, "Cancel"),
                    React.createElement("button", { className: "btn danger", onClick: handleRemove, disabled: removeBusy },
                        removeBusy ? React.createElement("span", { className: "search-spinner" }) : null,
                        "Remove node")))))));
}
/**
 * Renders the enroll node drawer UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function EnrollNodeWizard({ onClose, onCreated }) {
    const [step, setStep] = useState("details");
    const [form, setForm] = useState({ name: "", publicUrl: "http://localhost:4200", region: "", site: "" });
    const [result, setResult] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const noticeTimer = useRef(null);
    const set = (key, value) => setForm(prev => ({ ...prev, [key]: value }));
    const oneLinerJson = result ? JSON.stringify(result) : "";
    const prettyJson = result ? JSON.stringify(result, null, 2) : "";
    const steps = [
        ["details", "Details"],
        ["enrollment", "Enrollment"],
        ["install", "Install"],
    ];
    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const created = await PatchAPI.createNodeEnrollment({
                name: form.name.trim(),
                publicUrl: form.publicUrl.trim(),
                region: form.region.trim() || undefined,
                site: form.site.trim() || undefined,
            });
            setResult(created);
            setStep("enrollment");
            onCreated?.(created);
        }
        catch (err) {
            setError(err);
        }
        finally {
            setBusy(false);
        }
    };
    const copy = async (text) => {
        const copied = await copyTextToClipboard(text);
        setNotice({ msg: copied ? "Copied to clipboard." : "Copy failed — select and copy manually.", ok: copied });
        if (noticeTimer.current)
            clearTimeout(noticeTimer.current);
        noticeTimer.current = setTimeout(() => setNotice(null), 2400);
    };
    return (React.createElement(React.Fragment, null,
        React.createElement("div", { className: "drawer-backdrop", onClick: onClose }),
        React.createElement("div", { className: "wizard-modal", role: "dialog", "aria-modal": "true" },
            React.createElement("div", { className: "wizard-head" },
                React.createElement("div", null,
                    React.createElement("h3", null, "Enroll backend node"),
                    React.createElement("p", null, "Generate an enrollment token for a new backend node.")),
                React.createElement("button", { className: "icon-btn", onClick: onClose },
                    React.createElement("span", { style: { width: 14, height: 14, display: "inline-flex" } }, Icon.close))),
            React.createElement("div", { className: "wizard-body" },
                React.createElement("div", { className: "wizard-steps" }, steps.map(([id, label]) => {
                    const done = (id === "details" && result) || (id === "enrollment" && result && step === "install");
                    const active = step === id;
                    return (React.createElement("button", { key: id, className: "wizard-step " + (active ? "active " : "") + (done ? "done" : ""), onClick: () => (id === "details" || result) && setStep(id) },
                        React.createElement("span", null, done ? "OK" : "--"),
                        label));
                })),
                React.createElement("div", { className: "wizard-panel" },
                    step === "details" && (React.createElement("form", { onSubmit: submit, style: { display: "flex", flexDirection: "column", gap: 14 } },
                        React.createElement("div", { className: "form-grid" },
                            React.createElement("label", { className: "field" },
                                React.createElement("span", null, "Name"),
                                React.createElement("input", { required: true, value: form.name, placeholder: "node-1", onChange: e => set("name", e.target.value) })),
                            React.createElement("label", { className: "field" },
                                React.createElement("span", null, "Public URL"),
                                React.createElement("input", { required: true, value: form.publicUrl, placeholder: "http://host:4200", onChange: e => set("publicUrl", e.target.value) })),
                            React.createElement("label", { className: "field" },
                                React.createElement("span", null, "Region"),
                                React.createElement("input", { value: form.region, placeholder: "eu-central", onChange: e => set("region", e.target.value) })),
                            React.createElement("label", { className: "field" },
                                React.createElement("span", null, "Site"),
                                React.createElement("input", { value: form.site, placeholder: "office-1", onChange: e => set("site", e.target.value) }))),
                        error && React.createElement(ErrorAlert, { error: error }),
                        React.createElement("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
                            React.createElement("button", { type: "button", className: "btn", onClick: onClose }, "Cancel"),
                            React.createElement("button", { className: "btn primary", disabled: busy }, busy ? "Creating…" : "Create enrollment")))),
                    step === "enrollment" && result && (React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 14 } },
                        React.createElement("div", { className: "success-card" },
                            React.createElement("strong", null, "Enrollment created"),
                            React.createElement("span", null, "Copy the JSON and paste it when the backend node asks for the enrollment.")),
                        React.createElement("textarea", { className: "codebox one-line", readOnly: true, value: oneLinerJson }),
                        React.createElement("details", null,
                            React.createElement("summary", { className: "muted", style: { cursor: "pointer" } }, "Pretty JSON"),
                            React.createElement("textarea", { className: "codebox", readOnly: true, value: prettyJson })),
                        React.createElement("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
                            React.createElement("button", { type: "button", className: "btn", disabled: !oneLinerJson, onClick: () => copy(oneLinerJson) }, "Copy JSON"),
                            React.createElement("button", { className: "btn primary", onClick: () => setStep("install") }, "Next")),
                        React.createElement("div", { className: "notice-slot " + (notice ? "show " + (notice.ok ? "ok" : "err") : ""), "aria-live": "polite" }, notice?.msg))),
                    step === "install" && result && (React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 14 } },
                        React.createElement("div", { className: "success-card" },
                            React.createElement("strong", null, "Start the backend node"),
                            React.createElement("span", null, "Run the node in an interactive console. When prompted for the enrollment JSON, paste what you copied.")),
                        React.createElement("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
                            React.createElement("button", { className: "btn", onClick: () => setStep("enrollment") }, "Back"),
                            React.createElement("button", { className: "btn primary", onClick: onClose }, "Done")))))))));
}
// ---------- Alarms ----------
/**
 * Renders the alarms page UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function AlarmsPage({ globalSearch = "" }) {
    const alarms = useResource(() => PatchAPI.alarms());
    useLiveResource(alarms, 5000);
    /**
     * Resolves resolve configuration.
     *
     * @param id Identifier used to locate the target record.
     */
    const resolve = async (id) => { try {
        await PatchAPI.resolveAlarm(id);
    }
    finally {
        alarms.reload();
    } };
    const [resolvingAll, setResolvingAll] = React.useState(false);
    const resolveAll = async () => { setResolvingAll(true); try {
        await PatchAPI.resolveAllAlarms();
    }
    finally {
        setResolvingAll(false);
        alarms.reload();
    } };
    const rows = (alarms.data || []).filter(a => textMatches(globalSearch, [a.message, a.deviceId, a.severity, a.id]));
    return (React.createElement("div", { className: "page" },
        React.createElement("div", { className: "page-head" },
            React.createElement("div", null,
                React.createElement("h2", null, "Alarms"),
                React.createElement("p", null, alarms.loading ? "…" : `${rows.length} active across the fleet`)),
            rows.length > 0 && React.createElement("button", { className: "btn", disabled: resolvingAll, onClick: resolveAll }, resolvingAll ? "Resolving…" : "Resolve all")),
        React.createElement("div", { className: "card" },
            alarms.error && React.createElement("div", { style: { padding: 16 } },
                React.createElement(ErrorAlert, { error: alarms.error, onRetry: alarms.reload })),
            React.createElement("div", { className: "card-body tight" },
                alarms.loading && React.createElement("div", { style: { padding: 16 } },
                    React.createElement(Skeleton, { h: 60 })),
                !alarms.loading && rows.length === 0 && React.createElement("div", { style: { padding: 24, color: "var(--text-3)" } }, "No active alarms."),
                !alarms.loading && rows.map(a => (React.createElement("div", { key: a.id, style: { display: "flex", gap: 14, padding: "14px 18px", borderBottom: "1px solid var(--line)", alignItems: "center" } },
                    React.createElement("div", { className: "sev-strip " + a.severity }),
                    React.createElement("div", { style: { flex: 1, minWidth: 0 } },
                        React.createElement("div", { style: { fontWeight: 500 } }, a.message),
                        React.createElement("div", { className: "muted", style: { fontSize: 12, marginTop: 2 } },
                            a.deviceId && React.createElement("span", { className: "mono" }, a.deviceId),
                            " \u00B7 ",
                            fmtAgo(a.createdAt))),
                    React.createElement("span", { className: "pill " + (a.severity === "critical" ? "crit" : a.severity === "warning" ? "warn" : "accent") }, a.severity),
                    React.createElement("button", { className: "btn sm ghost", onClick: () => resolve(a.id) }, "Resolve"))))))));
}
// ---------- Audit ----------
/**
 * Renders the audit page UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function AuditPage({ globalSearch = "" }) {
    const audit = useResource(() => PatchAPI.audit(100));
    useLiveResource(audit, 10000);
    const rows = (audit.data || []).filter(e => textMatches(globalSearch, [e.actor, e.action, e.target, e.id]));
    return (React.createElement("div", { className: "page" },
        React.createElement("div", { className: "page-head" },
            React.createElement("div", null,
                React.createElement("h2", null, "Audit log"),
                React.createElement("p", null, "Signed event stream for compliance review")),
            React.createElement("button", { className: "btn" },
                React.createElement("span", { style: { width: 14, height: 14, display: "inline-flex" } }, Icon.download),
                "Export")),
        React.createElement("div", { className: "card" },
            audit.error && React.createElement("div", { style: { padding: 16 } },
                React.createElement(ErrorAlert, { error: audit.error, onRetry: audit.reload })),
            React.createElement("table", { className: "tbl" },
                React.createElement("thead", null,
                    React.createElement("tr", null,
                        React.createElement("th", null, "Time"),
                        React.createElement("th", null, "Actor"),
                        React.createElement("th", null, "Action"),
                        React.createElement("th", null, "Target"))),
                React.createElement("tbody", null,
                    audit.loading && React.createElement(SkeletonRows, { n: 6, cols: 4 }),
                    !audit.loading && rows.length === 0 && React.createElement("tr", null,
                        React.createElement("td", { colSpan: 4, style: { padding: 24, color: "var(--text-3)" } }, "No audit events.")),
                    !audit.loading && rows.map((e, i) => (React.createElement("tr", { key: e.id || i },
                        React.createElement("td", { className: "muted" }, fmtAgo(e.createdAt)),
                        React.createElement("td", { className: "mono" }, e.actor),
                        React.createElement("td", null,
                            React.createElement("span", { className: "pill" }, e.action)),
                        React.createElement("td", null, e.target || "—")))))))));
}
// ---------- SIEM ----------
/**
 * Renders the siem page UI.
 * @returns The result produced by the operation.
 */
function SiemPage() {
    const [tenantId, setTenantId] = useState("default");
    const [form, setForm] = useState(defaultSiemConfig());
    const [notice, setNotice] = useState(null);
    const [busy, setBusy] = useState("");
    const config = useResource(() => PatchAPI.siemConfig(tenantId).catch(() => ({ tenantId, config: defaultSiemConfig() })), [tenantId]);
    const queue = useResource(() => PatchAPI.siemQueueStatus());
    useLiveResource(queue, 10000);
    useEffect(() => {
        if (config.data?.config)
            setForm(mergeSiemConfig(config.data.config));
    }, [config.data]);
    /**
     * Sets the set value.
     *
     * @param path Filesystem or URL path used by the operation.
     * @param value Value to read, render, or store.
     */
    const set = (path, value) => {
        setForm(prev => {
            const next = JSON.parse(JSON.stringify(prev));
            const parts = path.split(".");
            let cur = next;
            for (const part of parts.slice(0, -1))
                cur = cur[part] = cur[part] || {};
            cur[parts[parts.length - 1]] = value;
            return next;
        });
    };
    /**
     * Handles the payload operation.
     * @returns The result produced by the operation.
     */
    const payload = () => {
        const next = mergeSiemConfig(form);
        if (!next.webhook.url)
            delete next.webhook;
        if (!next.syslog.host)
            delete next.syslog;
        if (!next.sentinel.workspaceId)
            delete next.sentinel;
        return next;
    };
    /**
     * Handles the run operation.
     *
     * @param kind kind supplied to the function.
     */
    const run = async (kind) => {
        setBusy(kind);
        setNotice(null);
        try {
            const result = kind === "save"
                ? await PatchAPI.saveSiemConfig(tenantId, payload())
                : kind === "test"
                    ? await PatchAPI.testSiem(tenantId)
                    : await PatchAPI.verifySiem(tenantId);
            setNotice({ ok: true, text: kind === "save" ? "SIEM configuration saved." : JSON.stringify(result.results || result, null, 2) });
            config.reload(true);
            queue.reload(true);
        }
        catch (err) {
            setNotice({ ok: false, text: err?.message || String(err) });
        }
        finally {
            setBusy("");
        }
    };
    const webhookConfigured = !!form.webhook.url;
    const syslogConfigured = !!form.syslog.host;
    const sentinelConfigured = !!form.sentinel.workspaceId;
    const queueDepth = queue.loading ? null : (queue.data?.queueDepth ?? 0);
    return (React.createElement("div", { className: "page" },
        React.createElement("div", { className: "page-head" },
            React.createElement("div", null,
                React.createElement("h2", null, "SIEM integrations"),
                React.createElement("p", null, "Export security events to Webhook, Syslog, and Microsoft Sentinel")),
            React.createElement("div", { style: { display: "flex", gap: 8 } },
                React.createElement("button", { className: "btn", disabled: busy, onClick: () => run("verify") }, busy === "verify" ? "Checking…" : "Verify"),
                React.createElement("button", { className: "btn", disabled: busy, onClick: () => run("test") }, busy === "test" ? "Sending…" : "Test"),
                React.createElement("button", { className: "btn primary", disabled: busy, onClick: () => run("save") }, busy === "save" ? "Saving…" : "Save"))),
        config.error && React.createElement(ErrorAlert, { error: config.error, onRetry: config.reload }),
        notice && (React.createElement("div", { className: `siem-notice ${notice.ok ? "ok" : "err"}` },
            React.createElement("span", { className: "siem-notice-icon" }, notice.ok
                ? React.createElement("svg", { width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" },
                    React.createElement("path", { d: "M13 4L6.5 11 3 7.5" }))
                : React.createElement("svg", { width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round" },
                    React.createElement("path", { d: "M8 5v4M8 11v1" }),
                    React.createElement("circle", { cx: "8", cy: "8", r: "6.5" }))),
            React.createElement("pre", { style: { margin: 0, whiteSpace: "pre-wrap", flex: 1, fontFamily: "inherit", fontSize: 13 } }, notice.text),
            React.createElement("button", { className: "btn ghost sm", style: { flexShrink: 0 }, onClick: () => setNotice(null) },
                React.createElement("svg", { width: "12", height: "12", viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round" },
                    React.createElement("path", { d: "M1 1l10 10M11 1 1 11" }))))),
        React.createElement("div", { className: "siem-config-strip" },
            React.createElement("div", { className: "siem-config-group" },
                React.createElement("span", { className: "siem-config-label" }, "Tenant"),
                React.createElement("input", { className: "siem-config-input", value: tenantId, onChange: e => setTenantId(e.target.value || "default") })),
            React.createElement("div", { className: "siem-config-sep" }),
            React.createElement("div", { className: "siem-config-group" },
                React.createElement("span", { className: "siem-config-label" }, "Export mode"),
                React.createElement("div", { className: "segmented" }, ["minimal", "standard", "full"].map(m => (React.createElement("button", { key: m, className: form.mode === m ? "active" : "", onClick: () => set("mode", m) }, m))))),
            React.createElement("div", { className: "siem-config-sep" }),
            React.createElement("div", { className: "siem-config-group", style: { marginLeft: "auto" } },
                React.createElement("span", { className: "siem-config-label" }, "Queue depth"),
                React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                    React.createElement("span", { className: `siem-queue-dot ${queueDepth > 0 ? "active" : ""}` }),
                    React.createElement("span", { className: "siem-queue-num" }, queueDepth === null ? "…" : queueDepth)))),
        React.createElement("div", { className: "row-3" },
            React.createElement("div", { className: "card siem-card" },
                React.createElement("div", { className: "siem-card-accent", style: { background: "var(--accent)" } }),
                React.createElement("div", { className: "card-head", style: { gap: 12 } },
                    React.createElement("div", { className: "siem-card-icon", style: { background: "var(--accent-soft)", color: "var(--accent)" } },
                        React.createElement("svg", { width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.75", strokeLinecap: "round", strokeLinejoin: "round" },
                            React.createElement("path", { d: "M2 8c0-3.3 2.7-6 6-6" }),
                            React.createElement("path", { d: "M14 8c0 3.3-2.7 6-6 6" }),
                            React.createElement("path", { d: "M9 5l3 3-3 3" }),
                            React.createElement("path", { d: "M7 11l-3-3 3-3" }))),
                    React.createElement("div", { style: { flex: 1, minWidth: 0 } },
                        React.createElement("h3", { style: { margin: 0, fontSize: 14, fontWeight: 600 } }, "Webhook"),
                        React.createElement("div", { className: "sub" }, "HTTPS JSON array export")),
                    React.createElement("span", { className: `pill ${webhookConfigured ? "ok" : ""}` }, webhookConfigured ? "active" : "not set")),
                React.createElement("div", { className: "card-body", style: { display: "flex", flexDirection: "column", gap: 14 } },
                    React.createElement("label", { className: "field" },
                        React.createElement("span", null, "URL"),
                        React.createElement("input", { value: form.webhook.url, onChange: e => set("webhook.url", e.target.value), placeholder: "https://siem.example/events" })),
                    React.createElement("label", { className: "field" },
                        React.createElement("span", null, "HMAC secret"),
                        React.createElement("input", { type: "password", value: form.webhook.secret, onChange: e => set("webhook.secret", e.target.value), placeholder: "optional" })))),
            React.createElement("div", { className: "card siem-card" },
                React.createElement("div", { className: "siem-card-accent", style: { background: "var(--warn)" } }),
                React.createElement("div", { className: "card-head", style: { gap: 12 } },
                    React.createElement("div", { className: "siem-card-icon", style: { background: "var(--warn-soft)", color: "var(--warn)" } },
                        React.createElement("svg", { width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.75", strokeLinecap: "round", strokeLinejoin: "round" },
                            React.createElement("rect", { x: "1.5", y: "2.5", width: "13", height: "11", rx: "1.5" }),
                            React.createElement("path", { d: "M4.5 6l2.5 2.5L4.5 11" }),
                            React.createElement("path", { d: "M9 11h2.5" }))),
                    React.createElement("div", { style: { flex: 1, minWidth: 0 } },
                        React.createElement("h3", { style: { margin: 0, fontSize: 14, fontWeight: 600 } }, "Syslog"),
                        React.createElement("div", { className: "sub" }, "RFC5424 UDP or TCP")),
                    React.createElement("span", { className: `pill ${syslogConfigured ? "ok" : ""}` }, syslogConfigured ? "active" : "not set")),
                React.createElement("div", { className: "card-body", style: { display: "flex", flexDirection: "column", gap: 14 } },
                    React.createElement("label", { className: "field" },
                        React.createElement("span", null, "Host"),
                        React.createElement("input", { value: form.syslog.host, onChange: e => set("syslog.host", e.target.value), placeholder: "syslog.example" })),
                    React.createElement("label", { className: "field" },
                        React.createElement("span", null, "Port"),
                        React.createElement("input", { type: "number", value: form.syslog.port, onChange: e => set("syslog.port", Number(e.target.value || 514)) })),
                    React.createElement("label", { className: "field" },
                        React.createElement("span", null, "Protocol"),
                        React.createElement("select", { className: "siem-select", value: form.syslog.protocol, onChange: e => set("syslog.protocol", e.target.value) },
                            React.createElement("option", { value: "udp" }, "udp"),
                            React.createElement("option", { value: "tcp" }, "tcp"))))),
            React.createElement("div", { className: "card siem-card" },
                React.createElement("div", { className: "siem-card-accent", style: { background: "oklch(0.55 0.18 290)" } }),
                React.createElement("div", { className: "card-head", style: { gap: 12 } },
                    React.createElement("div", { className: "siem-card-icon", style: { background: "oklch(0.95 0.04 290)", color: "oklch(0.45 0.18 290)" } },
                        React.createElement("svg", { width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.75", strokeLinecap: "round", strokeLinejoin: "round" },
                            React.createElement("path", { d: "M8 1.5L2 4v4c0 3.3 2.5 5.7 6 6.5 3.5-.8 6-3.2 6-6.5V4L8 1.5z" }),
                            React.createElement("path", { d: "M5.5 8.5l2 2 3.5-3.5" }))),
                    React.createElement("div", { style: { flex: 1, minWidth: 0 } },
                        React.createElement("h3", { style: { margin: 0, fontSize: 14, fontWeight: 600 } }, "Microsoft Sentinel"),
                        React.createElement("div", { className: "sub" }, "Log Analytics Data Collector API")),
                    React.createElement("span", { className: `pill ${sentinelConfigured ? "ok" : ""}` }, sentinelConfigured ? "active" : "not set")),
                React.createElement("div", { className: "card-body", style: { display: "flex", flexDirection: "column", gap: 14 } },
                    React.createElement("label", { className: "field" },
                        React.createElement("span", null, "Workspace ID"),
                        React.createElement("input", { value: form.sentinel.workspaceId, onChange: e => set("sentinel.workspaceId", e.target.value), placeholder: "workspace-guid" })),
                    React.createElement("label", { className: "field" },
                        React.createElement("span", null, "Shared key"),
                        React.createElement("input", { type: "password", value: form.sentinel.sharedKey, onChange: e => set("sentinel.sharedKey", e.target.value), placeholder: "base64 key" })),
                    React.createElement("label", { className: "field" },
                        React.createElement("span", null, "Log type"),
                        React.createElement("input", { value: form.sentinel.logType, onChange: e => set("sentinel.logType", e.target.value || "OnePatchEvents") })))))));
}
/**
 * Handles the default siem config operation.
 * @returns The result produced by the operation.
 */
function defaultSiemConfig() {
    return {
        mode: "standard",
        webhook: { url: "", secret: "" },
        syslog: { host: "", port: 514, protocol: "udp", appName: "1patch" },
        sentinel: { workspaceId: "", sharedKey: "", logType: "OnePatchEvents" },
        exportOverrides: {},
    };
}
/**
 * Handles the merge siem config operation.
 *
 * @param config Configuration object used by the operation.
 * @returns The result produced by the operation.
 */
function mergeSiemConfig(config) {
    const base = defaultSiemConfig();
    return {
        ...base,
        ...config,
        webhook: { ...base.webhook, ...(config.webhook || {}) },
        syslog: { ...base.syslog, ...(config.syslog || {}) },
        sentinel: { ...base.sentinel, ...(config.sentinel || {}) },
        exportOverrides: config.exportOverrides || {},
    };
}
// ---------- Security Posture ----------
/**
 * Renders the security posture page UI.
 * @returns The result produced by the operation.
 */
function SecurityPosturePage() {
    const [tenantId, setTenantId] = useState("default");
    const [notice, setNotice] = useState(null);
    const [busy, setBusy] = useState("");
    const posture = useResource(() => PatchAPI.securityPosture(tenantId), [tenantId]);
    const report = posture.data;
    const critical = report?.findingsBySeverity?.critical || [];
    const findings = report?.findings || [];
    const safeFixCount = findings.filter(f => f.autoFixAvailable && f.severity !== "critical").length;
    /**
     * Handles the rerun operation.
     */
    const rerun = () => {
        setNotice(null);
        posture.reload(false);
    };
    /**
     * Handles the apply safe operation.
     */
    const applySafe = async () => {
        setBusy("fix");
        setNotice(null);
        try {
            const result = await PatchAPI.fixSecurityPosture(tenantId);
            setNotice({ ok: true, text: `Applied ${result.applied.length} safe fix${result.applied.length === 1 ? "" : "es"}.` });
            posture.reload(true);
        }
        catch (err) {
            setNotice({ ok: false, text: err?.message || String(err) });
        }
        finally {
            setBusy("");
        }
    };
    /**
     * Handles the export json operation.
     */
    const exportJson = () => {
        const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `1patch-security-posture-${tenantId}-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
    };
    const scoreTone = report?.score >= 85 ? "ok" : report?.score >= 70 ? "warn" : "crit";
    return (React.createElement("div", { className: "page posture-page" },
        React.createElement("div", { className: "page-head" },
            React.createElement("div", null,
                React.createElement("h2", null, "Security Posture"),
                React.createElement("p", null, "Auditable setup health for enterprise readiness")),
            React.createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
                React.createElement("label", { className: "posture-tenant" },
                    React.createElement("span", null, "Tenant"),
                    React.createElement("input", { value: tenantId, onChange: e => setTenantId(e.target.value || "default") })),
                React.createElement("button", { className: "btn", onClick: rerun, disabled: posture.loading },
                    React.createElement("span", { style: { width: 14, height: 14, display: "inline-flex" } }, Icon.refresh),
                    "Re-run check"),
                React.createElement("button", { className: "btn", onClick: exportJson, disabled: !report },
                    React.createElement("span", { style: { width: 14, height: 14, display: "inline-flex" } }, Icon.download),
                    "Export JSON"),
                React.createElement("button", { className: "btn", onClick: () => window.print(), disabled: !report }, "Export PDF"),
                React.createElement("button", { className: "btn primary", onClick: applySafe, disabled: !safeFixCount || busy === "fix" }, busy === "fix" ? "Applying..." : `Apply safe fixes${safeFixCount ? ` (${safeFixCount})` : ""}`))),
        posture.error && React.createElement(ErrorAlert, { error: posture.error, onRetry: posture.reload }),
        notice && React.createElement("div", { className: "alert", style: { borderColor: notice.ok ? "var(--ok)" : "var(--crit)", background: notice.ok ? "var(--ok-soft)" : "var(--crit-soft)", color: notice.ok ? "var(--ok)" : "var(--crit)" } }, notice.text),
        React.createElement("div", { className: "posture-hero card" },
            React.createElement("div", { className: "posture-score" }, posture.loading ? React.createElement(Skeleton, { w: 132, h: 132, r: 66 }) : React.createElement(Donut, { value: report?.score ?? 0 })),
            React.createElement("div", { className: "posture-summary" },
                React.createElement("div", { className: "pulse-sub" }, "Overall security score"),
                React.createElement("div", { className: `posture-score-text ${scoreTone}` }, posture.loading ? "..." : `${report.score}/100`),
                React.createElement("div", { className: "posture-meta" },
                    React.createElement("span", { className: `pill ${modeTone(report?.mode)}` }, report?.mode || "..."),
                    React.createElement("span", null,
                        "Last checked ",
                        report ? fmtAgo(report.generatedAt) : "..."))),
            React.createElement("div", { className: "posture-verdict" }, posture.loading ? React.createElement(Skeleton, { h: 80 }) : (React.createElement(React.Fragment, null,
                React.createElement("strong", null, enterpriseVerdict(report.score, critical.length)),
                React.createElement("span", null, critical.length ? `${critical.length} critical issue${critical.length === 1 ? "" : "s"} must be fixed first.` : "No critical issues detected in the current posture checks."))))),
        critical.length > 0 && (React.createElement("div", { className: "card posture-critical" },
            React.createElement("div", { className: "card-head" },
                React.createElement("div", null,
                    React.createElement("h3", null, "Critical issues"),
                    React.createElement("div", { className: "sub" }, "Fix these before treating the tenant as enterprise-ready"))),
            React.createElement("div", { className: "card-body posture-finding-list" }, critical.map(f => React.createElement(SecurityFindingCard, { key: f.id, finding: f, onFix: applySafe, busy: busy }))))),
        React.createElement("div", { className: "posture-categories" },
            (report?.categoryBreakdown || []).map(category => (React.createElement("div", { className: `posture-category ${category.status}`, key: category.category },
                React.createElement("div", null,
                    React.createElement("strong", null, category.label),
                    React.createElement("span", null, category.findingCount ? `${category.findingCount} issue${category.findingCount === 1 ? "" : "s"}` : "No findings")),
                React.createElement("span", { className: `pill ${category.status === "critical" ? "crit" : category.status === "warning" ? "warn" : "ok"}` }, category.status)))),
            posture.loading && Array.from({ length: 8 }).map((_, i) => React.createElement("div", { className: "posture-category", key: i },
                React.createElement(Skeleton, { w: 130 }),
                React.createElement(Skeleton, { w: 62 })))),
        React.createElement("div", { className: "card" },
            React.createElement("div", { className: "card-head" },
                React.createElement("div", null,
                    React.createElement("h3", null, "Findings"),
                    React.createElement("div", { className: "sub" }, posture.loading ? "Loading" : `${findings.length} total`))),
            React.createElement("div", { className: "card-body posture-finding-list" },
                posture.loading && Array.from({ length: 5 }).map((_, i) => React.createElement(Skeleton, { key: i, h: 92 })),
                !posture.loading && findings.length === 0 && React.createElement("div", { className: "empty" }, "No posture findings detected."),
                !posture.loading && findings.map(f => React.createElement(SecurityFindingCard, { key: f.id, finding: f, onFix: applySafe, busy: busy }))))));
}
/**
 * Renders the security finding card UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function SecurityFindingCard({ finding, onFix, busy }) {
    return (React.createElement("div", { className: `posture-finding ${finding.severity}` },
        React.createElement("div", { className: "posture-finding-main" },
            React.createElement("div", { className: "posture-finding-title" },
                React.createElement("strong", null, finding.title),
                React.createElement("span", { className: `pill ${severityTone(finding.severity)}` }, finding.severity)),
            React.createElement("p", null, finding.description),
            React.createElement("dl", null,
                React.createElement("dt", null, "Risk"),
                React.createElement("dd", null, finding.riskExplanation),
                React.createElement("dt", null, "Fix"),
                React.createElement("dd", null, finding.fixSuggestion))),
        React.createElement("div", { className: "posture-finding-actions" }, finding.autoFixAvailable
            ? React.createElement("button", { className: "btn sm", onClick: onFix, disabled: busy === "fix" || finding.severity === "critical" }, finding.severity === "critical" ? "Confirm manually" : "Fix")
            : React.createElement("span", { className: "muted" }, "Manual"))));
}
/**
 * Handles the severity tone operation.
 *
 * @param severity severity supplied to the function.
 * @returns The result produced by the operation.
 */
function severityTone(severity) {
    return severity === "critical" ? "crit" : severity === "high" || severity === "medium" ? "warn" : "accent";
}
/**
 * Handles the mode tone operation.
 *
 * @param mode mode supplied to the function.
 * @returns The result produced by the operation.
 */
function modeTone(mode) {
    return mode === "tinfoil" ? "crit" : mode === "strict" ? "ok" : "warn";
}
/**
 * Handles the enterprise verdict operation.
 *
 * @param score score supplied to the function.
 * @param criticalCount critical count supplied to the function.
 * @returns The result produced by the operation.
 */
function enterpriseVerdict(score, criticalCount) {
    if (criticalCount > 0)
        return "Not enterprise-ready yet";
    if (score >= 85)
        return "Enterprise-ready posture";
    if (score >= 70)
        return "Close, with remediation needed";
    return "Needs security hardening";
}
// ---------- Device drawer ----------
/**
 * Renders the device drawer UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function DeviceDrawer({ deviceId, onClose }) {
    const detail = useResource(() => PatchAPI.device(deviceId), [deviceId]);
    useLiveResource(detail, 2500);
    const [deviceNotice, setDeviceNotice] = useState(null);
    const [queuingApp, setQueuingApp] = useState(null);
    if (!deviceId)
        return null;
    const d = detail.data?.device;
    const apps = detail.data?.installedApps || [];
    const tasks = sortTasksNewestFirst(detail.data?.tasks || []);
    // compute "outdated" client-side from latest version per app/publisher across the response
    const latest = new Map();
    for (const a of apps) {
        const k = `${a.name}|${a.publisher || ""}`;
        const version = a.latestVersion || a.version;
        if (!latest.has(k) || version.localeCompare(latest.get(k), undefined, { numeric: true }) > 0)
            latest.set(k, version);
    }
    const outdated = apps.filter(a => a.version !== latest.get(`${a.name}|${a.publisher || ""}`)).length;
    const platform = d?.platform || (/(windows|win)/i.test(d?.os || "") ? "windows" : "linux");
    const online = d?.lastSeenAt ? Date.now() - new Date(d.lastSeenAt).getTime() < 2 * 60000 : false;
    /**
     * Handles the refresh operation.
     */
    const refresh = async () => { try {
        await PatchAPI.refreshInventory(deviceId);
    }
    finally {
        detail.reload();
    } };
    /**
     * Updates the all record or state.
     */
    const updateAll = async () => {
        try {
            const result = await PatchAPI.updateAllOutdated(deviceId);
            const count = result?.tasks?.length ?? 0;
            const msg = count > 0
                ? `Queued ${count} update task${count !== 1 ? "s" : ""}.`
                : "All apps are already up to date.";
            setDeviceNotice({ ok: count > 0, msg });
            setTimeout(() => setDeviceNotice(null), 5000);
        }
        finally {
            detail.reload();
        }
    };
    /**
     * Updates the app record or state.
     *
     * @param app app supplied to the function.
     */
    const updateApp = async (app) => {
        const key = `${app.name}|${app.publisher || ""}`;
        if (queuingApp === key)
            return;
        setQueuingApp(key);
        try {
            await PatchAPI.updateDeviceForApp(app.name, {
                deviceId,
                packageId: app.packageId,
                productCode: app.productCode,
                targetVersion: 'latest',
            });
            setDeviceNotice({ ok: true, msg: `Queued update for ${app.name}.` });
            detail.reload();
        }
        catch (e) {
            setDeviceNotice({ ok: false, msg: `Failed to queue update for ${app.name}: ${e?.message ?? "unknown error"}` });
        }
        finally {
            setQueuingApp(null);
            setTimeout(() => setDeviceNotice(null), 5000);
        }
    };
    return (React.createElement(React.Fragment, null,
        React.createElement("div", { className: "drawer-backdrop", onClick: onClose }),
        React.createElement("div", { className: "drawer" },
            React.createElement("div", { className: "drawer-head" },
                React.createElement("h3", null,
                    d ? React.createElement(OsIcon, { platform: platform }) : null,
                    React.createElement("span", { className: "mono" }, d?.hostname || deviceId),
                    d && React.createElement(StatusPill, { status: online ? "online" : "offline" })),
                React.createElement("button", { className: "icon-btn", onClick: onClose },
                    React.createElement("span", { style: { width: 14, height: 14, display: "inline-flex" } }, Icon.close))),
            React.createElement("div", { className: "drawer-body" },
                detail.error && React.createElement(ErrorAlert, { error: detail.error, onRetry: detail.reload }),
                detail.loading && React.createElement(Skeleton, { h: 240 }),
                !detail.loading && d && (React.createElement(React.Fragment, null,
                    React.createElement("div", { className: "drawer-actions" },
                        React.createElement("button", { className: "btn primary", onClick: refresh }, "Refresh inventory"),
                        React.createElement("button", { className: "btn accent", onClick: updateAll },
                            "Update all (",
                            outdated,
                            ")")),
                    deviceNotice && (React.createElement("div", { className: `toast-inline${deviceNotice.ok ? "" : " error"}`, style: { margin: "0 0 12px" } }, deviceNotice.msg)),
                    React.createElement("div", { className: "card" },
                        React.createElement("div", { className: "card-body" },
                            React.createElement("dl", { className: "kv" },
                                React.createElement("dt", null, "Device ID"),
                                React.createElement("dd", { className: "mono" }, d.id),
                                React.createElement("dt", null, "OS"),
                                React.createElement("dd", null, formatOs(d.os)),
                                React.createElement("dt", null, "Site"),
                                React.createElement("dd", null, d.site || "—"),
                                React.createElement("dt", null, "Backend node"),
                                React.createElement("dd", { className: "mono" }, d.preferredNodeId || "—"),
                                React.createElement("dt", null, "Last seen"),
                                React.createElement("dd", null, fmtAgo(d.lastSeenAt)),
                                React.createElement("dt", null, "Apps"),
                                React.createElement("dd", null,
                                    apps.length,
                                    " installed \u00B7 ",
                                    React.createElement("span", { style: { color: outdated ? "var(--warn)" : "var(--text-3)" } },
                                        outdated,
                                        " outdated"))))),
                    React.createElement("div", { className: "card" },
                        React.createElement("div", { className: "card-head" },
                            React.createElement("h3", null, "Installed apps"),
                            React.createElement("div", { className: "sub" }, apps.length)),
                        React.createElement("div", { style: { maxHeight: 280, overflowY: "auto" } },
                            React.createElement("table", { className: "tbl" },
                                React.createElement("thead", null,
                                    React.createElement("tr", null,
                                        React.createElement("th", null, "App"),
                                        React.createElement("th", null, "Installed"),
                                        React.createElement("th", null, "Latest"),
                                        React.createElement("th", null))),
                                React.createElement("tbody", null, apps.map((a, i) => {
                                    const want = a.latestVersion || latest.get(`${a.name}|${a.publisher || ""}`);
                                    const isOutdated = a.version !== want;
                                    const key = `${a.name}|${a.publisher || ""}`;
                                    return (React.createElement("tr", { key: i },
                                        React.createElement("td", null, a.name),
                                        React.createElement("td", { className: "mono", style: { color: isOutdated ? "var(--warn)" : "var(--text)" } }, a.version),
                                        React.createElement("td", { className: "mono muted" }, want),
                                        React.createElement("td", null, isOutdated && React.createElement("button", { className: "btn sm", disabled: queuingApp === key, onClick: () => updateApp(a) }, queuingApp === key ? "Queuing…" : "Update"))));
                                }))))),
                    tasks.length > 0 && (React.createElement("div", { className: "card" },
                        React.createElement("div", { className: "card-head" },
                            React.createElement("h3", null, "Tasks"),
                            React.createElement("div", { className: "sub" }, tasks.length)),
                        React.createElement("div", { className: "drawer-table-scroll" },
                            React.createElement("table", { className: "tbl" },
                                React.createElement("thead", null,
                                    React.createElement("tr", null,
                                        React.createElement("th", null, "App"),
                                        React.createElement("th", null, "Version"),
                                        React.createElement("th", null, "Status"))),
                                React.createElement("tbody", null, tasks.map(t => (React.createElement("tr", { key: t.id },
                                    React.createElement("td", null, taskLabel(t)),
                                    React.createElement("td", { className: "mono muted" }, taskVersionLabel(t)),
                                    React.createElement("td", null,
                                        React.createElement(StatusPill, { status: t.status }))))))))))))))));
}
// ── SSO Settings Page ──────────────────────────────────────────────────────
const SSO_PROVIDER_LABELS = {
    microsoft: 'Microsoft Entra ID',
    google: 'Google Workspace',
    github: 'GitHub',
    okta: 'Okta',
    oidc: 'Generic OIDC',
};
const SSO_PROVIDER_META = [
    { type: 'microsoft', label: 'Microsoft Entra ID', desc: 'Azure AD · Office 365', badge: 'Popular' },
    { type: 'google', label: 'Google Workspace', desc: 'Google accounts' },
    { type: 'github', label: 'GitHub', desc: 'GitHub.com or GHES' },
    { type: 'okta', label: 'Okta', desc: 'Okta Universal Directory' },
    { type: 'oidc', label: 'Generic OIDC', desc: 'Any OIDC-compliant IdP' },
];
const SSO_ROLE_OPTIONS = [
    { value: 'viewer', label: 'Viewer' },
    { value: 'auditor', label: 'Auditor' },
    { value: 'node_operator', label: 'Node Operator' },
    { value: 'patch_manager', label: 'Patch Manager' },
    { value: 'admin', label: 'Admin' },
];
function roleLabel(role, rbac) {
    return (rbac?.roleDefinitions || []).find(r => r.id === role)?.name || role;
}
function roleOptionsFromRbac(rbac) {
    const definitions = rbac?.roleDefinitions || [];
    return definitions.length
        ? definitions.map(role => ({ value: role.id, label: role.name || role.id }))
        : SSO_ROLE_OPTIONS;
}
const SSO_SETUP_GUIDE = {
    microsoft: {
        portalUrl: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
        portalLabel: 'Open Azure Portal',
        steps: [
            { text: 'Go to Azure Portal → App registrations' },
            { text: 'Click New registration and give the app a name (e.g. "1Patch")' },
            { text: 'Choose Supported account types — Single tenant for your org only, or Multitenant / organizations for any work account' },
            { text: 'Under Redirect URI, select Web and paste this callback URL:', uri: true },
            { text: 'Click Register — note the Application (client) ID and Directory (tenant) ID from the Overview page' },
            { text: 'Go to Certificates & secrets → New client secret → copy the Value (not the Secret ID)' },
        ],
        tip: {
            title: 'Security recommendations',
            items: [
                {
                    heading: 'Restrict sign-in to specific groups',
                    text: 'By default, any user in your tenant can authenticate. Set the app to require explicit assignment.',
                    steps: [
                        'Open Enterprise applications and find the app you just registered',
                        'Under Properties, set "Assignment required?" to Yes',
                        'Under Users and groups, add the groups or users allowed to sign in to 1Patch',
                    ],
                    linkUrl: 'https://portal.azure.com/#view/Microsoft_AAD_IAM/StartboardApplicationsMenuBlade/~/AppAppsPreview',
                    linkLabel: 'Enterprise applications',
                },
                {
                    heading: 'Configure Conditional Access',
                    text: 'Enforce MFA, require compliant devices, or restrict by location for all 1Patch sign-ins.',
                    steps: [
                        'Go to Azure AD → Security → Conditional Access → New policy',
                        'Under Cloud apps, select the 1Patch app registration',
                        'Add conditions (device compliance, named location, sign-in risk) and require MFA as a grant control',
                    ],
                    linkUrl: 'https://portal.azure.com/#view/Microsoft_AAD_ConditionalAccess/CaTemplates.ReactView',
                    linkLabel: 'Conditional Access',
                },
                {
                    heading: 'Rotate client secrets before expiry',
                    text: 'Client secrets have a fixed expiry. Letting one expire will break SSO until rotated.',
                    steps: [
                        'In App registrations → Certificates & secrets, note the expiry date of your secret',
                        'Create a new secret before it expires, update it in 1Patch (Settings → Edit), then delete the old one',
                    ],
                    linkUrl: null,
                    linkLabel: null,
                },
                {
                    heading: 'Monitor sign-in activity',
                    text: 'Review Entra sign-in logs regularly to detect anomalous or unexpected access.',
                    steps: [
                        'Azure AD → Monitoring → Sign-in logs — filter by your app to see all authentications',
                        'Consider exporting logs to a Log Analytics workspace or SIEM via Diagnostic settings',
                    ],
                    linkUrl: 'https://portal.azure.com/#view/Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/~/SignIns',
                    linkLabel: 'Sign-in logs',
                },
            ],
        },
    },
    google: {
        portalUrl: 'https://console.cloud.google.com/apis/credentials',
        portalLabel: 'Open Google Cloud Console',
        steps: [
            { text: 'Go to APIs & Services → Credentials' },
            { text: 'Click Create credentials → OAuth client ID' },
            { text: 'Application type: Web application' },
            { text: 'Under Authorized redirect URIs, paste this URL:', uri: true },
            { text: 'Copy the Client ID and Client secret from the confirmation dialog' },
        ],
        tip: {
            title: 'Security recommendations',
            items: [
                {
                    heading: 'Restrict to your Google Workspace org',
                    text: 'By default, any Google account can authenticate — including personal accounts.',
                    steps: [
                        'Go to APIs & Services → OAuth consent screen',
                        'Set User type to Internal to limit sign-in to your Workspace org only',
                        'For partner domains, use the "Allowed email domains" field in the next step instead',
                    ],
                    linkUrl: 'https://console.cloud.google.com/apis/credentials/consent',
                    linkLabel: 'OAuth consent screen',
                },
                {
                    heading: 'Configure Context-Aware Access',
                    text: 'Google Workspace\'s equivalent of Conditional Access — restrict by device trust level, location, or IP range.',
                    steps: [
                        'In Google Admin → Security → Access and data control → Context-Aware Access',
                        'Create an access level (e.g. require corp device or specific IP range)',
                        'Assign the access level to the OAuth app under "App access control"',
                    ],
                    linkUrl: 'https://admin.google.com/ac/contextawareaccess/accesslevel',
                    linkLabel: 'Context-Aware Access',
                },
                {
                    heading: 'Enforce 2-Step Verification',
                    text: 'Require 2SV for all users in your org before they can authenticate to any app including 1Patch.',
                    steps: [
                        'Google Admin → Security → 2-Step Verification → turn on enforcement for your org',
                    ],
                    linkUrl: 'https://admin.google.com/ac/security/2sv',
                    linkLabel: 'Google Admin 2SV',
                },
                {
                    heading: 'Review OAuth app access',
                    text: 'Audit which apps have access to your users\' data in the Google security dashboard.',
                    steps: [
                        'Google Admin → Security → API controls → App access control — review and revoke as needed',
                    ],
                    linkUrl: null,
                    linkLabel: null,
                },
            ],
        },
    },
    github: {
        portalUrl: 'https://github.com/settings/developers',
        portalLabel: 'Open GitHub Developer Settings',
        steps: [
            { text: 'Go to Settings → Developer settings → OAuth Apps → New OAuth App' },
            { text: 'Fill in Application name and Homepage URL' },
            { text: 'Under Authorization callback URL, paste this URL:', uri: true },
            { text: 'Click Register application, then generate a new client secret' },
        ],
        tip: {
            title: 'Security recommendations',
            items: [
                {
                    heading: 'GitHub OAuth cannot restrict by org membership',
                    text: 'Unlike Entra or Okta, GitHub OAuth Apps have no native group restriction. Use these controls instead.',
                    steps: [
                        'Set "Allowed email domains" in the next step to your company domain — this blocks personal GitHub accounts',
                        'Keep auto-provision off and manually approve each user after their first sign-in',
                    ],
                    linkUrl: null,
                    linkLabel: null,
                },
                {
                    heading: 'Require 2FA for all organization members',
                    text: 'Enforce two-factor authentication for your GitHub org — accounts without 2FA will be blocked.',
                    steps: [
                        'GitHub → Your organization → Settings → Authentication security → Require two-factor authentication',
                    ],
                    linkUrl: 'https://github.com/organizations',
                    linkLabel: 'GitHub Organization settings',
                },
                {
                    heading: 'Rotate the client secret periodically',
                    text: 'GitHub client secrets don\'t expire automatically, but rotating them limits exposure if leaked.',
                    steps: [
                        'In your OAuth App settings, click "Generate a new client secret"',
                        'Update the secret in 1Patch (Settings → Edit), then delete the old one from GitHub',
                    ],
                    linkUrl: 'https://github.com/settings/developers',
                    linkLabel: 'GitHub Developer settings',
                },
            ],
        },
    },
    okta: {
        portalUrl: null,
        portalLabel: 'Open Okta Admin Console',
        steps: [
            { text: 'Go to Applications → Create App Integration' },
            { text: 'Choose OIDC – OpenID Connect → Web Application' },
            { text: 'Under Sign-in redirect URIs, paste this URL:', uri: true },
            { text: 'Copy the Client ID and Client secret, and note your Okta domain' },
        ],
        tip: {
            title: 'Security recommendations',
            items: [
                {
                    heading: 'Restrict sign-in to specific groups',
                    text: 'By default the app is accessible to everyone in your org. Limit it to specific groups.',
                    steps: [
                        'Open the application in Okta Admin Console',
                        'Go to the Assignments tab → change from "Everyone" to specific groups',
                        'Add only the groups that should have access to 1Patch',
                    ],
                    linkUrl: null,
                    linkLabel: null,
                },
                {
                    heading: 'Configure an MFA sign-on policy',
                    text: 'Require MFA specifically for 1Patch sign-ins, independently of your global Okta policy.',
                    steps: [
                        'In the application, go to the Sign On tab → Sign On Policy',
                        'Add a rule that requires MFA for all users (or a subset based on group or network zone)',
                    ],
                    linkUrl: null,
                    linkLabel: null,
                },
                {
                    heading: 'Set session and token lifetime',
                    text: 'Limit how long an Okta session is valid to reduce the window of a stolen token.',
                    steps: [
                        'In Sign On Policy, configure "Max Okta session" and set a reasonable idle/max duration',
                        'Consider setting a short access token lifetime for API-facing apps',
                    ],
                    linkUrl: null,
                    linkLabel: null,
                },
                {
                    heading: 'Monitor with the Okta System Log',
                    text: 'Review authentication events and failed logins for 1Patch in the Okta System Log.',
                    steps: [
                        'Okta Admin Console → Reports → System Log — filter by your app client ID',
                        'Set up a log streaming integration to send events to your SIEM',
                    ],
                    linkUrl: null,
                    linkLabel: null,
                },
            ],
        },
    },
    oidc: {
        portalUrl: null,
        portalLabel: null,
        steps: [
            { text: 'Register 1Patch as an OAuth 2.0 client in your identity provider' },
            { text: 'Set the redirect / callback URI to this URL:', uri: true },
            { text: 'Ensure the provider exposes /.well-known/openid-configuration (OIDC discovery)' },
            { text: 'Note the Client ID, Client secret, and the discovery base URL' },
        ],
        tip: {
            title: 'Security recommendations',
            items: [
                {
                    heading: 'Restrict access at the identity provider level',
                    text: 'Most OIDC providers support app assignment or group-based access — check your provider\'s documentation.',
                    steps: [
                        'Use the "Allowed email domains" field in the next step as a baseline domain filter',
                        'Disable auto-provision and manually approve users for tighter control',
                    ],
                    linkUrl: null,
                    linkLabel: null,
                },
                {
                    heading: 'Use short-lived tokens where possible',
                    text: 'Configure your IdP to issue short access token lifetimes to reduce the impact of a leaked token.',
                    steps: [
                        'Check your provider\'s token lifetime settings and set access tokens to 15–60 minutes',
                        '1Patch uses server-side sessions so users will re-authenticate via SSO when the token expires',
                    ],
                    linkUrl: null,
                    linkLabel: null,
                },
                {
                    heading: 'Rotate the client secret regularly',
                    text: 'Rotate credentials at least annually, or immediately if you suspect exposure.',
                    steps: [
                        'Generate a new client secret in your IdP',
                        'Update it in 1Patch (Settings → Edit provider) before deleting the old one',
                    ],
                    linkUrl: null,
                    linkLabel: null,
                },
            ],
        },
    },
};
function CopyButton({ text }) {
    const [copied, setCopied] = useState(false);
    const copy = () => {
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }).catch(() => { });
    };
    return (React.createElement("button", { type: "button", className: `sso-copy-btn ${copied ? 'copied' : ''}`, onClick: copy }, copied ? React.createElement(React.Fragment, null,
        Icon.check,
        " Copied") : React.createElement(React.Fragment, null,
        Icon.copy,
        " Copy")));
}
function ToggleSwitch({ checked, onChange, label }) {
    return (React.createElement("label", { className: "toggle-switch", "aria-label": label },
        React.createElement("input", { type: "checkbox", checked: checked, onChange: onChange }),
        React.createElement("span", { className: "toggle-track" })));
}
// ── Wizard step indicator ──────────────────────────────────────────────────
function SsoWizardSteps({ current }) {
    const steps = ['Provider', 'Setup', 'Credentials', 'Access'];
    return (React.createElement("div", { className: "sso-wizard-steps" }, steps.map((label, i) => {
        const n = i + 1;
        const state = n < current ? 'done' : n === current ? 'active' : 'idle';
        return (React.createElement(React.Fragment, { key: n },
            i > 0 && React.createElement("div", { className: `sso-wizard-connector ${n <= current ? 'filled' : ''}` }),
            React.createElement("div", { className: `sso-wizard-step-dot ${state}` },
                React.createElement("div", { className: "sso-wizard-dot-num" }, state === 'done' ? Icon.check : n),
                React.createElement("span", { className: "sso-wizard-dot-label" }, label))));
    })));
}
// ── Step 1: Choose provider type ──────────────────────────────────────────
function SsoTypeStep({ type, setType, onNext, onCancel }) {
    return (React.createElement("div", { className: "sso-wizard-body" },
        React.createElement("div", { className: "sso-wizard-header" },
            React.createElement("h3", null, "Choose an identity provider"),
            React.createElement("p", null, "Select the SSO provider your organization uses.")),
        React.createElement("div", { className: "sso-type-grid" }, SSO_PROVIDER_META.map(p => (React.createElement("button", { key: p.type, type: "button", className: `sso-type-card ${type === p.type ? 'selected' : ''}`, onClick: () => setType(p.type) },
            p.badge && React.createElement("span", { className: "sso-type-badge" }, p.badge),
            React.createElement("div", { className: "sso-type-card-icon" },
                React.createElement(SsoProviderIcon, { type: p.type, size: 26 })),
            React.createElement("span", { className: "sso-type-card-label" }, p.label),
            React.createElement("span", { className: "sso-type-card-desc" }, p.desc))))),
        React.createElement("div", { className: "sso-wizard-actions" },
            React.createElement("button", { type: "button", className: "btn ghost", onClick: onCancel }, "Cancel"),
            React.createElement("button", { type: "button", className: "btn primary", onClick: onNext },
                "Continue ",
                React.createElement("span", { className: "btn-icon" }, Icon.arrowR)))));
}
// ── Setup tip callout ─────────────────────────────────────────────────────
function SsoSetupTip({ tip }) {
    const [open, setOpen] = useState(false);
    return (React.createElement("div", { className: "sso-setup-tip" },
        React.createElement("button", { type: "button", className: "sso-setup-tip-toggle", onClick: () => setOpen(o => !o) },
            React.createElement("span", { className: "sso-setup-tip-icon" }, Icon.lightbulb),
            React.createElement("strong", null, tip.title),
            React.createElement("span", { className: `sso-setup-tip-chevron ${open ? 'open' : ''}` }, Icon.arrowR)),
        open && (React.createElement("div", { className: "sso-setup-tip-body" }, tip.items.map((item, i) => (React.createElement("div", { key: i, className: "sso-setup-tip-item" },
            React.createElement("div", { className: "sso-setup-tip-item-head" },
                React.createElement("span", { className: "sso-setup-tip-item-title" }, item.heading),
                item.linkUrl && (React.createElement("a", { href: item.linkUrl, target: "_blank", rel: "noopener noreferrer", className: "sso-setup-tip-link" },
                    item.linkLabel,
                    " ",
                    React.createElement("span", { className: "btn-icon" }, Icon.externalLink)))),
            React.createElement("p", { className: "sso-setup-tip-item-text" }, item.text),
            item.steps && (React.createElement("ol", { className: "sso-setup-tip-steps" }, item.steps.map((s, j) => React.createElement("li", { key: j }, s)))))))))));
}
// ── Step 2: Setup guide ───────────────────────────────────────────────────
function SsoSetupStep({ type, callbackUrl, onNext, onBack }) {
    const guide = SSO_SETUP_GUIDE[type] || SSO_SETUP_GUIDE.oidc;
    const meta = SSO_PROVIDER_META.find(p => p.type === type);
    return (React.createElement("div", { className: "sso-wizard-body" },
        React.createElement("div", { className: "sso-wizard-header" },
            React.createElement("div", { className: "sso-wizard-header-row" },
                React.createElement("span", { className: "sso-wizard-provider-icon" },
                    React.createElement(SsoProviderIcon, { type: type, size: 20 })),
                React.createElement("h3", null,
                    "Set up ",
                    meta?.label)),
            React.createElement("p", null, "Register 1Patch in your identity provider before entering credentials.")),
        React.createElement("div", { className: "sso-setup-guide" },
            React.createElement("div", { className: "sso-setup-guide-head" },
                React.createElement("span", { className: "sso-setup-guide-title" }, "Setup instructions"),
                guide.portalUrl && (React.createElement("a", { href: guide.portalUrl, target: "_blank", rel: "noopener noreferrer", className: "sso-setup-guide-link" },
                    guide.portalLabel,
                    " ",
                    React.createElement("span", { className: "btn-icon" }, Icon.externalLink)))),
            React.createElement("ol", { className: "sso-setup-guide-steps" }, guide.steps.map((step, i) => (React.createElement("li", { key: i, className: "sso-setup-guide-step" },
                React.createElement("div", { className: "sso-setup-guide-step-num" }, i + 1),
                React.createElement("div", { className: "sso-setup-guide-step-body" },
                    React.createElement("span", null, step.text),
                    step.uri && (React.createElement("div", { className: "sso-callback-uri" },
                        React.createElement("span", { className: "sso-callback-uri-url" }, callbackUrl),
                        React.createElement(CopyButton, { text: callbackUrl })))))))),
            guide.tip && React.createElement(SsoSetupTip, { tip: guide.tip })),
        React.createElement("div", { className: "sso-wizard-actions" },
            React.createElement("button", { type: "button", className: "btn ghost", onClick: onBack },
                React.createElement("span", { className: "btn-icon" }, Icon.arrowL),
                " Back"),
            React.createElement("button", { type: "button", className: "btn primary", onClick: onNext },
                "Continue ",
                React.createElement("span", { className: "btn-icon" }, Icon.arrowR)))));
}
// ── Step 3: Credentials ───────────────────────────────────────────────────
function SsoCredsStep({ type, name, setName, clientId, setClientId, clientSecret, setClientSecret, tenantId, setTenantId, domain, setDomain, discoveryUrl, setDiscoveryUrl, onNext, onBack }) {
    const meta = SSO_PROVIDER_META.find(p => p.type === type);
    const canContinue = name.trim() && clientId.trim() && clientSecret.trim()
        && (type !== 'microsoft' || tenantId.trim())
        && (type !== 'okta' || domain.trim())
        && (type !== 'oidc' || discoveryUrl.trim());
    return (React.createElement("div", { className: "sso-wizard-body" },
        React.createElement("div", { className: "sso-wizard-header" },
            React.createElement("div", { className: "sso-wizard-header-row" },
                React.createElement("span", { className: "sso-wizard-provider-icon" },
                    React.createElement(SsoProviderIcon, { type: type, size: 20 })),
                React.createElement("h3", null,
                    meta?.label,
                    " credentials")),
            React.createElement("p", null, "Enter the app registration details from your identity provider.")),
        React.createElement("div", { className: "sso-wizard-fields" },
            React.createElement("label", { className: "field" },
                React.createElement("span", null, "Display name"),
                React.createElement("input", { type: "text", value: name, onChange: e => setName(e.target.value), placeholder: "e.g. Contoso AD", autoFocus: true, required: true })),
            type === 'microsoft' && (React.createElement("label", { className: "field" },
                React.createElement("span", null, "Directory (Tenant) ID"),
                React.createElement("input", { type: "text", value: tenantId, onChange: e => setTenantId(e.target.value), placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx", required: true }),
                React.createElement("span", { className: "field-sub" },
                    "Use ",
                    React.createElement("code", null, "common"),
                    " for multi-tenant, ",
                    React.createElement("code", null, "organizations"),
                    " for any work account, or your specific tenant UUID"))),
            React.createElement("label", { className: "field" },
                React.createElement("span", null, "Application (Client) ID"),
                React.createElement("input", { type: "text", value: clientId, onChange: e => setClientId(e.target.value), placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx", required: true })),
            React.createElement("label", { className: "field" },
                React.createElement("span", null, "Client secret"),
                React.createElement("input", { type: "password", autoComplete: "new-password", value: clientSecret, onChange: e => setClientSecret(e.target.value), placeholder: "Paste the client secret value", required: true }),
                type === 'microsoft' && (React.createElement("span", { className: "field-sub" },
                    "Copy the ",
                    React.createElement("strong", null, "Value"),
                    " from Certificates & secrets \u2014 not the Secret ID"))),
            type === 'okta' && (React.createElement("label", { className: "field" },
                React.createElement("span", null, "Okta domain"),
                React.createElement("input", { type: "text", value: domain, onChange: e => setDomain(e.target.value), placeholder: "dev-12345.okta.com", required: true }))),
            type === 'oidc' && (React.createElement("label", { className: "field" },
                React.createElement("span", null, "Discovery base URL"),
                React.createElement("input", { type: "url", value: discoveryUrl, onChange: e => setDiscoveryUrl(e.target.value), placeholder: "https://idp.example.com", required: true }),
                React.createElement("span", { className: "field-sub" },
                    "/",
                    React.createElement("code", null, ".well-known/openid-configuration"),
                    " is appended automatically")))),
        React.createElement("div", { className: "sso-wizard-actions" },
            React.createElement("button", { type: "button", className: "btn ghost", onClick: onBack },
                React.createElement("span", { className: "btn-icon" }, Icon.arrowL),
                " Back"),
            React.createElement("button", { type: "button", className: "btn primary", onClick: onNext, disabled: !canContinue },
                "Continue ",
                React.createElement("span", { className: "btn-icon" }, Icon.arrowR)))));
}
// ── Step 4: Access control ────────────────────────────────────────────────
function SsoAccessStep({ allowedDomains, setAllowedDomains, defaultRole, setDefaultRole, roleOptions = SSO_ROLE_OPTIONS, autoProvision, setAutoProvision, enabled, setEnabled, onSubmit, onBack, saving, saveError }) {
    return (React.createElement("div", { className: "sso-wizard-body" },
        React.createElement("div", { className: "sso-wizard-header" },
            React.createElement("h3", null, "Access control"),
            React.createElement("p", null, "Configure who can sign in and what permissions they receive.")),
        React.createElement("div", { className: "sso-wizard-fields" },
            React.createElement("label", { className: "field" },
                React.createElement("span", null, "Allowed email domains"),
                React.createElement("input", { type: "text", value: allowedDomains, onChange: e => setAllowedDomains(e.target.value), placeholder: "company.com, partner.com" }),
                React.createElement("span", { className: "field-sub" }, "Comma-separated. Leave blank to allow any verified account from this provider.")),
            React.createElement("div", { className: "sso-toggle-card" },
                React.createElement("div", null,
                    React.createElement("strong", null, "Auto-provision new users"),
                    React.createElement("p", null, "Automatically create accounts for first-time SSO users.")),
                React.createElement(ToggleSwitch, { checked: autoProvision, onChange: e => setAutoProvision(e.target.checked), label: "Auto-provision" })),
            autoProvision && (React.createElement("label", { className: "field" },
                React.createElement("span", null, "Default role for auto-provisioned users"),
                React.createElement("select", { value: defaultRole, onChange: e => setDefaultRole(e.target.value) }, roleOptions.map(o => React.createElement("option", { key: o.value, value: o.value }, o.label))))),
            React.createElement("div", { className: "sso-toggle-card" },
                React.createElement("div", null,
                    React.createElement("strong", null, "Enable provider"),
                    React.createElement("p", null, "Show this provider on the login screen and accept sign-ins.")),
                React.createElement(ToggleSwitch, { checked: enabled, onChange: e => setEnabled(e.target.checked), label: "Enable provider" }))),
        saveError && React.createElement("div", { className: "banner error", style: { marginBottom: 12 } }, saveError),
        React.createElement("div", { className: "sso-wizard-actions" },
            React.createElement("button", { type: "button", className: "btn ghost", onClick: onBack, disabled: saving },
                React.createElement("span", { className: "btn-icon" }, Icon.arrowL),
                " Back"),
            React.createElement("button", { type: "button", className: "btn primary", onClick: onSubmit, disabled: saving },
                saving ? React.createElement("span", { className: "search-spinner" }) : null,
                "Add provider"))));
}
// ── Full add-provider wizard ──────────────────────────────────────────────
function SsoWizard({ onSave, onCancel, saving, saveError, roleOptions = SSO_ROLE_OPTIONS }) {
    const [step, setStep] = useState(1);
    const [type, setType] = useState('microsoft');
    const [name, setName] = useState('');
    const [clientId, setClientId] = useState('');
    const [clientSecret, setClientSecret] = useState('');
    const [tenantId, setTenantId] = useState('');
    const [domain, setDomain] = useState('');
    const [discoveryUrl, setDiscoveryUrl] = useState('');
    const [allowedDomains, setAllowedDomains] = useState('');
    const [defaultRole, setDefaultRole] = useState('viewer');
    const [autoProvision, setAutoProvision] = useState(false);
    const [enabled, setEnabled] = useState(true);
    const callbackUrl = `${window.location.origin}/auth/sso/callback`;
    const submit = () => {
        const dto = {
            type, name, clientId, clientSecret, enabled, autoProvision, defaultRole,
            allowedDomains: allowedDomains.split(',').map(s => s.trim()).filter(Boolean),
        };
        if (type === 'microsoft')
            dto.tenantId = tenantId;
        if (type === 'okta')
            dto.domain = domain;
        if (type === 'oidc')
            dto.discoveryUrl = discoveryUrl;
        onSave(dto);
    };
    return (React.createElement("div", { className: "sso-wizard" },
        React.createElement(SsoWizardSteps, { current: step }),
        step === 1 && (React.createElement(SsoTypeStep, { type: type, setType: setType, onNext: () => setStep(2), onCancel: onCancel })),
        step === 2 && (React.createElement(SsoSetupStep, { type: type, callbackUrl: callbackUrl, onNext: () => setStep(3), onBack: () => setStep(1) })),
        step === 3 && (React.createElement(SsoCredsStep, { type: type, name: name, setName: setName, clientId: clientId, setClientId: setClientId, clientSecret: clientSecret, setClientSecret: setClientSecret, tenantId: tenantId, setTenantId: setTenantId, domain: domain, setDomain: setDomain, discoveryUrl: discoveryUrl, setDiscoveryUrl: setDiscoveryUrl, onNext: () => setStep(4), onBack: () => setStep(2) })),
        step === 4 && (React.createElement(SsoAccessStep, { allowedDomains: allowedDomains, setAllowedDomains: setAllowedDomains, defaultRole: defaultRole, setDefaultRole: setDefaultRole, roleOptions: roleOptions, autoProvision: autoProvision, setAutoProvision: setAutoProvision, enabled: enabled, setEnabled: setEnabled, onSubmit: submit, onBack: () => setStep(3), saving: saving, saveError: saveError }))));
}
// ── Edit form (compact, for existing providers) ───────────────────────────
function SsoEditForm({ initial, onSave, onCancel, saving, saveError, roleOptions = SSO_ROLE_OPTIONS }) {
    const [name, setName] = useState(initial?.name ?? '');
    const [clientId, setClientId] = useState(initial?.clientId ?? '');
    const [clientSecret, setClientSecret] = useState('');
    const [tenantId, setTenantId] = useState(initial?.tenantId ?? '');
    const [domain, setDomain] = useState(initial?.domain ?? '');
    const [discoveryUrl, setDiscoveryUrl] = useState(initial?.discoveryUrl ?? '');
    const [allowedDomains, setAllowedDomains] = useState((initial?.allowedDomains ?? []).join(', '));
    const [defaultRole, setDefaultRole] = useState(initial?.defaultRole ?? 'viewer');
    const [autoProvision, setAutoProvision] = useState(initial?.autoProvision ?? false);
    const [enabled, setEnabled] = useState(initial?.enabled ?? true);
    const submit = (e) => {
        e.preventDefault();
        const dto = { name, clientId, enabled, autoProvision, defaultRole,
            allowedDomains: allowedDomains.split(',').map(s => s.trim()).filter(Boolean) };
        if (clientSecret)
            dto.clientSecret = clientSecret;
        if (initial?.type === 'microsoft')
            dto.tenantId = tenantId;
        if (initial?.type === 'okta')
            dto.domain = domain;
        if (initial?.type === 'oidc')
            dto.discoveryUrl = discoveryUrl;
        onSave(dto);
    };
    return (React.createElement("form", { className: "sso-edit-form", onSubmit: submit },
        React.createElement("div", { className: "sso-wizard-header", style: { paddingBottom: 16, marginBottom: 16, borderBottom: '1px solid var(--line)' } },
            React.createElement("div", { className: "sso-wizard-header-row" },
                React.createElement("span", { className: "sso-wizard-provider-icon" },
                    React.createElement(SsoProviderIcon, { type: initial?.type, size: 18 })),
                React.createElement("h3", { style: { margin: 0 } },
                    "Edit ",
                    SSO_PROVIDER_LABELS[initial?.type] || 'provider'))),
        React.createElement("div", { className: "sso-wizard-fields" },
            React.createElement("div", { className: "form-grid-2" },
                React.createElement("label", { className: "field" },
                    React.createElement("span", null, "Display name"),
                    React.createElement("input", { type: "text", value: name, onChange: e => setName(e.target.value), required: true })),
                React.createElement("label", { className: "field" },
                    React.createElement("span", null, "Client ID"),
                    React.createElement("input", { type: "text", value: clientId, onChange: e => setClientId(e.target.value), required: true }))),
            React.createElement("label", { className: "field" },
                React.createElement("span", null,
                    "Client secret ",
                    React.createElement("span", { className: "field-sub", style: { marginLeft: 0 } }, "(leave blank to keep current)")),
                React.createElement("input", { type: "password", autoComplete: "new-password", value: clientSecret, onChange: e => setClientSecret(e.target.value), placeholder: "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" })),
            initial?.type === 'microsoft' && (React.createElement("label", { className: "field" },
                React.createElement("span", null, "Tenant ID"),
                React.createElement("input", { type: "text", value: tenantId, onChange: e => setTenantId(e.target.value), required: true }))),
            initial?.type === 'okta' && (React.createElement("label", { className: "field" },
                React.createElement("span", null, "Okta domain"),
                React.createElement("input", { type: "text", value: domain, onChange: e => setDomain(e.target.value), required: true }))),
            initial?.type === 'oidc' && (React.createElement("label", { className: "field" },
                React.createElement("span", null, "Discovery base URL"),
                React.createElement("input", { type: "url", value: discoveryUrl, onChange: e => setDiscoveryUrl(e.target.value), required: true }))),
            React.createElement("label", { className: "field" },
                React.createElement("span", null, "Allowed email domains"),
                React.createElement("input", { type: "text", value: allowedDomains, onChange: e => setAllowedDomains(e.target.value), placeholder: "company.com, partner.com" }),
                React.createElement("span", { className: "field-sub" }, "Comma-separated. Leave blank to allow any verified account.")),
            React.createElement("div", { className: "sso-toggle-card" },
                React.createElement("div", null,
                    React.createElement("strong", null, "Auto-provision new users"),
                    React.createElement("p", null, "Automatically create accounts for first-time SSO users.")),
                React.createElement(ToggleSwitch, { checked: autoProvision, onChange: e => setAutoProvision(e.target.checked), label: "Auto-provision" })),
            autoProvision && (React.createElement("label", { className: "field" },
                React.createElement("span", null, "Default role for auto-provisioned users"),
                React.createElement("select", { value: defaultRole, onChange: e => setDefaultRole(e.target.value) }, roleOptions.map(o => React.createElement("option", { key: o.value, value: o.value }, o.label))))),
            React.createElement("div", { className: "sso-toggle-card" },
                React.createElement("div", null,
                    React.createElement("strong", null, "Enable provider"),
                    React.createElement("p", null, "Show this provider on the login screen and accept sign-ins.")),
                React.createElement(ToggleSwitch, { checked: enabled, onChange: e => setEnabled(e.target.checked), label: "Enable provider" }))),
        saveError && React.createElement("div", { className: "banner error", style: { marginTop: 8, marginBottom: 4 } }, saveError),
        React.createElement("div", { className: "sso-form-actions" },
            React.createElement("button", { type: "button", className: "btn ghost", onClick: onCancel, disabled: saving }, "Cancel"),
            React.createElement("button", { type: "submit", className: "btn primary", disabled: saving },
                saving ? React.createElement("span", { className: "search-spinner" }) : null,
                "Save changes"))));
}
// ── Provider card (replaces table row) ────────────────────────────────────
function SsoProviderCard({ provider, onEdit, onDelete, onToggle }) {
    return (React.createElement("div", { className: `sso-provider-card ${provider.enabled ? '' : 'sso-provider-card--off'}` },
        React.createElement("div", { className: "sso-provider-card-header" },
            React.createElement("div", { className: "sso-provider-card-identity" },
                React.createElement("div", { className: "sso-provider-card-icon" },
                    React.createElement(SsoProviderIcon, { type: provider.type, size: 20 })),
                React.createElement("div", null,
                    React.createElement("strong", null, provider.name),
                    React.createElement("span", null, SSO_PROVIDER_LABELS[provider.type] || provider.type))),
            React.createElement(ToggleSwitch, { checked: provider.enabled, onChange: () => onToggle(provider), label: provider.enabled ? 'Disable provider' : 'Enable provider' })),
        React.createElement("div", { className: "sso-provider-card-meta" },
            React.createElement("div", { className: "sso-provider-card-meta-item" },
                React.createElement("span", { className: "sso-meta-label" }, "Client ID"),
                React.createElement("span", { className: "sso-meta-value mono" },
                    provider.clientId.slice(0, 8),
                    "\u2026")),
            React.createElement("div", { className: "sso-provider-card-meta-item" },
                React.createElement("span", { className: "sso-meta-label" }, "Domains"),
                React.createElement("span", { className: "sso-meta-value" }, provider.allowedDomains?.length > 0 ? provider.allowedDomains.join(', ') : React.createElement("span", { className: "muted" }, "Any"))),
            provider.autoProvision && (React.createElement("div", { className: "sso-provider-card-meta-item" },
                React.createElement("span", { className: "sso-meta-label" }, "Auto-provision"),
                React.createElement("span", { className: "sso-meta-value" }, provider.defaultRole || 'viewer')))),
        React.createElement("div", { className: "sso-provider-card-footer" },
            React.createElement("span", { className: `status-pill ${provider.enabled ? 'ok' : 'off'}` }, provider.enabled ? 'Active' : 'Disabled'),
            React.createElement("div", { style: { flex: 1 } }),
            React.createElement("button", { className: "btn sm ghost", onClick: () => onEdit(provider) }, "Edit"),
            React.createElement("button", { className: "btn sm ghost danger", onClick: () => onDelete(provider) }, "Delete"))));
}
// ── Settings page ──────────────────────────────────────────────────────────
function SsoSettingsPage() {
    const { data: providers, loading, error, reload } = useResource(() => PatchAPI.ssoProvidersAdmin());
    const rbac = useResource(() => PatchAPI.adminRbac());
    const [mode, setMode] = useState('list'); // 'list' | 'add' | 'edit'
    const [editing, setEditing] = useState(null);
    const [deleting, setDeleting] = useState(null);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState('');
    const openAdd = () => { setSaveError(''); setMode('add'); };
    const openEdit = (p) => { setSaveError(''); setEditing(p); setMode('edit'); };
    const closeForm = () => { setMode('list'); setEditing(null); setSaveError(''); };
    const handleSave = (dto) => {
        setSaving(true);
        setSaveError('');
        const action = mode === 'edit'
            ? PatchAPI.ssoUpdateProvider(editing.id, dto)
            : PatchAPI.ssoCreateProvider(dto);
        action
            .then(() => { closeForm(); reload(); })
            .catch(err => setSaveError(err.message || 'Save failed'))
            .finally(() => setSaving(false));
    };
    const handleDelete = () => {
        setSaving(true);
        PatchAPI.ssoDeleteProvider(deleting.id)
            .then(() => { setDeleting(null); reload(); })
            .catch(err => setSaveError(err.message || 'Delete failed'))
            .finally(() => setSaving(false));
    };
    const handleToggle = (provider) => {
        PatchAPI.ssoUpdateProvider(provider.id, { enabled: !provider.enabled })
            .then(() => reload())
            .catch(() => { });
    };
    const roleOptions = roleOptionsFromRbac(rbac.data);
    return (React.createElement("div", { className: "page" },
        React.createElement("div", { className: "page-head" },
            React.createElement("div", null,
                React.createElement("h2", null, "Settings"),
                React.createElement("p", { className: "sub" }, "Identity provider configuration for single sign-on")),
            mode === 'list' && (React.createElement("button", { className: "btn primary", onClick: openAdd },
                Icon.plus,
                " Add provider"))),
        mode === 'add' && (React.createElement("div", { className: "card sso-wizard-card" },
            React.createElement(SsoWizard, { onSave: handleSave, onCancel: closeForm, saving: saving, saveError: saveError, roleOptions: roleOptions }))),
        mode === 'edit' && (React.createElement("div", { className: "card", style: { marginBottom: 16 } },
            React.createElement(SsoEditForm, { initial: editing, onSave: handleSave, onCancel: closeForm, saving: saving, saveError: saveError, roleOptions: roleOptions }))),
        React.createElement("div", { className: "card" },
            React.createElement("div", { className: "card-head" },
                React.createElement("h3", null, "Identity Providers"),
                React.createElement("div", { className: "sub" },
                    Array.isArray(providers) ? providers.length : 0,
                    " configured")),
            React.createElement("div", { className: "sso-security-note" },
                Icon.shield,
                React.createElement("span", null, "All SSO logins use PKCE (S256), nonce replay protection, ID token signature verification, and server-side state validation. Client secrets are stored AES-256-GCM encrypted.")),
            loading && React.createElement("div", { className: "empty-state" },
                React.createElement("span", { className: "search-spinner" }),
                " Loading providers\u2026"),
            error && React.createElement("div", { className: "banner error", style: { margin: 12 } }, "Failed to load providers."),
            !loading && !error && Array.isArray(providers) && providers.length === 0 && (React.createElement("div", { className: "empty-state" },
                React.createElement("div", { style: { color: 'var(--text-3)', marginBottom: 6 } }, Icon.shield),
                React.createElement("p", null, "No SSO providers configured."),
                React.createElement("p", { className: "sub" }, "Add a provider to enable single sign-on for your team."),
                mode === 'list' && (React.createElement("button", { className: "btn primary", style: { marginTop: 12 }, onClick: openAdd },
                    Icon.plus,
                    " Add your first provider")))),
            !loading && !error && Array.isArray(providers) && providers.length > 0 && (React.createElement("div", { className: "sso-providers-list" }, providers.map(p => (React.createElement(SsoProviderCard, { key: p.id, provider: p, onEdit: openEdit, onDelete: p => setDeleting(p), onToggle: handleToggle })))))),
        deleting && (React.createElement("div", { className: "modal-overlay", onClick: () => setDeleting(null) },
            React.createElement("div", { className: "modal-box", onClick: e => e.stopPropagation() },
                React.createElement("h3", null, "Delete SSO provider?"),
                React.createElement("p", null,
                    "This will permanently remove ",
                    React.createElement("strong", null, deleting.name),
                    ". Users who sign in via this provider will need to use a password or another provider."),
                saveError && React.createElement("div", { className: "banner error" }, saveError),
                React.createElement("div", { className: "modal-actions" },
                    React.createElement("button", { className: "btn ghost", onClick: () => setDeleting(null), disabled: saving }, "Cancel"),
                    React.createElement("button", { className: "btn danger", onClick: handleDelete, disabled: saving },
                        saving ? React.createElement("span", { className: "search-spinner" }) : null,
                        "Delete provider")))))));
}
function TenantPolicySettings() {
    const [tenantId, setTenantId] = useState('default');
    const policy = useResource(() => PatchAPI.tenantPolicy(tenantId), [tenantId]);
    const [form, setForm] = useState(null);
    const [saving, setSaving] = useState(false);
    const [notice, setNotice] = useState('');
    useEffect(() => {
        if (!policy.data)
            return;
        setForm({
            securityMode: policy.data.securityMode || 'normal',
            requireVirusTotalForStrict: Boolean(policy.data.requireVirusTotalForStrict),
            requireVirusTotalForTinfoil: Boolean(policy.data.requireVirusTotalForTinfoil),
            virusTotalApiKey: policy.data.virusTotalConfigured ? '********' : '',
            trustedSourceHosts: (policy.data.trustedSourceHosts || []).join('\n'),
        });
    }, [policy.data]);
    const set = (key, value) => setForm(prev => ({ ...(prev || {}), [key]: value }));
    const save = (e) => {
        e.preventDefault();
        setSaving(true);
        setNotice('');
        PatchAPI.saveTenantPolicy(tenantId, {
            securityMode: form.securityMode,
            requireVirusTotalForStrict: form.requireVirusTotalForStrict,
            requireVirusTotalForTinfoil: form.requireVirusTotalForTinfoil,
            virusTotalApiKey: form.virusTotalApiKey,
            trustedSourceHosts: form.trustedSourceHosts.split(/\r?\n|,/).map(v => v.trim()).filter(Boolean),
        }).then(() => {
            setNotice('Policy saved.');
            policy.reload();
        }).catch(err => {
            setNotice(err.message || 'Save failed');
        }).finally(() => setSaving(false));
    };
    return (React.createElement("div", null,
        React.createElement("div", { className: "page-head" },
            React.createElement("div", null,
                React.createElement("h2", null, "Security policy"),
                React.createElement("p", null, "Tenant guardrails, trusted sources, and BYO VirusTotal reputation"))),
        React.createElement("div", { className: "card" },
            React.createElement("form", { className: "card-body", onSubmit: save, style: { display: 'flex', flexDirection: 'column', gap: 14 } },
                React.createElement("div", { className: "form-grid" },
                    React.createElement("label", { className: "field" },
                        React.createElement("span", null, "Tenant"),
                        React.createElement("input", { value: tenantId, onChange: e => setTenantId(e.target.value || 'default') })),
                    React.createElement("label", { className: "field" },
                        React.createElement("span", null, "Security mode"),
                        React.createElement("select", { value: form?.securityMode || 'normal', onChange: e => set('securityMode', e.target.value) },
                            React.createElement("option", { value: "normal" }, "Normal"),
                            React.createElement("option", { value: "strict" }, "Strict"),
                            React.createElement("option", { value: "tinfoil" }, "Tinfoil")))),
                policy.error && React.createElement(ErrorAlert, { error: policy.error, onRetry: policy.reload }),
                policy.loading || !form ? React.createElement(Skeleton, { h: 160 }) : (React.createElement(React.Fragment, null,
                    React.createElement("label", { className: "field" },
                        React.createElement("span", null,
                            "VirusTotal API key ",
                            React.createElement("em", { className: "field-hint" }, "BYO key, stored server-side only; never sent to nodes or clients")),
                        React.createElement("input", { type: "password", autoComplete: "new-password", value: form.virusTotalApiKey, onChange: e => set('virusTotalApiKey', e.target.value), placeholder: policy.data?.virusTotalConfigured ? 'Configured' : 'Paste API key' })),
                    React.createElement("div", { className: "checkbox-group" },
                        React.createElement("label", { className: "checkbox-label" },
                            React.createElement("input", { type: "checkbox", checked: form.requireVirusTotalForStrict, onChange: e => set('requireVirusTotalForStrict', e.target.checked) }),
                            " Require VirusTotal in strict mode"),
                        React.createElement("label", { className: "checkbox-label" },
                            React.createElement("input", { type: "checkbox", checked: form.requireVirusTotalForTinfoil, onChange: e => set('requireVirusTotalForTinfoil', e.target.checked) }),
                            " Require VirusTotal in tinfoil mode")),
                    React.createElement("label", { className: "field" },
                        React.createElement("span", null, "Trusted source hosts"),
                        React.createElement("textarea", { value: form.trustedSourceHosts, onChange: e => set('trustedSourceHosts', e.target.value), placeholder: "packages.example.com, vendor.example.com" })),
                    notice && React.createElement("div", { className: "banner" }, notice),
                    React.createElement("div", { style: { display: 'flex', justifyContent: 'flex-end' } },
                        React.createElement("button", { className: "btn primary", disabled: saving }, saving ? 'Saving...' : 'Save policy'))))))));
}
function AccessSettings() {
    const users = useResource(() => PatchAPI.adminUsers());
    const rbac = useResource(() => PatchAPI.adminRbac());
    const [creating, setCreating] = useState(false);
    const [form, setForm] = useState({ email: '', password: '', roles: ['viewer'] });
    const [error, setError] = useState('');
    const [actionError, setActionError] = useState('');
    const [resetUser, setResetUser] = useState(null);
    const [resetPassword, setResetPassword] = useState('');
    const [deletingUser, setDeletingUser] = useState(null);
    const roles = rbac.data?.roles || ['viewer'];
    useEffect(() => {
        if (!roles.length || form.roles.some(role => roles.includes(role)))
            return;
        setForm(prev => ({ ...prev, roles: [roles.includes('viewer') ? 'viewer' : roles[0]] }));
    }, [roles.join('|')]);
    const toggleRole = (role) => setForm(prev => ({ ...prev, roles: prev.roles.includes(role) ? prev.roles.filter(r => r !== role) : [...prev.roles, role] }));
    const create = (e) => {
        e.preventDefault();
        setError('');
        PatchAPI.adminCreateUser(form)
            .then(() => { setCreating(false); setForm({ email: '', password: '', roles: ['viewer'] }); users.reload(); })
            .catch(err => setError(err.message || 'Create failed'));
    };
    const updateUser = (user, patch) => {
        setActionError('');
        return PatchAPI.adminUpdateUser(user.id, patch).then(() => users.reload()).catch(err => {
            setActionError(err.message || 'User update failed');
            throw err;
        });
    };
    const confirmResetPassword = (e) => {
        e.preventDefault();
        if (!resetUser)
            return;
        updateUser(resetUser, { password: resetPassword }).then(() => {
            setResetUser(null);
            setResetPassword('');
        });
    };
    const confirmDeleteUser = () => {
        if (!deletingUser)
            return;
        setActionError('');
        PatchAPI.adminDeleteUser(deletingUser.id)
            .then(() => { setDeletingUser(null); users.reload(); })
            .catch(err => setActionError(err.message || 'Delete failed'));
    };
    return (React.createElement("div", null,
        React.createElement("div", { className: "page-head" },
            React.createElement("div", null,
                React.createElement("h2", null, "Users"),
                React.createElement("p", null, "Accounts, roles, status, password resets, and access lifecycle")),
            React.createElement("button", { className: "btn primary", onClick: () => setCreating(true) },
                Icon.plus,
                " Add user")),
        (users.error || rbac.error) && React.createElement(ErrorAlert, { error: users.error || rbac.error, onRetry: () => { users.reload(); rbac.reload(); } }),
        actionError && React.createElement("div", { className: "banner error" }, actionError),
        creating && (React.createElement("div", { className: "card" },
            React.createElement("form", { className: "card-body", onSubmit: create, style: { display: 'flex', flexDirection: 'column', gap: 14 } },
                React.createElement("div", { className: "form-grid" },
                    React.createElement("label", { className: "field" },
                        React.createElement("span", null, "Email"),
                        React.createElement("input", { type: "email", required: true, value: form.email, onChange: e => setForm(prev => ({ ...prev, email: e.target.value })) })),
                    React.createElement("label", { className: "field" },
                        React.createElement("span", null, "Temporary password"),
                        React.createElement("input", { type: "password", required: true, minLength: "12", value: form.password, onChange: e => setForm(prev => ({ ...prev, password: e.target.value })) }))),
                React.createElement("div", { className: "checkbox-group" }, roles.map(role => React.createElement("label", { className: "checkbox-label", key: role },
                    React.createElement("input", { type: "checkbox", checked: form.roles.includes(role), onChange: () => toggleRole(role) }),
                    roleLabel(role, rbac.data)))),
                error && React.createElement("div", { className: "banner error" }, error),
                React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between' } },
                    React.createElement("button", { type: "button", className: "btn ghost", onClick: () => setCreating(false) }, "Cancel"),
                    React.createElement("button", { className: "btn primary" }, "Create user"))))),
        React.createElement("div", { className: "card" },
            React.createElement("div", { className: "card-head" },
                React.createElement("h3", null, "Users"),
                React.createElement("div", { className: "sub" },
                    (users.data || []).length,
                    " accounts")),
            React.createElement("div", { className: "table-wrap" },
                React.createElement("table", { className: "tbl" },
                    React.createElement("thead", null,
                        React.createElement("tr", null,
                            React.createElement("th", null, "Email"),
                            React.createElement("th", null, "Roles"),
                            React.createElement("th", null, "Permissions"),
                            React.createElement("th", null, "MFA"),
                            React.createElement("th", null, "Status"),
                            React.createElement("th", null, "Actions"))),
                    React.createElement("tbody", null,
                        (users.loading || rbac.loading) && React.createElement(SkeletonRows, { n: 4, cols: 6 }),
                        !users.loading && (users.data || []).map(user => (React.createElement("tr", { key: user.id },
                            React.createElement("td", null,
                                React.createElement("strong", null, user.email),
                                React.createElement("div", { className: "mono muted" }, user.id)),
                            React.createElement("td", null, roles.map(role => React.createElement("label", { className: "checkbox-label", key: role, style: { marginRight: 8 } },
                                React.createElement("input", { type: "checkbox", checked: (user.roles || []).includes(role), onChange: e => {
                                        const next = e.target.checked ? [...user.roles, role] : user.roles.filter(r => r !== role);
                                        updateUser(user, { roles: next });
                                    } }),
                                roleLabel(role, rbac.data)))),
                            React.createElement("td", { className: "mono muted" }, (user.permissions || []).join(', ')),
                            React.createElement("td", null, user.mfaEnabled ? React.createElement("span", { className: "pill ok" }, "Enabled") : React.createElement("span", { className: "pill" }, "Off")),
                            React.createElement("td", null, user.disabled ? React.createElement("span", { className: "pill crit" }, "Disabled") : React.createElement("span", { className: "pill ok" }, "Active")),
                            React.createElement("td", null,
                                React.createElement("div", { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                                    React.createElement("button", { className: "btn sm ghost", onClick: () => updateUser(user, { disabled: !user.disabled }) }, user.disabled ? 'Enable' : 'Disable'),
                                    React.createElement("button", { className: "btn sm ghost", onClick: () => { setResetUser(user); setResetPassword(''); } }, "Reset password"),
                                    React.createElement("button", { className: "btn sm ghost danger", onClick: () => setDeletingUser(user) }, "Delete")))))))))),
        resetUser && (React.createElement("div", { className: "modal-overlay", onClick: () => setResetUser(null) },
            React.createElement("form", { className: "modal-box", onSubmit: confirmResetPassword, onClick: e => e.stopPropagation() },
                React.createElement("h3", null, "Reset password"),
                React.createElement("p", null,
                    "Set a new temporary password for ",
                    React.createElement("strong", null, resetUser.email),
                    "."),
                React.createElement("label", { className: "field" },
                    React.createElement("span", null, "New temporary password"),
                    React.createElement("input", { type: "password", minLength: "12", required: true, value: resetPassword, onChange: e => setResetPassword(e.target.value) })),
                React.createElement("div", { className: "modal-actions" },
                    React.createElement("button", { type: "button", className: "btn ghost", onClick: () => setResetUser(null) }, "Cancel"),
                    React.createElement("button", { className: "btn primary" }, "Reset password"))))),
        deletingUser && (React.createElement("div", { className: "modal-overlay", onClick: () => setDeletingUser(null) },
            React.createElement("div", { className: "modal-box", onClick: e => e.stopPropagation() },
                React.createElement("h3", null, "Delete user?"),
                React.createElement("p", null,
                    "This permanently removes ",
                    React.createElement("strong", null, deletingUser.email),
                    " from the management server."),
                React.createElement("div", { className: "modal-actions" },
                    React.createElement("button", { className: "btn ghost", onClick: () => setDeletingUser(null) }, "Cancel"),
                    React.createElement("button", { className: "btn danger", onClick: confirmDeleteUser }, "Delete user")))))));
}
function PermissionSettings() {
    const rbac = useResource(() => PatchAPI.adminRbac());
    const [mode, setMode] = useState('list');
    const [editing, setEditing] = useState(null);
    const [deleting, setDeleting] = useState(null);
    const [form, setForm] = useState({ id: '', name: '', description: '', permissions: [] });
    const [saving, setSaving] = useState(false);
    const [notice, setNotice] = useState('');
    const roleDefinitions = rbac.data?.roleDefinitions || [];
    const permissions = rbac.data?.permissions || [];
    const openCreate = () => {
        setNotice('');
        setEditing(null);
        setForm({ id: '', name: '', description: '', permissions: ['apps:read'] });
        setMode('form');
    };
    const openEdit = (role) => {
        setNotice('');
        setEditing(role);
        setForm({
            id: role.id,
            name: role.name || role.id,
            description: role.description || '',
            permissions: [...(role.permissions || [])],
        });
        setMode('form');
    };
    const closeForm = () => {
        setMode('list');
        setEditing(null);
        setNotice('');
    };
    const togglePermission = (permission) => setForm(prev => ({
        ...prev,
        permissions: prev.permissions.includes(permission)
            ? prev.permissions.filter(p => p !== permission)
            : [...prev.permissions, permission].sort(),
    }));
    const submitRole = (e) => {
        e.preventDefault();
        setSaving(true);
        setNotice('');
        const dto = {
            id: form.id,
            name: form.name,
            description: form.description,
            permissions: form.permissions,
        };
        const action = editing
            ? PatchAPI.adminUpdateRole(editing.id, dto)
            : PatchAPI.adminCreateRole(dto);
        action
            .then(() => { closeForm(); rbac.reload(); })
            .catch(err => setNotice(err.message || 'Role save failed'))
            .finally(() => setSaving(false));
    };
    const confirmDeleteRole = () => {
        if (!deleting)
            return;
        setSaving(true);
        setNotice('');
        PatchAPI.adminDeleteRole(deleting.id)
            .then(() => { setDeleting(null); rbac.reload(); })
            .catch(err => setNotice(err.message || 'Delete failed'))
            .finally(() => setSaving(false));
    };
    return (React.createElement("div", null,
        React.createElement("div", { className: "page-head" },
            React.createElement("div", null,
                React.createElement("h2", null, "Permissions"),
                React.createElement("p", null, "Create roles and assign access across the management server")),
            mode === 'list' && React.createElement("button", { className: "btn primary", onClick: openCreate },
                Icon.plus,
                " New role")),
        rbac.error && React.createElement(ErrorAlert, { error: rbac.error, onRetry: rbac.reload }),
        notice && React.createElement("div", { className: "banner error" }, notice),
        mode === 'form' && (React.createElement("div", { className: "card", style: { marginBottom: 16 } },
            React.createElement("div", { className: "card-head" },
                React.createElement("div", null,
                    React.createElement("h3", null, editing ? `Edit ${editing.name || editing.id}` : 'Create role'),
                    React.createElement("div", { className: "sub" }, editing?.builtIn ? 'Built-in role' : 'Custom role'))),
            React.createElement("form", { className: "card-body", onSubmit: submitRole, style: { display: 'flex', flexDirection: 'column', gap: 14 } },
                React.createElement("div", { className: "form-grid" },
                    React.createElement("label", { className: "field" },
                        React.createElement("span", null, "Role ID"),
                        React.createElement("input", { required: true, disabled: Boolean(editing), value: form.id, onChange: e => setForm(prev => ({ ...prev, id: e.target.value })), placeholder: "regional_operator" }),
                        React.createElement("span", { className: "field-sub" }, "Lowercase letters, numbers, underscores, colons, or hyphens.")),
                    React.createElement("label", { className: "field" },
                        React.createElement("span", null, "Display name"),
                        React.createElement("input", { required: true, value: form.name, onChange: e => setForm(prev => ({ ...prev, name: e.target.value })), placeholder: "Regional Operator" }))),
                React.createElement("label", { className: "field" },
                    React.createElement("span", null, "Description"),
                    React.createElement("input", { value: form.description, onChange: e => setForm(prev => ({ ...prev, description: e.target.value })), placeholder: "What this role is used for" })),
                React.createElement("div", null,
                    React.createElement("strong", null, "Permissions"),
                    React.createElement("div", { className: "checkbox-group", style: { marginTop: 8 } }, permissions.map(permission => (React.createElement("label", { className: "checkbox-label", key: permission },
                        React.createElement("input", { type: "checkbox", checked: form.permissions.includes(permission), onChange: () => togglePermission(permission) }),
                        React.createElement("span", { className: "mono" }, permission)))))),
                React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between' } },
                    React.createElement("button", { type: "button", className: "btn ghost", onClick: closeForm, disabled: saving }, "Cancel"),
                    React.createElement("button", { className: "btn primary", disabled: saving }, saving ? 'Saving...' : 'Save role'))))),
        React.createElement("div", { className: "card" },
            React.createElement("div", { className: "card-head" },
                React.createElement("h3", null, "Roles"),
                React.createElement("div", { className: "sub" },
                    roleDefinitions.length || (rbac.data?.roles || []).length,
                    " roles \u00B7 ",
                    permissions.length,
                    " permissions")),
            React.createElement("div", { className: "card-body" },
                rbac.loading && React.createElement(Skeleton, { h: 140 }),
                !rbac.loading && roleDefinitions.length === 0 && React.createElement("div", { className: "empty-state" }, "No roles configured."),
                !rbac.loading && roleDefinitions.map(role => (React.createElement("div", { key: role.id, style: { border: '1px solid var(--line)', borderRadius: 8, padding: 14, marginBottom: 12 } },
                    React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' } },
                        React.createElement("div", null,
                            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                                React.createElement("strong", null, role.name || role.id),
                                React.createElement("span", { className: "pill" }, role.id),
                                role.builtIn && React.createElement("span", { className: "pill accent" }, "Built-in")),
                            role.description && React.createElement("div", { className: "muted", style: { fontSize: 12, marginTop: 4 } }, role.description)),
                        React.createElement("div", { style: { display: 'flex', gap: 6 } },
                            React.createElement("button", { className: "btn sm ghost", onClick: () => openEdit(role) }, "Edit"),
                            React.createElement("button", { className: "btn sm ghost danger", onClick: () => setDeleting(role), disabled: role.id === 'owner' }, "Delete"))),
                    React.createElement("div", { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 } },
                        (role.permissions || []).map(p => React.createElement("span", { className: "pill", key: p }, p)),
                        (role.permissions || []).length === 0 && React.createElement("span", { className: "muted" }, "No permissions assigned"))))))),
        deleting && (React.createElement("div", { className: "modal-overlay", onClick: () => setDeleting(null) },
            React.createElement("div", { className: "modal-box", onClick: e => e.stopPropagation() },
                React.createElement("h3", null, "Delete role?"),
                React.createElement("p", null,
                    "This removes ",
                    React.createElement("strong", null, deleting.name || deleting.id),
                    ". Users and SSO providers must be moved off this role first."),
                notice && React.createElement("div", { className: "banner error" }, notice),
                React.createElement("div", { className: "modal-actions" },
                    React.createElement("button", { className: "btn ghost", onClick: () => setDeleting(null), disabled: saving }, "Cancel"),
                    React.createElement("button", { className: "btn danger", onClick: confirmDeleteRole, disabled: saving },
                        saving ? React.createElement("span", { className: "search-spinner" }) : null,
                        " Delete role")))))));
}
// ── Device Retirement Policies ──────────────────────────────────────────────
const CRITERION_LABELS = {
    inactive_days: 'Inactive for N days',
    os_pattern: 'OS name contains',
    trust_score_below: 'Trust score below',
    risk_score_above: 'Risk score above',
    has_tag: 'Has tag',
    missing_tag: 'Missing tag',
    in_group: 'In group',
    os_family: 'OS family',
};
const ACTION_LABELS = {
    tag_device: 'Apply tag to device',
    create_alarm: 'Create alarm',
    notify: 'Send notification',
};
function RetirementCriterionRow({ criterion, onChange, onRemove }) {
    const set = (key, value) => onChange({ ...criterion, [key]: value });
    return (React.createElement("div", { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', background: 'var(--bg-2)', borderRadius: 6, padding: '8px 10px' } },
        React.createElement("select", { value: criterion.type, onChange: e => onChange({ type: e.target.value }), style: { flexShrink: 0 } }, Object.entries(CRITERION_LABELS).map(([v, l]) => React.createElement("option", { key: v, value: v }, l))),
        criterion.type === 'inactive_days' && (React.createElement("input", { type: "number", min: "1", placeholder: "days", value: criterion.days ?? '', onChange: e => set('days', Number(e.target.value)), style: { width: 80 } })),
        criterion.type === 'os_pattern' && (React.createElement("input", { placeholder: "e.g. Windows 7", value: criterion.pattern ?? '', onChange: e => set('pattern', e.target.value), style: { flex: 1 } })),
        (criterion.type === 'trust_score_below' || criterion.type === 'risk_score_above') && (React.createElement("input", { type: "number", min: "0", max: "100", placeholder: "0\u2013100", value: criterion.score ?? '', onChange: e => set('score', Number(e.target.value)), style: { width: 80 } })),
        (criterion.type === 'has_tag' || criterion.type === 'missing_tag') && (React.createElement("input", { placeholder: "tag name", value: criterion.tag ?? '', onChange: e => set('tag', e.target.value), style: { flex: 1 } })),
        criterion.type === 'in_group' && (React.createElement("input", { placeholder: "group name", value: criterion.group ?? '', onChange: e => set('group', e.target.value), style: { flex: 1 } })),
        criterion.type === 'os_family' && (React.createElement("select", { value: criterion.os ?? 'windows', onChange: e => set('os', e.target.value) },
            React.createElement("option", { value: "windows" }, "Windows"),
            React.createElement("option", { value: "linux" }, "Linux"))),
        React.createElement("button", { className: "btn sm ghost danger", onClick: onRemove, style: { marginLeft: 'auto' } }, "Remove")));
}
function RetirementActionRow({ action, onChange, onRemove }) {
    const set = (key, value) => onChange({ ...action, [key]: value });
    return (React.createElement("div", { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', background: 'var(--bg-2)', borderRadius: 6, padding: '8px 10px' } },
        React.createElement("select", { value: action.type, onChange: e => onChange({ type: e.target.value }), style: { flexShrink: 0 } }, Object.entries(ACTION_LABELS).map(([v, l]) => React.createElement("option", { key: v, value: v }, l))),
        action.type === 'tag_device' && (React.createElement("input", { placeholder: "tag to apply", value: action.tag ?? '', onChange: e => set('tag', e.target.value), style: { flex: 1 } })),
        action.type === 'create_alarm' && (React.createElement(React.Fragment, null,
            React.createElement("select", { value: action.severity ?? 'warning', onChange: e => set('severity', e.target.value) },
                React.createElement("option", { value: "info" }, "Info"),
                React.createElement("option", { value: "warning" }, "Warning"),
                React.createElement("option", { value: "critical" }, "Critical")),
            React.createElement("input", { placeholder: "alarm message", value: action.message ?? '', onChange: e => set('message', e.target.value), style: { flex: 1 } }))),
        action.type === 'notify' && (React.createElement(React.Fragment, null,
            React.createElement("select", { value: action.channel ?? 'siem', onChange: e => set('channel', e.target.value) },
                React.createElement("option", { value: "siem" }, "SIEM"),
                React.createElement("option", { value: "webhook" }, "Webhook"),
                React.createElement("option", { value: "email" }, "Email")),
            React.createElement("input", { placeholder: "optional message", value: action.message ?? '', onChange: e => set('message', e.target.value), style: { flex: 1 } }))),
        React.createElement("button", { className: "btn sm ghost danger", onClick: onRemove, style: { marginLeft: 'auto' } }, "Remove")));
}
const BLANK_POLICY = {
    name: '', description: '', enabled: true,
    conditionCombinator: 'AND', priority: 10,
    conditions: [{ type: 'inactive_days', days: 90 }],
    actions: [{ type: 'tag_device', tag: 'retired' }],
};
function RetirementPolicyForm({ initial, onSave, onCancel, saving, saveError }) {
    const [form, setForm] = useState(initial ? { ...initial } : { ...BLANK_POLICY });
    const setField = (key, value) => setForm(prev => ({ ...prev, [key]: value }));
    const addCondition = () => setForm(prev => ({ ...prev, conditions: [...prev.conditions, { type: 'inactive_days', days: 90 }] }));
    const updateCondition = (i, val) => setForm(prev => ({ ...prev, conditions: prev.conditions.map((c, idx) => idx === i ? val : c) }));
    const removeCondition = (i) => setForm(prev => ({ ...prev, conditions: prev.conditions.filter((_, idx) => idx !== i) }));
    const addAction = () => setForm(prev => ({ ...prev, actions: [...prev.actions, { type: 'tag_device', tag: 'retired' }] }));
    const updateAction = (i, val) => setForm(prev => ({ ...prev, actions: prev.actions.map((a, idx) => idx === i ? val : a) }));
    const removeAction = (i) => setForm(prev => ({ ...prev, actions: prev.actions.filter((_, idx) => idx !== i) }));
    const submit = (e) => { e.preventDefault(); onSave(form); };
    return (React.createElement("form", { className: "card-body", onSubmit: submit, style: { display: 'flex', flexDirection: 'column', gap: 16 } },
        React.createElement("div", { className: "form-grid" },
            React.createElement("label", { className: "field" },
                React.createElement("span", null, "Policy name"),
                React.createElement("input", { required: true, value: form.name, onChange: e => setField('name', e.target.value), placeholder: "e.g. Retire inactive Windows 7 devices" })),
            React.createElement("label", { className: "field" },
                React.createElement("span", null, "Priority"),
                React.createElement("input", { type: "number", min: "1", value: form.priority, onChange: e => setField('priority', Number(e.target.value)) }))),
        React.createElement("label", { className: "field" },
            React.createElement("span", null,
                "Description ",
                React.createElement("em", { className: "field-hint" }, "optional")),
            React.createElement("input", { value: form.description, onChange: e => setField('description', e.target.value), placeholder: "What does this policy retire and why?" })),
        React.createElement("div", { className: "checkbox-group" },
            React.createElement("label", { className: "checkbox-label" },
                React.createElement("input", { type: "checkbox", checked: form.enabled, onChange: e => setField('enabled', e.target.checked) }),
                " Enabled")),
        React.createElement("div", null,
            React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 } },
                React.createElement("strong", null, "Conditions"),
                React.createElement("div", { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                    React.createElement("span", { className: "muted", style: { fontSize: 12 } }, "Match"),
                    React.createElement("select", { value: form.conditionCombinator, onChange: e => setField('conditionCombinator', e.target.value), style: { width: 'auto' } },
                        React.createElement("option", { value: "AND" }, "ALL (AND)"),
                        React.createElement("option", { value: "OR" }, "ANY (OR)")))),
            React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, form.conditions.map((c, i) => (React.createElement(RetirementCriterionRow, { key: i, criterion: c, onChange: val => updateCondition(i, val), onRemove: () => removeCondition(i) })))),
            React.createElement("button", { type: "button", className: "btn sm ghost", style: { marginTop: 8 }, onClick: addCondition }, "+ Add condition")),
        React.createElement("div", null,
            React.createElement("div", { style: { marginBottom: 8 } },
                React.createElement("strong", null, "Actions"),
                " ",
                React.createElement("span", { className: "muted", style: { fontSize: 12 } }, "executed when a device matches")),
            React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, form.actions.map((a, i) => (React.createElement(RetirementActionRow, { key: i, action: a, onChange: val => updateAction(i, val), onRemove: () => removeAction(i) })))),
            React.createElement("button", { type: "button", className: "btn sm ghost", style: { marginTop: 8 }, onClick: addAction }, "+ Add action")),
        saveError && React.createElement("div", { className: "banner error" }, saveError),
        React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between' } },
            React.createElement("button", { type: "button", className: "btn ghost", onClick: onCancel }, "Cancel"),
            React.createElement("button", { className: "btn primary", disabled: saving }, saving ? 'Saving…' : (initial ? 'Update policy' : 'Create policy')))));
}
function RetirementPolicyCard({ policy, onEdit, onDelete, onEvaluate, evaluating }) {
    const conditionSummary = policy.conditions.map(c => {
        switch (c.type) {
            case 'inactive_days': return `Inactive > ${c.days}d`;
            case 'os_pattern': return `OS contains "${c.pattern}"`;
            case 'trust_score_below': return `Trust < ${c.score}`;
            case 'risk_score_above': return `Risk > ${c.score}`;
            case 'has_tag': return `Tag: ${c.tag}`;
            case 'missing_tag': return `No tag: ${c.tag}`;
            case 'in_group': return `Group: ${c.group}`;
            case 'os_family': return `OS: ${c.os}`;
            default: return c.type;
        }
    }).join(` ${policy.conditionCombinator} `);
    return (React.createElement("div", { style: { border: '1px solid var(--border)', borderRadius: 8, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 } },
        React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 } },
            React.createElement("div", null,
                React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                    React.createElement("strong", null, policy.name),
                    React.createElement("span", { className: 'pill ' + (policy.enabled ? 'ok' : '') }, policy.enabled ? 'Enabled' : 'Disabled'),
                    React.createElement("span", { className: "pill" },
                        "Priority ",
                        policy.priority)),
                policy.description && React.createElement("div", { className: "muted", style: { fontSize: 12, marginTop: 2 } }, policy.description)),
            React.createElement("div", { style: { display: 'flex', gap: 6 } },
                React.createElement("button", { className: "btn sm ghost", onClick: () => onEvaluate(policy), disabled: evaluating },
                    evaluating ? React.createElement("span", { className: "search-spinner" }) : null,
                    " Evaluate"),
                React.createElement("button", { className: "btn sm ghost", onClick: () => onEdit(policy) }, "Edit"),
                React.createElement("button", { className: "btn sm ghost danger", onClick: () => onDelete(policy) }, "Delete"))),
        React.createElement("div", { style: { fontSize: 12 } },
            React.createElement("span", { className: "muted" }, "Conditions: "),
            React.createElement("span", { className: "mono" }, conditionSummary)),
        React.createElement("div", { style: { fontSize: 12 } },
            React.createElement("span", { className: "muted" }, "Actions: "),
            policy.actions.map((a, i) => (React.createElement("span", { key: i, className: "pill", style: { marginRight: 4 } }, a.type === 'tag_device' ? `tag: ${a.tag}` : a.type === 'create_alarm' ? `alarm(${a.severity})` : `notify:${a.channel}`)))),
        policy.lastEvaluatedAt != null && (React.createElement("div", { className: "muted", style: { fontSize: 11 } },
            "Last evaluated ",
            fmtAgo(policy.lastEvaluatedAt),
            " \u2014 matched ",
            policy.matchCount ?? 0,
            " device",
            policy.matchCount !== 1 ? 's' : ''))));
}
function RetirementEvalModal({ result, onClose }) {
    if (!result)
        return null;
    return (React.createElement("div", { className: "modal-overlay", onClick: onClose },
        React.createElement("div", { className: "modal-box", style: { maxWidth: 560, width: '95%' }, onClick: e => e.stopPropagation() },
            React.createElement("h3", null, "Evaluation results"),
            React.createElement("p", { className: "muted" },
                result.matchCount,
                " of ",
                result.totalDevices,
                " devices match this policy."),
            result.matchedDevices.length > 0 ? (React.createElement("div", { style: { maxHeight: 280, overflowY: 'auto', marginTop: 10 } },
                React.createElement("table", { className: "tbl" },
                    React.createElement("thead", null,
                        React.createElement("tr", null,
                            React.createElement("th", null, "Hostname"),
                            React.createElement("th", null, "OS"),
                            React.createElement("th", null, "Group"),
                            React.createElement("th", null, "Last seen"))),
                    React.createElement("tbody", null, result.matchedDevices.map(d => (React.createElement("tr", { key: d.id },
                        React.createElement("td", null,
                            React.createElement("strong", null, d.hostname)),
                        React.createElement("td", { className: "muted" }, d.os),
                        React.createElement("td", null, d.group || '—'),
                        React.createElement("td", { className: "muted" }, fmtAgo(d.lastSeenAt))))))))) : (React.createElement("div", { className: "empty-state", style: { padding: 20 } }, "No devices currently match this policy.")),
            React.createElement("div", { className: "modal-actions", style: { marginTop: 12 } },
                React.createElement("button", { className: "btn primary", onClick: onClose }, "Close")))));
}
function RetirementPoliciesPage() {
    const [tenantId] = useState('default');
    const { data: policies, loading, error, reload } = useResource(() => PatchAPI.retirementPolicies(tenantId), [tenantId]);
    const [mode, setMode] = useState('list'); // 'list' | 'add' | 'edit'
    const [editing, setEditing] = useState(null);
    const [deleting, setDeleting] = useState(null);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState('');
    const [evaluating, setEvaluating] = useState(null);
    const [evalResult, setEvalResult] = useState(null);
    const openAdd = () => { setSaveError(''); setMode('add'); };
    const openEdit = (p) => { setSaveError(''); setEditing(p); setMode('edit'); };
    const closeForm = () => { setMode('list'); setEditing(null); setSaveError(''); };
    const handleSave = (dto) => {
        setSaving(true);
        setSaveError('');
        const action = mode === 'edit'
            ? PatchAPI.updateRetirementPolicy(editing.id, dto)
            : PatchAPI.createRetirementPolicy({ ...dto, tenantId });
        action
            .then(() => { closeForm(); reload(); })
            .catch(err => setSaveError(err.message || 'Save failed'))
            .finally(() => setSaving(false));
    };
    const handleDelete = () => {
        setSaving(true);
        PatchAPI.deleteRetirementPolicy(deleting.id)
            .then(() => { setDeleting(null); reload(); })
            .catch(err => setSaveError(err.message || 'Delete failed'))
            .finally(() => setSaving(false));
    };
    const handleEvaluate = (policy) => {
        setEvaluating(policy.id);
        PatchAPI.evaluateRetirementPolicy(policy.id)
            .then(result => { setEvalResult(result); reload(); })
            .catch(err => alert(err.message || 'Evaluation failed'))
            .finally(() => setEvaluating(null));
    };
    const list = Array.isArray(policies) ? policies : [];
    return (React.createElement("div", null,
        React.createElement("div", { className: "page-head" },
            React.createElement("div", null,
                React.createElement("h2", null, "Device retirement policies"),
                React.createElement("p", null, "Define rules to identify and flag devices for retirement based on inactivity, OS, trust score, and other parameters.")),
            mode === 'list' && React.createElement("button", { className: "btn primary", onClick: openAdd },
                Icon.plus,
                " New policy")),
        (mode === 'add' || mode === 'edit') && (React.createElement("div", { className: "card", style: { marginBottom: 16 } },
            React.createElement("div", { className: "card-head" },
                React.createElement("h3", null, mode === 'edit' ? 'Edit policy' : 'New policy')),
            React.createElement(RetirementPolicyForm, { initial: mode === 'edit' ? editing : null, onSave: handleSave, onCancel: closeForm, saving: saving, saveError: saveError }))),
        React.createElement("div", { className: "card" },
            React.createElement("div", { className: "card-head" },
                React.createElement("h3", null, "Policies"),
                React.createElement("div", { className: "sub" },
                    list.length,
                    " configured")),
            loading && React.createElement("div", { className: "empty-state" },
                React.createElement("span", { className: "search-spinner" }),
                " Loading\u2026"),
            error && React.createElement("div", { style: { padding: 12 } },
                React.createElement(ErrorAlert, { error: error, onRetry: reload })),
            !loading && !error && list.length === 0 && (React.createElement("div", { className: "empty-state" },
                React.createElement("div", { style: { color: 'var(--text-3)', marginBottom: 6 } }, Icon.shield),
                React.createElement("p", null, "No retirement policies configured."),
                React.createElement("p", { className: "sub" }, "Create a policy to automatically identify devices that should be retired."),
                mode === 'list' && React.createElement("button", { className: "btn primary", style: { marginTop: 12 }, onClick: openAdd },
                    Icon.plus,
                    " Create first policy"))),
            !loading && !error && list.length > 0 && (React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 16px' } }, list.map(p => (React.createElement(RetirementPolicyCard, { key: p.id, policy: p, onEdit: openEdit, onDelete: p => setDeleting(p), onEvaluate: handleEvaluate, evaluating: evaluating === p.id })))))),
        deleting && (React.createElement("div", { className: "modal-overlay", onClick: () => setDeleting(null) },
            React.createElement("div", { className: "modal-box", onClick: e => e.stopPropagation() },
                React.createElement("h3", null, "Delete retirement policy?"),
                React.createElement("p", null,
                    "This permanently removes ",
                    React.createElement("strong", null, deleting.name),
                    ". Devices already tagged by this policy will retain their tags."),
                saveError && React.createElement("div", { className: "banner error" }, saveError),
                React.createElement("div", { className: "modal-actions" },
                    React.createElement("button", { className: "btn ghost", onClick: () => setDeleting(null), disabled: saving }, "Cancel"),
                    React.createElement("button", { className: "btn danger", onClick: handleDelete, disabled: saving },
                        saving ? React.createElement("span", { className: "search-spinner" }) : null,
                        " Delete policy"))))),
        React.createElement(RetirementEvalModal, { result: evalResult, onClose: () => setEvalResult(null) })));
}
function AdminSettingsPage({ initialTab = 'policy' }) {
    return (React.createElement("div", { className: "page" },
        initialTab === 'policy' && React.createElement(TenantPolicySettings, null),
        initialTab === 'users' && React.createElement(AccessSettings, null),
        initialTab === 'permissions' && React.createElement(PermissionSettings, null),
        initialTab === 'siem' && React.createElement(SiemPage, null),
        initialTab === 'sso' && React.createElement(SsoSettingsPage, null),
        initialTab === 'posture' && React.createElement(SecurityPosturePage, null),
        initialTab === 'retirement' && React.createElement(RetirementPoliciesPage, null)));
}
// ---------- Quick Actions ----------
/**
 * Triggers a client-side file download from a string payload.
 *
 * @param data File contents.
 * @param filename Suggested download filename.
 * @param mimeType MIME type for the blob.
 */
function downloadBlob(data, filename, mimeType) {
    const blob = new Blob([data], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}
/**
 * Serialises an array of objects to RFC-4180 CSV.
 *
 * @param rows Array of plain objects.
 * @param keys Column names (used as header row and property accessors).
 */
function toCSV(rows, keys) {
    const esc = (v) => {
        const s = v == null ? '' : String(v);
        return s.includes(',') || s.includes('"') || s.includes('\n')
            ? '"' + s.replace(/"/g, '""') + '"'
            : s;
    };
    return [keys.join(','), ...rows.map(r => keys.map(k => esc(r[k])).join(','))].join('\n');
}
/** ISO timestamp slug safe for filenames. */
const exportStamp = () => new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
/**
 * A single quick-action card with run / confirm / result / error states.
 *
 * @param props.icon SVG icon element.
 * @param props.title Card heading.
 * @param props.description One-line subtitle.
 * @param props.onRun Async function that performs the action and returns a result string or object.
 * @param props.confirmText When set a confirmation step is shown before the action fires.
 */
function ActionCard({ icon, title, description, onRun, confirmText }) {
    const [status, setStatus] = useState('idle');
    const [result, setResult] = useState(null);
    const [error, setError] = useState(null);
    const [confirming, setConfirming] = useState(false);
    const execute = async () => {
        setConfirming(false);
        setStatus('running');
        setResult(null);
        setError(null);
        try {
            setResult(await onRun());
            setStatus('done');
        }
        catch (err) {
            setError(err?.message || String(err));
            setStatus('error');
        }
    };
    const handleRun = () => {
        if (confirmText && !confirming) {
            setConfirming(true);
            return;
        }
        execute();
    };
    return (React.createElement("div", { className: 'qa-card' + (status === 'error' ? ' qa-card--err' : status === 'done' ? ' qa-card--done' : '') },
        React.createElement("div", { className: "qa-card-icon" }, icon),
        React.createElement("div", { className: "qa-card-body" },
            React.createElement("div", { className: "qa-card-head" },
                React.createElement("strong", { className: "qa-card-title" }, title),
                React.createElement("span", { className: "qa-card-desc" }, description)),
            status === 'done' && result !== null && (React.createElement("div", { className: "qa-card-result" },
                typeof result === 'string' && (React.createElement("span", { className: "qa-ok" },
                    Icon.check,
                    " ",
                    result)),
                result?.type === 'nodes' && (React.createElement("div", { className: "qa-node-grid" }, result.nodes.map(n => (React.createElement("div", { key: n.id, className: "qa-node-row" },
                    React.createElement("span", { className: `qa-dot ${n.healthState === 'healthy' ? 'ok' : n.healthState === 'degraded' ? 'warn' : 'err'}` }),
                    React.createElement("span", { className: "qa-node-name" }, n.name || n.id),
                    React.createElement("span", { className: "qa-node-score" },
                        "Trust ",
                        n.trust?.trustScore ?? '--'),
                    React.createElement("span", { className: "qa-node-state muted" },
                        n.healthState,
                        " \u00B7 ",
                        n.status)))))),
                result?.type === 'stale' && (React.createElement("div", { className: "qa-stale" },
                    React.createElement("span", { className: "qa-ok" },
                        Icon.check,
                        " ",
                        result.count,
                        " device",
                        result.count !== 1 ? 's' : '',
                        " with inventory older than 7 days"),
                    result.devices.length > 0 && (React.createElement("div", { className: "qa-stale-list" },
                        result.devices.slice(0, 10).map(d => (React.createElement("span", { key: d.id, className: "tag" }, d.hostname || d.id))),
                        result.devices.length > 10 && (React.createElement("span", { className: "muted" },
                            "+",
                            result.devices.length - 10,
                            " more")))))))),
            status === 'error' && (React.createElement("div", { className: "qa-card-result" },
                React.createElement("span", { className: "qa-err" }, error))),
            confirming && (React.createElement("div", { className: "qa-confirm" },
                React.createElement("span", { className: "qa-confirm-text" }, confirmText),
                React.createElement("div", { className: "qa-confirm-btns" },
                    React.createElement("button", { className: "btn sm danger", onClick: execute }, "Confirm"),
                    React.createElement("button", { className: "btn sm ghost", onClick: () => setConfirming(false) }, "Cancel"))))),
        React.createElement("div", { className: "qa-card-actions" }, status === 'running' ? (React.createElement("span", { className: "search-spinner" })) : !confirming && (React.createElement("button", { className: "btn sm accent", onClick: handleRun }, status === 'done' ? 'Run again' : 'Run')))));
}
/**
 * A labelled group of action cards.
 *
 * @param props.label Section heading.
 * @param props.children ActionCard elements.
 */
function ActionGroup({ label, children }) {
    return (React.createElement("div", { className: "qa-group" },
        React.createElement("div", { className: "qa-group-label" }, label),
        React.createElement("div", { className: "qa-group-cards" }, children)));
}
/**
 * Renders the quick actions page UI.
 * @returns The result produced by the operation.
 */
function QuickActionsPage() {
    return (React.createElement("div", { className: "page" },
        React.createElement("div", { className: "page-head" },
            React.createElement("div", null,
                React.createElement("h2", null, "Quick Actions"),
                React.createElement("p", null, "Batch fleet operations \u2014 results appear inline after each run."))),
        React.createElement(ActionGroup, { label: "Inventory" },
            React.createElement(ActionCard, { icon: Icon.refresh, title: "Pull Inventory \u2014 All Devices", description: "Queue an inventory refresh for every enrolled device in the fleet.", onRun: async () => {
                    const devices = await PatchAPI.devices();
                    let queued = 0, failed = 0;
                    await Promise.allSettled(devices.map(d => PatchAPI.refreshInventory(d.id).then(() => queued++, () => failed++)));
                    return `Queued ${queued} refresh task${queued !== 1 ? 's' : ''}${failed ? ` · ${failed} skipped` : ''}`;
                } }),
            React.createElement(ActionCard, { icon: Icon.refresh, title: "Pull Inventory \u2014 Offline & Stale", description: "Refresh only devices that are offline or haven't checked in for over 24 hours.", onRun: async () => {
                    const devices = await PatchAPI.devices();
                    const cutoff = Date.now() - 24 * 60 * 60000;
                    const stale = devices.filter(d => !d.online || new Date(d.lastSeenAt).getTime() < cutoff);
                    if (stale.length === 0)
                        return 'No offline or stale devices found.';
                    let queued = 0, failed = 0;
                    await Promise.allSettled(stale.map(d => PatchAPI.refreshInventory(d.id).then(() => queued++, () => failed++)));
                    return `${stale.length} stale device${stale.length !== 1 ? 's' : ''} — queued ${queued}${failed ? ` · ${failed} skipped` : ''}`;
                } })),
        React.createElement(ActionGroup, { label: "Task Queue" },
            React.createElement(ActionCard, { icon: Icon.tasks, title: "Cancel Pending Tasks", description: "Cancel all tasks waiting in the queue that have not yet been dispatched to a node.", confirmText: "Cancel all pending tasks?", onRun: async () => {
                    const tasks = await PatchAPI.tasks();
                    const pending = tasks.filter(t => t.status === 'pending');
                    if (pending.length === 0)
                        return 'No pending tasks found.';
                    let cancelled = 0, failed = 0;
                    await Promise.allSettled(pending.map(t => PatchAPI.cancelTask(t.id).then(() => cancelled++, () => failed++)));
                    return `Cancelled ${cancelled} task${cancelled !== 1 ? 's' : ''}${failed ? ` · ${failed} skipped` : ''}`;
                } }),
            React.createElement(ActionCard, { icon: Icon.tasks, title: "Clear Failed Tasks", description: "Remove all failed tasks from the queue to declutter the task list.", confirmText: "Clear all failed tasks?", onRun: async () => {
                    const tasks = await PatchAPI.tasks();
                    const failed = tasks.filter(t => t.status === 'failed');
                    if (failed.length === 0)
                        return 'No failed tasks found.';
                    let cleared = 0, errs = 0;
                    await Promise.allSettled(failed.map(t => PatchAPI.cancelTask(t.id).then(() => cleared++, () => errs++)));
                    return `Cleared ${cleared} failed task${cleared !== 1 ? 's' : ''}${errs ? ` · ${errs} skipped` : ''}`;
                } })),
        React.createElement(ActionGroup, { label: "Alarms" },
            React.createElement(ActionCard, { icon: Icon.alarms, title: "Dismiss All Alarms", description: "Resolve every active alarm at once \u2014 use after investigating open alerts.", confirmText: "Dismiss all active alarms?", onRun: async () => {
                    const res = await PatchAPI.resolveAllAlarms();
                    const n = res?.resolved ?? 0;
                    return `Dismissed ${n} alarm${n !== 1 ? 's' : ''}`;
                } })),
        React.createElement(ActionGroup, { label: "Fleet Insights" },
            React.createElement(ActionCard, { icon: Icon.nodes, title: "Node Health Snapshot", description: "Fetch live health and trust scores for every backend node.", onRun: async () => {
                    const nodes = await PatchAPI.nodeTrustCenter();
                    return { type: 'nodes', nodes };
                } }),
            React.createElement(ActionCard, { icon: Icon.search, title: "Stale-Inventory Report", description: "List devices whose last recorded inventory is more than 7 days old.", onRun: async () => {
                    const devices = await PatchAPI.devices();
                    const cutoff = Date.now() - 7 * 24 * 60 * 60000;
                    const stale = devices.filter(d => !d.lastSeenAt || new Date(d.lastSeenAt).getTime() < cutoff);
                    return { type: 'stale', count: stale.length, devices: stale };
                } })),
        React.createElement(ActionGroup, { label: "Exports" },
            React.createElement(ActionCard, { icon: Icon.download, title: "Device Roster (CSV)", description: "Download all enrolled devices as a spreadsheet-ready CSV.", onRun: async () => {
                    const devices = await PatchAPI.devices();
                    const keys = ['id', 'hostname', 'os', 'platform', 'site', 'group', 'online', 'lastSeenAt', 'installedAppCount', 'pendingTaskCount'];
                    downloadBlob(toCSV(devices, keys), `1patch-devices-${exportStamp()}.csv`, 'text/csv');
                    return `Exported ${devices.length} device${devices.length !== 1 ? 's' : ''}`;
                } }),
            React.createElement(ActionCard, { icon: Icon.download, title: "Audit Log (JSON)", description: "Download the last 500 audit entries as a JSON file.", onRun: async () => {
                    const entries = await PatchAPI.audit(500);
                    downloadBlob(JSON.stringify(entries, null, 2), `1patch-audit-${exportStamp()}.json`, 'application/json');
                    return `Exported ${entries.length} audit entr${entries.length !== 1 ? 'ies' : 'y'}`;
                } }),
            React.createElement(ActionCard, { icon: Icon.download, title: "Task History (JSON)", description: "Download the full task list across all statuses as a JSON file.", onRun: async () => {
                    const tasks = await PatchAPI.tasks();
                    downloadBlob(JSON.stringify(tasks, null, 2), `1patch-tasks-${exportStamp()}.json`, 'application/json');
                    return `Exported ${tasks.length} task${tasks.length !== 1 ? 's' : ''}`;
                } }))));
}
Object.assign(window, {
    OverviewPage, DevicesPage, AppsPage, PackagesPage, RulesPage, TasksPage, NodesPage, AlarmsPage, AuditPage, SiemPage, SecurityPosturePage, DeviceDrawer, SsoSettingsPage, AdminSettingsPage, QuickActionsPage
});


// AGPL-3.0-only — Main app shell, routing, tweaks
const { useState: useStateApp, useEffect: useEffectApp, useRef: useRefApp } = React;
const TENANT_NAME = /*EDITMODE-BEGIN*/ "1patch" /*EDITMODE-END*/;
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/ {
    "theme": "light",
    "accentHue": 145,
    "density": "comfortable",
    "sidebar": "labelled"
} /*EDITMODE-END*/;
const CATEGORY_IDS = [
    "overview", "quick-actions", "devices", "device-groups", "apps", "packages", "rules", "tasks", "nodes", "alarms", "audit",
    "admin-policy", "admin-users", "admin-permissions", "admin-siem", "admin-sso", "admin-posture", "admin-retirement",
];
const LEGACY_CATEGORY_MAP = {
    admin: "admin-policy",
    siem: "admin-siem",
    settings: "admin-sso",
    "security-posture": "admin-posture",
};
const ADMIN_TAB_TO_CATEGORY = {
    policy: "admin-policy",
    users: "admin-users",
    permissions: "admin-permissions",
    siem: "admin-siem",
    sso: "admin-sso",
    posture: "admin-posture",
    retirement: "admin-retirement",
};
const SEARCH_TYPES = ["device", "group", "app", "package", "rule", "task", "node", "alarm", "audit"];
const SEARCH_ALIASES = {
    devices: "device",
    groups: "group",
    "device-groups": "group",
    apps: "app",
    packages: "package",
    rules: "rule",
    tasks: "task",
    nodes: "node",
    alarms: "alarm",
    audits: "audit",
    log: "audit",
    logs: "audit",
};
const SEARCH_TYPE_TO_CATEGORY = {
    device: "devices",
    group: "device-groups",
    app: "apps",
    package: "packages",
    rule: "rules",
    task: "tasks",
    node: "nodes",
    alarm: "alarms",
    audit: "audit",
};
/**
 * Parses search query input.
 *
 * @param value Value to read, render, or store.
 * @returns The result produced by the operation.
 */
function parseSearchQuery(value) {
    const raw = (value || "").trim();
    const match = raw.match(/^([a-z]+):\s*(.*)$/i);
    if (!match)
        return { type: null, term: raw };
    const requested = match[1].toLowerCase();
    const type = SEARCH_TYPES.includes(requested) ? requested : SEARCH_ALIASES[requested];
    return type ? { type, term: match[2].trim() } : { type: null, term: raw };
}
/**
 * Handles the text matches operation.
 *
 * @param query Search query or filter supplied by the caller.
 * @param parts parts supplied to the function.
 * @returns The result produced by the operation.
 */
function textMatches(query, parts) {
    if (!query)
        return true;
    const haystack = parts.filter(Boolean).join(" ").toLowerCase();
    return query.toLowerCase().split(/\s+/).every((part) => haystack.includes(part));
}
/**
 * Handles the highlight operation.
 *
 * @param text text supplied to the function.
 * @param term term supplied to the function.
 * @returns The result produced by the operation.
 */
function highlight(text, term) {
    if (!term || !text)
        return text || "";
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const parts = String(text).split(new RegExp(`(${esc})`, "gi"));
    if (parts.length === 1)
        return text;
    return parts.map((p, i) => i % 2 === 1 ? React.createElement("mark", { className: "search-mark", key: i }, p) : p);
}
/**
 * Handles the limit results operation.
 *
 * @param items items supplied to the function.
 * @param limit Maximum number of records to return.
 * @returns The result produced by the operation.
 */
function limitResults(items, limit = 8) {
    return items.slice(0, limit);
}
/**
 * Builds the search results payload.
 *
 * @param data data supplied to the function.
 * @param query Search query or filter supplied by the caller.
 * @returns The result produced by the operation.
 */
function buildSearchResults(data, query) {
    const { type, term } = parseSearchQuery(query);
    /**
     * Handles the include operation.
     *
     * @param candidateType candidate type supplied to the function.
     */
    const include = (candidateType) => !type || type === candidateType;
    const groups = [];
    if (include("device")) {
        const rows = limitResults((data.devices || [])
            .filter(d => textMatches(term, [d.hostname, formatOs(d.os), d.os, d.site, d.id, d.preferredNodeId]))
            .map(d => ({
            type: "device",
            title: d.hostname || d.id,
            meta: [formatOs(d.os), d.site, d.online ? "online" : "offline"].filter(Boolean).join(" · "),
            target: "devices",
            deviceId: d.id,
        })));
        if (rows.length)
            groups.push(["Devices", rows]);
    }
    if (include("group")) {
        const groupMap = new Map();
        for (const device of data.devices || []) {
            const name = device.group || "ungrouped";
            const row = groupMap.get(name) || { name, count: 0, online: 0, samples: [] };
            row.count += 1;
            row.online += device.online ? 1 : 0;
            if (row.samples.length < 3)
                row.samples.push(device.hostname || device.id);
            groupMap.set(name, row);
        }
        const rows = limitResults([...groupMap.values()]
            .filter(g => textMatches(term, [g.name, ...g.samples]))
            .map(g => ({
            type: "group",
            title: g.name,
            meta: `${g.count} devices · ${g.online} online`,
            target: "device-groups",
        })));
        if (rows.length)
            groups.push(["Device Groups", rows]);
    }
    if (include("app")) {
        const rows = limitResults((data.apps || [])
            .filter(a => textMatches(term, [a.name, a.publisher, a.latestVersion, a.latest, a.oldestVersion, a.oldest]))
            .map(a => ({
            type: "app",
            title: a.name,
            meta: [a.publisher, a.latestVersion ?? a.latest].filter(Boolean).join(" · "),
            target: "apps",
        })));
        if (rows.length)
            groups.push(["Apps", rows]);
    }
    if (include("package")) {
        const rows = limitResults((data.packages || [])
            .filter(p => textMatches(term, [p.name, p.publisher, p.version, p.type, p.platform, p.architecture, p.sha256]))
            .map(p => ({
            type: "package",
            title: p.name,
            meta: [p.version, p.type, p.platform].filter(Boolean).join(" · "),
            target: "packages",
        })));
        if (rows.length)
            groups.push(["Packages", rows]);
    }
    if (include("rule")) {
        const rows = limitResults((data.rules || [])
            .filter(r => textMatches(term, [r.name, r.description, r.trigger?.type, r.trigger?.eventType, JSON.stringify(r.conditionGroup), JSON.stringify(r.actions), r.enabled ? "enabled" : "disabled"]))
            .map(r => ({
            type: "rule",
            title: r.name,
            meta: `${r.trigger?.type || "manual"} · ${conditionSummary(r.conditionGroup || { combinator: "AND", conditions: r.conditions || [] })}`,
            target: "rules",
        })));
        if (rows.length)
            groups.push(["Rules", rows]);
    }
    if (include("task")) {
        const rows = limitResults(sortTasksNewestFirst(data.tasks || [])
            .filter(t => textMatches(term, [taskLabel(t), t.type, t.appName, t.deviceId, t.nodeId, t.status, t.fromVersion, t.targetVersion, t.output]))
            .map(t => ({
            type: "task",
            title: taskLabel(t),
            meta: [t.deviceId, t.nodeId, t.status].filter(Boolean).join(" · "),
            target: "tasks",
        })));
        if (rows.length)
            groups.push(["Tasks", rows]);
    }
    if (include("node")) {
        const rows = limitResults((data.nodes || [])
            .filter(n => textMatches(term, [n.name, n.id, n.publicUrl, n.url, n.region, n.site, n.status, n.version]))
            .map(n => ({
            type: "node",
            title: n.name || n.id,
            meta: [n.region, n.status, n.publicUrl || n.url].filter(Boolean).join(" · "),
            target: "nodes",
        })));
        if (rows.length)
            groups.push(["Nodes", rows]);
    }
    if (include("alarm")) {
        const rows = limitResults((data.alarms || [])
            .filter(a => textMatches(term, [a.message, a.deviceId, a.severity, a.id]))
            .map(a => ({
            type: "alarm",
            title: a.message,
            meta: [a.severity, a.deviceId].filter(Boolean).join(" · "),
            target: "alarms",
        })));
        if (rows.length)
            groups.push(["Alarms", rows]);
    }
    if (include("audit")) {
        const rows = limitResults((data.audit || [])
            .filter(e => textMatches(term, [e.actor, e.action, e.target, e.id]))
            .map(e => ({
            type: "audit",
            title: e.action || e.id,
            meta: [e.actor, e.target].filter(Boolean).join(" · "),
            target: "audit",
        })));
        if (rows.length)
            groups.push(["Audit", rows]);
    }
    return groups;
}
/**
 * Handles the category from url operation.
 * @returns The result produced by the operation.
 */
function categoryFromUrl() {
    const parts = window.location.pathname.replace(/^\/ui\/?/, "").split("/").filter(Boolean);
    const pathCategory = parts[0];
    if (pathCategory === "admin") {
        const adminSection = parts[1] || "policy";
        return ADMIN_TAB_TO_CATEGORY[adminSection] || "admin-policy";
    }
    if (LEGACY_CATEGORY_MAP[pathCategory])
        return LEGACY_CATEGORY_MAP[pathCategory];
    if (CATEGORY_IDS.includes(pathCategory))
        return pathCategory;
    const params = new URLSearchParams(window.location.search);
    const category = params.get("category") || params.get("tab");
    if (LEGACY_CATEGORY_MAP[category])
        return LEGACY_CATEGORY_MAP[category];
    return CATEGORY_IDS.includes(category) ? category : "overview";
}
/**
 * Handles the push category url operation.
 *
 * @param category category supplied to the function.
 */
function pushCategoryUrl(category) {
    const adminEntry = Object.entries(ADMIN_TAB_TO_CATEGORY).find(([, value]) => value === category);
    const target = category === "overview"
        ? "/ui"
        : adminEntry
            ? `/ui/admin/${adminEntry[0]}`
            : `/ui/${category}`;
    window.history.pushState({ category }, "", target);
}
/**
 * Renders the app UI.
 * @returns The result produced by the operation.
 */
function App() {
    const [authSession, setAuthSession] = useStateApp(() => PatchAPI.session());
    useEffectApp(() => {
        /**
         * Handles the on session change operation.
         */
        const onSessionChange = () => setAuthSession(PatchAPI.session());
        window.addEventListener("patch-session-change", onSessionChange);
        return () => window.removeEventListener("patch-session-change", onSessionChange);
    }, []);
    if (!authSession.accessToken) {
        return React.createElement(LoginScreen, { onAuthenticated: (nextSession) => setAuthSession(nextSession) });
    }
    return React.createElement(DashboardApp, { sessionInfo: authSession, onLogout: () => { PatchAPI.logout(); setAuthSession({}); } });
}
/**
 * Renders the dashboard app UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function DashboardApp({ sessionInfo, onLogout }) {
    const [tab, setTabState] = useStateApp(categoryFromUrl);
    const [openDevice, setOpenDevice] = useStateApp(null);
    const [globalSearch, setGlobalSearch] = useStateApp("");
    const [confirmLogout, setConfirmLogout] = useStateApp(false);
    const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);
    /**
     * Sets the tab value.
     *
     * @param category category supplied to the function.
     */
    const setTab = (category) => {
        if (!CATEGORY_IDS.includes(category))
            category = "overview";
        setTabState(category);
        pushCategoryUrl(category);
    };
    useEffectApp(() => {
        /**
         * Handles the on pop state operation.
         */
        const onPopState = () => setTabState(categoryFromUrl());
        window.addEventListener("popstate", onPopState);
        return () => window.removeEventListener("popstate", onPopState);
    }, []);
    // live counts for sidebar badges
    const [counts, setCounts] = useStateApp({ devices: null, pending: null, criticalAlarms: null });
    useEffectApp(() => {
        let alive = true;
        let inFlight = false;
        /**
         * Handles the tick operation.
         */
        const tick = () => {
            if (inFlight || document.visibilityState === "hidden")
                return;
            inFlight = true;
            Promise.allSettled([
                PatchAPI.summary(),
                PatchAPI.tasks(),
                PatchAPI.alarms(),
            ]).then(([summaryResult, tasksResult, alarmsResult]) => {
                if (!alive)
                    return;
                setCounts(prev => {
                    const s = summaryResult.status === "fulfilled" ? summaryResult.value : null;
                    const tasks = tasksResult.status === "fulfilled" ? tasksResult.value : null;
                    const alarms = alarmsResult.status === "fulfilled" ? alarmsResult.value : null;
                    return {
                        devices: s?.managedDevices ?? prev.devices,
                        pending: Array.isArray(tasks) ? tasks.filter(t => ["pending", "dispatched"].includes(t.status)).length : prev.pending,
                        criticalAlarms: Array.isArray(alarms) ? alarms.filter(a => a.severity === "critical").length : prev.criticalAlarms,
                    };
                });
            }).finally(() => {
                inFlight = false;
            });
        };
        /**
         * Handles the on visible operation.
         */
        const onVisible = () => {
            if (document.visibilityState === "visible")
                tick();
        };
        tick();
        document.addEventListener("visibilitychange", onVisible);
        const id = setInterval(tick, 15000);
        return () => {
            alive = false;
            clearInterval(id);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, []);
    useEffectApp(() => {
        document.documentElement.style.setProperty("--accent", `oklch(0.55 0.14 ${tweaks.accentHue})`);
        document.documentElement.style.setProperty("--accent-h", `oklch(0.50 0.15 ${tweaks.accentHue})`);
        document.documentElement.style.setProperty("--accent-soft", `oklch(0.96 0.03 ${tweaks.accentHue})`);
        document.documentElement.style.setProperty("--accent-text", `oklch(0.40 0.13 ${tweaks.accentHue})`);
    }, [tweaks.accentHue, tweaks.theme]);
    const permissions = sessionInfo.user?.permissions || [];
    const canAdmin = permissions.some((permission) => ['auth:manage', 'users:manage', 'roles:manage'].includes(permission));
    const OPERATE_NAV = [
        { id: "overview", label: "Overview", icon: Icon.dashboard },
        { id: "quick-actions", label: "Quick Actions", icon: Icon.play },
        { id: "devices", label: "Devices", icon: Icon.devices, count: counts.devices },
    ];
    const CATALOG_NAV = [
        { id: "device-groups", label: "Groups", icon: Icon.groups },
        { id: "apps", label: "Apps", icon: Icon.apps },
        { id: "packages", label: "Packages", icon: Icon.packages },
    ];
    const ACTIVITY_NAV = [
        { id: "rules", label: "Rules", icon: Icon.rules },
        { id: "tasks", label: "Tasks", icon: Icon.tasks, count: counts.pending },
        { id: "nodes", label: "Nodes", icon: Icon.nodes },
        { id: "alarms", label: "Alarms", icon: Icon.alarms, count: counts.criticalAlarms, countTone: "crit" },
        { id: "audit", label: "Audit", icon: Icon.audit },
    ];
    const ADMIN_NAV = [
        { id: "admin-policy", label: "Policy", icon: Icon.shield },
        { id: "admin-users", label: "Users", icon: Icon.devices },
        { id: "admin-permissions", label: "Permissions", icon: Icon.rules },
        { id: "admin-siem", label: "SIEM", icon: Icon.audit },
        { id: "admin-sso", label: "SSO", icon: Icon.settings },
        { id: "admin-posture", label: "Posture", icon: Icon.shield },
        { id: "admin-retirement", label: "Retirement", icon: Icon.shield },
    ];
    const NAV = [...OPERATE_NAV, ...CATALOG_NAV, ...ACTIVITY_NAV, ...(canAdmin ? ADMIN_NAV : [])];
    /**
     * Handles the page search term operation.
     *
     * @param category category supplied to the function.
     * @returns The result produced by the operation.
     */
    const pageSearchTerm = (category) => {
        const parsed = parseSearchQuery(globalSearch);
        if (!parsed.type)
            return "";
        return SEARCH_TYPE_TO_CATEGORY[parsed.type] === category ? parsed.term : "";
    };
    const adminPage = (initialTab) => canAdmin
        ? React.createElement(AdminSettingsPage, { initialTab: initialTab })
        : (React.createElement("div", { className: "page" },
            React.createElement("div", { className: "card" },
                React.createElement("div", { className: "card-body" },
                    React.createElement("h2", null, "Admin permissions required"),
                    React.createElement("p", { className: "sub" }, "You need an admin role with auth, user, or role management permission to open this area.")))));
    const Page = {
        overview: React.createElement(OverviewPage, { onNav: setTab, onOpenDevice: setOpenDevice }),
        "quick-actions": React.createElement(QuickActionsPage, null),
        devices: React.createElement(DevicesPage, { onOpenDevice: setOpenDevice, globalSearch: pageSearchTerm("devices") }),
        "device-groups": React.createElement(DeviceGroupsPage, { onOpenDevice: setOpenDevice, globalSearch: pageSearchTerm("device-groups") }),
        apps: React.createElement(AppsPage, { globalSearch: pageSearchTerm("apps") }),
        packages: React.createElement(PackagesPage, { globalSearch: pageSearchTerm("packages") }),
        rules: React.createElement(RulesPage, { globalSearch: pageSearchTerm("rules") }),
        tasks: React.createElement(TasksPage, { globalSearch: pageSearchTerm("tasks") }),
        nodes: React.createElement(NodesPage, { globalSearch: pageSearchTerm("nodes") }),
        alarms: React.createElement(AlarmsPage, { globalSearch: pageSearchTerm("alarms") }),
        audit: React.createElement(AuditPage, { globalSearch: pageSearchTerm("audit") }),
        "admin-policy": adminPage('policy'),
        "admin-users": adminPage('users'),
        "admin-permissions": adminPage('permissions'),
        "admin-siem": adminPage('siem'),
        "admin-sso": adminPage('sso'),
        "admin-posture": adminPage('posture'),
        "admin-retirement": adminPage('retirement'),
    }[tab];
    const current = NAV.find(n => n.id === tab) || {
        label: tab.startsWith('admin-') ? 'Admin' : 'Overview',
    };
    /**
     * Handles the handle search select operation.
     *
     * @param result result supplied to the function.
     */
    const handleSearchSelect = (result) => {
        setTab(result.target);
        if (result.deviceId)
            setOpenDevice(result.deviceId);
    };
    return (React.createElement("div", { className: "shell", "data-theme": tweaks.theme, "data-density": tweaks.density, "data-sidebar": tweaks.sidebar, "data-screen-label": `01 ${current.label}` },
        React.createElement("aside", { className: "sidebar" },
            React.createElement("div", { className: "sidebar-brand" },
                React.createElement("img", { src: "/ui/logo.png", alt: "1Patch", className: "brand-logo" }),
                React.createElement("div", { className: "brand-name" },
                    "1Patch ",
                    React.createElement("em", null, "Management"))),
            React.createElement("div", { className: "nav-section" }, "Operate"),
            OPERATE_NAV.map(n => React.createElement(NavItem, { key: n.id, item: n, active: tab === n.id, onClick: () => setTab(n.id) })),
            React.createElement("div", { className: "nav-section" }, "Catalog"),
            CATALOG_NAV.map(n => React.createElement(NavItem, { key: n.id, item: n, active: tab === n.id, onClick: () => setTab(n.id) })),
            React.createElement("div", { className: "nav-section" }, "Activity"),
            ACTIVITY_NAV.map(n => React.createElement(NavItem, { key: n.id, item: n, active: tab === n.id, onClick: () => setTab(n.id) })),
            canAdmin && (React.createElement(React.Fragment, null,
                React.createElement("div", { className: "nav-section" }, "Admin"),
                ADMIN_NAV.map(n => React.createElement(NavItem, { key: n.id, item: n, active: tab === n.id, onClick: () => setTab(n.id) })))),
            React.createElement("div", { className: "sidebar-footer" }, confirmLogout ? (React.createElement("div", { className: "logout-confirm" },
                React.createElement("span", { className: "logout-confirm-label" }, "Sign out?"),
                React.createElement("div", { className: "logout-confirm-actions" },
                    React.createElement("button", { type: "button", className: "btn sm ghost", onClick: () => setConfirmLogout(false) }, "Cancel"),
                    React.createElement("button", { type: "button", className: "btn sm logout-confirm-yes", onClick: () => { onLogout(); setConfirmLogout(false); } }, "Sign out")))) : (React.createElement("div", { className: "user-card" },
                React.createElement("div", { className: "avatar" }, initials(sessionInfo.user?.email)),
                React.createElement("div", { className: "user-meta" },
                    React.createElement("strong", null, sessionInfo.user?.email || "Admin session"),
                    React.createElement("span", null, TENANT_NAME)),
                React.createElement("button", { type: "button", className: "icon-btn logout-btn", "aria-label": "Sign out", title: "Sign out", onClick: () => setConfirmLogout(true) }, Icon.logout))))),
        React.createElement("div", { className: "main" },
            React.createElement("div", { className: "topbar" },
                React.createElement("div", { className: "crumbs" },
                    React.createElement("span", { className: "crumb" }, "Tenant"),
                    React.createElement("span", { className: "sep" }, "/"),
                    React.createElement("span", { className: "crumb" }, TENANT_NAME),
                    React.createElement("span", { className: "sep" }, "/"),
                    React.createElement("h1", null, current.label)),
                React.createElement(GlobalSearch, { onSelect: handleSearchSelect, onQueryChange: (value) => {
                        setGlobalSearch(value);
                        const parsed = parseSearchQuery(value);
                        const category = parsed.type ? SEARCH_TYPE_TO_CATEGORY[parsed.type] : null;
                        if (category && category !== tab)
                            setTab(category);
                    } }),
                React.createElement(NotificationBell, { counts: counts, onNav: setTab })),
            Page),
        openDevice && React.createElement(DeviceDrawer, { deviceId: openDevice, onClose: () => setOpenDevice(null) }),
        React.createElement(TweaksPanel, { title: "Tweaks" },
            React.createElement(TweakSection, { title: "Appearance" },
                React.createElement(TweakRadio, { label: "Theme", value: tweaks.theme, options: [["light", "Light"], ["dark", "Dark"]], onChange: v => setTweak("theme", v) }),
                React.createElement(TweakSlider, { label: "Accent hue", min: 0, max: 360, step: 1, value: tweaks.accentHue, onChange: v => setTweak("accentHue", v) }),
                React.createElement(TweakRadio, { label: "Density", value: tweaks.density, options: [["compact", "Compact"], ["comfortable", "Comfy"], ["spacious", "Spacious"]], onChange: v => setTweak("density", v) }),
                React.createElement(TweakRadio, { label: "Sidebar", value: tweaks.sidebar, options: [["labelled", "Labelled"], ["icon", "Icon-only"]], onChange: v => setTweak("sidebar", v) })))));
}
/**
 * Returns a human-readable label for the auth method stored in the session.
 *
 * @param method The authMethod string from the session.
 * @returns The result produced by the operation.
 */
function authMethodLabel(method) {
    if (!method || method === 'password')
        return 'Password auth';
    if (method === 'password+totp')
        return 'Password + TOTP';
    if (method.startsWith('sso:')) {
        const type = method.split(':')[1];
        const labels = {
            microsoft: 'Microsoft SSO',
            google: 'Google SSO',
            github: 'GitHub SSO',
            okta: 'Okta SSO',
            oidc: 'SSO',
        };
        return labels[type] || 'SSO';
    }
    return 'Signed in';
}
/**
 * Handles the initials operation.
 *
 * @param email email supplied to the function.
 * @returns The result produced by the operation.
 */
function initials(email) {
    const name = String(email || "1P").trim();
    if (!name || name === "1P")
        return "1P";
    return name.slice(0, 2).toUpperCase();
}
/**
 * Returns the SVG icon element for a given SSO provider type.
 *
 * @param type The provider type string.
 * @returns The result produced by the operation.
 */
function SsoProviderIcon({ type, size = 18 }) {
    if (type === 'microsoft')
        return (React.createElement("svg", { viewBox: "0 0 21 21", width: size, height: size, fill: "none" },
            React.createElement("rect", { x: "1", y: "1", width: "9", height: "9", fill: "#F25022" }),
            React.createElement("rect", { x: "11", y: "1", width: "9", height: "9", fill: "#7FBA00" }),
            React.createElement("rect", { x: "1", y: "11", width: "9", height: "9", fill: "#00A4EF" }),
            React.createElement("rect", { x: "11", y: "11", width: "9", height: "9", fill: "#FFB900" })));
    if (type === 'google')
        return (React.createElement("svg", { viewBox: "0 0 24 24", width: size, height: size },
            React.createElement("path", { d: "M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z", fill: "#4285F4" }),
            React.createElement("path", { d: "M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z", fill: "#34A853" }),
            React.createElement("path", { d: "M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z", fill: "#FBBC05" }),
            React.createElement("path", { d: "M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z", fill: "#EA4335" })));
    if (type === 'github')
        return (React.createElement("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "currentColor" },
            React.createElement("path", { d: "M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z" })));
    if (type === 'okta')
        return (React.createElement("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "none" },
            React.createElement("circle", { cx: "12", cy: "12", r: "10", fill: "#007DC1" }),
            React.createElement("circle", { cx: "12", cy: "12", r: "5", fill: "white" })));
    return (React.createElement("svg", { viewBox: "0 0 16 16", width: size, height: size, fill: "none", stroke: "currentColor", strokeWidth: "1.5" },
        React.createElement("path", { d: "M8 2 13 4v3.5c0 3-2 5.4-5 6.5-3-1.1-5-3.5-5-6.5V4z" })));
}
/**
 * Renders the login screen UI with SSO provider support.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function LoginScreen({ onAuthenticated }) {
    const [email, setEmail] = useStateApp("");
    const [password, setPassword] = useStateApp("");
    const [mfaCode, setMfaCode] = useStateApp("");
    const [challengeToken, setChallengeToken] = useStateApp("");
    const [loading, setLoading] = useStateApp(false);
    const [error, setError] = useStateApp("");
    const [ssoProviders, setSsoProviders] = useStateApp([]);
    const [ssoLoading, setSsoLoading] = useStateApp(null);
    const mfaRequired = Boolean(challengeToken);
    // Load SSO providers and handle SSO callback on mount
    useEffectApp(() => {
        PatchAPI.ssoProviders().then(setSsoProviders).catch(() => { });
        const params = new URLSearchParams(window.location.search);
        const handoffToken = params.get('sso_handoff');
        const ssoError = params.get('sso_error');
        // Clean URL regardless of outcome
        if (handoffToken || ssoError) {
            const clean = window.location.pathname;
            window.history.replaceState({}, '', clean);
        }
        if (ssoError) {
            setError(decodeURIComponent(ssoError));
            return;
        }
        if (handoffToken) {
            setLoading(true);
            PatchAPI.ssoComplete(handoffToken)
                .then((body) => onAuthenticated(body))
                .catch((err) => setError(err.message || 'SSO login failed'))
                .finally(() => setLoading(false));
        }
    }, []);
    /**
     * Handles SSO provider button click.
     *
     * @param provider The SSO provider object.
     */
    const handleSsoClick = (provider) => {
        if (ssoLoading)
            return;
        setSsoLoading(provider.id);
        setError("");
        PatchAPI.ssoInitiate(provider.id)
            .then(({ authorizationUrl }) => {
            window.location.href = authorizationUrl;
        })
            .catch((err) => {
            setError(err.message || 'SSO initiation failed');
            setSsoLoading(null);
        });
    };
    /**
     * Handles the submit operation.
     *
     * @param event Event object emitted by the runtime or UI.
     */
    const submit = (event) => {
        event.preventDefault();
        if (loading)
            return;
        setLoading(true);
        setError("");
        const action = mfaRequired
            ? PatchAPI.verifyMfa(challengeToken, mfaCode.trim())
            : PatchAPI.login(email.trim(), password);
        action.then((body) => {
            if (body.mfaRequired) {
                setChallengeToken(body.challengeToken);
                setMfaCode("");
                setError("");
                return;
            }
            onAuthenticated(body);
        }).catch((err) => {
            setError(err.message || (mfaRequired ? "MFA verification failed" : "Login failed"));
        }).finally(() => {
            setLoading(false);
        });
    };
    return (React.createElement("main", { className: "login-screen" },
        React.createElement("section", { className: "login-panel", "aria-labelledby": "login-title" },
            React.createElement("div", { className: "login-brand" },
                React.createElement("img", { src: "/ui/logo.png", alt: "1Patch", className: "brand-logo brand-logo--lg" }),
                React.createElement("div", null,
                    React.createElement("strong", null, "1Patch Management"),
                    React.createElement("span", null, "Control plane access"))),
            React.createElement("div", { className: "login-copy" },
                React.createElement("h1", { id: "login-title" }, mfaRequired ? "Enter MFA code" : "Sign in"),
                React.createElement("p", null, mfaRequired ? "Use the current code from your authenticator app." : "Use your account credentials or an identity provider below.")),
            !mfaRequired && ssoProviders.length > 0 && (React.createElement("div", { className: "sso-providers" },
                ssoProviders.map((provider) => (React.createElement("button", { key: provider.id, type: "button", className: "btn sso-btn", disabled: Boolean(ssoLoading) || loading, onClick: () => handleSsoClick(provider) },
                    ssoLoading === provider.id
                        ? React.createElement("span", { className: "search-spinner" })
                        : React.createElement(SsoProviderIcon, { type: provider.type }),
                    "Continue with ",
                    provider.name))),
                React.createElement("div", { className: "sso-divider" },
                    React.createElement("span", null, "or sign in with password")))),
            React.createElement("form", { className: "login-form", onSubmit: submit },
                !mfaRequired && (React.createElement(React.Fragment, null,
                    React.createElement("label", { className: "field" },
                        React.createElement("span", null, "Email address"),
                        React.createElement("input", { type: "email", autoComplete: "email", placeholder: "admin@example.com", value: email, onChange: (e) => setEmail(e.target.value), required: true, autoFocus: ssoProviders.length === 0 })),
                    React.createElement("label", { className: "field" },
                        React.createElement("span", null, "Password"),
                        React.createElement("input", { type: "password", autoComplete: "current-password", placeholder: "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022", minLength: "12", value: password, onChange: (e) => setPassword(e.target.value), required: true })))),
                mfaRequired && (React.createElement("label", { className: "field" },
                    React.createElement("span", null, "Authentication code"),
                    React.createElement("input", { className: "mfa-input", inputMode: "numeric", autoComplete: "one-time-code", placeholder: "000000", value: mfaCode, onChange: (e) => setMfaCode(e.target.value.replace(/\D/g, "").slice(0, 6)), required: true, autoFocus: true }))),
                error && React.createElement("div", { className: "login-error", role: "alert" }, error),
                React.createElement("button", { type: "submit", className: "btn login-submit", disabled: loading || (mfaRequired ? mfaCode.length < 6 : !email || !password) },
                    loading ? React.createElement("span", { className: "search-spinner" }) : React.createElement("span", { className: "login-submit-icon" }, Icon.shield),
                    mfaRequired ? "Verify code" : "Sign in securely"),
                mfaRequired && (React.createElement("button", { type: "button", className: "btn login-back", onClick: () => { setChallengeToken(""); setError(""); } }, "Back to password"))))));
}
/**
 * Renders the notification bell UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function NotificationBell({ counts, onNav }) {
    const [open, setOpen] = useStateApp(false);
    const [loading, setLoading] = useStateApp(false);
    const [error, setError] = useStateApp(null);
    const [alarms, setAlarms] = useStateApp([]);
    const [tasks, setTasks] = useStateApp([]);
    const rootRef = useRefApp(null);
    const alarmCount = alarms.length || counts.criticalAlarms || 0;
    const activeTasks = tasks.filter(t => ["pending", "dispatched"].includes(t.status));
    const failedTasks = tasks.filter(t => t.status === "failed");
    const unreadCount = Math.min(99, alarmCount + activeTasks.length + failedTasks.length);
    const recentItems = [
        ...alarms.slice(0, 4).map(a => ({
            key: `alarm-${a.id}`,
            type: "alarm",
            title: a.message || "Active alarm",
            meta: [a.deviceId, fmtAgo(a.createdAt)].filter(Boolean).join(" · "),
            tone: a.severity === "critical" ? "crit" : a.severity === "warning" ? "warn" : "accent",
            target: "alarms",
        })),
        ...activeTasks.slice(0, 3).map(t => ({
            key: `task-${t.id}`,
            type: "task",
            title: taskLabel(t),
            meta: [t.status, t.deviceId, fmtAgo(t.createdAt)].filter(Boolean).join(" · "),
            tone: "accent",
            target: "tasks",
        })),
        ...failedTasks.slice(0, 3).map(t => ({
            key: `failed-${t.id}`,
            type: "failed",
            title: taskLabel(t),
            meta: [t.deviceId, fmtAgo(t.completedAt || t.createdAt)].filter(Boolean).join(" · "),
            tone: "crit",
            target: "tasks",
        })),
    ].slice(0, 6);
    /**
     * Loads load data.
     *
     * @param silent silent supplied to the function.
     */
    const load = (silent = false) => {
        if (!silent)
            setLoading(true);
        setError(null);
        Promise.all([
            PatchAPI.alarms(),
            PatchAPI.tasks(),
        ]).then(([nextAlarms, nextTasks]) => {
            setAlarms(Array.isArray(nextAlarms) ? nextAlarms : []);
            setTasks(Array.isArray(nextTasks) ? nextTasks : []);
        }).catch((err) => {
            setError(err);
        }).finally(() => {
            if (!silent)
                setLoading(false);
        });
    };
    useEffectApp(() => {
        load(true);
    }, []);
    useEffectApp(() => {
        if (!open)
            return;
        load(false);
        const id = setInterval(() => load(true), 10000);
        return () => clearInterval(id);
    }, [open]);
    useEffectApp(() => {
        if (!open)
            return;
        /**
         * Handles the on pointer down operation.
         *
         * @param e Event object emitted by the runtime or UI.
         */
        const onPointerDown = (e) => {
            if (!rootRef.current?.contains(e.target))
                setOpen(false);
        };
        /**
         * Handles the on key down operation.
         *
         * @param e Event object emitted by the runtime or UI.
         */
        const onKeyDown = (e) => {
            if (e.key === "Escape")
                setOpen(false);
        };
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [open]);
    /**
     * Handles the go operation.
     *
     * @param target target supplied to the function.
     */
    const go = (target) => {
        onNav(target);
        setOpen(false);
    };
    return (React.createElement("div", { className: "notification-bell", ref: rootRef },
        React.createElement("button", { type: "button", className: "icon-btn notification-trigger " + (open ? "active" : ""), "aria-label": `Notifications${unreadCount ? `, ${unreadCount} active` : ""}`, "aria-haspopup": "dialog", "aria-expanded": open ? "true" : "false", onClick: () => setOpen(v => !v) },
            React.createElement("span", { className: "notification-icon" }, Icon.bell),
            unreadCount > 0 && (React.createElement("span", { className: "notification-badge", "aria-hidden": "true" }, unreadCount > 9 ? "9+" : unreadCount))),
        open && (React.createElement("div", { className: "notification-popover", role: "dialog", "aria-label": "Notifications" },
            React.createElement("div", { className: "notification-head" },
                React.createElement("div", null,
                    React.createElement("h2", null, "Notifications"),
                    React.createElement("span", null, loading ? "Checking fleet activity" : `${unreadCount} item${unreadCount === 1 ? "" : "s"} need attention`)),
                React.createElement("button", { type: "button", className: "btn sm ghost", onClick: () => load(false) }, "Refresh")),
            React.createElement("div", { className: "notification-summary" },
                React.createElement("button", { type: "button", onClick: () => go("alarms") },
                    React.createElement("strong", null, alarmCount),
                    React.createElement("span", null, "Alarms")),
                React.createElement("button", { type: "button", onClick: () => go("tasks") },
                    React.createElement("strong", null, activeTasks.length),
                    React.createElement("span", null, "Running")),
                React.createElement("button", { type: "button", onClick: () => go("tasks") },
                    React.createElement("strong", null, failedTasks.length),
                    React.createElement("span", null, "Failed"))),
            error && React.createElement("div", { className: "notification-empty" }, "Notifications failed to load."),
            !error && loading && recentItems.length === 0 && React.createElement("div", { className: "notification-empty" },
                React.createElement("span", { className: "search-spinner" }),
                "Loading notifications..."),
            !error && !loading && recentItems.length === 0 && React.createElement("div", { className: "notification-empty" }, "No active notifications."),
            !error && recentItems.length > 0 && (React.createElement("div", { className: "notification-list" }, recentItems.map(item => (React.createElement("button", { type: "button", key: item.key, className: "notification-item", onClick: () => go(item.target) },
                React.createElement("span", { className: "notification-dot " + item.tone }),
                React.createElement("span", { className: "notification-copy" },
                    React.createElement("strong", null, item.title),
                    React.createElement("span", null, item.meta || item.type)),
                React.createElement("span", { className: "notification-type" }, item.type)))))),
            React.createElement("div", { className: "notification-actions" },
                React.createElement("button", { type: "button", className: "btn ghost sm", onClick: () => go("tasks") }, "View tasks"),
                React.createElement("button", { type: "button", className: "btn primary sm", onClick: () => go("alarms") }, "Open alarms"))))));
}
/**
 * Renders the global search UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function GlobalSearch({ onSelect, onQueryChange }) {
    const [query, setQuery] = useStateApp("");
    const [focused, setFocused] = useStateApp(false);
    const [activeIndex, setActiveIndex] = useStateApp(0);
    const [loading, setLoading] = useStateApp(false);
    const [error, setError] = useStateApp(null);
    const [data, setData] = useStateApp({
        devices: [], apps: [], packages: [], rules: [], tasks: [], nodes: [], alarms: [], audit: [],
    });
    const trimmed = query.trim();
    const parsed = parseSearchQuery(trimmed);
    const results = trimmed ? buildSearchResults(data, trimmed) : [];
    const flatResults = results.flatMap(([label, rows]) => rows.map((result) => ({ ...result, group: label })));
    const resultCount = results.reduce((total, [, rows]) => total + rows.length, 0);
    const showPanel = focused && trimmed.length > 0;
    const showHint = focused && !trimmed;
    const isOpen = showPanel || showHint;
    const shortcutLabel = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || "") ? "⌘K" : "Ctrl K";
    useEffectApp(() => {
        onQueryChange?.(query);
        setActiveIndex(0);
    }, [query]);
    useEffectApp(() => {
        if (!trimmed) {
            setError(null);
            setLoading(false);
            return;
        }
        let alive = true;
        setLoading(true);
        setError(null);
        Promise.all([
            PatchAPI.devices().catch(() => []),
            PatchAPI.apps().catch(() => []),
            PatchAPI.packages().catch(() => []),
            PatchAPI.rules().catch(() => []),
            PatchAPI.tasks().catch(() => []),
            PatchAPI.nodes().catch(() => []),
            PatchAPI.alarms().catch(() => []),
            PatchAPI.audit(200).catch(() => []),
        ]).then(([devices, apps, packages, rules, tasks, nodes, alarms, audit]) => {
            if (!alive)
                return;
            setData({ devices, apps, packages, rules, tasks, nodes, alarms, audit });
        }).catch((err) => {
            if (alive)
                setError(err);
        }).finally(() => {
            if (alive)
                setLoading(false);
        });
        return () => { alive = false; };
    }, [trimmed]);
    useEffectApp(() => {
        if (activeIndex >= flatResults.length)
            setActiveIndex(Math.max(0, flatResults.length - 1));
    }, [flatResults.length, activeIndex]);
    /**
     * Handles the choose operation.
     *
     * @param result result supplied to the function.
     */
    const choose = (result) => {
        if (!result)
            return;
        onSelect(result);
        setQuery("");
        setFocused(false);
    };
    return (React.createElement("div", { className: "global-search " + (focused ? "focused " : "") + (isOpen ? "open" : "") },
        React.createElement("div", { className: "searchbox" },
            React.createElement("span", { style: { width: 14, height: 14, display: "inline-flex" } }, Icon.search),
            React.createElement("input", { id: "topbar-search", placeholder: "Search everything...", value: query, onFocus: () => setFocused(true), onBlur: () => setTimeout(() => setFocused(false), 120), onChange: e => setQuery(e.target.value), onKeyDown: e => {
                    if (e.key === "Escape") {
                        setQuery("");
                        e.currentTarget.blur();
                    }
                    if (e.key === "ArrowDown" && flatResults.length) {
                        e.preventDefault();
                        setActiveIndex(i => (i + 1) % flatResults.length);
                    }
                    if (e.key === "ArrowUp" && flatResults.length) {
                        e.preventDefault();
                        setActiveIndex(i => (i - 1 + flatResults.length) % flatResults.length);
                    }
                    if (e.key === "Enter") {
                        e.preventDefault();
                        choose(flatResults[activeIndex]);
                    }
                } }),
            React.createElement("span", { className: "kbd" }, shortcutLabel)),
        showHint && (React.createElement("div", { className: "search-panel" },
            React.createElement("div", { className: "search-hint" },
                React.createElement("div", { className: "search-hint-title" }, "Search everything, or scope with a prefix:"),
                React.createElement("div", { className: "search-hint-chips" }, [["device:", "devices"], ["app:", "apps"], ["rule:", "rules"], ["node:", "nodes"], ["alarm:", "alarms"], ["audit:", "audit"]].map(([pfx]) => (React.createElement("button", { key: pfx, className: "search-hint-chip", onMouseDown: e => { e.preventDefault(); setQuery(pfx); } },
                    React.createElement("code", null, pfx)))))))),
        showPanel && (React.createElement("div", { className: "search-panel" },
            React.createElement("div", { className: "search-head" },
                React.createElement("span", { className: "search-scope" }, parsed.type || "all"),
                React.createElement("span", null, loading ? "Searching" : `${resultCount} result${resultCount === 1 ? "" : "s"}`)),
            loading && React.createElement("div", { className: "search-empty" },
                React.createElement("span", { className: "search-pulse" }),
                "Searching\u2026"),
            error && React.createElement("div", { className: "search-empty" }, "Search failed."),
            !loading && !error && resultCount === 0 && React.createElement("div", { className: "search-empty" },
                "No results for ",
                React.createElement("strong", null, trimmed)),
            !loading && !error && results.map(([label, rows]) => (React.createElement("div", { className: "search-group", key: label },
                React.createElement("div", { className: "search-group-label" },
                    label,
                    React.createElement("span", { className: "search-group-count" }, rows.length)),
                rows.map((result) => {
                    const index = flatResults.findIndex(item => item.group === label && item.type === result.type && item.title === result.title && item.meta === result.meta);
                    return (React.createElement("button", { className: "search-result " + (index === activeIndex ? "active" : ""), key: `${label}-${index}`, onMouseEnter: () => setActiveIndex(index), onMouseDown: (e) => { e.preventDefault(); choose(result); } },
                        React.createElement("span", { className: "search-type", "data-type": result.type }, result.type),
                        React.createElement("span", { className: "search-main" },
                            React.createElement("strong", null, highlight(result.title || "Untitled", parsed.term)),
                            result.meta && React.createElement("span", null, highlight(result.meta, parsed.term))),
                        React.createElement("span", { className: "search-open" }, Icon.arrowR)));
                })))),
            !loading && !error && resultCount > 0 && (React.createElement("div", { className: "search-footer" },
                React.createElement("span", null,
                    React.createElement("span", { className: "kbd" }, "\u2191\u2193"),
                    " navigate"),
                React.createElement("span", null,
                    React.createElement("span", { className: "kbd" }, "\u23CE"),
                    " open"),
                React.createElement("span", null,
                    React.createElement("span", { className: "kbd" }, "esc"),
                    " clear")))))));
}
/**
 * Renders the nav item UI.
 *
 * @param props Component props supplied by the caller.
 * @returns The result produced by the operation.
 */
function NavItem({ item, active, onClick }) {
    return (React.createElement("button", { className: "nav-item " + (active ? "active" : ""), onClick: onClick },
        item.icon,
        React.createElement("span", { className: "nav-label" }, item.label),
        item.count != null && item.count > 0 && (React.createElement("span", { className: "nav-count " + (item.countTone || "") }, item.count))));
}
// ⌘K focuses the search input
window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const input = document.getElementById("topbar-search");
        input?.focus();
        input?.select();
    }
});
ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(App, null));

//# sourceURL=/ui/app.bundle.js
