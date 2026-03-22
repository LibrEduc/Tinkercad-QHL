import { OptionDefaults } from "typedoc";

/** @type {import("typedoc").TypeDocOptions} */
export default {
  entryPoints: ["./src"],
  entryPointStrategy: "expand",
  exclude: ["**/test/**", "**/*.test.ts"],
  out: "docs",
  readme: "./README.md",
  tsconfig: "./tsconfig.typedoc.json",
  blockTags: [...OptionDefaults.blockTags, "@file", "@description"],
};
