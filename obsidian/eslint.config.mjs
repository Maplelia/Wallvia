import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

// Mirrors the rule set the Obsidian community directory scanner runs.
//
// This config sits next to the sources it governs, so every pattern below is
// relative to `obsidian/`. Run it from the repository root as
//
//   npx eslint --config obsidian/eslint.config.mjs obsidian
//
// which is what `npm run lint` and the release workflow do. The toolchain
// itself is installed once at the repository root: the plugin's runtime files
// (manifest.json / main.js / styles.css / versions.json) have to stay there for
// Obsidian to find them, and the VS Code extension, the CLI and the test
// suites share that same install.
export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        // Pin type-aware parsing to this folder, so the config behaves the same
        // whether it is run from the repository root or from `obsidian/`
        // (`allowDefaultProject` patterns are resolved against this, not cwd).
        tsconfigRootDir: import.meta.dirname,
        // The sources are covered by ./tsconfig.json; this one file is not.
        projectService: {
          allowDefaultProject: ["eslint.config.*"],
        },
      },
    },
  },
  {
    ignores: ["node_modules/**"],
  },
]);
