import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(eslint.configs.recommended, ...tseslint.configs.recommended, {
  ignores: ["dist/", "node_modules/", "test/"],
  rules: {
    // Provider payloads are untyped JSON at the boundary; `any` casts there
    // are deliberate. Logic rules (unused vars, const-correctness, escapes) stay on.
    "@typescript-eslint/no-explicit-any": "off",
  },
});
