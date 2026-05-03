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
