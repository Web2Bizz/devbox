import backendDomain from "./plop/backend-domain.mjs";
import backendSub from "./plop/backend-sub.mjs";
import backendUtil from "./plop/backend-util.mjs";

/**
 * Backend plop entry — the only mutation path for src/** scaffolding.
 * Run from apps/backend: `bunx plop backend-domain`, `bunx plop backend-sub`,
 * `bunx plop backend-util`. Paths are computed from answers, never hand-picked.
 */
export default function plopfile(plop) {
  backendDomain(plop);
  backendSub(plop);
  backendUtil(plop);
}
