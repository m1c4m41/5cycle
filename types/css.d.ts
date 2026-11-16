/**
 * TypeScript 5.9+ type-checks side-effect imports (TS2882) and Next only ships
 * ambient declarations for `*.module.css`, so bare `import './globals.css'` in
 * app/layout.tsx has no type. This is the standard shim.
 */
declare module "*.css";
declare module "*.scss";
