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
    const dismiss = () => {
        setOpen(false);
        window.parent.postMessage({ type: '__edit_mode_dismissed' }, '*');
    };
    const onDragStart = (e) => {
        const panel = dragRef.current;
        if (!panel)
            return;
        const r = panel.getBoundingClientRect();
        const sx = e.clientX, sy = e.clientY;
        const startRight = window.innerWidth - r.right;
        const startBottom = window.innerHeight - r.bottom;
        const move = (ev) => {
            offsetRef.current = {
                x: startRight - (ev.clientX - sx),
                y: startBottom - (ev.clientY - sy),
            };
            clampToViewport();
        };
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
function TweakSection({ label, children }) {
    return (React.createElement(React.Fragment, null,
        React.createElement("div", { className: "twk-sect" }, label),
        children));
}
function TweakRow({ label, value, children, inline = false }) {
    return (React.createElement("div", { className: inline ? 'twk-row twk-row-h' : 'twk-row' },
        React.createElement("div", { className: "twk-lbl" },
            React.createElement("span", null, label),
            value != null && React.createElement("span", { className: "twk-val" }, value)),
        children));
}
// ── Controls ────────────────────────────────────────────────────────────────
function TweakSlider({ label, value, min = 0, max = 100, step = 1, unit = '', onChange }) {
    return (React.createElement(TweakRow, { label: label, value: `${value}${unit}` },
        React.createElement("input", { type: "range", className: "twk-slider", min: min, max: max, step: step, value: value, onChange: (e) => onChange(Number(e.target.value)) })));
}
function TweakToggle({ label, value, onChange }) {
    return (React.createElement("div", { className: "twk-row twk-row-h" },
        React.createElement("div", { className: "twk-lbl" },
            React.createElement("span", null, label)),
        React.createElement("button", { type: "button", className: "twk-toggle", "data-on": value ? '1' : '0', role: "switch", "aria-checked": !!value, onClick: () => onChange(!value) },
            React.createElement("i", null))));
}
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
    const segAt = (clientX) => {
        const r = trackRef.current.getBoundingClientRect();
        const inner = r.width - 4;
        const i = Math.floor(((clientX - r.left - 2) / inner) * n);
        return opts[Math.max(0, Math.min(n - 1, i))].value;
    };
    const onPointerDown = (e) => {
        setDragging(true);
        const v0 = segAt(e.clientX);
        if (v0 !== valueRef.current)
            onChange(v0);
        const move = (ev) => {
            if (!trackRef.current)
                return;
            const v = segAt(ev.clientX);
            if (v !== valueRef.current)
                onChange(v);
        };
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
function TweakSelect({ label, value, options, onChange }) {
    return (React.createElement(TweakRow, { label: label },
        React.createElement("select", { className: "twk-field", value: value, onChange: (e) => onChange(e.target.value) }, options.map((o) => {
            const v = typeof o === 'object' ? o.value : o;
            const l = typeof o === 'object' ? o.label : o;
            return React.createElement("option", { key: v, value: v }, l);
        }))));
}
function TweakText({ label, value, placeholder, onChange }) {
    return (React.createElement(TweakRow, { label: label },
        React.createElement("input", { className: "twk-field", type: "text", value: value, placeholder: placeholder, onChange: (e) => onChange(e.target.value) })));
}
function TweakNumber({ label, value, min, max, step = 1, unit = '', onChange }) {
    const clamp = (n) => {
        if (min != null && n < min)
            return min;
        if (max != null && n > max)
            return max;
        return n;
    };
    const startRef = React.useRef({ x: 0, val: 0 });
    const onScrubStart = (e) => {
        e.preventDefault();
        startRef.current = { x: e.clientX, val: value };
        const decimals = (String(step).split('.')[1] || '').length;
        const move = (ev) => {
            const dx = ev.clientX - startRef.current.x;
            const raw = startRef.current.val + dx * step;
            const snapped = Math.round(raw / step) * step;
            onChange(clamp(Number(snapped.toFixed(decimals))));
        };
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
function TweakColor({ label, value, onChange }) {
    return (React.createElement("div", { className: "twk-row twk-row-h" },
        React.createElement("div", { className: "twk-lbl" },
            React.createElement("span", null, label)),
        React.createElement("input", { type: "color", className: "twk-swatch", value: value, onChange: (e) => onChange(e.target.value) })));
}
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
function session() {
    try {
        return JSON.parse(localStorage.getItem(SESSION_KEY) || '{}');
    }
    catch {
        return {};
    }
}
function storeSession(sessionBody) {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ accessToken: sessionBody.accessToken, user: sessionBody.user }));
    window.dispatchEvent(new CustomEvent('patch-session-change', { detail: sessionBody }));
    return sessionBody;
}
function clearSession() {
    localStorage.removeItem(SESSION_KEY);
    window.dispatchEvent(new CustomEvent('patch-session-change', { detail: null }));
}
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
async function token() {
    const existing = session().accessToken;
    if (existing)
        return existing;
    const err = new Error('Authentication required');
    err.code = 'AUTH_REQUIRED';
    throw err;
}
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
    if (!r.ok)
        throw new Error(`${r.status} ${r.statusText} — ${path}`);
    const ct = r.headers.get('content-type') || '';
    return ct.includes('application/json') ? r.json() : r.text();
}
window.PatchAPI = {
    session,
    login: (email, password) => loginWithCredentials(email, password),
    verifyMfa: (challengeToken, code) => verifyMfaWithCode(challengeToken, code),
    logout: () => clearSession(),
    summary: () => api('/dashboard/summary'),
    coverageHistory: (d = 30) => api(`/dashboard/coverage-history?days=${d}`),
    devices: (q) => api('/devices' + (q ? `?q=${encodeURIComponent(q)}` : '')),
    device: (id) => api(`/devices/${id}`),
    createDeviceEnrollment: (b) => api('/devices/enrollments', { method: 'POST', body: JSON.stringify(b) }),
    apps: (q) => api('/apps' + (q ? `?q=${encodeURIComponent(q)}` : '')),
    packages: () => api('/packages'),
    rules: () => api('/rules'),
    tasks: () => api('/tasks'),
    cancelTask: (id) => api(`/tasks/${id}`, { method: 'DELETE' }),
    nodes: () => api('/nodes'),
    createNodeEnrollment: (b) => api('/nodes/enrollments', { method: 'POST', body: JSON.stringify(b) }),
    alarms: () => api('/alarms'),
    audit: (l = 100) => api(`/audit?limit=${l}`),
    siemConfig: (t = 'default') => api(`/siem/config/${encodeURIComponent(t)}`),
    saveSiemConfig: (t, b) => api(`/siem/config/${encodeURIComponent(t)}`, { method: 'PUT', body: JSON.stringify(b) }),
    testSiem: (t = 'default') => api(`/siem/test/${encodeURIComponent(t)}`, { method: 'POST', body: '{}' }),
    verifySiem: (t = 'default') => api(`/siem/verify/${encodeURIComponent(t)}`, { method: 'POST', body: '{}' }),
    siemQueueStatus: () => api('/siem/queue/status'),
    securityPosture: (t = 'default') => api(`/security/posture?tenantId=${encodeURIComponent(t)}`),
    fixSecurityPosture: (t = 'default', actions) => api(`/security/posture/fix?tenantId=${encodeURIComponent(t)}`, { method: 'POST', body: JSON.stringify(actions ? { actions } : {}) }),
    createPackage: (b) => api('/packages', { method: 'POST', body: JSON.stringify(b) }),
    deployPackageAll: (id) => api(`/packages/${id}/deploy-all`, { method: 'POST', body: '{}' }),
    updateAllForApp: (n, b) => api(`/apps/${encodeURIComponent(n)}/update-all`, { method: 'POST', body: JSON.stringify(b || { targetVersion: 'latest' }) }),
    updateDeviceForApp: (n, b) => api(`/apps/${encodeURIComponent(n)}/update-device`, { method: 'POST', body: JSON.stringify(b) }),
    refreshInventory: (id) => api(`/tasks/refresh-inventory/${id}`, { method: 'POST', body: '{}' }),
    updateAllOutdated: (id) => api(`/devices/${id}/update-all-outdated`, { method: 'POST', body: '{}' }),
    createRule: (b) => api('/rules', { method: 'POST', body: JSON.stringify(b) }),
    updateRule: (id, b) => api(`/rules/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
    toggleRule: (id, e) => api(`/rules/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled: e }) }),
    testRule: (id, b) => api(`/rules/${id}/test`, { method: 'POST', body: JSON.stringify(b || {}) }),
    triggerRule: (id, b) => api(`/rules/${id}/trigger`, { method: 'POST', body: JSON.stringify(b || {}) }),
    ruleAudit: (id) => api(id ? `/rules/${id}/audit` : '/rules/audit'),
    resolveAlarm: (id) => api(`/alarms/${id}/resolve`, { method: 'POST', body: '{}' }),
};


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
};
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
function StatusPill({ status }) {
    const map = {
        online: { cls: "ok", label: "Online" },
        offline: { cls: "", label: "Offline" },
        pending: { cls: "", label: "Pending" },
        dispatched: { cls: "accent", label: "Dispatched" },
        completed: { cls: "ok", label: "Completed" },
        failed: { cls: "crit", label: "Failed" },
        rejected: { cls: "warn", label: "Rejected" },
        cancelled: { cls: "", label: "Cancelled" },
        valid: { cls: "ok", label: "Signed" },
        unsigned: { cls: "warn", label: "Unsigned" },
        unknown: { cls: "", label: "Unknown" },
    };
    const it = map[status] || { cls: "", label: status };
    return React.createElement("span", { className: "pill " + it.cls },
        React.createElement("span", { className: "dot" }),
        it.label);
}
function OsIcon({ platform }) {
    return React.createElement("span", { style: { display: "inline-flex", width: 14, height: 14, color: "var(--text-3)" } }, platform === "linux" ? Icon.linux : Icon.windows);
}
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
function taskLabel(task) {
    if (!task)
        return "Task";
    if (task.type === "refresh_inventory")
        return "Refresh inventory";
    return task.appName || task.packageId || task.packageArtifactId || task.type || task.id;
}
function taskVersionLabel(task) {
    if (!task)
        return "—";
    if (task.type === "refresh_inventory")
        return "Inventory scan";
    return (task.fromVersion || "—") + " → " + (task.targetVersion ?? task.toVersion ?? "latest");
}
function sortTasksNewestFirst(tasks) {
    return (tasks || []).slice().sort((a, b) => {
        const aTime = a.createdAt || a.dispatchedAt || a.completedAt || "";
        const bTime = b.createdAt || b.dispatchedAt || b.completedAt || "";
        return bTime.localeCompare(aTime);
    });
}
Object.assign(window, { Icon, Sparkline, Donut, StatusPill, OsIcon, formatOs, taskLabel, taskVersionLabel, sortTasksNewestFirst });


// AGPL-3.0-only — Page components for the 1Patch management UI (live data, no mocks)
const { useState, useEffect, useMemo, useCallback, useRef } = React;
// ---------- Loader hook ----------
function dataSignature(value) {
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
}
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
function useLiveResource(resource, intervalMs = 5000) {
    useEffect(() => {
        let inFlight = false;
        const tick = () => {
            if (inFlight || document.visibilityState === "hidden")
                return;
            inFlight = true;
            Promise.resolve(resource.reload(true)).finally(() => { inFlight = false; });
        };
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
function Skeleton({ w = "100%", h = 16, r = 4, style }) {
    return React.createElement("span", { className: "skel", style: { display: "inline-block", width: w, height: h, borderRadius: r, ...style } });
}
function ErrorAlert({ error, onRetry }) {
    return (React.createElement("div", { className: "alert" },
        React.createElement("strong", null, "Couldn't load."),
        " ",
        React.createElement("span", { className: "muted" }, error?.message || String(error)),
        onRetry && React.createElement("button", { className: "btn sm", onClick: onRetry }, "Retry")));
}
function SkeletonRows({ n = 6, cols = 6 }) {
    return Array.from({ length: n }).map((_, i) => (React.createElement("tr", { key: i }, Array.from({ length: cols }).map((_, j) => React.createElement("td", { key: j },
        React.createElement(Skeleton, { w: j === 0 ? 160 : 80 }))))));
}
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
    const trend = (history.data || []).map(p => p.value);
    const coverage = trend.length ? trend[trend.length - 1] : (s.coverage ?? 0);
    const trendStart = trend[0] ?? coverage;
    const topApps = (apps.data || []).filter(a => (a.outdatedDeviceCount ?? a.outdated) > 0).slice(0, 6);
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
                        React.createElement(Metric, { label: "Critical CVEs", value: s.criticalCves ?? "—", tone: "crit" }),
                        React.createElement(Metric, { label: "Failed tasks", value: tasks.loading ? "—" : (tasks.data || []).filter(t => t.status === "failed").length, tone: "crit" }),
                        React.createElement(Metric, { label: "Active rules", value: s.activeRules ?? "—" }))),
                React.createElement("div", { className: "pulse-spark", style: { display: "flex", flexDirection: "column", justifyContent: "space-between" } },
                    React.createElement("div", { className: "pulse-sub", style: { display: "flex", justifyContent: "space-between" } },
                        React.createElement("span", null, "30-day trend"),
                        trend.length > 1 && React.createElement("span", { style: { color: "var(--ok)" } },
                            "+",
                            coverage - trendStart,
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
function Stat({ label, value, sub, tone }) {
    return (React.createElement("div", { className: "stat" },
        React.createElement("div", { className: "label" }, label),
        React.createElement("div", { className: "value", style: tone === "crit" ? { color: "var(--crit)" } : {} }, value),
        sub && React.createElement("div", { className: "delta" }, sub)));
}
function Metric({ label, value, tone }) {
    const color = tone === "crit" ? "var(--crit)" : tone === "warn" ? "var(--warn)" : "var(--text)";
    return (React.createElement("div", null,
        React.createElement("div", { style: { fontSize: 12, color: "var(--text-3)" } }, label),
        React.createElement("div", { style: { fontSize: 20, fontWeight: 600, color, fontVariantNumeric: "tabular-nums" } }, value)));
}
// ---------- Devices ----------
function DevicesPage({ onOpenDevice, globalSearch = "" }) {
    const [filter, setFilter] = useState("all");
    const [q, setQ] = useState("");
    const activeQ = globalSearch || q;
    const [enrolling, setEnrolling] = useState(false);
    const devices = useResource(() => PatchAPI.devices());
    useLiveResource(devices, 2500);
    const rows = (devices.data || []).filter(d => {
        const platform = d.platform || (/(windows|win)/i.test(d.os || "") ? "windows" : "linux");
        if (!textMatches(activeQ, [d.hostname, formatOs(d.os), d.os, d.site, d.id, d.preferredNodeId]))
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
        enrolling && React.createElement(ClientEnrollmentWizard, { onClose: () => setEnrolling(false), onCreated: devices.reload })));
}
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
function AppsPage({ globalSearch = "" }) {
    const [q, setQ] = useState("");
    const activeQ = globalSearch || q;
    const apps = useResource(() => PatchAPI.apps());
    useLiveResource(apps, 5000);
    const [queuing, setQueuing] = useState(new Set());
    const [recentlyQueued, setRecentlyQueued] = useState(new Set());
    const [notice, setNotice] = useState(null);
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
    useLiveResource(pkgs, 10000);
    const deploy = async (id) => { try {
        await PatchAPI.deployPackageAll(id);
    }
    finally {
        pkgs.reload();
    } };
    const rows = (pkgs.data || []).filter(p => textMatches(globalSearch, [p.name, p.publisher, p.version, p.type, p.platform, p.architecture, p.sha256]));
    return (React.createElement("div", { className: "page" },
        React.createElement("div", { className: "page-head" },
            React.createElement("div", null,
                React.createElement("h2", null, "Package library"),
                React.createElement("p", null, "Signed artifacts deployed to backend nodes \u00B7 MSI / winget / apt")),
            React.createElement("button", { className: "btn primary" },
                React.createElement("span", { style: { width: 14, height: 14, display: "inline-flex" } }, Icon.plus),
                "Add package")),
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
                        React.createElement("th", null, "SHA-256"),
                        React.createElement("th", null, "Signature"),
                        React.createElement("th", null, "Created"),
                        React.createElement("th", null))),
                React.createElement("tbody", null,
                    pkgs.loading && React.createElement(SkeletonRows, { n: 5, cols: 8 }),
                    !pkgs.loading && rows.length === 0 && React.createElement("tr", null,
                        React.createElement("td", { colSpan: 8, style: { padding: 24, color: "var(--text-3)" } }, "No packages uploaded.")),
                    !pkgs.loading && rows.map(p => (React.createElement("tr", { key: p.id || p.sha256 },
                        React.createElement("td", null,
                            React.createElement("div", null,
                                React.createElement("strong", { style: { fontWeight: 500 } }, p.name),
                                React.createElement("div", { className: "muted", style: { fontSize: 12 } }, p.publisher))),
                        React.createElement("td", { className: "mono" }, p.version),
                        React.createElement("td", null,
                            React.createElement("span", { className: "pill" }, p.type)),
                        React.createElement("td", { className: "muted" },
                            p.platform,
                            p.architecture ? " · " + p.architecture : ""),
                        React.createElement("td", { className: "mono muted", title: p.sha256 }, p.sha256 ? `${p.sha256.slice(0, 12)}…` : "—"),
                        React.createElement("td", null,
                            React.createElement(StatusPill, { status: p.signatureStatus })),
                        React.createElement("td", { className: "muted" }, fmtAgo(p.createdAt)),
                        React.createElement("td", null,
                            React.createElement("button", { className: "btn sm", onClick: () => deploy(p.id) }, "Deploy"))))))))));
}
// ---------- Rules ----------
function RulesPage({ globalSearch = "" }) {
    const [editing, setEditing] = useState(null);
    const [testing, setTesting] = useState(null);
    const rules = useResource(() => PatchAPI.rules());
    const audit = useResource(() => PatchAPI.ruleAudit());
    useLiveResource(rules, 10000);
    useLiveResource(audit, 10000);
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
function RuleWizard({ rule, onClose, onCreated }) {
    const [step, setStep] = useState("trigger");
    const [form, setForm] = useState(() => normalizeRuleForm(rule));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const set = (key, value) => setForm(prev => ({ ...prev, [key]: value }));
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
    const tabs = [["trigger", "Trigger"], ["conditions", "Conditions"], ["actions", "Actions"], ["schedule", "Schedule"], ["preview", "Preview"]];
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
                                    React.createElement("option", { value: "enabled" }, "Enabled"),
                                    React.createElement("option", { value: "disabled" }, "Disabled")))),
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
                                    React.createElement("option", { value: "vulnerability.detected" }, "vulnerability.detected"))),
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
                                    React.createElement("option", { value: "mark_device" }, "Mark device"))),
                            form.actionType === "create_patch_task" && React.createElement("label", { className: "field" },
                                React.createElement("span", null, "Patch mode"),
                                React.createElement("select", { value: form.patchMode, onChange: e => set("patchMode", e.target.value) },
                                    React.createElement("option", { value: "all_outdated" }, "All outdated packages"),
                                    React.createElement("option", { value: "specific_package" }, "Specific package"))),
                            form.actionType === "create_patch_task" && form.patchMode === "specific_package" && React.createElement("label", { className: "field" },
                                React.createElement("span", null, "Package"),
                                React.createElement("input", { value: form.packageName, onChange: e => set("packageName", e.target.value), placeholder: "Google Chrome" })),
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
                                React.createElement("input", { value: form.tag, onChange: e => set("tag", e.target.value), placeholder: "needs-review" }))),
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
                            React.createElement("input", { type: "number", min: "0", max: "100", value: form.requireApprovalAtRiskScore, onChange: e => set("requireApprovalAtRiskScore", Number(e.target.value || 60)) })),
                        React.createElement("label", { className: "field" },
                            React.createElement("span", null, "Max devices"),
                            React.createElement("input", { type: "number", min: "1", max: "25", value: form.maxDevices, onChange: e => set("maxDevices", Number(e.target.value || 25)) })))),
                    step === "preview" && (React.createElement(React.Fragment, null,
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
function RuleTester({ rule, onClose, onExecuted }) {
    const devices = useResource(() => PatchAPI.devices());
    const [deviceId, setDeviceId] = useState("");
    const [result, setResult] = useState(null);
    const [busy, setBusy] = useState("");
    const sampleId = deviceId || devices.data?.[0]?.id || "";
    const test = async () => { setBusy("test"); try {
        setResult(await PatchAPI.testRule(rule.id, { deviceId: sampleId }));
    }
    finally {
        setBusy("");
    } };
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
const conditionFields = ["device.os", "device.hostname", "device.group", "device.tag", "device.deviceTrustScore", "package.outdated", "package.name", "package.version", "lastTask.failed", "lastTask.retryCount", "currentTime.maintenanceWindow", "riskScore"];
const conditionOperators = ["eq", "neq", "contains", "matches", "lt", "lte", "gt", "gte", "in"];
function defaultRule() {
    return { enabled: true, tenantId: "default", name: "", description: "", priority: 100, trigger: { type: "manual" }, conditionGroup: { combinator: "AND", conditions: [{ field: "package.outdated", operator: "eq", value: true }] }, actions: [{ type: "create_patch_task", mode: "all_outdated", targetVersion: "latest", maxDevices: 25 }], schedule: { maintenanceWindow: { startHourUtc: 0, endHourUtc: 6 } }, safeMode: { enabled: true, requireApprovalAtRiskScore: 60 } };
}
function normalizeRuleForm(rule) {
    const r = rule || defaultRule();
    const action = (r.actions || defaultRule().actions)[0];
    return { id: r.id, tenantId: r.tenantId || "default", name: r.name || "", description: r.description || "", enabled: r.enabled !== false, priority: r.priority ?? 100, triggerType: r.trigger?.type || "manual", eventType: r.trigger?.eventType || "device.inventory.updated", cron: r.schedule?.cron || "0 2 * * 0", combinator: r.conditionGroup?.combinator || "AND", conditions: r.conditionGroup?.conditions?.filter(c => !c.combinator) || [], actionType: action.type, patchMode: action.mode || "all_outdated", packageName: action.packageName || "", targetVersion: action.targetVersion || "latest", securityTask: action.task || "refresh_inventory", notifyMessage: action.message || "Rule matched", tag: action.tag || "rule-matched", startHourUtc: r.schedule?.maintenanceWindow?.startHourUtc ?? 0, endHourUtc: r.schedule?.maintenanceWindow?.endHourUtc ?? 6, requireApprovalAtRiskScore: r.safeMode?.requireApprovalAtRiskScore ?? 60, maxDevices: action.maxDevices || 25 };
}
function rulePayload(form) {
    const action = form.actionType === "create_patch_task" ? { type: "create_patch_task", mode: form.patchMode, packageName: form.packageName || undefined, targetVersion: form.targetVersion || "latest", maxDevices: form.maxDevices } : form.actionType === "create_security_task" ? { type: "create_security_task", task: form.securityTask } : form.actionType === "notify" ? { type: "notify", channel: "siem", message: form.notifyMessage || "Rule matched" } : { type: "mark_device", tag: form.tag || "rule-matched" };
    return { tenantId: form.tenantId || "default", name: form.name.trim(), description: form.description.trim(), enabled: form.enabled, priority: Number(form.priority || 100), trigger: { type: form.triggerType, ...(form.triggerType === "event" ? { eventType: form.eventType } : {}) }, conditionGroup: { combinator: form.combinator, conditions: form.conditions }, actions: [action], schedule: { cron: form.triggerType === "schedule" ? form.cron : undefined, maintenanceWindow: { startHourUtc: Number(form.startHourUtc), endHourUtc: Number(form.endHourUtc) } }, safeMode: { enabled: true, requireApprovalAtRiskScore: Number(form.requireApprovalAtRiskScore || 60) } };
}
function updateCondition(setForm, index, patch) { setForm(prev => ({ ...prev, conditions: prev.conditions.map((c, i) => i === index ? { ...c, ...patch } : c) })); }
function removeCondition(setForm, index) { setForm(prev => ({ ...prev, conditions: prev.conditions.filter((_, i) => i !== index) })); }
function parseConditionValue(value) { if (value === "true")
    return true; if (value === "false")
    return false; const n = Number(value); return value.trim() !== "" && Number.isFinite(n) ? n : value; }
function conditionSummary(group) { const count = group?.conditions?.length || 0; return `${group?.combinator || "AND"} · ${count} condition${count === 1 ? "" : "s"}`; }
function actionSummary(action) { if (!action)
    return "none"; if (action.type === "create_patch_task")
    return action.mode === "all_outdated" ? "patch all outdated" : `patch ${action.packageName || action.packageId || "package"}`; if (action.type === "create_security_task")
    return action.task; if (action.type === "notify")
    return `notify ${action.channel}`; if (action.type === "mark_device")
    return `tag ${action.tag}`; return action.type; }
// ---------- Tasks ----------
function TasksPage({ globalSearch = "" }) {
    const [filter, setFilter] = useState("all");
    const tasks = useResource(() => PatchAPI.tasks());
    useLiveResource(tasks, 2500);
    const [cancelling, setCancelling] = useState(new Set());
    const [outputTask, setOutputTask] = useState(null);
    const [copied, setCopied] = useState(false);
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
                React.createElement("p", null, tasks.loading ? "…" : `${(tasks.data || []).length} update jobs`))),
        React.createElement("div", { className: "card" },
            React.createElement("div", { className: "filterbar" }, [["all", "All"], ["pending", "Pending"], ["dispatched", "Dispatched"], ["completed", "Completed"], ["failed", "Failed"], ["cancelled", "Cancelled"]].map(([k, l]) => (React.createElement("button", { key: k, className: "chip " + (filter === k ? "active" : ""), onClick: () => setFilter(k) }, l)))),
            tasks.error && React.createElement("div", { style: { padding: 16 } },
                React.createElement(ErrorAlert, { error: tasks.error, onRetry: tasks.reload })),
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
                            React.createElement("td", { className: "mono muted", style: { maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: t.output ? "pointer" : "default" }, title: t.output ? "Click to view full output" : undefined, onClick: () => t.output && setOutputTask(t) }, t.output || "—"),
                            React.createElement("td", { className: "muted" }, fmtAgo(t.createdAt)),
                            React.createElement("td", null, t.status === "pending" && (React.createElement("button", { className: "btn sm", disabled: cancelling.has(t.id), onClick: () => cancel(t.id) }, cancelling.has(t.id) ? "…" : "Cancel")))))))))),
        outputTask && (React.createElement(React.Fragment, null,
            React.createElement("div", { className: "drawer-backdrop", onClick: () => setOutputTask(null) }),
            React.createElement("div", { className: "output-dialog" },
                React.createElement("div", { className: "output-dialog-box" },
                    React.createElement("div", { className: "output-dialog-head" },
                        React.createElement("h4", null, taskLabel(outputTask)),
                        React.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
                            React.createElement("button", { className: "btn sm", onClick: copyOutput }, copied ? "Copied!" : "Copy"),
                            React.createElement("button", { className: "icon-btn", onClick: () => setOutputTask(null) },
                                React.createElement("span", { style: { width: 14, height: 14, display: "inline-flex" } }, Icon.close)))),
                    React.createElement("div", { className: "output-dialog-body" },
                        React.createElement("pre", null, outputTask.output))))))));
}
// ---------- Nodes ----------
function NodesPage({ globalSearch = "" }) {
    const nodes = useResource(() => PatchAPI.nodes());
    useLiveResource(nodes, 5000);
    const rows = (nodes.data || []).filter(n => textMatches(globalSearch, [n.name, n.id, n.publicUrl, n.url, n.region, n.site, n.status, n.version]));
    const [enrolling, setEnrolling] = useState(false);
    const [enrollment, setEnrollment] = useState(null);
    return (React.createElement("div", { className: "page" },
        React.createElement("div", { className: "page-head" },
            React.createElement("div", null,
                React.createElement("h2", null, "Backend nodes"),
                React.createElement("p", null, "Regional workers that fan out tasks to enrolled clients")),
            React.createElement("button", { className: "btn primary", onClick: () => { setEnrollment(null); setEnrolling(true); } },
                React.createElement("span", { style: { width: 14, height: 14, display: "inline-flex" } }, Icon.plus),
                "Enroll node")),
        nodes.error && React.createElement(ErrorAlert, { error: nodes.error, onRetry: nodes.reload }),
        React.createElement("div", { className: "row-3" },
            nodes.loading && Array.from({ length: 3 }).map((_, i) => React.createElement("div", { className: "card", key: i },
                React.createElement("div", { className: "card-body" },
                    React.createElement(Skeleton, { h: 80 })))),
            !nodes.loading && rows.length === 0 && React.createElement("div", { className: "card" },
                React.createElement("div", { className: "card-body", style: { color: "var(--text-3)" } }, "No nodes enrolled.")),
            !nodes.loading && rows.map(n => (React.createElement("div", { className: "card", key: n.id },
                React.createElement("div", { className: "card-body", style: { display: "flex", flexDirection: "column", gap: 14 } },
                    React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 } },
                        React.createElement("div", null,
                            React.createElement("div", { style: { fontWeight: 600, fontSize: 15 } }, n.name),
                            React.createElement("div", { className: "muted mono", style: { fontSize: 12 } }, n.publicUrl || n.url)),
                        React.createElement(StatusPill, { status: n.status })),
                    React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, paddingTop: 12, borderTop: "1px solid var(--line)" } },
                        React.createElement("div", null,
                            React.createElement("div", { className: "muted", style: { fontSize: 11 } }, "REGION"),
                            React.createElement("div", { className: "mono", style: { fontSize: 13 } }, n.region || "—")),
                        React.createElement("div", null,
                            React.createElement("div", { className: "muted", style: { fontSize: 11 } }, "VERSION"),
                            React.createElement("div", { className: "mono", style: { fontSize: 13 } }, n.version || "—")),
                        React.createElement("div", null,
                            React.createElement("div", { className: "muted", style: { fontSize: 11 } }, "CAPACITY"),
                            React.createElement("div", { className: "mono", style: { fontSize: 13 } }, n.capacity ? JSON.stringify(n.capacity) : "—")),
                        React.createElement("div", null,
                            React.createElement("div", { className: "muted", style: { fontSize: 11 } }, "LAST SEEN"),
                            React.createElement("div", { className: "mono", style: { fontSize: 13 } }, fmtAgo(n.lastSeenAt))))))))),
        enrolling && (React.createElement(EnrollNodeDrawer, { result: enrollment, onClose: () => setEnrolling(false), onCreated: (created) => { setEnrollment(created); nodes.reload(); } }))));
}
function EnrollNodeDrawer({ result, onClose, onCreated }) {
    const [form, setForm] = useState({ name: "", publicUrl: "http://localhost:4200", region: "", site: "" });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const enrollmentJson = result ? JSON.stringify(result, null, 2) : "";
    const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));
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
            onCreated(created);
        }
        catch (err) {
            setError(err);
        }
        finally {
            setBusy(false);
        }
    };
    const copy = async () => {
        await copyTextToClipboard(enrollmentJson);
    };
    return (React.createElement(React.Fragment, null,
        React.createElement("div", { className: "drawer-backdrop", onClick: onClose }),
        React.createElement("div", { className: "drawer" },
            React.createElement("div", { className: "drawer-head" },
                React.createElement("h3", null, "Enroll backend node"),
                React.createElement("button", { className: "icon-btn", onClick: onClose },
                    React.createElement("span", { style: { width: 14, height: 14, display: "inline-flex" } }, Icon.close))),
            React.createElement("div", { className: "drawer-body" },
                !result && (React.createElement("form", { onSubmit: submit, style: { display: "flex", flexDirection: "column", gap: 14 } },
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
                        React.createElement("input", { value: form.site, placeholder: "office-1", onChange: e => set("site", e.target.value) })),
                    error && React.createElement(ErrorAlert, { error: error }),
                    React.createElement("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
                        React.createElement("button", { type: "button", className: "btn", onClick: onClose }, "Cancel"),
                        React.createElement("button", { className: "btn primary", disabled: busy }, busy ? "Creating…" : "Create enrollment")))),
                result && (React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 14 } },
                    React.createElement("div", { className: "alert", style: { color: "var(--ok)", background: "var(--ok-soft)", borderColor: "transparent" } },
                        React.createElement("strong", null, "Enrollment created."),
                        React.createElement("span", { className: "muted" }, "Use this JSON in the backend node setup.")),
                    React.createElement("textarea", { className: "codebox", readOnly: true, value: enrollmentJson }),
                    React.createElement("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
                        React.createElement("button", { className: "btn", onClick: copy }, "Copy JSON"),
                        React.createElement("button", { className: "btn primary", onClick: onClose }, "Done"))))))));
}
// ---------- Alarms ----------
function AlarmsPage({ globalSearch = "" }) {
    const alarms = useResource(() => PatchAPI.alarms());
    useLiveResource(alarms, 5000);
    const resolve = async (id) => { try {
        await PatchAPI.resolveAlarm(id);
    }
    finally {
        alarms.reload();
    } };
    const rows = (alarms.data || []).filter(a => textMatches(globalSearch, [a.message, a.deviceId, a.severity, a.id]));
    return (React.createElement("div", { className: "page" },
        React.createElement("div", { className: "page-head" },
            React.createElement("div", null,
                React.createElement("h2", null, "Alarms"),
                React.createElement("p", null, alarms.loading ? "…" : `${rows.length} active across the fleet`))),
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
function defaultSiemConfig() {
    return {
        mode: "standard",
        webhook: { url: "", secret: "" },
        syslog: { host: "", port: 514, protocol: "udp", appName: "1patch" },
        sentinel: { workspaceId: "", sharedKey: "", logType: "OnePatchEvents" },
        exportOverrides: {},
    };
}
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
function SecurityPosturePage() {
    const [tenantId, setTenantId] = useState("default");
    const [notice, setNotice] = useState(null);
    const [busy, setBusy] = useState("");
    const posture = useResource(() => PatchAPI.securityPosture(tenantId), [tenantId]);
    const report = posture.data;
    const critical = report?.findingsBySeverity?.critical || [];
    const findings = report?.findings || [];
    const safeFixCount = findings.filter(f => f.autoFixAvailable && f.severity !== "critical").length;
    const rerun = () => {
        setNotice(null);
        posture.reload(false);
    };
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
function severityTone(severity) {
    return severity === "critical" ? "crit" : severity === "high" || severity === "medium" ? "warn" : "accent";
}
function modeTone(mode) {
    return mode === "tinfoil" ? "crit" : mode === "strict" ? "ok" : "warn";
}
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
    const refresh = async () => { try {
        await PatchAPI.refreshInventory(deviceId);
    }
    finally {
        detail.reload();
    } };
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
Object.assign(window, {
    OverviewPage, DevicesPage, AppsPage, PackagesPage, RulesPage, TasksPage, NodesPage, AlarmsPage, AuditPage, SiemPage, SecurityPosturePage, DeviceDrawer
});


// AGPL-3.0-only — Main app shell, routing, tweaks
const { useState: useStateApp, useEffect: useEffectApp, useRef: useRefApp } = React;
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/ {
    "theme": "light",
    "accentHue": 230,
    "density": "comfortable",
    "sidebar": "labelled"
} /*EDITMODE-END*/;
const CATEGORY_IDS = ["overview", "devices", "apps", "packages", "rules", "tasks", "nodes", "alarms", "audit", "siem", "security-posture"];
const SEARCH_TYPES = ["device", "app", "package", "rule", "task", "node", "alarm", "audit"];
const SEARCH_ALIASES = {
    devices: "device",
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
    app: "apps",
    package: "packages",
    rule: "rules",
    task: "tasks",
    node: "nodes",
    alarm: "alarms",
    audit: "audit",
};
function parseSearchQuery(value) {
    const raw = (value || "").trim();
    const match = raw.match(/^([a-z]+):\s*(.*)$/i);
    if (!match)
        return { type: null, term: raw };
    const requested = match[1].toLowerCase();
    const type = SEARCH_TYPES.includes(requested) ? requested : SEARCH_ALIASES[requested];
    return type ? { type, term: match[2].trim() } : { type: null, term: raw };
}
function textMatches(query, parts) {
    if (!query)
        return true;
    const haystack = parts.filter(Boolean).join(" ").toLowerCase();
    return query.toLowerCase().split(/\s+/).every((part) => haystack.includes(part));
}
function highlight(text, term) {
    if (!term || !text)
        return text || "";
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const parts = String(text).split(new RegExp(`(${esc})`, "gi"));
    if (parts.length === 1)
        return text;
    return parts.map((p, i) => i % 2 === 1 ? React.createElement("mark", { className: "search-mark", key: i }, p) : p);
}
function limitResults(items, limit = 8) {
    return items.slice(0, limit);
}
function buildSearchResults(data, query) {
    const { type, term } = parseSearchQuery(query);
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
function categoryFromUrl() {
    const pathCategory = window.location.pathname.replace(/^\/ui\/?/, "").split("/")[0];
    if (CATEGORY_IDS.includes(pathCategory))
        return pathCategory;
    const params = new URLSearchParams(window.location.search);
    const category = params.get("category") || params.get("tab");
    return CATEGORY_IDS.includes(category) ? category : "overview";
}
function pushCategoryUrl(category) {
    const target = category === "overview" ? "/ui" : `/ui/${category}`;
    window.history.pushState({ category }, "", target);
}
function App() {
    const [authSession, setAuthSession] = useStateApp(() => PatchAPI.session());
    useEffectApp(() => {
        const onSessionChange = () => setAuthSession(PatchAPI.session());
        window.addEventListener("patch-session-change", onSessionChange);
        return () => window.removeEventListener("patch-session-change", onSessionChange);
    }, []);
    if (!authSession.accessToken) {
        return React.createElement(LoginScreen, { onAuthenticated: (nextSession) => setAuthSession(nextSession) });
    }
    return React.createElement(DashboardApp, { sessionInfo: authSession, onLogout: () => { PatchAPI.logout(); setAuthSession({}); } });
}
function DashboardApp({ sessionInfo, onLogout }) {
    const [tab, setTabState] = useStateApp(categoryFromUrl);
    const [openDevice, setOpenDevice] = useStateApp(null);
    const [globalSearch, setGlobalSearch] = useStateApp("");
    const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);
    const setTab = (category) => {
        if (!CATEGORY_IDS.includes(category))
            category = "overview";
        setTabState(category);
        pushCategoryUrl(category);
    };
    useEffectApp(() => {
        const onPopState = () => setTabState(categoryFromUrl());
        window.addEventListener("popstate", onPopState);
        return () => window.removeEventListener("popstate", onPopState);
    }, []);
    // live counts for sidebar badges
    const [counts, setCounts] = useStateApp({ devices: null, pending: null, criticalAlarms: null });
    useEffectApp(() => {
        let alive = true;
        let inFlight = false;
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
    const NAV = [
        { id: "overview", label: "Overview", icon: Icon.dashboard },
        { id: "devices", label: "Devices", icon: Icon.devices, count: counts.devices },
        { id: "apps", label: "Apps", icon: Icon.apps },
        { id: "packages", label: "Packages", icon: Icon.packages },
        { id: "rules", label: "Rules", icon: Icon.rules },
        { id: "tasks", label: "Tasks", icon: Icon.tasks, count: counts.pending },
        { id: "nodes", label: "Nodes", icon: Icon.nodes },
        { id: "alarms", label: "Alarms", icon: Icon.alarms, count: counts.criticalAlarms, countTone: "crit" },
        { id: "audit", label: "Audit", icon: Icon.audit },
        { id: "siem", label: "SIEM", icon: Icon.audit },
        { id: "security-posture", label: "Posture", icon: Icon.shield },
    ];
    const pageSearchTerm = (category) => {
        const parsed = parseSearchQuery(globalSearch);
        if (!parsed.type)
            return "";
        return SEARCH_TYPE_TO_CATEGORY[parsed.type] === category ? parsed.term : "";
    };
    const Page = {
        overview: React.createElement(OverviewPage, { onNav: setTab, onOpenDevice: setOpenDevice }),
        devices: React.createElement(DevicesPage, { onOpenDevice: setOpenDevice, globalSearch: pageSearchTerm("devices") }),
        apps: React.createElement(AppsPage, { globalSearch: pageSearchTerm("apps") }),
        packages: React.createElement(PackagesPage, { globalSearch: pageSearchTerm("packages") }),
        rules: React.createElement(RulesPage, { globalSearch: pageSearchTerm("rules") }),
        tasks: React.createElement(TasksPage, { globalSearch: pageSearchTerm("tasks") }),
        nodes: React.createElement(NodesPage, { globalSearch: pageSearchTerm("nodes") }),
        alarms: React.createElement(AlarmsPage, { globalSearch: pageSearchTerm("alarms") }),
        audit: React.createElement(AuditPage, { globalSearch: pageSearchTerm("audit") }),
        siem: React.createElement(SiemPage, null),
        "security-posture": React.createElement(SecurityPosturePage, null),
    }[tab];
    const current = NAV.find(n => n.id === tab);
    const handleSearchSelect = (result) => {
        setTab(result.target);
        if (result.deviceId)
            setOpenDevice(result.deviceId);
    };
    return (React.createElement("div", { className: "shell", "data-theme": tweaks.theme, "data-density": tweaks.density, "data-sidebar": tweaks.sidebar, "data-screen-label": `01 ${current.label}` },
        React.createElement("aside", { className: "sidebar" },
            React.createElement("div", { className: "sidebar-brand" },
                React.createElement("div", { className: "brand-mark" }, "1P"),
                React.createElement("div", { className: "brand-name" },
                    "1Patch ",
                    React.createElement("em", null, "Management"))),
            React.createElement("div", { className: "nav-section" }, "Operate"),
            NAV.slice(0, 2).map(n => React.createElement(NavItem, { key: n.id, item: n, active: tab === n.id, onClick: () => setTab(n.id) })),
            React.createElement("div", { className: "nav-section" }, "Catalog"),
            NAV.slice(2, 5).map(n => React.createElement(NavItem, { key: n.id, item: n, active: tab === n.id, onClick: () => setTab(n.id) })),
            React.createElement("div", { className: "nav-section" }, "Activity"),
            NAV.slice(5).map(n => React.createElement(NavItem, { key: n.id, item: n, active: tab === n.id, onClick: () => setTab(n.id) })),
            React.createElement("div", { className: "sidebar-footer" },
                React.createElement("div", { className: "user-card" },
                    React.createElement("div", { className: "avatar" }, initials(sessionInfo.user?.email)),
                    React.createElement("div", { className: "user-meta" },
                        React.createElement("strong", null, sessionInfo.user?.email || "Admin session"),
                        React.createElement("span", null, "JWT session")),
                    React.createElement("button", { type: "button", className: "icon-btn logout-btn", "aria-label": "Sign out", onClick: onLogout }, Icon.close)))),
        React.createElement("div", { className: "main" },
            React.createElement("div", { className: "topbar" },
                React.createElement("div", { className: "crumbs" },
                    React.createElement("span", { className: "crumb" }, "Tenant"),
                    React.createElement("span", { className: "sep" }, "/"),
                    React.createElement("span", { className: "crumb" }, "1patch"),
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
function initials(email) {
    const name = String(email || "1P").trim();
    if (!name || name === "1P")
        return "1P";
    return name.slice(0, 2).toUpperCase();
}
function LoginScreen({ onAuthenticated }) {
    const [email, setEmail] = useStateApp("");
    const [password, setPassword] = useStateApp("");
    const [mfaCode, setMfaCode] = useStateApp("");
    const [challengeToken, setChallengeToken] = useStateApp("");
    const [loading, setLoading] = useStateApp(false);
    const [error, setError] = useStateApp("");
    const mfaRequired = Boolean(challengeToken);
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
                React.createElement("div", { className: "brand-mark" }, "1P"),
                React.createElement("div", null,
                    React.createElement("strong", null, "1Patch Management"),
                    React.createElement("span", null, "Control plane access"))),
            React.createElement("div", { className: "login-copy" },
                React.createElement("h1", { id: "login-title" }, mfaRequired ? "Enter MFA code" : "Sign in"),
                React.createElement("p", null, mfaRequired ? "Use the current code from your authenticator app." : "Use your local owner or admin account.")),
            React.createElement("form", { className: "login-form", onSubmit: submit },
                !mfaRequired && (React.createElement(React.Fragment, null,
                    React.createElement("label", { className: "field" },
                        React.createElement("span", null, "Email"),
                        React.createElement("input", { type: "email", autoComplete: "email", value: email, onChange: (e) => setEmail(e.target.value), required: true, autoFocus: true })),
                    React.createElement("label", { className: "field" },
                        React.createElement("span", null, "Password"),
                        React.createElement("input", { type: "password", autoComplete: "current-password", minLength: "12", value: password, onChange: (e) => setPassword(e.target.value), required: true })))),
                mfaRequired && (React.createElement("label", { className: "field" },
                    React.createElement("span", null, "Authentication code"),
                    React.createElement("input", { className: "mfa-input", inputMode: "numeric", autoComplete: "one-time-code", value: mfaCode, onChange: (e) => setMfaCode(e.target.value.replace(/\D/g, "").slice(0, 6)), required: true, autoFocus: true }))),
                error && React.createElement("div", { className: "login-error", role: "alert" }, error),
                React.createElement("button", { type: "submit", className: "btn primary login-submit", disabled: loading || (mfaRequired ? mfaCode.length < 6 : !email || !password) },
                    loading ? React.createElement("span", { className: "search-spinner" }) : React.createElement("span", { className: "login-submit-icon" }, Icon.shield),
                    mfaRequired ? "Verify code" : "Sign in"),
                mfaRequired && (React.createElement("button", { type: "button", className: "btn ghost login-back", onClick: () => { setChallengeToken(""); setError(""); } }, "Back to password"))))));
}
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
        if (!open)
            return;
        load(false);
        const id = setInterval(() => load(true), 10000);
        return () => clearInterval(id);
    }, [open]);
    useEffectApp(() => {
        if (!open)
            return;
        const onPointerDown = (e) => {
            if (!rootRef.current?.contains(e.target))
                setOpen(false);
        };
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
