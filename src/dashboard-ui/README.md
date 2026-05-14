# Dashboard UI Source

This folder contains the built-in management dashboard served by `src/dashboard-ui.controller.ts` at `/ui`.

## Files

| File | Purpose |
|---|---|
| `shell.html` | HTML host that loads the UI runtime and source assets. |
| `api.jsx` | Session storage, login/MFA helpers, fetch wrapper, and `window.PatchAPI`. |
| `app.jsx` | Top-level app, routing, navigation, global search, login screen, notification shell. |
| `pages.jsx` | Dashboard pages, drawers, dialogs, resource hooks, and page-level actions. |
| `primitives.jsx` | Shared icons, charts, pills, OS markers, and compact UI primitives. |
| `tweaks-panel.jsx` | Local edit-mode/tweak controls used during dashboard design. |
| `styles.css` | Design tokens, layout, page, dialog, drawer, table, and responsive styling. |
| `app.bundle.js` | Generated bundle from `scripts/build-dashboard-ui.cjs`; do not edit by hand. |
| `mini-react.js` | Local runtime helper; treat as vendored/generated unless intentionally replacing it. |

## Data Flow

1. `shell.html` loads the source assets.
2. `api.jsx` stores the JWT session in local storage and sends `Authorization: Bearer <token>` on API calls.
3. `app.jsx` controls tabs/routes, global search, counts, session transitions, and high-level layout.
4. `pages.jsx` fetches data through `PatchAPI`, renders operational views, and calls action endpoints.
5. `styles.css` owns all visual behavior. No JSDoc is needed for CSS.

## Build Notes

The management server build runs `node scripts/build-dashboard-ui.cjs` before `nest build`. That script produces `app.bundle.js` from the JSX sources. Make changes in the JSX source files, then rebuild.

## Operational Areas

- Overview: fleet coverage, trend, active alarms, recent tasks.
- Devices and groups: endpoint list, manual enrollment, enrollment wizard, drawer actions.
- Apps/packages/rules/tasks: catalog, deployment, rule templates, task authorization flow.
- Nodes: backend node enrollment and liveness.
- SIEM and security posture: tenant export config, tests, queue health, readiness findings.
- Audit: compliance event review and export entry point.
