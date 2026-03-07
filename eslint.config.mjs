import tseslint from "typescript-eslint";

const HTML_PATTERN = /<\/?[a-z][\w:-]*(?:\s[^<>]*)?>/iu;
const CSS_PATTERN = /\b(?:display|position|top|right|bottom|left|width|height|margin|padding|border|background|font-size|font-family|color)\s*:/iu;

function getLiteralText(node) {
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }

  if (node.type === "TemplateLiteral") {
    return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join("${...}");
  }

  return null;
}

const noInlineMarkupRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow inline HTML and CSS strings in TypeScript files"
    },
    messages: {
      forbidden: "Move inline HTML/CSS out of TypeScript and into dedicated asset files."
    },
    schema: []
  },
  create(context) {
    function check(node) {
      const text = getLiteralText(node);
      if (!text) return;
      if (!HTML_PATTERN.test(text) && !CSS_PATTERN.test(text)) return;
      context.report({ node, messageId: "forbidden" });
    }

    return {
      Literal: check,
      TemplateLiteral: check
    };
  }
};

export default [
  {
    ignores: [
      "dist/**",
      "dist-electron/**",
      "node_modules/**",
      "playwright-report/**",
      "logs/**"
    ]
  },
  {
    files: ["**/*.ts", "**/*.cts", "**/*.mts"],
    languageOptions: {
      parser: tseslint.parser
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      local: {
        rules: {
          "no-inline-markup": noInlineMarkupRule
        }
      }
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "local/no-inline-markup": "error"
    }
  }
];
